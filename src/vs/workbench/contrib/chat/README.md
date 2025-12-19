# Chat Workbench Contrib

This folder contains the core implementation of the VS Code workbench chat experience (UI, model, and supporting services).

## Internal docs

- [Context usage indicator (two rings)](./docs/context-usage-indicator.md)
  - Estimated next-request token usage ring next to the Tools icon.
  - Model/provider-reported last-request token usage ring (with an opt-in Copilot output-log fallback).
