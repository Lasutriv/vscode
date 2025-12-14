# Ollama Dev (SSH Remote Provider)

This is a development VS Code extension that registers a **Language Model chat provider** and routes requests to either:

- **Ollama** (`/api/tags`, `/api/chat`, NDJSON streaming)
- **llama.cpp server** (`/v1/models`, `/v1/chat/completions`, SSE `data:` streaming)

It supports:

- Local or SSH-tunneled endpoints
- Streaming text + thinking parts
- Tool calling (with backend-specific parsing quirks handled)

## Quick start

### Configure connection

Settings (see `package.json` contributions):

- `ollamaDev.connectionMode`: `ssh` or `local`
- `ollamaDev.localEndpoint`: e.g. `http://127.0.0.1:11434` (Ollama) or `http://127.0.0.1:8081` (llama.cpp)
- `ollamaDev.remoteHost`: e.g. `user@192.168.1.100`
- `ollamaDev.remotePort`: defaults to `11434`
- `ollamaDev.localPort`: defaults to `43134` (to avoid colliding with a local Ollama)

### Commands

- **Ollama: Connect to Remote** — prompts for host (if missing) and opens the SSH tunnel
- **Ollama: Disconnect** — closes the SSH tunnel
- **Ollama: Reconnect** — disconnect + connect flow
- **Ollama: Change Remote Host** — clears saved host, then prompts
- **Ollama: Toggle Local / SSH** — switches connection mode

## Where to look

- Wiring/activation: `src/extension.ts`
- Connection lifecycle + commands: `src/connection/OllamaConnectionManager.ts`
- Provider implementation + backend selection: `src/provider/OllamaLanguageModelProvider.ts`
- Backends:
  - Ollama: `src/backends/OllamaBackend.ts`
  - llama.cpp: `src/backends/LlamaCppBackend.ts`
- Streaming parsers (unit-tested): `src/streaming/streamParsers.ts`
- Tool-call utilities (unit-tested): `src/tools/toolCallUtils.ts`

## Documentation

See `_documentation/`:

- `ARCHITECTURE.md`
- `DEBUGGING.md`
- `TESTING.md`

## Notes

- Output channel logs are intentionally verbose to diagnose streaming/tool-call issues.
- User-facing UI strings must be localized. Runtime UI uses `vscode.l10n.t(...)`, and manifest strings live in `package.nls.json`.
