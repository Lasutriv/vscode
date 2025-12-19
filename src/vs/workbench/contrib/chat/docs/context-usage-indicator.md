# Chat Context Usage Indicator (Two Rings)

This document describes how the chat input toolbar renders and populates the **context usage indicator rings** that appear next to the **Tools** icon.

There are **two rings**:

1. **Estimated next-request usage** (left ring)
   - A *best-effort estimate* of how many tokens the **next request** would consume if you pressed Enter right now.
   - Includes chat history + attachments/instructions + mode instructions + current draft.

2. **Model/provider-reported last-request usage** (right ring)
   - The token usage for the **last completed request**, as reported by the provider/model (when available).
   - When the provider does not persist usage in response metadata, an **opt-in debug fallback** can attempt to derive usage by parsing the **GitHub Copilot Chat Output** channel logs.

---

## UI: where and how it renders

**File:** `src/vs/workbench/contrib/chat/browser/actions/chatToolActions.ts`

The rings are rendered inside the existing chat input toolbar entry for **Configure Tools…** (the Tools icon). The rendering class builds two small SVGs:

- `.chat-context-usage-indicator` for the estimated ring
- `.chat-context-usage-indicator.chat-last-request-usage-indicator` for the last-request ring

Each ring is an SVG with:

- a track circle (`.chat-context-usage-track`)
- a progress circle (`.chat-context-usage-progress`) using `stroke-dasharray`/`stroke-dashoffset`

The progress circle uses a fixed circumference for `r=6`:

- $C = 2\pi r = 2\pi\cdot 6$

and updates `stroke-dashoffset = C * (1 - percent)`.

### Color bands

**File:** `src/vs/workbench/contrib/chat/browser/media/chat.css`

The ring’s progress color changes via CSS classes:

- `level-ok` (default) → blue (`--vscode-charts-blue`)
- `level-caution` → yellow (`--vscode-charts-yellow`)
- `level-warning` → orange (`--vscode-charts-orange`)
- `over-limit` → error red (`--vscode-problemsErrorIcon-foreground`)
- `unavailable` (last-request ring only) → muted grey

The threshold logic currently lives in `chatToolActions.ts`:

- caution: $\ge 70\%$ and $< 90\%$
- warning: $\ge 90\%$
- over-limit: tokens > max

### Hover + breakdown toggle

Both rings use the default hover delegate (`getDefaultHoverDelegate('mouse')`) to show a hover with:

- headline (tokens used / max + remaining)
- percent
- optional breakdown

A hover action toggles breakdown:

- `workbench.action.chat.contextUsage.toggleBreakdown`
- `workbench.action.chat.lastRequestUsage.toggleBreakdown`

These are used only as identifiers for the hover UI action; they are not registered as separate commands.

### Interaction: preventing “Tools” clicks

Because the rings are rendered *inside* the Tools action view item, clicks could accidentally trigger the Tools menu.

To prevent this:

- `onClick` is overridden to ignore events originating inside either ring element.
- Pointer/mouse/click events are registered on the ring elements **in capture phase** and call `preventDefault()` + `stopPropagation()` (+ `stopImmediatePropagation()` when available).

This ensures the ring behaves like an independent hit target and doesn’t open the Tools picker when clicked.

---

## Data model: context keys that drive the UI

**File:** `src/vs/workbench/contrib/chat/common/chatContextKeys.ts`

The rings are driven entirely by context keys so the UI can update without tight coupling to the chat input implementation.

### Estimated next-request keys

- `chatInputContextTokens`
- `chatInputContextHistoryTokens`
- `chatInputContextAttachmentTokens`
- `chatInputContextModeTokens`
- `chatInputContextDraftTokens`
- `chatInputContextMaxTokens`
- `chatInputContextUsagePercent`

These are updated continuously as you type, change modes, or add/remove attachments.

### Last-request (model-reported) keys

- `chatLastRequestUsageAvailable`
- `chatLastRequestPromptTokens`
- `chatLastRequestCompletionTokens`
- `chatLastRequestTotalTokens`
- `chatLastRequestCachedPromptTokens`
- `chatLastRequestAcceptedPredictionTokens`
- `chatLastRequestRejectedPredictionTokens`
- `chatLastRequestMaxPromptTokens`
- `chatLastRequestPromptUsagePercent`

These update when responses complete and whenever the chat model changes.

---

## Estimated next-request usage: how tokens are computed

**File:** `src/vs/workbench/contrib/chat/browser/chatInputPart.ts`

The estimate is computed in `ChatInputPart` and debounced (via `RunOnceScheduler`) so it does not re-tokenize on every keystroke synchronously.

### When recomputation happens

Recompute is scheduled on:

- input editor text changes
- attachments/context changes
- chat view model changes
- accept input (submit)
- language model changes

To avoid race conditions, recomputation is:

- cancellable (`CancellationTokenSource`)
- run-id guarded (ignore stale completions)

### What’s included in the estimate

The estimate is built as four independent text buckets:

1. **History**
   - previous request text (`getPromptText(request.message)`) and the response string
2. **Attachments / Instructions**
   - attached files (optionally ranged)
   - prompt files
   - prompt text / string variables
   - paste content
   - terminal command + output
3. **Mode instructions**
   - `currentModeInfo.modeInstructions?.content`
4. **Draft**
   - current input editor value

Each bucket is tokenized separately so the hover breakdown can show where tokens are coming from.

### How the token count is obtained

For each bucket, `languageModelsService.computeTokenLength(model.identifier, text, token)` is used.

If the provider does not support exact counting (or the call fails), the estimate falls back to:

- $\lceil \text{chars} / 4 \rceil$

This heuristic intentionally trades accuracy for resilience.

### Attachment expansion rules (and why the estimate is still an estimate)

Some context entries do not have a single stable “prompt expansion” (e.g. images, symbol references, problems, SCM history). Those are *not expanded* here.

For file-like contexts that can be read locally, content is read via `fileService.readFile()` and capped to 100,000 characters to avoid runaway estimates.

As a result:

- the estimate can be **lower** than reality when the agent expands references or injects tool schemas
- the estimate can be **higher** than reality if the provider truncates/filters the prompt

The hover explicitly calls out that it is an estimate.

---

## Last-request usage: provider-reported tokens

**File:** `src/vs/workbench/contrib/chat/browser/chatInputPart.ts`

`ChatInputPart._recomputeLastRequestUsage()` scans the current chat model’s requests from newest to oldest, finds the most recent **completed** response, and then tries to locate a usage object.

### Where usage is searched

The implementation tries multiple sources because providers differ in how they attach usage:

- `response.result.metadata` (preferred)
- `response.result` (some providers attach usage at the root)
- “thinking” parts metadata (`response.entireResponse.value`) as a last resort

To make this robust, the code uses:

- `_findUsageInUnknown()`
  - bounded depth scan
  - prefers the tail of arrays (final events)
  - checks for keys like `usage`, `token_usage`, `tokenUsage`

### Normalizing field names

Because different providers use different names, extraction accepts a superset:

- prompt: `prompt_tokens` / `promptTokens` / `input_tokens` / `inputTokens`
- completion: `completion_tokens` / `completionTokens` / `output_tokens` / `outputTokens`
- total: `total_tokens` / `totalTokens`

Optional details:

- cached prompt tokens:
  - `prompt_tokens_details.cached_tokens`
  - `input_tokens_details.cached_tokens`
- prediction tokens:
  - `completion_tokens_details.accepted_prediction_tokens`
  - `completion_tokens_details.rejected_prediction_tokens`

Max prompt tokens (`chatLastRequestMaxPromptTokens`) is derived from (in order):

- response metadata/result/usage fields (`maxPromptTokens`, `max_prompt_tokens`)
- model metadata (`_currentLanguageModel.metadata.maxInputTokens`)

---

## Why “actual provider usage” is sometimes missing

Many providers (or plumbing layers between extension host and workbench) do not persist usage into the stored chat response metadata. Even if you can see usage in logs, the UI may have nothing to read.

This implementation therefore supports two strategies:

1. **Preferred:** provider attaches usage into the response result metadata so it survives into the stored model.
2. **Fallback (opt-in):** derive usage from the Copilot output logs.

---

## Opt-in fallback: derive usage from Copilot Output logs

**Files:**

- `src/vs/workbench/contrib/chat/browser/chat.contribution.ts`
- `src/vs/workbench/contrib/chat/browser/chatInputPart.ts`

### Setting

A new experimental setting gates the fallback:

- `chat.debug.deriveUsageFromCopilotOutputChannel` (default: `false`)

When enabled, and when the selected model appears to be Copilot (`identifier` starts with `copilot/`, vendor fallback), the implementation attempts to read the backing file for the **GitHub Copilot Chat Output** channel.

### Finding the output channel backing file

The code:

- queries `outputService.getChannelDescriptors()`
- matches descriptors by `extensionId` (preferred) or label
- resolves one or more backing `resource` URIs
- reads up to the last **1 MiB** of the file

### Extracting usage robustly

The log can contain huge JSON records, sometimes larger than a line or truncated at tail boundaries.

To handle that, extraction is done in two passes:

1. **Robust extraction near the last completion event**
   - locate the last `response.completed`
   - find the nearest `"usage": {`
   - brace-match the JSON object while skipping strings

2. **Line-based parsing fallback**
   - scan from the end for lines containing `"usage"`
   - parse the JSON object segment and check `type === 'response.completed'`

If a usage object is found, it populates the *same* last-request context keys.

### Privacy posture

This is intentionally *privacy-safe*:

- no prompt/response text is logged
- trace logs include only ids/keys/types/numeric token counts
- output channel content is read locally and only numeric fields are extracted

### Limitations

This fallback is best-effort and may be wrong when:

- multiple requests are running concurrently (the “last response.completed” might not correspond to the active chat)
- output logs rotate/truncate
- the Copilot output format changes

---

## How to verify manually

1. Open a chat session in Agent mode.
2. Watch the **left ring** (estimate) update while you:
   - type in the input
   - attach a file
   - add a paste or terminal output
   - switch chat mode/model
3. Trigger a request and, after it completes, check the **right ring** (last request).
4. Hover each ring to see the tooltip and use **Breakdown** to inspect the bucket totals.

To exercise the fallback:

- enable `chat.debug.deriveUsageFromCopilotOutputChannel`
- run a Copilot-backed model
- ensure the “GitHub Copilot Chat” output channel is active and contains `response.completed` events with a `usage` object

---

## Files involved (quick index)

- `src/vs/workbench/contrib/chat/common/chatContextKeys.ts`
  - defines all context keys for both rings
- `src/vs/workbench/contrib/chat/browser/chatInputPart.ts`
  - computes estimate and last-request usage; implements Copilot output fallback
- `src/vs/workbench/contrib/chat/browser/actions/chatToolActions.ts`
  - renders the rings next to Tools, hover, breakdown toggles, event isolation
- `src/vs/workbench/contrib/chat/browser/media/chat.css`
  - styling and color bands
- `src/vs/workbench/contrib/chat/browser/chat.contribution.ts`
  - registers the debug setting for the fallback
