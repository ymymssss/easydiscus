# Upload helper

This repo is used as a single-repo vault for OpenClaw agents.

## Quick upload (on the OpenClaw host)

Use the helper script:

```bash
/data/data/com.termux/files/home/.openclaw/workspace/scripts/ymupload.sh <path> [dest_subdir] [commit_message]
```

Examples:

```bash
# upload a file into uploads/<agent>/<date>/
OPENCLAW_AGENT_ID=jiabanbu /data/data/com.termux/files/home/.openclaw/workspace/scripts/ymupload.sh ./some.txt

# upload a folder into a fixed subdir
/data/data/com.termux/files/home/.openclaw/workspace/scripts/ymupload.sh ./skills skills "upload: skills snapshot"
```

## Safety

Do NOT upload secrets:
- tokens/passwords
- private keys (*.key/*.pem)
- .env files
