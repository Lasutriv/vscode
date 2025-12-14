# Architecture — ollama-dev

This document explains the major components, boundaries, and data flow.

## Goals

- Keep `src/extension.ts` **thin** (activation + wiring only).
- Keep protocol logic isolated in **backends**.
- Make streaming/tool-call handling **testable** (chunk boundaries, partial frames).
- Centralize connection state and commands in a **connection manager**.

## High-level data flow

1. **Activation** (`src/extension.ts`)
   - Creates the output channel
   - Creates `SshTunnel`
   - Creates `OllamaLanguageModelProvider`
   - Creates `OllamaConnectionManager`
   - Registers `vscode.lm.registerLanguageModelChatProvider('ollama', …)`

2. **Connection selection** (`src/connection/OllamaConnectionManager.ts`)
   - Reads configuration
   - Connects via SSH tunnel or uses local endpoint
   - Emits connection-changed events

3. **Provider orchestration** (`src/provider/OllamaLanguageModelProvider.ts`)
   - Implements VS Code LM provider methods
   - Performs model discovery
   - Routes chat requests to the correct backend

4. **Backend protocol adapters** (`src/backends/*`)
   - Transform VS Code messages → backend request shapes
   - Stream responses back as `BackendPart` (`text`, `thinking`, `toolCall`)

5. **Streaming parsers** (`src/streaming/streamParsers.ts`)
   - NDJSON incremental parser for Ollama
   - SSE `data:` incremental parser for llama.cpp

6. **Tool-call utilities** (`src/tools/toolCallUtils.ts`)
   - Normalize tool schemas (including `explanation` handling)
   - Infer tool names from argument fragments
   - Coerce malformed/partial tool args to an object the tool can accept

## Modules and responsibilities

### `src/extension.ts`
**Owns:** DI/wiring and registration.

**Must not own:** protocol parsing, tool-call logic, streaming parsing.

### `src/connection/OllamaConnectionManager.ts`
**Owns:**
- Connection mode (`ssh` vs `local`) behavior
- UI prompts & command handlers
- Applying configuration to the provider

### `src/provider/OllamaLanguageModelProvider.ts`
**Owns:**
- Provider-facing orchestration
- Backend selection strategy
- Translating backend stream parts into VS Code response parts

### `src/backends/OllamaBackend.ts`
**Owns:**
- Ollama endpoints: `/api/tags`, `/api/chat`
- NDJSON streaming consumption
- Ollama tool-call variants + Qwen3-Coder XML tool-call parsing

### `src/backends/LlamaCppBackend.ts`
**Owns:**
- llama.cpp endpoints: `/v1/models`, `/v1/chat/completions`
- SSE streaming consumption
- OpenAI-like tool-call streaming assembly

### `src/common/httpClient.ts`
**Owns:**
- HTTP request helper
- Streaming request helper with cancellation support

## Extension points

- Adding a new backend/protocol:
  1. Add a new backend in `src/backends/`
  2. Keep the backend surface consistent (`listModels`, `provideChatResponse`)
  3. Add parser tests if the protocol streaming format differs
  4. Update provider routing logic

- Adding model-specific handling:
  - Prefer a focused helper module under `src/ollama/` or `src/llamaCpp/`.

## Localization

- Runtime UI strings: use `vscode.l10n.t(...)`.
- Manifest strings: use `%key%` placeholders in `package.json` and define values in `package.nls.json`.

Output channel logs do not need localization.
