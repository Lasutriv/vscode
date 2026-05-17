/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

import { httpRequest, httpStreamRequest } from '../common/httpClient';
import type { OllamaModelInfo, OllamaTool } from '../common/ollamaTypes';
import type { OpenAIChatMessage, OpenAIChatRequest, OpenAIStreamChunk } from '../common/openAITypes';
import { getLlamaCppAlternationViolation, normalizeOpenAIMessagesForAlternatingTemplate } from '../llamaCpp/alternation';
import { SseDataJsonStreamParser } from '../streaming/streamParsers';
import { coerceToolArgsFromString, ensureToolExplanationField, getToolNameToParams, inferToolNameFromRawArgs, normalizeToolInputSchema, tryParseJsonObject, type ToolInputSchema } from '../tools/toolCallUtils';
import type { BackendPart, ToolSchema } from './backendTypes';

export interface LlamaCppBackendListModelsResult {
	isLlamaCpp: boolean;
	models: OllamaModelInfo[];
}

export class LlamaCppBackend {
	private _tokenizeStrategy: { path: string; body: (model: string, content: string) => string } | undefined;
	private _tokenizeStrategyProbed = false;

	constructor(private readonly _outputChannel: vscode.OutputChannel) { }

	private extractTextForTokenCount(input: string | vscode.LanguageModelChatRequestMessage): string {
		if (typeof input === 'string') {
			return input;
		}
		let out = '';
		for (const part of input.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				out += part.value;
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				// Preserve tool calls as a stable textual representation.
				out += `\n<tool_call name="${part.name}" id="${part.callId}">${JSON.stringify(part.input ?? {})}</tool_call>`;
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				const content = part.content.map(c => c instanceof vscode.LanguageModelTextPart ? c.value : '').join('');
				out += `\n<tool_result id="${part.callId}">${content}</tool_result>`;
			}
		}
		return out;
	}

	private tryParseTokenCount(body: string): number | undefined {
		try {
			const parsed = JSON.parse(body) as unknown;
			if (!parsed || typeof parsed !== 'object') {
				return undefined;
			}
			const obj = parsed as Record<string, unknown>;
			if (Array.isArray(obj.tokens)) {
				return obj.tokens.length;
			}
			if (typeof obj.token_count === 'number') {
				return obj.token_count;
			}
			if (typeof obj.count === 'number') {
				return obj.count;
			}
			if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) {
				const data = obj.data as Record<string, unknown>;
				if (Array.isArray(data.tokens)) {
					return data.tokens.length;
				}
				if (typeof data.token_count === 'number') {
					return data.token_count;
				}
			}
		} catch {
			// ignore
		}
		return undefined;
	}

	async provideTokenCount(endpoint: string, model: OllamaModelInfo, input: string | vscode.LanguageModelChatRequestMessage): Promise<number> {
		const text = this.extractTextForTokenCount(input);
		if (!text) {
			return 0;
		}

		// Use cached strategy first.
		if (this._tokenizeStrategy) {
			try {
				const response = await httpRequest(`${endpoint}${this._tokenizeStrategy.path}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: this._tokenizeStrategy.body(model.ollamaName, text)
				}, this._outputChannel);

				if (response.status === 200) {
					const count = this.tryParseTokenCount(response.body);
					if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
						return count;
					}
				}
			} catch {
				// fall through to probing/fallback
			}
		}

		// Probe once per backend instance to avoid hammering endpoints.
		if (!this._tokenizeStrategyProbed) {
			this._tokenizeStrategyProbed = true;
			const strategies: Array<{ path: string; body: (model: string, content: string) => string }> = [
				{ path: '/tokenize', body: (_model, content) => JSON.stringify({ content }) },
				{ path: '/tokenize', body: (_model, content) => JSON.stringify({ text: content }) },
				{ path: '/v1/tokenize', body: (m, content) => JSON.stringify({ model: m, input: content }) },
				{ path: '/v1/tokenize', body: (m, content) => JSON.stringify({ model: m, text: content }) },
			];

			for (const s of strategies) {
				try {
					const response = await httpRequest(`${endpoint}${s.path}`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: s.body(model.ollamaName, text)
					}, this._outputChannel);

					if (response.status !== 200) {
						continue;
					}
					const count = this.tryParseTokenCount(response.body);
					if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
						this._tokenizeStrategy = s;
						this._outputChannel.appendLine(`[ollama-dev] (llama.cpp) Using token counting endpoint ${s.path}`);
						return count;
					}
				} catch {
					// try next
				}
			}
		}

		// Final fallback: rough estimate.
		return Math.ceil(text.length / 4);
	}

	async listModels(endpoint: string): Promise<LlamaCppBackendListModelsResult> {
		this._outputChannel.appendLine(`[ollama-dev] Fetching models from ${endpoint}/v1/models (llama.cpp check)`);
		const modelsResponse = await httpRequest(`${endpoint}/v1/models`, {
			method: 'GET',
			headers: { 'Content-Type': 'application/json' }
		}, this._outputChannel);

		if (modelsResponse.status !== 200) {
			return { isLlamaCpp: false, models: [] };
		}

		const data = JSON.parse(modelsResponse.body) as { data?: Array<{ id?: string; owned_by?: string }>; models?: Array<{ name?: string }> };

		const first = Array.isArray(data.data) && data.data.length > 0 ? data.data[0] : undefined;
		const firstAlt = Array.isArray(data.models) && data.models.length > 0 ? data.models[0] : undefined;

		const ownedBy = first?.owned_by?.toLowerCase();
		const isLlamaCpp =
			!!(first && ((ownedBy === 'llamacpp' || ownedBy === 'llama.cpp' || ownedBy === 'llama_cpp') || (first.id && first.id.endsWith('.gguf')))) ||
			!!(firstAlt && firstAlt.name && firstAlt.name.endsWith('.gguf'));

		if (!isLlamaCpp) {
			return { isLlamaCpp: false, models: [] };
		}

		const raw = (data.data ?? []).map(m => m.id).filter((v): v is string => typeof v === 'string' && v.length > 0);
		const rawAlt = (data.models ?? []).map(m => m.name).filter((v): v is string => typeof v === 'string' && v.length > 0);
		const ids = raw.length > 0 ? raw : rawAlt;

		const models: OllamaModelInfo[] = ids.map(id => ({
			id: `llama.cpp/${id}`,
			name: `${id} (llama.cpp)`,
			vendor: 'llama.cpp',
			ollamaName: id,
			family: 'unknown',
			version: '1.0',
			detail: '0x',
			isUserSelectable: true,
			capabilities: {
				tokenizer: 'cl100k_base',
				toolCalling: true,
				agentMode: true,
				editTools: ['multi-find-replace', 'find-replace'],
			},
			maxInputTokens: 65536,
			maxOutputTokens: 16384
		}));

		this._outputChannel.appendLine(`[ollama-dev] Found ${models.length} models (llama.cpp): ${models.map(m => m.name).join(', ')}`);
		return { isLlamaCpp: true, models };
	}

	async provideChatResponse(
		endpoint: string,
		model: OllamaModelInfo,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		onPart: (part: BackendPart) => void,
		token: vscode.CancellationToken
	): Promise<void> {
		const requestId = `req-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
		const temperature = options.modelOptions?.temperature ?? 0;
		const maxTokens = model.maxOutputTokens ?? 16384;
		const toolCallIdToName = new Map<string, string>();

		// Convert VS Code messages to OpenAI chat format.
		// IMPORTANT: llama.cpp's chat template for this model enforces that user/assistant roles alternate,
		// except that assistant messages *with tool_calls* and tool result messages are excluded from the
		// alternation check. Therefore we must encode VS Code tool calls as OpenAI `tool_calls`.
		const oaMessages: OpenAIChatMessage[] = [];
		for (const msg of messages) {
			let textContent = '';
			const toolCalls: NonNullable<OpenAIChatMessage['tool_calls']> = [];
			const toolResults: { callId: string; content: string }[] = [];

			for (const part of msg.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textContent += part.value;
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					toolCallIdToName.set(part.callId, part.name);
					toolCalls.push({
						id: part.callId,
						type: 'function',
						function: {
							name: part.name,
							arguments: JSON.stringify(part.input ?? {})
						}
					});
				} else if (part instanceof vscode.LanguageModelToolResultPart) {
					const resultContent = part.content.map(c => c instanceof vscode.LanguageModelTextPart ? c.value : '').join('');
					toolResults.push({ callId: part.callId, content: resultContent });
				}
			}

			const role: OpenAIChatMessage['role'] = msg.role === vscode.LanguageModelChatMessageRole.User ? 'user' :
				msg.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'system';

			// Do not create empty placeholder messages unless they contain tool calls.
			const hasContent = !!textContent;
			const hasToolCalls = toolCalls.length > 0;
			const shouldEmitBaseMessage = role === 'system' || hasContent || hasToolCalls;

			if (shouldEmitBaseMessage) {
				const last = oaMessages[oaMessages.length - 1];
				const lastHasToolCalls = !!(last?.tool_calls && last.tool_calls.length > 0);
				// Merge only simple consecutive text-only messages. Never merge into/out of a tool_calls message.
				if (
					last &&
					last.role === role &&
					last.tool_call_id === undefined &&
					!lastHasToolCalls &&
					!hasToolCalls
				) {
					const mergedContent = ((last.content as string | null) || '') + (textContent ? `\n${textContent}` : '');
					last.content = mergedContent || null;
				} else {
					const base: OpenAIChatMessage = { role, content: hasContent ? textContent : null };
					if (hasToolCalls) {
						base.tool_calls = toolCalls;
					}
					oaMessages.push(base);
				}
			}

			for (const toolResult of toolResults) {
				oaMessages.push({
					role: 'tool',
					tool_call_id: toolResult.callId,
					name: toolCallIdToName.get(toolResult.callId),
					content: toolResult.content
				});
			}
		}

		const oaTools: OllamaTool[] | undefined = options.tools?.map(tool => {
			const schema = normalizeToolInputSchema(tool.inputSchema as ToolInputSchema | undefined);
			return {
				type: 'function',
				function: {
					name: tool.name,
					description: tool.description || tool.name,
					parameters: {
						type: 'object',
						properties: schema.properties ?? {},
						required: schema.required && schema.required.length > 0 ? schema.required : undefined
					}
				}
			};
		});

		const normalizedOaMessages = normalizeOpenAIMessagesForAlternatingTemplate(oaMessages, this._outputChannel);
		if (normalizedOaMessages.length !== oaMessages.length) {
			this._outputChannel.appendLine(`[ollama-dev] Normalized OpenAI messages for llama.cpp template constraints: ${oaMessages.length} -> ${normalizedOaMessages.length}`);
		}
		const alternationViolation = getLlamaCppAlternationViolation(normalizedOaMessages);
		if (alternationViolation) {
			const trace = normalizedOaMessages.slice(0, 50).map((m, i) => {
				const hasToolCalls = m.role === 'assistant' && !!(m.tool_calls && m.tool_calls.length > 0);
				const toolId = m.role === 'tool' ? (m.tool_call_id ?? '?') : '';
				return `[${i}] ${m.role}${hasToolCalls ? '(tool_calls)' : ''}${toolId ? `(${toolId})` : ''}`;
			}).join(' ');
			this._outputChannel.appendLine(`[ollama-dev] WARNING: ${alternationViolation}`);
			this._outputChannel.appendLine(`[ollama-dev] WARNING: Role trace (first 50): ${trace}`);
		}

		const toolNameToParams: ReadonlyMap<string, ToolSchema> = getToolNameToParams((options.tools as readonly { name: string; inputSchema?: ToolInputSchema }[] | undefined));

		const requestBody: OpenAIChatRequest = {
			model: model.ollamaName,
			messages: normalizedOaMessages,
			stream: true,
			stream_options: { include_usage: true },
			tools: oaTools,
			temperature,
			max_tokens: maxTokens
		};

		const pendingToolCalls = new Map<number, { id: string; name?: string; args: string[] }>();
		const emittedToolCallIds = new Set<string>();

		const toolIndexToId = new Map<number, string>();
		const toolIdToIndex = new Map<string, number>();
		const toolIndexToName = new Map<number, string>();
		const toolIndexToExplicitName = new Map<number, string>();
		let lastOpenToolIndex: number | undefined;

		const flushPendingToolCalls = (reason: string) => {
			if (pendingToolCalls.size === 0) {
				return;
			}
			this._outputChannel.appendLine(`[ollama-dev] (llama.cpp) Flushing ${pendingToolCalls.size} pending tool call(s) on finish_reason=${reason}`);
			for (const [idx, pending] of pendingToolCalls) {
				const rawArgsStr = pending.args.join('');
				let toolName = pending.name?.trim() || toolIndexToExplicitName.get(idx) || toolIndexToName.get(idx);
				if (!toolName) {
					toolName = inferToolNameFromRawArgs(rawArgsStr, toolNameToParams);
					if (toolName) {
						this._outputChannel.appendLine(`[ollama-dev] (llama.cpp) Inferred tool name '${toolName}' for tool_call[${idx}] from arguments.`);
					}
				}
				if (!toolName) {
					this._outputChannel.appendLine(`[ollama-dev] (llama.cpp) Skipping tool_call[${idx}] because function name is missing.`);
					continue;
				}
				if (pending.args.length === 0) {
					this._outputChannel.appendLine(`[ollama-dev] (llama.cpp) Skipping tool_call[${idx}] (${toolName}) because no argument fragments were received.`);
					continue;
				}
				const argsObj = coerceToolArgsFromString(rawArgsStr, toolName, toolNameToParams);
				ensureToolExplanationField(argsObj, toolName);

				onPart({ type: 'toolCall', callId: pending.id, name: toolName, input: argsObj });
				this._outputChannel.appendLine(`[ollama-dev] (llama.cpp) -> tool_call[${idx}] ${toolName}(${JSON.stringify(argsObj).substring(0, 200)}${JSON.stringify(argsObj).length > 200 ? '...' : ''})`);
			}
			pendingToolCalls.clear();
		};

		this._outputChannel.appendLine(`[ollama-dev] (llama.cpp) REQUEST ${requestId}`);
		this._outputChannel.appendLine(`[ollama-dev] Endpoint: ${endpoint}/v1/chat/completions`);
		this._outputChannel.appendLine(`[ollama-dev] Model: ${model.name}`);
		this._outputChannel.appendLine(`[ollama-dev] Temperature: ${temperature}`);
		this._outputChannel.appendLine(`[ollama-dev] Max tokens: ${maxTokens}`);
		this._outputChannel.appendLine(`[ollama-dev] Messages: raw=${oaMessages.length}, final=${normalizedOaMessages.length}`);
		this._outputChannel.appendLine(`[ollama-dev] Tools: ${oaTools?.length ?? 0}`);
		const roleTrace = normalizedOaMessages.slice(0, 120).map((m, i) => {
			const toolCallsLen = m.role === 'assistant' && m.tool_calls ? m.tool_calls.length : 0;
			const hasToolCallsProp = m.role === 'assistant' && Object.prototype.hasOwnProperty.call(m, 'tool_calls');
			return `[${i}] ${m.role}${toolCallsLen ? `(tool_calls:${toolCallsLen})` : ''}${hasToolCallsProp && !toolCallsLen ? '(tool_calls:0)' : ''}`;
		}).join(' ');
		this._outputChannel.appendLine(`[ollama-dev] Role trace (first 120): ${roleTrace}`);
		this._outputChannel.appendLine('[ollama-dev] ----------------------------------------------------------------------');

		let toolCallCounter = 0;
		const startTime = Date.now();
		const sseParser = new SseDataJsonStreamParser<OpenAIStreamChunk>();

		try {
			await httpStreamRequest(
				`${endpoint}/v1/chat/completions`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(requestBody)
				},
				(chunk: string) => {
					for (const parsed of sseParser.push(chunk)) {
						try {
							const choice = parsed.choices?.[0];
							const delta = choice?.delta;

							if (delta?.content) {
								onPart({ type: 'text', value: delta.content });
							}

							if (delta?.tool_calls && delta.tool_calls.length > 0) {
								for (const toolCall of delta.tool_calls) {
									const rawName = toolCall.function?.name?.trim();
									const rawArgs = toolCall.function?.arguments ?? '';
									this._outputChannel.appendLine(`[ollama-dev] (llama.cpp) delta tool_call id=${toolCall.id ?? '?'} index=${typeof toolCall.index === 'number' ? toolCall.index : '?'} name=${rawName ?? ''} argsLen=${rawArgs.length}`);

									let idx: number | undefined;
									if (toolCall.id && toolIdToIndex.has(toolCall.id)) {
										idx = toolIdToIndex.get(toolCall.id)!;
									} else if (typeof toolCall.index === 'number') {
										idx = toolCall.index;
									} else if (lastOpenToolIndex !== undefined) {
										idx = lastOpenToolIndex;
									}
									if (idx === undefined) {
										idx = toolCallCounter++;
									} else {
										toolCallCounter = Math.max(toolCallCounter, idx + 1);
									}

									let callId = toolCall.id || toolIndexToId.get(idx);
									if (!callId) {
										callId = `llama-tool-${idx}`;
									}

									toolIndexToId.set(idx, callId);
									if (toolCall.id) {
										toolIdToIndex.set(toolCall.id, idx);
									}
									lastOpenToolIndex = idx;

									let pending = pendingToolCalls.get(idx);
									if (!pending) {
										const inferredName = rawName || toolIndexToName.get(idx) || inferToolNameFromRawArgs(rawArgs, toolNameToParams);
										pending = { id: callId, name: inferredName, args: [] };
										if (pending.name) {
											toolIndexToName.set(idx, pending.name);
										}
										pendingToolCalls.set(idx, pending);
									}

									if (rawName) {
										pending.name = rawName;
										toolIndexToName.set(idx, rawName);
										toolIndexToExplicitName.set(idx, rawName);
									} else if (!pending.name) {
										const inferredName = inferToolNameFromRawArgs(rawArgs, toolNameToParams);
										if (inferredName) {
											pending.name = inferredName;
											toolIndexToName.set(idx, inferredName);
										}
									}

									if (rawArgs) {
										if (!emittedToolCallIds.has(pending.id)) {
											pending.args.push(rawArgs);
											const rawArgsStr = pending.args.join('');
											const toolName = (pending.name?.trim() || toolIndexToExplicitName.get(idx) || toolIndexToName.get(idx))?.trim();
											if (toolName) {
												const parsedArgs = tryParseJsonObject(rawArgsStr);
												if (parsedArgs) {
													ensureToolExplanationField(parsedArgs, toolName);
													onPart({ type: 'toolCall', callId: pending.id, name: toolName, input: parsedArgs });
													emittedToolCallIds.add(pending.id);
													pendingToolCalls.delete(idx);
													this._outputChannel.appendLine(`[ollama-dev] (llama.cpp) -> tool_call[${idx}] ${toolName}(...) (early)`);
													lastOpenToolIndex = undefined;
												}
											}
										}
										else {
											this._outputChannel.appendLine(`[ollama-dev] (llama.cpp) Ignoring extra args for already-emitted tool call ${pending.id}`);
										}
									}
								}
							}

							if (choice?.finish_reason && pendingToolCalls.size > 0) {
								flushPendingToolCalls(choice.finish_reason);
								lastOpenToolIndex = undefined;
							}

							if (choice?.finish_reason) {
								const totalDuration = Date.now() - startTime;
								this._outputChannel.appendLine(`[ollama-dev] (llama.cpp) RESPONSE COMPLETE (${requestId})`);
								this._outputChannel.appendLine(`[ollama-dev]   Finish reason: ${choice.finish_reason}`);
								if (parsed.usage) {
									this._outputChannel.appendLine(`[ollama-dev]   Usage: prompt=${parsed.usage.prompt_tokens ?? 0}, completion=${parsed.usage.completion_tokens ?? 0}, total=${parsed.usage.total_tokens ?? 0}`);
								}
								this._outputChannel.appendLine(`[ollama-dev]   Duration: ${totalDuration}ms`);
							}
						} catch {
							// Be tolerant of unexpected shapes.
						}
					}
				},
				token,
				this._outputChannel
			);

			if (pendingToolCalls.size > 0) {
				flushPendingToolCalls('stream-end');
				lastOpenToolIndex = undefined;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this._outputChannel.appendLine(`[ollama-dev] (llama.cpp) REQUEST FAILED (${requestId})`);
			this._outputChannel.appendLine(`[ollama-dev] Error: ${message}`);
			if (pendingToolCalls.size > 0) {
				flushPendingToolCalls('error');
				lastOpenToolIndex = undefined;
			}
			const finalViolation = getLlamaCppAlternationViolation(normalizedOaMessages);
			this._outputChannel.appendLine(`[ollama-dev] Final alternation check: ${finalViolation ?? 'ok'}`);
			throw error;
		}
	}
}
