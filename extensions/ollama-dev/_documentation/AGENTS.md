# ollama-dev — Documentation Notes for Agents

This folder is the preferred place for maintainability docs.

If you introduce new architecture (e.g. connection manager, backend abstraction, test harness), add or update:

- `ARCHITECTURE.md` — responsibilities, module boundaries, and extension points
- `DEBUGGING.md` — how to reproduce common failures (SSH tunnel, streaming, tool calls)
- `TESTING.md` — how to run relevant tests and what they cover

## When to update docs

Update these docs when you:

- add a backend/protocol
- change request/stream parsing
- change tool-call assembly/coercion
- add or rename user-facing commands/settings

Keep docs short and actionable.

Keep docs short and actionable.
