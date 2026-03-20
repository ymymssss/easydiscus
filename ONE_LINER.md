# One-liner install (Termux)

Bootstrap from GitHub (recommended):

```sh
curl -fsSL https://raw.githubusercontent.com/ymymssss/easydiscus/main/bootstrap.sh | bash -s -- --start --host=0.0.0.0 --port=3000
```

If `curl` is missing:
```sh
pkg update -y && pkg install -y curl && curl -fsSL https://raw.githubusercontent.com/ymymssss/easydiscus/main/bootstrap.sh | bash -s -- --start --host=0.0.0.0 --port=3000
```
