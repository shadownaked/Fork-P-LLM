

# ProxyLLM

A local Electron app that captures browser sessions for LLM sites and exposes OpenAI-compatible APIs for local clients. It includes a control panel for managing sites, inspecting captured requests, and testing models.

Language: English | Chinese (`README.zh-CN.md`)

## Features

- OpenAI-compatible API: `POST /v1/chat/completions`, `GET /v1/models`, plus Anthropic native `POST /v1/messages`.
- Multi-site control panel: add/remove sites, open/refresh windows, inspect requests, and pick credentials.
- Credential capture via Electron `webRequest`, CDP (HTTP + WebSocket), and optional local MITM proxy.
- Adapter system for non-OpenAI protocols, including built-in special adapters.
- OAuth device-code/PKCE flows for Gemini, OpenAI Codex, and Qwen.
- Optional API key auth, model aliases, dynamic model discovery, and token refresh helpers.
- Claude Code takeover/restore to point Claude CLI at the local proxy.
- Local persistence with redacted logging.

## How It Works

1. The app opens a site in an isolated Electron window and monitors traffic.
2. Capture rules extract authorization headers, cookies, and session IDs.
3. Models are detected from request/response payloads when possible.
4. The local API server maps OpenAI-format requests to site-specific adapters.
5. Responses stream back as OpenAI-compatible SSE or via WebSocket adapters.

## Quick Start

Install dependencies:

```bash
npm install
npm --prefix renderer install
```

Build UI and start the app:

```bash
npm --prefix renderer run build
npm run build
npm run start
```

Development (live UI reload):

```bash
npm --prefix renderer run dev
npm run dev
```

The app opens an Electron control panel. The API server binds to `127.0.0.1:8080` by default.

## Usage

1. Open the app and add a target site.
2. Click Open to launch the target site window.
3. Interact with the site to capture requests.
4. Use Requests to select a captured request as credentials.
5. Copy a model name from the UI and call the local API.

Example: list models

```bash
curl http://127.0.0.1:8080/v1/models
```

Example: chat completion

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"your-model-name","messages":[{"role":"user","content":"Hello"}]}'
```

If `requireApiKey` is enabled, include `Authorization: Bearer <key>` on `/v1/*` requests.

## API Endpoints

- `GET /health` - health check
- `GET /status` - site/model/credential summary
- `POST /v1/chat/completions` - OpenAI-compatible chat
- `GET /v1/models` - model list (site IDs + dynamic models)
- `POST /v1/messages` - Anthropic native messages
- `GET /oauth/providers` - list OAuth providers
- `POST /oauth/start` - start OAuth flow
- `GET /oauth/callback/:provider` - OAuth callback
- `GET /oauth/status` - OAuth session status
- `POST /oauth/poll` - device-code polling

## Configuration

`config/rules.json` controls the API server:

- `apiServerPort`, `apiServerHost`
- `requireApiKey`, `apiKeys`
- `modelAliases`
- `defaultTargetUrl`

Sites and credentials are stored locally. In development, data is saved under `data/` and `logs/`; in packaged builds, data is stored under Electron `userData`.

## Adapters

Built-in adapters:

- `template` (generic HTTP API bridge)
- `openai` (site-specific configuration)

Add new adapters under `src/adapters/special/` with a default export to auto-register.

## Data & Privacy

- The proxy and API server are local by default (binds to `127.0.0.1`).
- Proxy MITM certificates are trusted only inside Electron windows, not system-wide.
- Credentials are captured from your own browser sessions and stored locally.
- Respect the target site terms and only use this tool on accounts you control.

## Claude Code Takeover

Use the header UI to connect Claude Code to this proxy by updating `~/.claude/settings.json` (with backup). Use Disconnect to restore.

## Development & Tests

- Build main: `npm run build`
- Lint: `npm run lint`
- Unit tests: `npm test`
- E2E proxy test: `npm run test:e2e` (requires running app + captured credentials)

## License

MIT
