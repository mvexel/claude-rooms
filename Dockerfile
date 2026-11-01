# Minimal runtime for `rooms serve` (and the workers it starts) on a single host.
# node, claude and rooms are NOT in the image: they come from the bind-mounted
# home (~/.local/node/bin, ~/.local/bin), see compose.production.yml.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git gh jq curl rsync procps ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# Runs as the host user's UID/GID (compose `user:`), so no account is created.
CMD ["rooms", "serve", "--port", "8788", "--host", "127.0.0.1"]
