# Multi-Agent Gateway

Official **Kimi Code Web 0.38.0** is the only UI. Claude, Codex, and Grok
speak Kimi's kap-server protocol behind it. The official `web-dist` is never
edited — a SHA-checked injection (`web-extension/boot.js` + `style.css`) adds
the agent switcher.

## What you get

- One sidebar: **Kimi / Claude / Codex / Grok**
- Sessions prefixed `claude_`, `codex_`, `grok_` stay on their native runtimes
- Kimi sessions proxy to a local `kimi web` when `GATEWAY_KIMI` is not `off`
- When local CLIs are missing, `GATEWAY_DEMO` seeds preview transcripts so you
  can switch agents and inspect conversations

## Protocol map

| Agent | Native runtime | Notes |
| --- | --- | --- |
| Kimi | kap-server REST + WS | lossless proxy |
| Claude | `claude -p` stream-json | stdin stays open for steer / `control_request`; fork via `--resume --fork-session` |
| Codex | `codex app-server` JSON-RPC | compact / fork / undo / review |
| Grok | `grok agent stdio` (ACP) | headless `grok -p` is fallback only |

This gateway does **not** wrap cloud subscriptions as HTTP API keys. Each
agent uses the CLI already signed in on the machine.

## Env

| Variable | Default | Meaning |
| --- | --- | --- |
| `GATEWAY_PORT` | `58629` | API listen port |
| `GATEWAY_HOST` | `127.0.0.1` | API bind address |
| `GATEWAY_TOKEN` | `admin123` | `#token=` / Bearer |
| `GATEWAY_KIMI` | spawn | `off` = no Kimi child; `/auth` still ready |
| `GATEWAY_DEMO` | on when kimi=off | `on` / `off` — seed preview sessions |
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
