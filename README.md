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

### Request flow

Every request goes through the same decision tree. Any passthrough branch means the request is forwarded to `api.anthropic.com` **untouched** — no trimming, no injection, no modification beyond the hop itself.

```mermaid
flowchart TD
    A[Client: POST /v1/messages] --> B{anthropic-version<br/>header present?}
    B -->|no| X[400 — reject]
    B -->|yes| C{path starts with /v1/?}
    C -->|no| Y[403 — forbidden]
    C -->|yes| D{/v1/messages<br/>or count_tokens?}
    D -->|no| F1[passthrough]
    D -->|yes| E{proxy paused?}
    E -->|yes| F2[passthrough]
    E -->|no| G{thinking-state<br/>in request?}
    G -->|yes| F3[passthrough]
    G -->|no| H{token +<br/>server reachable?}
    H -->|no| F4[passthrough]
    H -->|yes| I[POST /api/cli/proxy/prepare<br/>800ms budget]
    I --> J{server responded<br/>in time?}
    J -->|no| F5[passthrough]
    J -->|yes| K[trim messages<br/>+ append system_fragment]
    K --> L[forward to api.anthropic.com]
    L --> M[patch input_tokens<br/>in SSE message_start]
    M --> N[stream response to client]
    F1 --> L0[forward to<br/>api.anthropic.com]
    F2 --> L0
    F3 --> L0
    F4 --> L0
    F5 --> L0
    L0 --> N

    classDef pass fill:#f0f0f0,stroke:#888,color:#333
    classDef reject fill:#fee,stroke:#c66,color:#933
    classDef active fill:#e8f4ff,stroke:#4a9,color:#046
    class F1,F2,F3,F4,F5,L0 pass
    class X,Y reject
    class I,K,L,M active
```

### Prepare exchange

The only content-aware call the proxy makes. Everything it sends, everything it gets back:

```mermaid
sequenceDiagram
    participant Client as Claude Code
    participant Proxy as ergosum-proxy
    participant Server as ErgoSum server
    participant Anthropic as api.anthropic.com

    Client->>Proxy: POST /v1/messages<br/>{messages, system, ...}
    Proxy->>Server: POST /api/cli/proxy/prepare<br/>{messages, window_tokens,<br/>last_user_text, session_id}
    Note over Server: priority-aware pair drop<br/>+ semantic retrieval<br/>+ archive dropped turns
    Server-->>Proxy: {messages, system_fragment,<br/>trimmed_count, retrieved_sections}
    Note over Proxy: append system_fragment<br/>to request.system
    Proxy->>Anthropic: POST /v1/messages (trimmed)
    Anthropic-->>Proxy: SSE stream
    Note over Proxy: patch input_tokens<br/>in message_start event
    Proxy-->>Client: SSE stream (patched)
```

### Lifecycle

```mermaid
stateDiagram-v2
    [*] --> NotRunning
    NotRunning --> Running: ergosum-proxy
    NotRunning --> LaunchAgent: ergosum-proxy install
    Running --> Paused: ergosum-proxy stop
    Paused --> Running: ergosum-proxy (resume)
    Running --> NotRunning: ergosum-proxy uninstall
    Paused --> NotRunning: ergosum-proxy uninstall
    LaunchAgent --> NotRunning: ergosum-proxy uninstall

    note right of Running
        ANTHROPIC_BASE_URL set
        trimming active
    end note
    note right of Paused
        proxy still up
        passthrough mode
        Claude Code stays connected
    end note
    note right of LaunchAgent
        survives reboot
        starts on login
        --persistent flag on
    end note
```

`stop` and `uninstall` are different on purpose: killing the proxy while Claude Code has `ANTHROPIC_BASE_URL` pointed at it would break the live session. `stop` instead flips the proxy into passthrough mode so the connection stays open while trimming pauses.

### Auth modes

The proxy touches one header: `x-api-key`. Default mode forwards it unchanged. `--oauth-bridge` swaps it with the Claude Code OAuth token read from the macOS keychain — nothing else.

```mermaid
flowchart LR
    subgraph Default["Default"]
        direction LR
        C1[Client] -->|"x-api-key: sk-ant-…"| P1[Proxy]
        P1 -->|"x-api-key: sk-ant-… (unchanged)"| A1[api.anthropic.com]
    end
    subgraph Bridge["--oauth-bridge"]
        direction LR
        C2[Client] -->|"x-api-key: sk-ant-…"| P2[Proxy]
        K[(macOS Keychain<br/>Claude Code-credentials)] -.->|security find-generic-password| P2
        P2 -->|"x-api-key: oauth-…"| A2[api.anthropic.com]
    end
```

`Authorization: Bearer …` headers (OpenAI, Codex, any other provider) are never touched in either mode.

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

## Contributing

PRs welcome. Before submitting:

- Run `npm run typecheck` and `npm run build` locally
- For non-trivial changes, open an issue first to discuss the approach
- Keep the proxy thin — retrieval logic, tagging schemas, and context templates belong server-side, not in this binary

## Security

See [SECURITY.md](./SECURITY.md). Report vulnerabilities privately to `security@ergosum.cc`.

## License

MIT. See [LICENSE](./LICENSE).

## Related

- Main ErgoSum site: https://ergosum.cc
- MCP server: (coming soon)
- CLI: (installed separately)
