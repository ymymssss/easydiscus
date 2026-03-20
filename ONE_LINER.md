# One-liner install (Termux)

Replace `<REPO_SSH_URL>` with your repo SSH URL.

```sh
pkg update -y && pkg install -y git && rm -rf termux-forum && git clone <REPO_SSH_URL> termux-forum && cd termux-forum && bash install.sh --start --host=0.0.0.0 --port=3000
```
