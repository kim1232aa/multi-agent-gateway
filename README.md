# Multi-Agent Gateway

Official **Kimi Code Web 0.40.1** is the only UI. Claude, Codex, and Grok
speak Kimi's kap-server protocol behind it. The official `web-dist` is never
edited — a SHA-checked injection (`web-extension/boot.js` + `style.css`) adds
the agent switcher.

## What you get

- One sidebar: **Kimi / Claude / Codex / Grok**
- Sessions prefixed `claude_`, `codex_`, `grok_` stay on their native runtimes
- Kimi sessions proxy to a local `kimi web` when `GATEWAY_KIMI` is not `off`
- Missing CLI or handshake failure is a real error (500), not a fake catalog
- Official first-run wizard is left alone; injection only adds the agent switcher

## Protocol map

| Agent | Native runtime | Notes |
| --- | --- | --- |
| Kimi | kap-server REST + WS | lossless proxy |
| Claude | `claude -p` stream-json | stdin stays open for steer / `control_request`; fork via `--resume --fork-session` (no dummy user line); model selector is the CLI handshake catalog |
| Codex | `codex app-server` JSON-RPC | compact / fork / undo / review |
| Grok | `grok agent stdio` (ACP) | headless `grok -p` is per-turn fallback only; ACP is retried on the next turn |

This gateway does **not** wrap cloud subscriptions as HTTP API keys. Each
agent uses the CLI already signed in on the machine.

## Env

| Variable | Default | Meaning |
| --- | --- | --- |
| `GATEWAY_PORT` | `58629` | API listen port |
| `GATEWAY_HOST` | `127.0.0.1` | API bind address |
| `GATEWAY_TOKEN` | `admin123` | `#token=` / Bearer |
| `GATEWAY_KIMI` | spawn | `off` = no Kimi child; `/auth` still ready |
| `GATEWAY_DEMO` | off | `on` / `1` — opt-in preview transcripts only; never a fake `/models` catalog |
| `GATEWAY_PROVIDERS` | detected | comma list for the switcher |
| `CLAUDE_BIN` / `GROK_BIN` / `CODEX_PATH` | PATH | binary overrides |

## Layout

- `web-dist/` — official Kimi Web (do not edit)
- `web-extension/` — injection only
- `web-origin-manifest.json` — SHA-256 of official assets
- `server/` — kap-server compatible gateway

## Tests

```sh
npm test --prefix server
```
