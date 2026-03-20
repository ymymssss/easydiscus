#!/usr/bin/env bash
set -euo pipefail

say() {
  printf "%s\n" "$*"
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

HOST_DEFAULT="${HOST:-127.0.0.1}"
PORT_DEFAULT="${PORT:-3000}"

say "== EasyDiscus: update =="

if ! command -v git >/dev/null 2>&1; then
  say "git not found."
  if command -v pkg >/dev/null 2>&1; then
    pkg update -y
    pkg install -y git
  else
    say "Please install git first."
    exit 1
  fi
fi

if [ -d .git ]; then
  say "Pulling latest code..."
  git pull --ff-only || {
    say "";
    say "Update failed: local changes or diverged history.";
    say "If you have local changes, commit/stash them first.";
    exit 1;
  }
else
  say "WARNING: not a git checkout (.git missing). Skipping git pull."
fi

say "Ensuring dependencies..."
bash install.sh

say ""
say "Update complete."
say "Start: HOST=$HOST_DEFAULT PORT=$PORT_DEFAULT bash start.sh"
