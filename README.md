# ErgoSum Proxy

The local proxy that sits between Claude Code (or any Anthropic/OpenAI-compatible client) and `api.anthropic.com`. Intercepts `/v1/messages`, asks the ErgoSum server to trim the message array and assemble a context fragment, then forwards the result upstream.

This is the client-side binary. It is intentionally thin — no retrieval logic, no tagging schema, no context templates live in this code. All of that runs server-side at `ergosum.cc` (or wherever you point `ERGOSUM_URL`).

## Why this is open source

You are piping every Claude Code request through this proxy. That's a trust ask. Open-sourcing the binary lets you audit exactly what the proxy does to your traffic before you run it.

What you'll find in the audit:

- Only hits `api.anthropic.com` and the public `/api/cli/proxy/*` endpoints on your ErgoSum server
- No hardcoded tokens, keys, or URLs beyond those two
- Token read from local `conf` storage (`~/.config/ergosum/`) or `ERGOSUM_TOKEN` env var
- Optional OAuth bridge reads Claude Code's own token from macOS keychain via the official `security` command
- All file writes are to user-local paths (`~/.config/ergosum/`, `~/.claude/settings.json`, `~/.codex/config.toml`, `~/Library/LaunchAgents/`)
- Server failures (unreachable, timeout >800ms) fall through to passthrough mode — the original request is forwarded untrimmed
- Defensive hardening: rejects requests missing `anthropic-version` header, validates path prefix, bounded timeouts on every network call

## Install

```bash
npm install -g @ergosum/proxy
```

## Use

```bash
# Start the proxy in the background (port 49200)
ergosum-proxy

# Check status
ergosum-proxy status

# Tail live logs
ergosum-proxy logs

# Pause trimming (proxy stays running, becomes a passthrough — no dropped connection)
ergosum-proxy stop

# Install as a macOS LaunchAgent so it survives reboots
ergosum-proxy install

# Remove everything
ergosum-proxy uninstall
```

The proxy sets `ANTHROPIC_BASE_URL=http://localhost:49200` in `~/.claude/settings.json` while running and clears it on uninstall.

## Config

| Env var | Default | Purpose |
| --- | --- | --- |
| `ERGOSUM_URL` | `https://ergosum.cc` | Base URL for the ErgoSum server |
| `ERGOSUM_TOKEN` | (read from `conf`) | Auth token for the server |

If neither a token nor a reachable server is available, the proxy runs in passthrough mode — every request is forwarded untrimmed to `api.anthropic.com`.

## How it works

```
┌─────────────┐    /v1/messages     ┌─────────────┐    POST /api/cli/proxy/prepare    ┌──────────────┐
│ Claude Code │ ──────────────────► │   Proxy     │ ────────────────────────────────► │ ErgoSum API  │
│             │                     │ :49200      │ ◄──────────────── trimmed msgs ── │              │
└─────────────┘                     └─────────────┘                                   └──────────────┘
                                           │
                                           │  forward (patched SSE input_tokens)
                                           ▼
                                    ┌─────────────┐
                                    │ api.anthropic.com │
                                    └─────────────┘
```

1. Client sends `POST /v1/messages` to `localhost:49200`
2. Proxy calls `POST /api/cli/proxy/prepare` on the ErgoSum server (800ms budget — passthrough on timeout)
3. Server returns a trimmed `messages` array + a `system_fragment` to append
4. Proxy appends the fragment to the request's `system` field
5. Proxy forwards the trimmed request to `api.anthropic.com`
6. Proxy patches `input_tokens` in the SSE `message_start` event so Claude Code's auto-compact counter reflects the trimmed size

## Modes

- `inject` (default) — priority trim + retrieval + system fragment injection
- `smart` — GPT-based compression of old turns server-side

Set via `ergosum-proxy --mode inject|smart`.

## Security notes

- The proxy validates every request has an `anthropic-version` header to raise the bar against local process abuse
- Only paths matching `/v1/*` are forwarded; all others return 403
- Upstream host is hardcoded to `api.anthropic.com` — no SSRF surface
- All network calls have bounded timeouts
- The proxy never logs request bodies; only request counts and token estimates to `/tmp/ergosum-proxy.log`

## License

MIT. See [LICENSE](./LICENSE).

## Related

- Main ErgoSum site: https://ergosum.cc
- MCP server: (coming soon)
- CLI: (installed separately)
