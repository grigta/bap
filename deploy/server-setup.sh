#!/bin/bash
# Installs or updates BAP on an Ubuntu server, as root:  ssh <server> 'bash -s' < deploy/server-setup.sh
# Touches only its own things: /opt/bap, the bap user, bap-*.service, the bap role and database in
# PostgreSQL, one ufw rule for its port, /etc/cron.d/bap-backup. Safe to run again: that is the update.
set -euo pipefail

BAP=/opt/bap
PORT="${BAP_PORT:-9443}"
PUBLIC_HOST="${BAP_PUBLIC_HOST:-$(curl -fsS -4 https://api.ipify.org)}"
REPO="${BAP_REPO:-https://github.com/grigta/bap.git}"
NODE_VERSION=24.19.0
WEED_VERSION=4.50

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
as_bap() { runuser -u bap -- env HOME="$BAP" PATH="$BAP/node/bin:/usr/bin:/bin" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@"; }

say "User and directories"
id bap >/dev/null 2>&1 || useradd --system --home-dir "$BAP" --shell /usr/sbin/nologin bap
install -d -o bap -g bap -m 750 "$BAP" "$BAP/bin" "$BAP/config" "$BAP/data" "$BAP/data/seaweed" "$BAP/backups" "$BAP/tls"

say "Node.js $NODE_VERSION"
if [ "$("$BAP/node/bin/node" -p process.versions.node 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  tmp="$(mktemp -d)"; dist="node-v$NODE_VERSION-linux-x64"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$dist.tar.xz" -o "$tmp/$dist.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " $dist.tar.xz\$" | (cd "$tmp" && sha256sum -c - >/dev/null)
  rm -rf "$BAP/node" && mkdir -p "$BAP/node" && tar -xJf "$tmp/$dist.tar.xz" -C "$BAP/node" --strip-components 1 && rm -rf "$tmp"
  chown -R bap:bap "$BAP/node"
fi

say "SeaweedFS $WEED_VERSION (artifact storage, 127.0.0.1 only)"
if [ ! -x "$BAP/bin/weed" ] || ! "$BAP/bin/weed" version 2>/dev/null | grep -q "$WEED_VERSION"; then
  tmp="$(mktemp -d)"; base="https://github.com/seaweedfs/seaweedfs/releases/download/$WEED_VERSION/linux_amd64.tar.gz"
  curl -fsSL "$base" -o "$tmp/weed.tar.gz"
  [ "$(md5sum "$tmp/weed.tar.gz" | awk '{print $1}')" = "$(curl -fsSL "$base.md5" | awk '{print $1}')" ]
  tar -xzf "$tmp/weed.tar.gz" -C "$BAP/bin" weed && rm -rf "$tmp"
  chown bap:bap "$BAP/bin/weed"
fi

say "PostgreSQL (127.0.0.1 only)"
command -v psql >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql >/dev/null; }
systemctl enable --now postgresql >/dev/null
ENV="$BAP/config/env"
if [ ! -f "$ENV" ]; then
  db_password="$(openssl rand -hex 24)"; operator_password="$(openssl rand -base64 18 | tr -d '/+=')"
  runuser -u postgres -- psql -qc "CREATE ROLE bap LOGIN PASSWORD '$db_password'"
  runuser -u postgres -- psql -qc "CREATE DATABASE bap OWNER bap"
  cat > "$ENV" <<EOF
DATABASE_URL=postgres://bap:$db_password@127.0.0.1:5432/bap
S3_ENDPOINT=http://127.0.0.1:8333
S3_BUCKET=bap
S3_ACCESS_KEY_ID=bap
S3_SECRET_ACCESS_KEY=bap
HOST=0.0.0.0
PORT=$PORT
TLS_CERT_FILE=$BAP/tls/cert.pem
TLS_KEY_FILE=$BAP/tls/key.pem
BAP_SECURE_COOKIES=true
BAP_PUBLIC_URL=https://$PUBLIC_HOST:$PORT
BAP_PUBLIC_CERT_FILE=$BAP/tls/cert.pem
BAP_WEB_DIR=$BAP/app/apps/web/dist
BAP_OPERATOR_LOGIN=operator
BAP_OPERATOR_PASSWORD=$operator_password
BACKUP_DIR=$BAP/backups
EOF
  chown bap:bap "$ENV"; chmod 600 "$ENV"
  echo "OPERATOR_PASSWORD_ONCE=$operator_password"
fi

say "TLS certificate for $PUBLIC_HOST"
if [ ! -f "$BAP/tls/cert.pem" ]; then
  san="DNS:localhost,IP:127.0.0.1"; [[ "$PUBLIC_HOST" =~ ^[0-9.]+$ ]] && san="IP:$PUBLIC_HOST,$san" || san="DNS:$PUBLIC_HOST,$san"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 -subj "/CN=BAP Control Plane" \
    -addext "subjectAltName=$san" -keyout "$BAP/tls/key.pem" -out "$BAP/tls/cert.pem" 2>/dev/null
  chown bap:bap "$BAP/tls/"*.pem; chmod 600 "$BAP/tls/key.pem"
fi

say "Code"
if [ -d "$BAP/app/.git" ]; then as_bap git -C "$BAP/app" pull -q --ff-only; else as_bap git clone -q "$REPO" "$BAP/app"; fi
as_bap corepack enable --install-directory "$BAP/node/bin" pnpm
(cd "$BAP/app" && as_bap pnpm install --frozen-lockfile --reporter=silent && as_bap pnpm --filter @bap/web build >/dev/null)
echo "$(as_bap git -C "$BAP/app" log -1 --format='%h %s')"

say "Claude Code (recording and healing of recipes, ADR-0026)"
as_bap "$BAP/node/bin/npm" install -g --prefix "$BAP/node" --silent @anthropic-ai/claude-code >/dev/null
echo "$("$BAP/node/bin/claude" --version)"
upsert() { grep -q "^$1=" "$ENV" && sed -i "s|^$1=.*|$1=$2|" "$ENV" || echo "$1=$2" >> "$ENV"; }
upsert BAP_CLAUDE_BIN "$BAP/node/bin/claude"
upsert BAP_LLM_DIR "$BAP/data/llm"
# The token from `claude setup-token` is passed once as an environment variable of this script, never in the repo.
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then upsert CLAUDE_CODE_OAUTH_TOKEN "$CLAUDE_CODE_OAUTH_TOKEN"; echo "model token stored in $ENV"; fi
grep -q "^CLAUDE_CODE_OAUTH_TOKEN=" "$ENV" || echo "no model token: recording and healing are off until CLAUDE_CODE_OAUTH_TOKEN is set"

say "Services"
cat > /etc/systemd/system/bap-seaweed.service <<EOF
[Unit]
Description=BAP artifact storage (SeaweedFS, 127.0.0.1 only)
After=network.target

[Service]
User=bap
ExecStart=$BAP/bin/weed server -ip=127.0.0.1 -ip.bind=127.0.0.1 -dir=$BAP/data/seaweed -s3 -s3.port=8333 -volume.max=0
Restart=always
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$BAP/data
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/bap-control-plane.service <<EOF
[Unit]
Description=BAP Control Plane (https://$PUBLIC_HOST:$PORT)
After=network.target postgresql.service bap-seaweed.service
Requires=bap-seaweed.service

[Service]
User=bap
WorkingDirectory=$BAP/app
EnvironmentFile=$BAP/config/env
ExecStart=$BAP/node/bin/node apps/control-plane/src/main.ts
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$BAP
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable bap-seaweed bap-control-plane >/dev/null 2>&1
# Storage first: the Control Plane checks its bucket on start.
systemctl restart bap-seaweed
for _ in $(seq 1 60); do curl -fsS -o /dev/null http://127.0.0.1:8333/ 2>/dev/null && break; sleep 1; done
systemctl restart bap-control-plane

say "Firewall: port $PORT"
ufw status | grep -q "^$PORT/tcp .*ALLOW" || ufw allow "$PORT/tcp" comment "BAP Control Plane" >/dev/null

say "Daily backup (03:15)"
cat > /etc/cron.d/bap-backup <<EOF
15 3 * * * bap cd $BAP/app && set -a && . $BAP/config/env && $BAP/node/bin/node apps/control-plane/src/backup-cli.ts backup >> $BAP/backups/backup.log 2>&1
EOF

say "Check"
for _ in $(seq 1 30); do curl -fsS -k "https://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS -k "https://127.0.0.1:$PORT/api/v1/health" && echo && echo "BAP is up: https://$PUBLIC_HOST:$PORT"
