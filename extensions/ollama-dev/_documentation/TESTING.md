# Testing — ollama-dev

This extension has unit tests focused on the most failure-prone areas:

- Streaming chunk parsing
- Tool-call coercion and schema normalization

## Running tests

From the VS Code repo root:

- Compile the extension:
  - TypeScript project: `extensions/ollama-dev/tsconfig.json`
  - Output: `extensions/ollama-dev/out/`

- Run Mocha tests from compiled output:
  - Tests: `extensions/ollama-dev/out/test/**/*.test.js`

## What’s covered

### Streaming parsers

- `src/streaming/streamParsers.ts`
- Tests: `src/test/streamParsers.test.ts`

These tests cover:

- NDJSON lines split across chunks
- SSE `data:` frames split across chunks
- malformed payload tolerance

### Tool-call utilities

- `src/tools/toolCallUtils.ts`
- Tests: `src/test/toolCallUtils.test.ts`

These tests cover:

- Tool-name inference from key overlap
- Coercion from strings/unknown values to objects
- Schema normalization (e.g. auto-requiring `explanation`)

## Adding new tests

If you add:

- a new backend streaming format
- a new model-specific tool-call format

…please add at least one test that simulates chunk-splitting in the middle of the relevant token/JSON boundary.
