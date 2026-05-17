/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

import { httpRequest, httpStreamRequest } from '../common/httpClient';
import type {
	OllamaChatMessage,
	OllamaChatRequest,
	OllamaChatStreamChunk,
	OllamaModelInfo,
	OllamaTagsResponse,
	OllamaTool,
} from '../common/ollamaTypes';
import { normalizeMessagesForAlternatingTemplate } from '../llamaCpp/alternation';
import { isQwen3CoderModel, parseQwen3CoderToolCalls } from '../ollama/qwen3CoderToolParser';
import { NdjsonStreamParser } from '../streaming/streamParsers';
import { coerceToolArgsFromUnknown, ensureToolExplanationField, getToolNameToParams, inferToolNameFromRawArgs, normalizeToolInputSchema, type ToolInputSchema } from '../tools/toolCallUtils';
import type { BackendPart, ToolSchema } from './backendTypes';

export interface OllamaBackendListModelsResult {
	models: OllamaModelInfo[];
	apiMode: 'ollama' | 'llamaCpp';
}

export class OllamaBackend {
	constructor(private readonly _outputChannel: vscode.OutputChannel) { }

	async listModels(endpoint: string): Promise<OllamaBackendListModelsResult> {
		this._outputChannel.appendLine(`[ollama-dev] Fetching models from ${endpoint}/api/tags`);
		const response = await httpRequest(`${endpoint}/api/tags`, {
			method: 'GET',
			headers: { 'Content-Type': 'application/json' }
		}, this._outputChannel);

		if (response.status !== 200) {
			throw new Error(`Ollama /api/tags failed (HTTP ${response.status}).`);
		}

		const data = JSON.parse(response.body) as OllamaTagsResponse;
		const hasGguf = data.models.some(m => m.name.endsWith('.gguf'));

		if (hasGguf) {
			this._outputChannel.appendLine('[ollama-dev] Detected .gguf in /api/tags; treating endpoint as llama.cpp.');
			return {
				apiMode: 'llamaCpp',
				models: data.models.map(model => ({
					id: `llama.cpp/${model.name}`,
					name: `${model.name} (llama.cpp)`,
					vendor: 'llama.cpp',
					ollamaName: model.name,
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
				}))
			};
		}

		const models: OllamaModelInfo[] = data.models.map(model => ({
			id: `ollama/${model.name}`,
			name: model.name,
			vendor: 'ollama',
			ollamaName: model.name,
			family: model.details?.family || 'unknown',
			version: model.details?.parameter_size || '1.0',
			detail: '0x',
			isUserSelectable: true,
			capabilities: {
				tokenizer: 'cl100k_base',
				toolCalling: true,
				agentMode: true,
				...(model.name.startsWith('devstral-small-2') && { imageInput: true, vision: true }),
				editTools: ['multi-find-replace', 'find-replace'],
			},
			maxInputTokens: 65536,
			maxOutputTokens: 16384
		}));

		this._outputChannel.appendLine(`[ollama-dev] Found ${models.length} models (ollama).`);
		return { apiMode: 'ollama', models };
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
		this._outputChannel.appendLine(`[ollama-dev] (ollama) REQUEST ${requestId} model=${model.ollamaName}`);

		// Map callId -> tool name so we can emit `tool_name` messages for tool results.
		const toolCallIdToName = new Map<string, string>();
		for (const msg of messages) {
			for (const part of msg.content) {
				if (part instanceof vscode.LanguageModelToolCallPart) {
					toolCallIdToName.set(part.callId, part.name);
				}
			}
		}

		const ollamaMessages: OllamaChatMessage[] = messages.flatMap(msg => {
			let textContent = '';
			let thinkingContent = '';
			const toolCalls: NonNullable<OllamaChatMessage['tool_calls']> = [];
			const toolResults: Array<{ callId: string; content: string }> = [];
			const images: string[] = [];

			for (const part of msg.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textContent += part.value;
				} else if (part instanceof vscode.LanguageModelThinkingPart) {
					if (typeof part.value === 'string') {
						thinkingContent += part.value;
					} else if (Array.isArray(part.value)) {
						thinkingContent += part.value.join('');
					}
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					toolCallIdToName.set(part.callId, part.name);
					toolCalls.push({
						function: {
							name: part.name,
							arguments: part.input as Record<string, unknown>
						}
					});
				} else if (part instanceof vscode.LanguageModelToolResultPart) {
					const content = part.content.map(c => c instanceof vscode.LanguageModelTextPart ? c.value : '').join('');
					toolResults.push({ callId: part.callId, content });
				} else if (part instanceof vscode.LanguageModelDataPart) {
					if (part.mimeType.startsWith('image/')) {
						images.push(Buffer.from(part.data).toString('base64'));
					}
				}
			}

			const role: OllamaChatMessage['role'] = msg.role === vscode.LanguageModelChatMessageRole.User ? 'user' :
				msg.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'system';

			const base: OllamaChatMessage = { role, content: textContent };
			if (role === 'assistant' && thinkingContent) {
				base.thinking = thinkingContent;
			}
			if (toolCalls.length > 0) {
				base.tool_calls = toolCalls;
			}
			if (images.length > 0) {
				base.images = images;
			}

			const out: OllamaChatMessage[] = [];
			if (base.content || base.thinking || base.tool_calls || base.images) {
				out.push(base);
			}
			for (const tr of toolResults) {
				const toolName = toolCallIdToName.get(tr.callId);
				out.push({
					role: toolName ? 'tool' : 'user',
					content: tr.content,
					...(toolName ? { tool_name: toolName } : {})
				});
			}
			return out;
		});

		const normalizedMessages = normalizeMessagesForAlternatingTemplate(ollamaMessages, this._outputChannel);

		const tools: OllamaTool[] | undefined = options.tools?.map(tool => {
			const schema = normalizeToolInputSchema(tool.inputSchema as ToolInputSchema | undefined);
			return {
				type: 'function',
				function: {
					name: tool.name,
					description: tool.description || '',
					parameters: {
						type: 'object',
						properties: schema.properties ?? {},
						required: schema.required && schema.required.length > 0 ? schema.required : undefined
					}
				}
			};
		});

		const toolNameToParams: ReadonlyMap<string, ToolSchema> = getToolNameToParams((options.tools as readonly { name: string; inputSchema?: ToolInputSchema }[] | undefined));

		const modelOpts = options.modelOptions as Record<string, unknown> | undefined;
		const temperature = typeof modelOpts?.temperature === 'number' ? modelOpts.temperature : undefined;
		const seed = typeof modelOpts?.seed === 'number' ? modelOpts.seed : undefined;
		const topK = typeof modelOpts?.top_k === 'number' ? modelOpts.top_k : undefined;
		const topP = typeof modelOpts?.top_p === 'number' ? modelOpts.top_p : undefined;

		const modelNameLower = model.ollamaName.toLowerCase();
		const isThinkingModel = (modelNameLower.includes('qwen3') && !modelNameLower.includes('coder')) ||
			modelNameLower.includes('deepseek-r1') ||
			modelNameLower.includes('deepseek-v3') ||
			modelNameLower.includes('qwq') ||
			modelOpts?.think === true;

		const requestBody: OllamaChatRequest = {
			model: model.ollamaName,
			messages: normalizedMessages,
			stream: true,
			tools,
			keep_alive: '30m',
			...(isThinkingModel && { think: true }),
			options: {
				num_ctx: 65536,
				num_predict: 16384,
				...(temperature !== undefined && { temperature }),
				...(seed !== undefined && { seed }),
				...(topK !== undefined && { top_k: topK }),
				...(topP !== undefined && { top_p: topP }),
			}
		};

		await this.streamChat(endpoint, requestId, requestBody, toolNameToParams, onPart, token);
	}

	async streamChat(
		endpoint: string,
		requestId: string,
		requestBody: OllamaChatRequest,
		toolNameToParams: ReadonlyMap<string, ToolSchema>,
		onPart: (part: BackendPart) => void,
		token: vscode.CancellationToken
	): Promise<void> {
		let lastAttemptStart = Date.now();

		const runStream = async (useTools: boolean) => {
			lastAttemptStart = Date.now();
			const isQwen3Coder = isQwen3CoderModel(requestBody.model);
			const body = useTools ? requestBody : { ...requestBody, tools: undefined };
			let accumulatedContent = '';
			let toolCallIdCounter = 0;
			let nextToolIndex = 0;

			const toolIndexToCallId = new Map<number, string>();
			const pendingToolCalls = new Map<number, { name?: string; argsFragments: string[]; argsObject?: Record<string, unknown>; emitted: boolean }>();

			const emitToolCall = (callId: string, toolName: string, rawArgs: unknown) => {
				const argsObj = coerceToolArgsFromUnknown(rawArgs, toolName, toolNameToParams);
				ensureToolExplanationField(argsObj, toolName);
				onPart({ type: 'toolCall', callId, name: toolName, input: argsObj });
			};

			const flushPendingToolCalls = (reason: string) => {
				if (pendingToolCalls.size === 0) {
					return;
				}
				this._outputChannel.appendLine(`[ollama-dev] (ollama) Flushing ${pendingToolCalls.size} pending tool call(s) (${reason})`);
				for (const [idx, pending] of pendingToolCalls) {
					if (pending.emitted) {
						continue;
					}
					let toolName = pending.name?.trim();
					const rawArgsStr = pending.argsFragments.join('');
					if (!toolName && rawArgsStr) {
						toolName = inferToolNameFromRawArgs(rawArgsStr, toolNameToParams);
					}
					if (!toolName) {
						continue;
					}
					const callId = toolIndexToCallId.get(idx) ?? `ollama-tool-${toolCallIdCounter++}`;
					toolIndexToCallId.set(idx, callId);
					emitToolCall(callId, toolName, pending.argsObject ?? rawArgsStr);
					pending.emitted = true;
				}
				pendingToolCalls.clear();
			};

			const ndjsonParser = new NdjsonStreamParser<OllamaChatStreamChunk>();

			await httpStreamRequest(
				`${endpoint}/api/chat`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body)
				},
				(chunk: string) => {
					for (const parsed of ndjsonParser.push(chunk)) {

						if (parsed.message?.thinking) {
							onPart({ type: 'thinking', value: parsed.message.thinking });
						}

						if (parsed.message?.content) {
							accumulatedContent += parsed.message.content;
							if (isQwen3Coder && (
								accumulatedContent.includes('<tool_call>') ||
								parsed.message.content.includes('<tool_call>') ||
								parsed.message.content.includes('<function=')
							)) {
								// suppress Qwen3-Coder XML tool call content
							} else {
								onPart({ type: 'text', value: parsed.message.content });
							}
						}

						if (parsed.message?.tool_calls && parsed.message.tool_calls.length > 0) {
							for (const tc of parsed.message.tool_calls) {
								const rawName = tc.function?.name?.trim();
								const idx = typeof tc.function?.index === 'number' ? tc.function.index : nextToolIndex++;
								let callId = toolIndexToCallId.get(idx);
								if (!callId) {
									callId = `ollama-tool-${toolCallIdCounter++}`;
									toolIndexToCallId.set(idx, callId);
								}

								let pending = pendingToolCalls.get(idx);
								if (!pending) {
									pending = { name: rawName || undefined, argsFragments: [], emitted: false };
									pendingToolCalls.set(idx, pending);
								} else if (rawName) {
									pending.name = rawName;
								}

								const rawArgs = (tc.function as unknown as { arguments?: unknown })?.arguments;
								if (typeof rawArgs === 'string') {
									pending.argsFragments.push(rawArgs);
								} else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
									pending.argsObject = rawArgs as Record<string, unknown>;
								}

								if (!pending.emitted && pending.name && pending.argsObject) {
									emitToolCall(callId, pending.name, pending.argsObject);
									pending.emitted = true;
								}
							}
						}

						if (parsed.done) {
							flushPendingToolCalls('done');
							if (isQwen3Coder && accumulatedContent.includes('<tool_call>')) {
								const xmlToolCalls = parseQwen3CoderToolCalls(accumulatedContent);
								for (const tc of xmlToolCalls) {
									const callId = `ollama-tool-${toolCallIdCounter++}`;
									const args = (tc.arguments ?? {}) as Record<string, unknown>;
									ensureToolExplanationField(args, tc.name);
									onPart({ type: 'toolCall', callId, name: tc.name, input: args });
								}
							}
						}
					}
				},
				token,
				this._outputChannel
			);
		};

		try {
			await runStream(true);
		} catch (error) {
			const duration = Date.now() - lastAttemptStart;
			const message = error instanceof Error ? error.message : String(error);
			this._outputChannel.appendLine(`[ollama-dev] (ollama) Request failed after ${duration}ms: ${message}`);
			if (message.toLowerCase().includes('does not support tools')) {
				this._outputChannel.appendLine('[ollama-dev] (ollama) Model does not support tools. Retrying without tools.');
				await runStream(false);
				return;
			}
			this._outputChannel.appendLine(`[ollama-dev] (ollama) REQUEST FAILED ${requestId}`);
			throw error;
		}
	}
}
