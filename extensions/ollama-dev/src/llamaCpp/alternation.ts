/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

import type { OllamaChatMessage } from '../common/ollamaTypes';
import type { OpenAIChatMessage } from '../common/openAITypes';

export function normalizeMessagesForAlternatingTemplate(messages: readonly OllamaChatMessage[], outputChannel?: vscode.OutputChannel): OllamaChatMessage[] {
	// Some llama.cpp chat templates (including the Devstral one shown in logs) enforce:
	// after optional system message, counted roles must alternate user/assistant.
	// VS Code often provides multiple user messages up front (context chunks), which
	// breaks that rule. We merge consecutive same-role messages to restore alternation.
	const out: OllamaChatMessage[] = [];

	for (const msg of messages) {
		const prev = out[out.length - 1];

		// Only merge the plain chat roles. Tool messages must remain separate.
		const isMergeableRole = msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant';
		const prevIsMergeableRole = prev && (prev.role === 'system' || prev.role === 'user' || prev.role === 'assistant');

		// Do not merge assistant tool calls into normal assistant content.
		const msgHasToolCalls = msg.role === 'assistant' && (msg.tool_calls?.length ?? 0) > 0;
		const prevHasToolCalls = prev?.role === 'assistant' && (prev.tool_calls?.length ?? 0) > 0;

		if (prev && prevIsMergeableRole && isMergeableRole && prev.role === msg.role && !msgHasToolCalls && !prevHasToolCalls) {
			prev.content = prev.content ? `${prev.content}\n\n${msg.content}` : msg.content;
			// Merge images if present (multimodal prompts)
			if (prev.images || msg.images) {
				prev.images = [...(prev.images ?? []), ...(msg.images ?? [])];
			}
			continue;
		}

		out.push({ ...msg });
	}

	// If we ended up with multiple system messages separated by non-mergeables, collapse
	// all system messages into the first one (llama.cpp templates expect <= 1 at start).
	const firstSystemIndex = out.findIndex(m => m.role === 'system');
	if (firstSystemIndex > 0) {
		// If a system message appears after other roles, treat it as user content.
		// This keeps the information but avoids violating the template.
		outputChannel?.appendLine('[ollama-dev] Normalizing: converting late system messages to user messages for llama.cpp compatibility.');
	}

	const normalized: OllamaChatMessage[] = [];
	let systemContent = '';
	for (const m of out) {
		if (m.role === 'system') {
			systemContent = systemContent ? `${systemContent}\n\n${m.content}` : m.content;
			continue;
		}
		normalized.push(m);
	}
	if (systemContent) {
		normalized.unshift({ role: 'system', content: systemContent });
	}

	return normalized;
}

export interface LlamaCppAlternationViolationInfo {
	countedIndex: number;
	messageIndex: number;
	expectedRole: 'user' | 'assistant';
	actualRole: 'user' | 'assistant';
}

export function normalizeOpenAIMessagesForAlternatingTemplate(messages: readonly OpenAIChatMessage[], outputChannel?: vscode.OutputChannel): OpenAIChatMessage[] {
	// Some llama.cpp chat templates (including the Devstral one) enforce:
	// after optional system message, counted roles must alternate user/assistant,
	// ignoring tool messages and assistant tool_calls messages.
	// This means patterns like: user -> tool -> user will FAIL (tool is ignored).
	// We normalize by:
	//  - merging multiple system messages into a single leading one
	//  - merging repeated counted roles (user/user or assistant/assistant) even when separated by tool/tool_calls messages
	const out: OpenAIChatMessage[] = [];

	// Merge system/developer messages into first (llama.cpp templates typically expect <= 1 system message at start).
	let systemContent = '';
	const nonSystem: OpenAIChatMessage[] = [];
	for (const m of messages) {
		if (m.role === 'system' || m.role === 'developer') {
			const c = typeof m.content === 'string' ? m.content : '';
			systemContent = systemContent ? `${systemContent}\n\n${c}` : c;
			continue;
		}
		nonSystem.push(m);
	}
	if (systemContent) {
		out.push({ role: 'system', content: systemContent });
	}

	let lastCountedRole: 'user' | 'assistant' | undefined;
	let lastCountedIndex = -1;
	const isAssistantWithToolCalls = (m: OpenAIChatMessage) => m.role === 'assistant' && !!(m.tool_calls && m.tool_calls.length > 0);
	const isCounted = (m: OpenAIChatMessage) => m.role === 'user' || (m.role === 'assistant' && !isAssistantWithToolCalls(m));

	for (const m of nonSystem) {
		// tool messages are ignored by the alternation check, keep them as-is
		if (m.role === 'tool' || isAssistantWithToolCalls(m)) {
			out.push(m);
			continue;
		}

		// Late system/developer messages shouldn't happen, but if they do, treat them as user content.
		if (m.role === 'system' || m.role === 'developer') {
			const c = typeof m.content === 'string' ? m.content : '';
			const userMsg: OpenAIChatMessage = { role: 'user', content: c || null };
			// fall through to counted-role normalization
			m.role = userMsg.role;
			m.content = userMsg.content;
		}

		if (!isCounted(m)) {
			out.push(m);
			continue;
		}

		const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
		if (lastCountedRole === undefined) {
			// The first counted message must be user. If we see assistant first, coerce it.
			if (role !== 'user') {
				outputChannel?.appendLine('[ollama-dev] Normalizing OpenAI messages: first counted message was not user; coercing to user for llama.cpp template compatibility.');
				m.role = 'user';
			}
			out.push(m);
			lastCountedRole = 'user';
			lastCountedIndex = out.length - 1;
			continue;
		}

		if (role === lastCountedRole && lastCountedIndex >= 0) {
			// Merge repeated counted roles (including cases where tool messages were between them).
			const prev = out[lastCountedIndex];
			const prevContent = typeof prev.content === 'string' ? prev.content : '';
			const curContent = typeof m.content === 'string' ? m.content : '';
			if (curContent) {
				prev.content = prevContent ? `${prevContent}\n${curContent}` : curContent;
				outputChannel?.appendLine(`[ollama-dev] Normalizing OpenAI messages: merged repeated '${role}' message for llama.cpp template compatibility.`);
			}
			continue;
		}

		out.push(m);
		lastCountedRole = role;
		lastCountedIndex = out.length - 1;
	}

	// As a final safety net, ensure the sequence passes the exact llama.cpp alternation check by
	// inserting minimal placeholder messages when needed.
	let normalized = out;
	for (let pass = 0; pass < 200; pass++) {
		const v = getLlamaCppAlternationViolationInfo(normalized);
		if (!v) {
			break;
		}
		const hasLeadingSystem = normalized.length > 0 && normalized[0].role === 'system';
		const insertAt = (hasLeadingSystem ? 1 : 0) + v.messageIndex;
		outputChannel?.appendLine(`[ollama-dev] Normalizing OpenAI messages: inserting missing '${v.expectedRole}' message to satisfy llama.cpp alternation (before messageIndex=${v.messageIndex}).`);
		normalized = [
			...normalized.slice(0, insertAt),
			{ role: v.expectedRole, content: null },
			...normalized.slice(insertAt)
		];
	}

	return normalized;
}

export function getLlamaCppAlternationViolationInfo(messages: readonly OpenAIChatMessage[]): LlamaCppAlternationViolationInfo | undefined {
	// Mirrors the Devstral llama.cpp chat template check:
	// After optional system message, the *counted* messages (user and assistant without tool_calls)
	// must alternate starting with user.
	const loopMessages = messages.length > 0 && messages[0].role === 'system' ? messages.slice(1) : messages;
	let index = 0;
	for (let i = 0; i < loopMessages.length; i++) {
		const m = loopMessages[i];
		const assistantHasToolCalls = m.role === 'assistant' && !!(m.tool_calls && m.tool_calls.length > 0);
		const isCounted = m.role === 'user' || (m.role === 'assistant' && !assistantHasToolCalls);
		if (!isCounted) {
			continue;
		}
		const expectedIsUser = index % 2 === 0;
		const actualIsUser = m.role === 'user';
		if (actualIsUser !== expectedIsUser) {
			return {
				countedIndex: index,
				messageIndex: i,
				expectedRole: expectedIsUser ? 'user' : 'assistant',
				actualRole: actualIsUser ? 'user' : 'assistant'
			};
		}
		index++;
	}
	return undefined;
}

export function getLlamaCppAlternationViolation(messages: readonly OpenAIChatMessage[]): string | undefined {
	const v = getLlamaCppAlternationViolationInfo(messages);
	if (!v) {
		return undefined;
	}
	return `Counted-message alternation violation at countedIndex=${v.countedIndex}, messageIndex=${v.messageIndex}, role=${v.actualRole} (expected ${v.expectedRole})`;
}
