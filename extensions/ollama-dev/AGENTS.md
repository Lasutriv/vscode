# Ollama Dev Extension — Agent Notes

This extension integrates Ollama/llama.cpp chat backends with VS Code's Language Model API.

These notes are intended for AI coding agents and human contributors. The goal is to keep `src/extension.ts` thin and keep backend/protocol logic isolated and testable.

## Repository and build context

- Repository: VS Code (`microsoft/vscode`-style mono-repo).
- Extension location: `extensions/ollama-dev/`.
- TypeScript compilation typically runs via the VS Code watch tasks.

## Design goals

- Keep `src/extension.ts` as wiring only (activation, commands, registration, configuration).
- Keep protocol/backends in dedicated modules (HTTP, parsing, streaming).
- Prefer small, cohesive modules over a single "provider mega-file".
- Add tests for parsing/streaming edge cases (chunk boundaries, partial JSON lines, SSE frames).

## Where things live

- `src/extension.ts`
  - Activation + command registration.
  - Creates `SshTunnel` and `OllamaLanguageModelProvider`.

- `src/provider/OllamaLanguageModelProvider.ts`
  - VS Code LM provider implementation.
  - Converts VS Code messages to backend requests.

- `src/ssh/SshTunnel.ts`
  - SSH tunnel lifecycle + port verification.

- `src/common/*`
  - Shared types and utilities.

- `src/ollama/*`
  - Ollama/model-specific helpers (e.g. Qwen tool-call parsing).

- `src/llamaCpp/*`
  - llama.cpp helpers (e.g. alternation constraints).

## Coding rules (important)

- Tabs for indentation (VS Code repo convention).
- User-facing UI strings must be localized:
  - Runtime UI: `vscode.l10n.t(...)`
  - Manifest (commands/settings): `%key%` placeholders in `package.json` with values in `package.nls.json`
- Prefer minimal, targeted changes and keep public behavior stable.

## Streaming + tools (high-value test targets)

- `src/streaming/streamParsers.ts` contains incremental parsers for NDJSON and SSE.
- `src/tools/toolCallUtils.ts` centralizes tool schema normalization and argument coercion.

## Contribution workflow hints

- Prefer incremental commits:
  1) mechanical refactor (move code),
  2) behavior changes,
  3) tests.
- When introducing new architecture, add a short doc under `_documentation/` describing responsibilities and extension points.
