# OpenRouter Stalker

Monitors OpenRouter for new models and pages.

## Run locally

```bash
bun install
bun run start
```

## Docker

```bash
docker build -t stalker .
docker run stalker
```

## GitHub Actions

Runs every minute. Add `NTFY_TOPIC` secret in repo Settings → Actions.
