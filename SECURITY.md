# Security Policy

The ErgoSum proxy sits between your client (Claude Code, Codex, etc.) and `api.anthropic.com`. It has access to your API traffic and, when the OAuth bridge is enabled, reads your Claude Code OAuth token from the macOS keychain. Security issues here are taken seriously.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Email **security@ergosum.cc** with:

- A description of the issue and its impact
- Steps to reproduce
- The commit or release version affected
- Any proof-of-concept code (if applicable)

You will receive an acknowledgement within **3 business days** and a status update within **7 days**. We aim to publish a fix or mitigation within **90 days** of the initial report. Reporters are credited in the release notes unless they request otherwise.

## Scope

In scope:

- The proxy binary in this repository (`src/`)
- The protocol it speaks to `https://ergosum.cc/api/cli/proxy/*`
- Dependency vulnerabilities that affect end users

Out of scope:

- The ErgoSum server (report via the same address; handled as a separate channel)
- Issues in Claude Code, Anthropic's API, or macOS keychain itself
- Social-engineering attacks against individual users
- Denial-of-service against `localhost:49200` from a malicious local process (the proxy is bound to localhost and includes a request-shape check; local attackers are assumed to have broader capabilities already)

## Coordinated disclosure

We prefer coordinated disclosure. If you publish independently before a fix ships, please give at least 30 days' notice after the initial report so users have a chance to upgrade.
