# Debugging — ollama-dev

This extension is designed to be debuggable via its dedicated output channel.

## First stop: Output channel

Open the **Output** panel and select **Ollama Dev**.

You should see logs for:

- activation
- endpoint selection
- model discovery
- request streaming
- tool-call assembly

## Common issues

### No models appear

1. Confirm the provider registered (look for activation logs).
2. Confirm connection mode:
   - `ollamaDev.connectionMode = local` → verify `ollamaDev.localEndpoint`
   - `ollamaDev.connectionMode = ssh` → verify `ollamaDev.remoteHost` and that the tunnel connected
3. Check endpoint health:
   - Ollama: `GET /api/tags`
   - llama.cpp: `GET /v1/models`

### SSH tunnel connects but requests fail

- Ensure the remote host has Ollama listening on the configured `ollamaDev.remotePort`.
- Ensure the local forwarded port (`ollamaDev.localPort`) is free.
- Look for `SshTunnel` logs (spawn output, port check results).

### Tool calls missing or malformed

Tool calling can fail for several reasons:

- The model omits `function.name` or streams arguments in fragments.
- Some models emit tool calls in a non-native format (e.g. Qwen3-Coder XML).

Relevant implementation:

- Tool coercion/inference: `src/tools/toolCallUtils.ts`
- Qwen3-Coder parsing: `src/ollama/qwen3CoderToolParser.ts`

If you suspect a regression:

- Add/adjust unit tests for tool-call coercion.

### Streaming parse issues (partial chunks)

Streaming data can arrive split across arbitrary chunk boundaries.

We avoid “split on newline and parse immediately” in favor of incremental parsers:

- NDJSON: `NdjsonStreamParser` (Ollama)
- SSE `data:`: `SseDataJsonStreamParser` (llama.cpp)

Tests live in `src/test/streamParsers.test.ts`.

## Tips

- Prefer reproducing issues with the smallest prompt/tool set possible.
- When adding new logging, keep it in the output channel (not UI).
- If you add any **user-visible** UI strings, localize with `vscode.l10n.t`.
