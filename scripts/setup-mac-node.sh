#!/usr/bin/env bash
# Prepares this Mac as a BAP agent node. Run from the repository as the user the agent will run as:
#
#   scripts/setup-mac-node.sh [--server <url> --token <invitation> [--name <name>]] [--no-bore] [--dry-run]
#
# Safe to re-run. Asks for the sudo password once (sleep settings, SSH hardening).
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER="" TOKEN="" NAME="" BORE=1 DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --no-bore) BORE=0; shift ;;
    --dry-run) DRY=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

LS_APP="/Applications/Linken Sphere 2.app"
LS_API="${BAP_LS_API_URL:-http://127.0.0.1:41234}"
UID_GUI="gui/$(id -u)"
BORE_PLIST="$HOME/Library/LaunchAgents/com.bap.bore.plist"
WARNINGS=()

step() { printf '\n==> %s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then echo "  [dry-run] $*"; else "$@"; fi; }
warn() { WARNINGS+=("$*"); echo "  ! $*"; }
ok() { echo "  ✓ $*"; }

[ "$(uname -s)" = Darwin ] || { echo "macOS only" >&2; exit 1; }

step "Node.js and dependencies"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 24 ] || { echo "Node.js >= 24 required (found ${NODE_MAJOR}): brew install node" >&2; exit 1; }
ok "node $(node -v)"
if [ -d node_modules ]; then ok "dependencies installed"; else
  PNPM=$(node -p 'require("./package.json").packageManager')
  run npx -y "$PNPM" install --frozen-lockfile
fi

step "Sleep and SSH (sudo)"
[ "$DRY" = 1 ] || sudo -v
run sudo pmset -a sleep 0 disksleep 0
run sudo pmset -a autorestart 1 2>/dev/null || true # absent on laptops
SSHD_DROPIN=/etc/ssh/sshd_config.d/010-bap-no-password.conf
if [ -s "$HOME/.ssh/authorized_keys" ]; then
  # Loaded before 100-macos.conf: sshd keeps the first value it reads.
  run sudo sh -c "printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' > $SSHD_DROPIN"
  ok "SSH password login disabled (key login only)"
else
  warn "no ~/.ssh/authorized_keys: SSH password login left enabled to avoid a lockout"
fi

step "Linken Sphere"
if [ -d "$LS_APP" ]; then
  if osascript -e 'tell application "System Events" to get the name of every login item' | grep -q "Linken Sphere 2"; then
    ok "already a login item"
  else
    run osascript -e "tell application \"System Events\" to make login item at end with properties {path:\"$LS_APP\", hidden:true}"
    ok "added to login items"
  fi
  if curl -sf -m 3 -o /dev/null "$LS_API/sessions"; then ok "Local API answers at $LS_API"; else
    warn "Local API not answering at $LS_API: open LS, sign in with autologin, Settings → Network → Api port"
  fi
else
  warn "Linken Sphere 2 is not installed"
fi

if [ "$BORE" = 1 ]; then
  step "SSH tunnel (bore)"
  if command -v bore >/dev/null; then
    # No fixed port: bore.pub keeps a dropped port for ~15 min after a reboot.
    run launchctl bootout "$UID_GUI/com.bap.bore" 2>/dev/null || true
    run rm -f "$BORE_PLIST"
    run plutil -create xml1 "$BORE_PLIST"
    run plutil -insert Label -string com.bap.bore "$BORE_PLIST"
    run plutil -insert ProgramArguments -array "$BORE_PLIST"
    for a in "$(command -v bore)" local 22 --to bore.pub; do run plutil -insert ProgramArguments -string "$a" -append "$BORE_PLIST"; done
    run plutil -insert RunAtLoad -bool true "$BORE_PLIST"
    run plutil -insert KeepAlive -bool true "$BORE_PLIST"
    run plutil -insert ThrottleInterval -integer 10 "$BORE_PLIST"
    run plutil -insert StandardOutPath -string "$HOME/bore.log" "$BORE_PLIST"
    run plutil -insert StandardErrorPath -string "$HOME/bore.log" "$BORE_PLIST"
    [ "$DRY" = 1 ] || : > "$HOME/bore.log"
    run launchctl bootstrap "$UID_GUI" "$BORE_PLIST"
    if [ "$DRY" = 0 ]; then
      sleep 4
      PORT=$(grep -o 'bore.pub:[0-9]*' "$HOME/bore.log" | tail -1 || true)
      if [ -n "$PORT" ]; then ok "listening at $PORT (changes after every reboot: see ~/bore.log)"; else warn "bore did not report a port: see ~/bore.log"; fi
    fi
  else
    warn "bore not installed (brew install bore-cli); skipped"
  fi
fi

step "BAP agent"
if [ -n "$TOKEN" ]; then
  [ -n "$SERVER" ] || { echo "--token needs --server" >&2; exit 2; }
  run node apps/mac-agent/src/cli.ts enroll --server "$SERVER" --token "$TOKEN" ${NAME:+--name "$NAME"}
fi
if [ -f "${BAP_AGENT_DATA:-$HOME/.bap}/agent.json" ] || [ "$DRY" = 1 ]; then
  run node apps/mac-agent/src/cli.ts install-launchagent --load
else
  warn "agent not enrolled: re-run with --server <url> --token <invitation from the panel>"
fi

step "Login after reboot"
if [ "$(fdesetup status)" = "FileVault is Off." ]; then ok "FileVault off"; else
  warn "FileVault is on: automatic login is impossible (System Settings → Privacy & Security → FileVault → Turn Off)"
fi
AUTOLOGIN=$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || true)
if [ "$AUTOLOGIN" = "$(whoami)" ]; then ok "automatic login as $AUTOLOGIN"; else
  warn "automatic login is not set to $(whoami) (System Settings → Users & Groups → Automatically log in as)"
fi

echo
if [ ${#WARNINGS[@]} -eq 0 ]; then echo "Node ready. Check: sudo reboot → the agent is ONLINE in the panel."; else
  echo "Done with ${#WARNINGS[@]} item(s) to fix by hand:"
  printf '  - %s\n' "${WARNINGS[@]}"
  exit 1
fi
