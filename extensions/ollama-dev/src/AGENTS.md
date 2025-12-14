# ollama-dev/src — Agent Guidelines

Keep `extension.ts` as a thin entrypoint.

## Responsibilities

- `extension.ts`
  - Create output channel
  - Wire commands
  - Register the LM provider
  - Delegate connection behavior to dedicated components

- Provider modules
  - Streaming and tool-call handling
  - Backend selection
  - Model discovery

## Adding new behavior

Before adding code to `extension.ts`, ask:

1) Is this activation/registration/command wiring? If not, it likely belongs elsewhere.
2) Can this be expressed as a small module with unit tests?

## Logging vs UI strings

- Output channel logs can be plain strings.
- Any user-visible UI text should be localized:
  - Runtime UI: `vscode.l10n.t(...)`
  - Manifest strings: `package.nls.json`

## Testing expectations

Prefer tests for:

- Chunk parsing (partial frames, multiple frames per chunk)
- Tool-call assembly across chunk boundaries
- Model-specific parsing (e.g. Qwen XML)

## Maintainability docs

See `../_documentation/` for architectural and debugging notes.
