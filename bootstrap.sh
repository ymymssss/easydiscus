#!/usr/bin/env bash
set -euo pipefail

say() {
  printf "%s\n" "$*"
}

die() {
  say "ERROR: $*" >&2
  exit 1
}

REPO_URL_DEFAULT="https://github.com/ymymssss/easydiscus.git"
DIR_DEFAULT="$HOME/termux-forum"
HOST_DEFAULT="0.0.0.0"
PORT_DEFAULT="3000"
AUTO_START=0

REPO_URL="$REPO_URL_DEFAULT"
DIR="$DIR_DEFAULT"
HOST="$HOST_DEFAULT"
PORT="$PORT_DEFAULT"

for arg in "$@"; do
  case "$arg" in
    --start)
      AUTO_START=1
      ;;
    --repo=*)
      REPO_URL="${arg#--repo=}"
      ;;
    --dir=*)
      DIR="${arg#--dir=}"
      ;;
    --host=*)
      HOST="${arg#--host=}"
      ;;
    --port=*)
      PORT="${arg#--port=}"
      ;;
    -h|--help)
      say "Usage: curl -fsSL <url>/bootstrap.sh | bash -s -- [--start] [--repo=...] [--dir=...] [--host=...] [--port=...]"
      exit 0
      ;;
    *)
      die "Unknown argument: $arg"
      ;;
  esac
done

say "== EasyDiscus: bootstrap =="

if ! command -v pkg >/dev/null 2>&1; then
  die "This bootstrap is for Termux (pkg not found)."
fi

say "Ensuring git..."
pkg update -y
pkg install -y git

if [ -d "$DIR/.git" ]; then
  say "Updating existing checkout: $DIR"
  cd "$DIR"
  git pull --ff-only || {
    say "";
    say "Update failed: local changes or diverged history.";
    say "Fix: cd '$DIR' && git status && (git stash || commit) then retry.";
    exit 1;
  }
else
  say "Cloning to: $DIR"
  rm -rf "$DIR"
  git clone "$REPO_URL" "$DIR"
  cd "$DIR"
fi

say "Installing dependencies..."
bash install.sh

say ""
say "Installed: $DIR"
say "Open: http://127.0.0.1:$PORT (if HOST=127.0.0.1)"
say "LAN:  http://<phone-ip>:$PORT (if HOST=0.0.0.0)"

if [ "$AUTO_START" -eq 1 ]; then
  say ""
  say "Starting..."
  HOST="$HOST" PORT="$PORT" bash start.sh
else
  say ""
  say "Start: HOST=$HOST PORT=$PORT bash start.sh"
fi
