# Custom LLM Tokenizer Compatibility

This custom VS Code build supports local or extension-contributed language models that do not advertise a Copilot-native tokenizer.

## Why this exists

Copilot Chat only has local BPE counters for `cl100k_base` and `o200k_base`. Some custom model providers, including local Qwen-family deployments, either omit tokenizer metadata or advertise a tokenizer name that Copilot does not know. Previously that could fail tool calls with:

```text
Unknown tokenizer: undefined
```

## Compatibility behavior

- `TokenizerProvider.acquireTokenizer` now treats missing tokenizer metadata as `cl100k_base`.
- Unknown tokenizer metadata also falls back to `cl100k_base` instead of throwing.
- Extension-contributed chat endpoints read `languageModel.capabilities.tokenizer` or `languageModel.tokenizer` when present, and otherwise default to `cl100k_base`.
- The built-in `ollama-dev` provider advertises `capabilities.tokenizer: 'cl100k_base'` for Ollama and llama.cpp models.
- The bundled GitHub Copilot LLM Gateway extension advertises `tokenizer: 'cl100k_base'`, adds the same tokenizer value to `capabilities`, and maps unknown model families to `qwen` instead of `llm-gateway`.

`cl100k_base` is a compatibility counter, not the exact tokenizer for Qwen. Exact Qwen token counting should be added as a separate tokenizer implementation if prompt budgeting needs to match the model byte-for-byte.

## Files changed

- `extensions/copilot/src/platform/tokenizer/node/tokenizer.ts`
- `extensions/copilot/src/platform/endpoint/vscode-node/extChatEndpoint.ts`
- `extensions/copilot/dist/extension.js`
- `src/vs/workbench/api/common/extHostLanguageModels.ts`
- `src/vs/workbench/contrib/chat/common/languageModels.ts`
- `src/vscode-dts/vscode.d.ts`
- `src/vscode-dts/vscode.proposed.chatProvider.d.ts`
- `src/vscode-dts/vscode.proposed.languageModelCapabilities.d.ts`
- `extensions/ollama-dev/src/backends/OllamaBackend.ts`
- `extensions/ollama-dev/src/backends/LlamaCppBackend.ts`
- `extensions/ollama-dev/out/backends/OllamaBackend.js`
- `extensions/ollama-dev/out/backends/LlamaCppBackend.js`
- `extensions/github-copilot-llm-gateway/package.json`
- `extensions/github-copilot-llm-gateway/out/extension.js`
