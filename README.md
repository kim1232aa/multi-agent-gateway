# Multi-Agent Gateway

Official **Kimi Code Web 2.6.2** is the only UI. Claude, Codex, Grok, and Pi
speak Kimi's kap-server protocol behind it. The official `web-dist` is never
edited — a SHA-checked injection (`web-extension/boot.js` + `style.css`) adds
the agent switcher and capability gating.

## What you get

- One sidebar: **Kimi / Claude / Codex / Grok / Pi**
- Sessions prefixed `claude_`, `codex_`, `grok_`, `pi_` stay on their native runtimes
- Kimi sessions proxy to a local `kimi web` when `GATEWAY_KIMI` is not `off`
- Missing CLI or handshake failure is a real error (500), not a fake catalog
- Official first-run wizard is left alone; injection only adds the agent switcher

## Protocol map

| Agent | Native runtime | Notes |
| --- | --- | --- |
| Kimi | kap-server REST + WS | lossless proxy (`2.6.2` turns/items WS + legacy transcript v2 compat) |
| Claude | `claude -p` stream-json (`2.1.325+`) | stdin stays open for steer / `control_request`; fork via `--resume --fork-session`; dynamic CLI handshake catalog |
| Codex | `codex app-server` JSON-RPC (`0.169.0+`) | compact / fork / undo / review / goal; server-request & collaboration items |
| Grok | `grok agent stdio` ACP (`1.0.77`) | headless `grok -p` fallback with `--prompt-file`; supports compact / undo / fork / goal |
| Pi | `pi --mode rpc` (`@earendil-works/pi-coding-agent@1.5.2`) | strict LF JSONL; settles on `agent_settled`; compact / fork / clone / question UI; no tool approval or native undo |

This gateway does **not** wrap cloud subscriptions as HTTP API keys, and never
refreshes CLI OAuth tokens on behalf of the user. Each agent uses the CLI
already installed and signed in on the machine.

## Env

| Variable | Default | Meaning |
| --- | --- | --- |
| `GATEWAY_PORT` | `58629` | API listen port |
| `GATEWAY_HOST` | `127.0.0.1` | API bind address |
| `GATEWAY_TOKEN` | generated per install (`0600` `<settingsDir>/gateway.token`) | `#token=` / Bearer |
| `GATEWAY_KIMI` | spawn | `off` = no Kimi child; `/auth` still ready |
| `GATEWAY_DEMO` | off | `on` / `1` — opt-in preview transcripts only; never a fake `/models` catalog |
| `GATEWAY_PROVIDERS` | detected | comma list for the switcher |
| `CLAUDE_BIN` / `GROK_BIN` / `CODEX_PATH` / `PI_BIN` | PATH / `~/.local/bin/*` | binary overrides |

## Layout

- `web-dist/` — official Kimi Web (do not edit)
- `web-extension/` — injection only
- `web-origin-manifest.json` — SHA-256 of official assets
- `server/` — kap-server compatible gateway

## Web UI slash commands

- `/skills` merges disk skills (`project`/`user`), agent prompt commands (`builtin`), and parameter hints (`argument_hint`) while deduplicating against Kimi Web 2.6.2's built-in menu.
- Interactive CLI commands are adapted into Web UI responses or protocol RPCs (`/help`, `/diff`, `/status`, `/permissions`, `/skills`, Codex `/review` / `/goal` / `/terminals` / `/terminals-clean`, Pi `/auto-compact` / `/tree` / `/copy` / `/thinking` / `/session` / `/name`, Grok `/always-approve` / `/session-info`), while terminal-screen-only commands are hidden or cleanly explained.

## Tests

```sh
npm test --prefix server
```
