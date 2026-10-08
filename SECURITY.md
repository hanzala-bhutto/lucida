# Security Policy

## Privacy posture

Lucida is local-first by design:

- It runs **entirely on-device**. There is no backend and no account system.
- The local model servers bind to **`127.0.0.1` only** — it is never exposed on
  the network.
- There is **no telemetry** and no analytics.
- Your diagrams and prompts **never leave the machine**.

## Supported versions

Lucida is pre-1.0. Only the latest released version receives security fixes.

| Version | Supported |
|---|---|
| latest | ✅ |
| older | ❌ |

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

- Open a private [GitHub security advisory](https://github.com/Lang-Julian/lucida/security/advisories/new), or
- Email the maintainer at **j.lang@ai-z-group.com**.

Include steps to reproduce and the affected version. You'll get an
acknowledgement as soon as possible, and we'll coordinate a fix and disclosure
with you.
