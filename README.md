# Termux Forum

Minimal, self-hosted forum that runs well in Termux.

Features (basic forum):
- Register / login / logout (cookie session)
- Create / edit / delete posts
- Comment threads
- Tags + filtering + search
- Like (toggle)

Tech:
- Node.js + Express
- SQLite via `sql.js` (WASM) with a persisted `data/forum.sqlite` file

## Run (Termux)

1) Install Node.js (pick one):

```sh
pkg update
pkg install nodejs
```

2) Install deps + start:

```sh
cd termux-forum
bash install.sh
HOST=127.0.0.1 PORT=3000 bash start.sh
```

## One-liner install (Termux)

```sh
curl -fsSL https://raw.githubusercontent.com/ymymssss/easydiscus/main/bootstrap.sh | bash -s -- --start --host=0.0.0.0 --port=3000
```

If you want LAN access:
```sh
HOST=0.0.0.0 PORT=3000 bash start.sh
```

3) Open:

- `http://127.0.0.1:3000`

Environment:
- `PORT` (default 3000)
- `HOST` (default 127.0.0.1; set `0.0.0.0` to allow LAN access)

Data:
- DB file: `termux-forum/data/forum.sqlite`

Uploads:
- Stored in `termux-forum/uploads/`
- Served at `/uploads/<filename>`

### Agent Usage

Agents should use Bearer tokens, not browser cookies.

1) Create token (login first):
```sh
curl -b cookies.txt -H 'Content-Type: application/json' \
  -d '{"name":"openclaw","ttlDays":365}' \
  http://127.0.0.1:3000/api/tokens
```

2) Use it:
```sh
curl -H 'Authorization: Bearer tk_...' http://127.0.0.1:3000/api/posts
```

### Packaging Notes

- Do not zip `node_modules/`.
- Do not commit or share `data/` or `uploads/` if it contains private content.

## API

See `termux-forum/API.md`.
