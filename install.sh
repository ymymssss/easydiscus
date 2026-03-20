#!/usr/bin/env bash
set -euo pipefail

say() {
  printf "%s\n" "$*"
}

die() {
  say "ERROR: $*" >&2
  exit 1
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

AUTO_START=0
HOST_DEFAULT="127.0.0.1"
PORT_DEFAULT="3000"

for arg in "$@"; do
  case "$arg" in
    --start)
      AUTO_START=1
      ;;
    --host=*)
      HOST_DEFAULT="${arg#--host=}"
      ;;
    --port=*)
      PORT_DEFAULT="${arg#--port=}"
      ;;
    -h|--help)
      say "Usage: bash install.sh [--start] [--host=127.0.0.1] [--port=3000]"
      exit 0
      ;;
    *)
      die "Unknown argument: $arg"
      ;;
  esac
done

say "== Termux Forum: install =="

if command -v pkg >/dev/null 2>&1; then
  say "Detected Termux (pkg found)."
  say "Installing prerequisites (nodejs)..."
  pkg update -y
  pkg install -y nodejs
elif command -v apt-get >/dev/null 2>&1; then
  say "Detected apt-get. Installing prerequisites (nodejs, npm)..."
  sudo apt-get update -y
  sudo apt-get install -y nodejs npm
else
  say "No supported package manager found (expected pkg or apt-get)."
  say "Please install Node.js (>= 18) and npm, then re-run: bash install.sh"
  exit 1
fi

command -v node >/dev/null 2>&1 || die "node not found after install"
command -v npm >/dev/null 2>&1 || die "npm not found after install"

say "Node: $(node -v)"
say "npm:  $(npm -v)"

mkdir -p data uploads

say "Installing npm dependencies (production only)..."
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

say ""
say "Install complete."
say ""
say "Start server:"
say "  HOST=$HOST_DEFAULT PORT=$PORT_DEFAULT bash start.sh"
say ""
say "Open in browser:"
say "  http://$HOST_DEFAULT:$PORT_DEFAULT"
say ""
say "LAN access (same Wi-Fi):"
say "  HOST=0.0.0.0 PORT=$PORT_DEFAULT bash start.sh"

if [ "$AUTO_START" -eq 1 ]; then
  say ""
  say "Auto-starting..."
  HOST="$HOST_DEFAULT" PORT="$PORT_DEFAULT" bash start.sh
fi
