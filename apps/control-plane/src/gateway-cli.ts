// pnpm gateway: makes the Control Plane on this Mac reachable for agents on other Macs, without a
// server. TLS terminates here, so the bore.pub relay only forwards encrypted bytes:
//   agent ──https──▶ bore.pub:<port> ──tcp──▶ bore client ──▶ TLS proxy 127.0.0.1:3443 ──▶ Control Plane 127.0.0.1:3000
// The certificate is self-signed; the one-line installer pins its public key and the agent trusts it.
import { execFileSync, spawn } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { createServer } from "node:tls";
import { stripVTControlCharacters } from "node:util";
import { gatewayFile } from "./agent-install.ts";

const RELAY = process.env.BAP_GATEWAY_RELAY ?? "bore.pub";
const UPSTREAM = Number(process.env.PORT ?? 3000);
const TLS_PORT = Number(process.env.BAP_GATEWAY_TLS_PORT ?? 3443);
const file = gatewayFile();
const dir = dirname(file);
const certFile = join(dir, "tls", "cert.pem");
const keyFile = join(dir, "tls", "key.pem");

const log = (line: string) => console.log(`[gateway] ${line}`);

function ensureCertificate() {
  if (existsSync(certFile) && existsSync(keyFile)) return;
  mkdirSync(dirname(certFile), { recursive: true, mode: 0o700 });
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "3650", "-subj", "/CN=BAP Control Plane",
      "-addext", `subjectAltName=DNS:${RELAY},DNS:localhost,IP:127.0.0.1`, "-keyout", keyFile, "-out", certFile],
    { stdio: "ignore" },
  );
  log(`created a certificate for ${RELAY}: ${certFile}`);
}

/** curl --pinnedpubkey form of the certificate's public key. */
const pinOf = (pem: string) => `sha256//${createHash("sha256").update(new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" })).digest("base64")}`;

interface Saved {
  port: number;
}
const saved: Saved = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { port: 20_000 + Math.floor(Math.random() * 40_000) };

ensureCertificate();
const cert = readFileSync(certFile, "utf8");
const publicUrl = `https://${RELAY}:${saved.port}`;
writeFileSync(file, JSON.stringify({ port: saved.port, publicUrl, pin: pinOf(cert), certFile }, null, 2) + "\n", { mode: 0o600 });

// TLS in front of the plain-HTTP Control Plane; WebSocket upgrades pass through as bytes.
createServer({ cert, key: readFileSync(keyFile) }, (client) => {
  const upstream = connect(UPSTREAM, "127.0.0.1");
  client.pipe(upstream).pipe(client);
  for (const s of [client, upstream]) s.on("error", () => client.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
}).listen(TLS_PORT, "127.0.0.1", () => log(`TLS on 127.0.0.1:${TLS_PORT} → Control Plane 127.0.0.1:${UPSTREAM}`));

/** bore keeps the same public port; after a crash the relay may hold it for a while, so retry. */
function relay() {
  const bore = spawn("bore", ["local", String(TLS_PORT), "--to", RELAY, "--port", String(saved.port)], { stdio: ["ignore", "pipe", "pipe"] });
  const show = (chunk: Buffer) => {
    for (const line of String(chunk).split("\n").filter(Boolean)) {
      if (line.includes("listening at")) log(`agents connect to ${publicUrl}`);
      else if (/error|in use/i.test(line)) log(`bore: ${stripVTControlCharacters(line).trim()}`);
    }
  };
  bore.stdout.on("data", show);
  bore.stderr.on("data", show);
  bore.on("error", (e) => {
    log(`cannot start bore (${e.message}): brew install bore-cli`);
    process.exit(1);
  });
  bore.on("exit", (code) => {
    log(`bore exited (${code}); retrying in 15 s`);
    setTimeout(relay, 15_000);
  });
}
relay();
log(`new Macs: panel → Агенты → Подключить Mac. Settings: ${file}`);
