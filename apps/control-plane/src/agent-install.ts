import { X509Certificate, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const AGENT_DIR = resolve(import.meta.dirname, "../../mac-agent");

/** Where agents reach this Control Plane, and the key pin when its certificate is self-signed. */
export interface PublicEndpoint {
  url: string;
  /** curl --pinnedpubkey value ("sha256//<base64>") for a self-signed certificate; null for a CA-signed one. */
  pin: string | null;
  /** PEM of the self-signed certificate agents must trust; null for a CA-signed one. */
  caPem: string | null;
}

/** curl --pinnedpubkey form of a certificate's public key. */
export const pinOf = (pem: string) => `sha256//${createHash("sha256").update(new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" })).digest("base64")}`;

export const gatewayFile = () => process.env.BAP_GATEWAY_FILE ?? join(homedir(), ".bap-cp", "gateway.json");

/**
 * BAP_PUBLIC_URL (a deployed server; BAP_PUBLIC_CERT_FILE when its certificate is self-signed) wins; otherwise the file `pnpm gateway` writes.
 * Read on every call: starting the gateway needs no Control Plane restart.
 */
export function publicEndpoint(): PublicEndpoint | null {
  if (process.env.BAP_PUBLIC_URL) {
    const url = process.env.BAP_PUBLIC_URL.replace(/\/$/, "");
    // A server on its IP without a domain: a self-signed certificate that installers pin.
    const caPem = process.env.BAP_PUBLIC_CERT_FILE ? readFileSync(process.env.BAP_PUBLIC_CERT_FILE, "utf8") : null;
    return { url, pin: caPem && pinOf(caPem), caPem };
  }
  const file = gatewayFile();
  if (!existsSync(file)) return null;
  const g = JSON.parse(readFileSync(file, "utf8")) as { publicUrl: string; pin: string; certFile: string };
  return { url: g.publicUrl, pin: g.pin, caPem: readFileSync(g.certFile, "utf8") };
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The one line an operator pastes on a new Mac. */
export function installCommand(endpoint: PublicEndpoint, token: string): string {
  const curl = endpoint.pin ? `curl -fsSL --pinnedpubkey ${quote(endpoint.pin)} -k` : "curl -fsSL";
  return `${curl} ${quote(`${endpoint.url}/install.sh`)} | bash -s -- ${quote(token)}`;
}

export interface AgentBundle {
  body: Buffer;
  sha256: string;
  playwrightVersion: string;
}

let bundle: Promise<AgentBundle> | null = null;

/** bap-agent as one ESM file; playwright-core stays external and is installed by npm on the Mac. */
export function agentBundle(): Promise<AgentBundle> {
  bundle ??= (async () => {
    const { build } = await import("esbuild");
    const out = await build({
      entryPoints: [join(AGENT_DIR, "src/cli.ts")],
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      target: "node24",
      external: ["playwright-core", "esbuild"],
      // Bundled CommonJS dependencies (ws) call require(); ESM output has none of its own.
      banner: { js: "import { createRequire as __bapRequire } from 'node:module'; const require = __bapRequire(import.meta.url);" },
      logLevel: "silent",
    });
    const body = Buffer.from(out.outputFiles[0]!.contents);
    // The version browser-adapters is built and tested against, not whatever else the workspace has.
    const adapters = join(AGENT_DIR, "../../packages/browser-adapters/package.json");
    const playwrightVersion = (createRequire(adapters)("playwright-core/package.json") as { version: string }).version;
    return { body, sha256: createHash("sha256").update(body).digest("hex"), playwrightVersion };
  })().catch((e) => {
    bundle = null; // a failed build is retried on the next request
    throw e;
  });
  return bundle;
}

/** The installer the one-line command pipes into bash. It carries no secrets: the invitation comes as $1. */
export function installScript(opts: { endpoint: PublicEndpoint; nodeVersion: string; playwrightVersion: string }): string {
  const vars = [`SERVER=${quote(opts.endpoint.url)}`, `PIN=${quote(opts.endpoint.pin ?? "")}`, `NODE_VERSION=${quote(opts.nodeVersion)}`, `PW_VERSION=${quote(opts.playwrightVersion)}`].join("\n");
  return `#!/bin/bash
# BAP agent installer. Everything goes to ~/.bap: no sudo, no Homebrew. Safe to run again.
set -euo pipefail
${vars}
TOKEN="\${1:-}"
BAP="\${BAP_HOME:-$HOME/.bap}"

bold() { printf '\\n\\033[1m%s\\033[0m\\n' "$*"; }
ok() { printf '  \\033[32m✓\\033[0m %s\\n' "$*"; }
warn() { printf '  \\033[33m!\\033[0m %s\\n' "$*"; }
die() { printf '\\n  \\033[31m✗ %s\\033[0m\\n\\n' "$*" >&2; exit 1; }
fetch() { if [ -n "$PIN" ]; then curl -fsS --pinnedpubkey "$PIN" -k "$@"; else curl -fsS "$@"; fi; }

[ -n "$TOKEN" ] || die "Нет приглашения. Скопируйте команду целиком: панель → Агенты → Подключить Mac."
[ "$(uname -s)" = Darwin ] || [ -n "\${BAP_ALLOW_NON_MAC:-}" ] || die "Установщик рассчитан на macOS."
case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) die "Неизвестная архитектура $(uname -m)." ;; esac
mkdir -p "$BAP/bin" "$BAP/app"

bold "1/6 Сервер BAP"
fetch "$SERVER/api/v1/health" >/dev/null || die "Сервер $SERVER не отвечает. Проверьте интернет и что на сервере запущен pnpm gateway."
if [ -n "$PIN" ]; then
  fetch "$SERVER/api/v1/agents/install/ca" -o "$BAP/server-ca.pem"
  export NODE_EXTRA_CA_CERTS="$BAP/server-ca.pem"
fi
ok "$SERVER отвечает, соединение зашифровано"

bold "2/6 Node.js"
NODE="\${BAP_NODE:-$BAP/node/bin/node}"
if [ -z "\${BAP_NODE:-}" ] && { [ ! -x "$NODE" ] || [ "$("$NODE" -p process.versions.node)" != "$NODE_VERSION" ]; }; then
  dist="node-v$NODE_VERSION-darwin-$ARCH"
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$dist.tar.gz" -o "$tmp/$dist.tar.gz" || die "Не удалось скачать Node.js $NODE_VERSION."
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " $dist.tar.gz\\$" | (cd "$tmp" && shasum -a 256 -c - >/dev/null) || die "Контрольная сумма Node.js не совпала."
  rm -rf "$BAP/node" && mkdir -p "$BAP/node" && tar -xzf "$tmp/$dist.tar.gz" -C "$BAP/node" --strip-components 1
  rm -rf "$tmp"
fi
ok "Node.js $("$NODE" -p process.versions.node)"

bold "3/6 Агент"
fetch -D "$BAP/app/.headers" "$SERVER/api/v1/agents/install/bundle?token=$TOKEN" -o "$BAP/app/bap-agent.mjs.new" \\
  || die "Приглашение недействительно: оно одноразовое и живёт 15 минут. Создайте новое в панели."
expected="$(grep -i '^x-bap-sha256:' "$BAP/app/.headers" | tr -d '\\r' | awk '{print $2}')"
actual="$(shasum -a 256 "$BAP/app/bap-agent.mjs.new" | awk '{print $1}')"
[ -n "$expected" ] && [ "$expected" = "$actual" ] || die "Агент повреждён при загрузке, запустите команду ещё раз."
mv "$BAP/app/bap-agent.mjs.new" "$BAP/app/bap-agent.mjs"
rm -f "$BAP/app/.headers"
printf '{"private":true,"type":"module","dependencies":{"playwright-core":"%s"}}\\n' "$PW_VERSION" > "$BAP/app/package.json"
if [ -z "\${BAP_SKIP_NPM:-}" ]; then
  (cd "$BAP/app" && PATH="$(dirname "$NODE"):$PATH" npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null) || die "npm install не удался: проверьте интернет."
fi
cat > "$BAP/bin/bap-agent" <<WRAPPER
#!/bin/bash
export BAP_AGENT_DATA="$BAP"
[ -f "$BAP/server-ca.pem" ] && export NODE_EXTRA_CA_CERTS="$BAP/server-ca.pem"
exec "$NODE" "$BAP/app/bap-agent.mjs" "\\$@"
WRAPPER
chmod +x "$BAP/bin/bap-agent"
ok "установлен в $BAP"

bold "4/6 Регистрация"
registered=""
if [ -f "$BAP/agent.json" ]; then
  # 0: the server accepts this Mac's key; 2: it was revoked; anything else: cannot tell, do not touch it.
  set +e; "$BAP/bin/bap-agent" check --server "$SERVER" >/dev/null 2>&1; key=$?; set -e
  case "$key" in
    0) registered=1; ok "этот Mac уже зарегистрирован, приглашение не понадобилось" ;;
    2) warn "ключ этого Mac отозван, регистрирую заново"; rm -f "$BAP/agent.json" ;;
    *) die "Не удалось проверить регистрацию этого Mac на сервере, запустите команду ещё раз." ;;
  esac
fi
if [ -z "$registered" ]; then
  "$BAP/bin/bap-agent" enroll --server "$SERVER" --token "$TOKEN" \${BAP_NAME:+--name "$BAP_NAME"} || die "Регистрация не прошла (сообщение выше)."
  ok "зарегистрирован"
fi

bold "5/6 Питание: Mac не засыпает"
POWER_CMD="pmset -a sleep 0 disksleep 0 autorestart 1 womp 1 && pmset -a disablesleep 1"
if [ -n "\${BAP_SKIP_POWER:-}" ]; then
  warn "настройка питания пропущена (BAP_SKIP_POWER)"
elif ! [ -r /dev/tty ]; then
  warn "нет терминала для пароля: выполните позже  sudo sh -c '$POWER_CMD'"
else
  printf '  Один раз нужен пароль администратора этого Mac, чтобы отключить сон.\n'
  if sudo -v < /dev/tty; then
    sudo pmset -a sleep 0 disksleep 0 autorestart 1 womp 1 >/dev/null
    # Laptops: keep running with the lid closed. Desktops have no such setting; that is fine.
    sudo pmset -a disablesleep 1 >/dev/null 2>&1 || true
    ok "сон отключён, в том числе с закрытой крышкой; после сбоя питания Mac включится сам"
  else
    warn "пароль не введён, сон не отключён. Позже:  sudo sh -c '$POWER_CMD'"
  fi
fi

bold "6/6 Автозапуск"
if [ -n "\${BAP_NO_LAUNCHAGENT:-}" ]; then
  warn "автозапуск пропущен (BAP_NO_LAUNCHAGENT)"
else
  "$BAP/bin/bap-agent" install-launchagent --load >/dev/null || die "Автозапуск не включился (сообщение выше). Выйдите из учётной записи macOS и войдите снова, затем повторите команду."
  for _ in $(seq 1 30); do grep -q "connected:" "$BAP/agent.log" 2>/dev/null && break; sleep 1; done
  grep -q "connected:" "$BAP/agent.log" 2>/dev/null && ok "агент запущен и на связи с сервером" || warn "агент запущен, но ещё не подключился: смотрите $BAP/agent.log"
fi

bold "Готово"
if curl -fsS -m 3 "http://127.0.0.1:41234/sessions" >/dev/null 2>&1; then
  ok "Linken Sphere отвечает на порту 41234"
else
  warn "Linken Sphere не отвечает на 127.0.0.1:41234: запустите LS, войдите и включите Settings → Network → Api port = 41234"
fi
pmset -g batt 2>/dev/null | grep -q "Battery Power" && warn "Mac работает от батареи: подключите зарядку, иначе он разрядится и выключится"
printf '\\n  Mac появится в панели в разделе «Агенты». Логи: %s/agent.log\\n\\n' "$BAP"
`;
}
