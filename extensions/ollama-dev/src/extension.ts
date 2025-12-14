/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';

// Configuration keys
const LLAMA_CPP_PATCH_MARKER = '2025-12-14-alternation-safety-net-v3';
const OLLAMA_REMOTE_HOST_CONFIG = 'ollamaDev.remoteHost';
const OLLAMA_REMOTE_PORT_CONFIG = 'ollamaDev.remotePort';
const OLLAMA_LOCAL_PORT_CONFIG = 'ollamaDev.localPort';
const OLLAMA_CONNECTION_MODE_CONFIG = 'ollamaDev.connectionMode';
const OLLAMA_LOCAL_ENDPOINT_CONFIG = 'ollamaDev.localEndpoint';

type ConnectionMode = 'ssh' | 'local';
type ApiMode = 'ollama' | 'llamaCpp';

interface OllamaModel {
	name: string;
	model: string;
	modified_at: string;
	size: number;
	digest: string;
	details: {
		parent_model: string;
		format: string;
		family: string;
		families: string[];
		parameter_size: string;
		quantization_level: string;
	};
}

interface OllamaTagsResponse {
	models: OllamaModel[];
}

interface OllamaToolCall {
	type?: 'function';  // Optional in response
	function: {
		index?: number;  // Index of the tool call in parallel calls
		name: string;
		arguments: Record<string, unknown>;
	};
}

interface OllamaChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	tool_calls?: OllamaToolCall[];
	tool_name?: string;  // Required when role is 'tool' - the name of the tool that was called
	images?: string[];   // Base64-encoded images for multimodal models
	thinking?: string;   // For thinking models - the model's thinking process
}

interface OllamaTool {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: {
			type: 'object';
			properties: Record<string, unknown>;
			required?: string[];
		};
	};
}

interface OllamaChatRequest {
	model: string;
	messages: OllamaChatMessage[];
	stream: boolean;
	tools?: OllamaTool[];
	format?: 'json' | Record<string, unknown>;  // JSON mode or structured outputs schema
	think?: boolean;  // For thinking models - should the model think before responding?
	keep_alive?: string | number;  // How long to keep model loaded (default: '5m')
	options?: {
		num_ctx?: number;
		num_predict?: number;
		temperature?: number;
		seed?: number;  // For reproducible outputs
		top_k?: number;
		top_p?: number;
		repeat_penalty?: number;
		stop?: string[];  // Stop sequences
	};
}

interface OllamaChatStreamChunk {
	model: string;
	created_at: string;
	message: {
		role: string;
		content: string;
		tool_calls?: OllamaToolCall[];
		thinking?: string;  // For thinking models
		images?: string[] | null;  // For multimodal responses
	};
	done: boolean;
	done_reason?: string;  // 'stop', 'load', 'unload' - reason why generation stopped
	// Token usage information (only present when done: true)
	prompt_eval_count?: number;
	eval_count?: number;
	total_duration?: number;
	load_duration?: number;
	prompt_eval_duration?: number;
	eval_duration?: number;
}

interface OllamaModelInfo extends vscode.LanguageModelChatInformation {
	ollamaName: string;
}

interface OpenAIChatMessage {
	role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
	content?: string | null;
	name?: string;
	tool_call_id?: string;
	tool_calls?: Array<{
		id?: string;
		type: 'function';
		function: { name: string; arguments: string };
	}>;
}

interface LlamaCppAlternationViolationInfo {
	countedIndex: number;
	messageIndex: number;
	expectedRole: 'user' | 'assistant';
	actualRole: 'user' | 'assistant';
}

interface OpenAIChatRequest {
	model: string;
	messages: OpenAIChatMessage[];
	stream: boolean;
	tools?: OllamaTool[];
	temperature?: number;
	max_tokens?: number;
}

interface OpenAIStreamChunk {
	id?: string;
	choices: Array<{
		delta: {
			content?: string;
			tool_calls?: Array<{
				id?: string;
				index?: number;
				type: 'function';
				function: { name: string; arguments: string };
			}>;
		};
		finish_reason?: string;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
}

function normalizeMessagesForAlternatingTemplate(messages: readonly OllamaChatMessage[], outputChannel?: vscode.OutputChannel): OllamaChatMessage[] {
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

function normalizeOpenAIMessagesForAlternatingTemplate(messages: readonly OpenAIChatMessage[], outputChannel?: vscode.OutputChannel): OpenAIChatMessage[] {
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

function getLlamaCppAlternationViolationInfo(messages: readonly OpenAIChatMessage[]): LlamaCppAlternationViolationInfo | undefined {
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

function getLlamaCppAlternationViolation(messages: readonly OpenAIChatMessage[]): string | undefined {
	const v = getLlamaCppAlternationViolationInfo(messages);
	if (!v) {
		return undefined;
	}
	return `Counted-message alternation violation at countedIndex=${v.countedIndex}, messageIndex=${v.messageIndex}, role=${v.actualRole} (expected ${v.expectedRole})`;
}

// Helper function to make HTTP requests using Node.js http module
function httpRequest(url: string, options: { method: string; headers?: Record<string, string>; body?: string }, outputChannel?: vscode.OutputChannel): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const urlObj = new URL(url);
		const reqOptions: http.RequestOptions = {
			hostname: urlObj.hostname,
			port: urlObj.port || 80,
			path: urlObj.pathname + urlObj.search,
			method: options.method,
			headers: options.headers || {},
			timeout: 10000 // 10 second timeout
		};

		outputChannel?.appendLine(`[HTTP] Requesting ${options.method} ${url}`);

		const req = http.request(reqOptions, (res) => {
			let data = '';
			res.on('data', (chunk: Buffer) => {
				data += chunk.toString();
			});
			res.on('end', () => {
				outputChannel?.appendLine(`[HTTP] Response: ${res.statusCode}, body length: ${data.length}`);
				resolve({ status: res.statusCode || 0, body: data });
			});
		});

		req.on('timeout', () => {
			outputChannel?.appendLine(`[HTTP] Request timeout`);
			req.destroy();
			reject(new Error('Request timeout'));
		});

		req.on('error', (err: NodeJS.ErrnoException) => {
			outputChannel?.appendLine(`[HTTP] Request error: ${err.message} (code: ${err.code}, errno: ${err.errno})`);
			reject(err);
		});

		if (options.body) {
			req.write(options.body);
		}
		req.end();
	});
}

// Helper function to make streaming HTTP requests
function httpStreamRequest(
	url: string,
	options: { method: string; headers?: Record<string, string>; body?: string },
	onData: (chunk: string) => void,
	token: vscode.CancellationToken,
	outputChannel?: vscode.OutputChannel
): Promise<void> {
	return new Promise((resolve, reject) => {
		const urlObj = new URL(url);
		// llama.cpp can take a long time to emit the first token when the prompt is large
		// (e.g. lots of tools / very long context). Node's request `timeout` is an
		// inactivity timeout, so we set it high to avoid aborting during prompt eval.
		const streamTimeoutMs = 30 * 60 * 1000; // 30 minutes
		const reqOptions: http.RequestOptions = {
			hostname: urlObj.hostname,
			port: urlObj.port || 80,
			path: urlObj.pathname + urlObj.search,
			method: options.method,
			headers: options.headers || {},
			timeout: streamTimeoutMs
		};

		outputChannel?.appendLine(`[HTTP] Streaming request ${options.method} ${url} (timeout=${streamTimeoutMs}ms)`);

		const req = http.request(reqOptions, (res) => {
			if (res.statusCode !== 200) {
				const errorChunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => errorChunks.push(chunk));
				res.on('end', () => {
					const errorBody = Buffer.concat(errorChunks).toString();
					outputChannel?.appendLine(`[HTTP] Stream error: HTTP ${res.statusCode} body: ${errorBody}`);
					reject(new Error(`HTTP ${res.statusCode}: ${errorBody}`));
				});
				return;
			}

			res.on('data', (chunk: Buffer) => {
				if (!token.isCancellationRequested) {
					onData(chunk.toString());
				}
			});
			res.on('end', () => {
				outputChannel?.appendLine(`[HTTP] Stream completed`);
				resolve();
			});
		});

		req.on('timeout', () => {
			outputChannel?.appendLine(`[HTTP] Stream timeout`);
			req.destroy();
			reject(new Error('Request timeout'));
		});

		req.on('error', (err: NodeJS.ErrnoException) => {
			outputChannel?.appendLine(`[HTTP] Stream error: ${err.message} (code: ${err.code}, errno: ${err.errno})`);
			reject(err);
		});

		token.onCancellationRequested(() => {
			req.destroy();
		});

		if (options.body) {
			req.write(options.body);
		}
		req.end();
	});
}

// =============================================================================
// MODEL CAPABILITY REFERENCE
// =============================================================================
//
// When adding support for new models, verify the following capabilities:
//
// 1. TOOL CALLING FORMAT:
//    - Standard JSON: Most models (llama3, mistral, etc.) use Ollama's native
//      tool_calls response format
//    - XML Format: Qwen3-Coder uses custom XML tags: <tool_call><function=...>
//    - Check model's HuggingFace page or documentation for tool call format
//
// 2. THINKING/REASONING MODE:
//    - Some models support `think: true` option (deepseek-r1, qwq, qwen3 non-coder)
//    - Qwen3-Coder does NOT support thinking mode despite qwen3 naming
//    - Check: https://docs.ollama.com/capabilities/thinking
//
// 3. CONTEXT LENGTH:
//    - Verify model's max context window (num_ctx)
//    - Qwen3-Coder: 262K native, up to 1M with Yarn
//    - Most models: 8K-128K
//
// 4. RECOMMENDED PARAMETERS (per model docs):
//    - Qwen3-Coder: temperature=0.7, top_p=0.8, top_k=20, repetition_penalty=1.05
//
// MODEL VERIFICATION CHECKLIST:
// +---------------------+-----------+----------+-------------+-----------------+
// | Model               | Tool Call | Thinking | Max Context | Special Notes   |
// +---------------------+-----------+----------+-------------+-----------------+
// | qwen3-coder         | XML       | NO       | 262K        | Agentic coding  |
// | qwen3 (non-coder)   | Standard  | YES      | 128K        |                 |
// | deepseek-r1         | Standard  | YES      | 128K        | Reasoning model |
// | deepseek-v3         | Standard  | YES      | 128K        |                 |
// | qwq                 | Standard  | YES      | 32K         | Reasoning model |
// | llama3              | Standard  | NO       | 8K          |                 |
// | mistral             | Standard  | NO       | 32K         |                 |
// +---------------------+-----------+----------+-------------+-----------------+
//
// TODO: When adding new models, update this table and the detection functions below
// =============================================================================

/**
 * Parse Qwen3-Coder's special XML tool call format.
 *
 * IMPORTANT: Qwen3-Coder uses a CUSTOM XML format instead of standard JSON tool calls.
 * This is different from most other models which use Ollama's native tool_calls format.
 *
 * XML Format:
 * ```xml
 * <tool_call>
 * <function=function_name>
 * <parameter=param1>value1</parameter>
 * <parameter=param2>value2</parameter>
 * </function>
 * </tool_call>
 * ```
 *
 * @see https://huggingface.co/Qwen/Qwen3-Coder-480B-A35B-Instruct/blob/main/qwen3coder_tool_parser.py
 * @see https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct (model card)
 */
interface ParsedQwenToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

function parseQwen3CoderToolCalls(content: string): ParsedQwenToolCall[] {
	const toolCalls: ParsedQwenToolCall[] = [];

	// Regex to find tool call blocks
	const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
	const functionRegex = /<function=([^>]+)>([\s\S]*?)<\/function>/;
	const parameterRegex = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g;

	let match;
	while ((match = toolCallRegex.exec(content)) !== null) {
		const toolCallContent = match[1];
		const funcMatch = functionRegex.exec(toolCallContent);

		if (funcMatch) {
			const functionName = funcMatch[1].trim();
			const parametersContent = funcMatch[2];
			const args: Record<string, unknown> = {};

			let paramMatch;
			while ((paramMatch = parameterRegex.exec(parametersContent)) !== null) {
				const paramName = paramMatch[1].trim();
				let paramValue: unknown = paramMatch[2].trim();

				// Remove leading/trailing newlines from parameter values
				if (typeof paramValue === 'string') {
					paramValue = paramValue.replace(/^\n+|\n+$/g, '');
					const strValue = paramValue as string;

					// Try to parse as JSON if it looks like JSON
					if ((strValue.startsWith('{') && strValue.endsWith('}')) ||
						(strValue.startsWith('[') && strValue.endsWith(']'))) {
						try {
							paramValue = JSON.parse(strValue);
						} catch {
							// Keep as string if not valid JSON
						}
					} else if (strValue.toLowerCase() === 'true') {
						paramValue = true;
					} else if (strValue.toLowerCase() === 'false') {
						paramValue = false;
					} else if (strValue.toLowerCase() === 'null') {
						paramValue = null;
					} else if (!isNaN(Number(strValue)) && strValue !== '') {
						// Try to parse as number
						const num = Number(strValue);
						if (Number.isInteger(num) && strValue.indexOf('.') === -1) {
							paramValue = parseInt(strValue, 10);
						} else {
							paramValue = num;
						}
					}
				}

				args[paramName] = paramValue;
			}

			toolCalls.push({
				name: functionName,
				arguments: args
			});
		}
	}

	return toolCalls;
}

/**
 * Check if model is Qwen3-Coder which uses special XML tool call format.
 *
 * TODO: When adding new models with non-standard tool call formats,
 * create similar detection functions and update the streaming handler.
 *
 * @see Model Capability Reference table above
 */
function isQwen3CoderModel(modelName: string): boolean {
	const lowerName = modelName.toLowerCase();
	return lowerName.includes('qwen3') && lowerName.includes('coder');
}

class SshTunnel implements vscode.Disposable {
	private _process: ChildProcess | undefined;
	private _isConnected = false;
	private readonly _outputChannel: vscode.OutputChannel;

	constructor(outputChannel: vscode.OutputChannel) {
		this._outputChannel = outputChannel;
	}

	get isConnected(): boolean {
		return this._isConnected;
	}

	async connect(remoteHost: string, remotePort: number, localPort: number): Promise<boolean> {
		if (this._isConnected) {
			this.disconnect();
		}

		this._outputChannel.appendLine(`[SSH] Connecting to ${remoteHost}...`);
		this._outputChannel.appendLine(`[SSH] Tunneling remote port ${remotePort} to local port ${localPort}`);

		return new Promise((resolve) => {
			// SSH tunnel: -L localPort:localhost:remotePort remoteHost -N (no command, just tunnel)
			const sshKeyPath = vscode.workspace.getConfiguration().get<string>('ollamaDev.sshKeyPath') || '';
			const sshArgs = [
				'-N', // No remote command
				'-L', `${localPort}:localhost:${remotePort}`,
				'-o', 'ExitOnForwardFailure=yes',
				'-o', 'ServerAliveInterval=60',
				'-o', 'ServerAliveCountMax=3',
				'-o', 'StrictHostKeyChecking=no',
			];

			// Add SSH key if configured
			if (sshKeyPath) {
				sshArgs.push('-i', sshKeyPath);
			}

			sshArgs.push(remoteHost);

			this._outputChannel.appendLine(`[SSH] Running: ssh ${sshArgs.join(' ')}`);

			this._process = spawn('ssh', sshArgs, {
				stdio: ['ignore', 'pipe', 'pipe'],
				shell: process.platform === 'win32'
			});

			let resolved = false;

			this._process.stderr?.on('data', (data: Buffer) => {
				const output = data.toString();
				this._outputChannel.appendLine(`[SSH] ${output}`);

				// Check for common error patterns
				if (output.includes('Permission denied') || output.includes('Connection refused') || output.includes('No route to host')) {
					if (!resolved) {
						resolved = true;
						this._isConnected = false;
						resolve(false);
					}
				}
			});

			this._process.stdout?.on('data', (data: Buffer) => {
				this._outputChannel.appendLine(`[SSH] ${data.toString()}`);
			});

			this._process.on('error', (err: Error) => {
				this._outputChannel.appendLine(`[SSH] Error: ${err.message}`);
				if (!resolved) {
					resolved = true;
					this._isConnected = false;
					resolve(false);
				}
			});

			this._process.on('exit', (code: number | null) => {
				this._outputChannel.appendLine(`[SSH] Process exited with code ${code}`);
				this._isConnected = false;
				if (!resolved) {
					resolved = true;
					resolve(false);
				}
			});

			// Give SSH a moment to establish the tunnel, then verify it's working
			setTimeout(async () => {
				if (!resolved && this._process && !this._process.killed) {
					// Verify the tunnel is actually listening
					const isOpen = await this.verifyPort(localPort);
					if (isOpen) {
						resolved = true;
						this._isConnected = true;
						this._outputChannel.appendLine(`[SSH] Tunnel established successfully on port ${localPort}`);
						resolve(true);
					} else {
						this._outputChannel.appendLine(`[SSH] Tunnel process running but port ${localPort} not accessible`);
						resolved = true;
						this._isConnected = false;
						resolve(false);
					}
				}
			}, 2000);
		});
	}

	private verifyPort(port: number): Promise<boolean> {
		return new Promise((resolve) => {
			const net = require('net');
			const socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
				this._outputChannel.appendLine(`[SSH] Port ${port} is open`);
				socket.end();
				resolve(true);
			});
			socket.setTimeout(2000);
			socket.on('error', (err: Error) => {
				this._outputChannel.appendLine(`[SSH] Port ${port} check failed: ${err.message}`);
				resolve(false);
			});
			socket.on('timeout', () => {
				this._outputChannel.appendLine(`[SSH] Port ${port} check timed out`);
				socket.destroy();
				resolve(false);
			});
		});
	}

	disconnect(): void {
		if (this._process) {
			this._outputChannel.appendLine(`[SSH] Disconnecting tunnel...`);
			this._process.kill();
			this._process = undefined;
			this._isConnected = false;
		}
	}

	dispose(): void {
		this.disconnect();
	}
}

class OllamaLanguageModelProvider implements vscode.Disposable {
	private readonly _disposables: vscode.Disposable[] = [];
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

	private _cachedModels: OllamaModelInfo[] = [];
	private readonly _sshTunnel: SshTunnel;
	private readonly _outputChannel: vscode.OutputChannel;
	private _localPort: number;
	private _connectionMode: ConnectionMode;
	private _localEndpoint: string;
	private _apiMode: ApiMode = 'ollama';

	constructor(outputChannel: vscode.OutputChannel, sshTunnel: SshTunnel) {
		this._outputChannel = outputChannel;
		this._sshTunnel = sshTunnel;
		const config = vscode.workspace.getConfiguration();
		this._localPort = config.get<number>(OLLAMA_LOCAL_PORT_CONFIG) || 43134;
		this._connectionMode = (config.get<string>(OLLAMA_CONNECTION_MODE_CONFIG) as ConnectionMode) || 'ssh';
		this._localEndpoint = config.get<string>(OLLAMA_LOCAL_ENDPOINT_CONFIG) || 'http://127.0.0.1:11434';

		// Watch for configuration changes
		this._disposables.push(
			vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
				if (e.affectsConfiguration(OLLAMA_REMOTE_HOST_CONFIG) ||
					e.affectsConfiguration(OLLAMA_REMOTE_PORT_CONFIG) ||
					e.affectsConfiguration(OLLAMA_LOCAL_PORT_CONFIG) ||
					e.affectsConfiguration(OLLAMA_CONNECTION_MODE_CONFIG) ||
					e.affectsConfiguration(OLLAMA_LOCAL_ENDPOINT_CONFIG)) {
					const newConfig = vscode.workspace.getConfiguration();
					this._localPort = newConfig.get<number>(OLLAMA_LOCAL_PORT_CONFIG) || this._localPort;
					this._connectionMode = (newConfig.get<string>(OLLAMA_CONNECTION_MODE_CONFIG) as ConnectionMode) || this._connectionMode;
					this._localEndpoint = newConfig.get<string>(OLLAMA_LOCAL_ENDPOINT_CONFIG) || this._localEndpoint;
					this._onDidChange.fire();
				}
			})
		);
	}

	private getEndpoint(): string {
		if (this._connectionMode === 'local') {
			return this._localEndpoint;
		}
		return `http://127.0.0.1:${this._localPort}`;
	}

	setLocalPort(port: number): void {
		this._localPort = port;
	}

	setConnectionMode(mode: ConnectionMode, localEndpoint?: string): void {
		this._connectionMode = mode;
		if (localEndpoint) {
			this._localEndpoint = localEndpoint;
		}
		this._onDidChange.fire();
	}

	async provideLanguageModelChatInformation(_options: vscode.PrepareLanguageModelChatModelOptions, _token: vscode.CancellationToken): Promise<OllamaModelInfo[]> {
		if (this._connectionMode === 'ssh' && !this._sshTunnel.isConnected) {
			this._outputChannel.appendLine(`[ollama-dev] SSH tunnel not connected, cannot fetch models`);
			return this._cachedModels;
		}

		const endpoint = this.getEndpoint();
		let forceLlamaEndpoint = endpoint.includes('8081') || endpoint.includes('llama.cpp');
		this._outputChannel.appendLine(`[ollama-dev] Discovery endpoint=${endpoint}, forceLlamaEndpoint=${forceLlamaEndpoint}`);

		// If cache already contains gguf, coerce to llama.cpp
		if (this._cachedModels.length > 0 && this._cachedModels.some(m => m.ollamaName.endsWith('.gguf'))) {
			this._apiMode = 'llamaCpp';
			forceLlamaEndpoint = true;
			this._cachedModels = this._cachedModels.map(m => ({
				...m,
				id: m.id.startsWith('llama.cpp/') ? m.id : `llama.cpp/${m.ollamaName}`,
				name: m.name.includes('(llama.cpp)') ? m.name : `${m.ollamaName} (llama.cpp)`,
				vendor: 'llama.cpp'
			}));
			this._outputChannel.appendLine(`[ollama-dev] Coerced cached gguf models to llama.cpp mode: ${this._cachedModels.map(m => m.name).join(', ')}`);
			return this._cachedModels;
		}

		const tryLlamaCpp = async (): Promise<OllamaModelInfo[] | undefined> => {
			try {
				this._outputChannel.appendLine(`[ollama-dev] Fetching models from ${endpoint}/v1/models (llama.cpp check)`);
				const modelsResponse = await httpRequest(`${endpoint}/v1/models`, {
					method: 'GET',
					headers: { 'Content-Type': 'application/json' }
				}, this._outputChannel);

				if (modelsResponse.status === 200) {
					const data = JSON.parse(modelsResponse.body);
					// Check for llama.cpp signature in data or headers
					const isLlamaCpp = (data.data && Array.isArray(data.data) && data.data.length > 0 && (data.data[0].owned_by === 'llamacpp' || (data.data[0].id && data.data[0].id.endsWith('.gguf')))) || (data.models && Array.isArray(data.models) && data.models.length > 0 && (data.models[0].name && data.models[0].name.endsWith('.gguf')));
					if (isLlamaCpp) {
						forceLlamaEndpoint = true;
						this._apiMode = 'llamaCpp';
						const models: OllamaModelInfo[] = (data.data || data.models || []).map((model: { id?: string; name?: string }) => ({
							id: `llama.cpp/${model.id || model.name}`,
							name: `${model.id || model.name} (llama.cpp)`,
							vendor: 'llama.cpp',
							ollamaName: model.id || model.name,
							family: 'unknown',
							version: '1.0',
							detail: '0x',
							isUserSelectable: true,
							capabilities: {
								toolCalling: true,
								agentMode: true,
								editTools: ['multi-find-replace', 'find-replace'],
							},
							maxInputTokens: 65536,
							maxOutputTokens: 16384
						}));
						this._cachedModels = models;
						this._outputChannel.appendLine(`[ollama-dev] Found ${models.length} models (llama.cpp): ${models.map((m: OllamaModelInfo) => m.name).join(', ')}`);
						return models;
					}
				}
				this._outputChannel.appendLine(`[ollama-dev] llama.cpp /v1/models failed (HTTP ${modelsResponse.status}). Trying Ollama /api/tags...`);
			} catch (error) {
				this._outputChannel.appendLine(`[ollama-dev] Error connecting to /v1/models: ${error}`);
			}
			return undefined;
		};

		// If endpoint or model data indicates llama.cpp, force llama.cpp mode and never use /api/tags
		const llamaModels = await tryLlamaCpp();
		if (forceLlamaEndpoint) {
			if (llamaModels) {
				return llamaModels;
			}
			this._outputChannel.appendLine(`[ollama-dev] llama.cpp forced by endpoint but /v1/models returned no models. Skipping /api/tags.`);
			return this._cachedModels;
		}

		// Only use /api/tags if not llama.cpp; if llama.cpp is forced but models were empty, still avoid /api/tags.
		if (!forceLlamaEndpoint) {
			try {
				this._outputChannel.appendLine(`[ollama-dev] Fetching models from ${endpoint}/api/tags`);
				const response = await httpRequest(`${endpoint}/api/tags`, {
					method: 'GET',
					headers: { 'Content-Type': 'application/json' }
				}, this._outputChannel);

				if (response.status === 200) {
					const data = JSON.parse(response.body) as OllamaTagsResponse;
					// If tags contain .gguf, treat as llama.cpp anyway
					const hasGguf = data.models.some(m => m.name.endsWith('.gguf'));
					if (hasGguf) {
						this._apiMode = 'llamaCpp';
						forceLlamaEndpoint = true;
						this._outputChannel.appendLine(`[ollama-dev] Detected .gguf in /api/tags; treating as llama.cpp and skipping Ollama API mode.`);
						this._cachedModels = data.models.map(model => ({
							id: `llama.cpp/${model.name}`,
							name: `${model.name} (llama.cpp)`,
							vendor: 'llama.cpp',
							ollamaName: model.name,
							family: 'unknown',
							version: '1.0',
							detail: '0x',
							isUserSelectable: true,
							capabilities: {
								toolCalling: true,
								agentMode: true,
								editTools: ['multi-find-replace', 'find-replace'],
							},
							maxInputTokens: 65536,
							maxOutputTokens: 16384
						}));
						this._outputChannel.appendLine(`[ollama-dev] Found ${this._cachedModels.length} models (llama.cpp inferred from tags): ${this._cachedModels.map(m => m.name).join(', ')}`);
						return this._cachedModels;
					}

					this._apiMode = 'ollama';

					this._cachedModels = data.models.map(model => ({
						id: `ollama/${model.name}`,
						name: model.name,
						vendor: 'ollama',
						ollamaName: model.name,
						family: model.details?.family || 'unknown',
						version: model.details?.parameter_size || '1.0',
						detail: '0x',
						isUserSelectable: true,
						capabilities: {
							toolCalling: true,
							agentMode: true,
							...(model.name.startsWith('devstral-small-2') && { imageInput: true, vision: true }),
							editTools: ['multi-find-replace', 'find-replace'],
						},
						maxInputTokens: 65536,
						maxOutputTokens: 16384
					}));

					this._outputChannel.appendLine(`[ollama-dev] Model metadata: ${JSON.stringify(this._cachedModels.map(m => ({
						id: m.id,
						maxInputTokens: m.maxInputTokens,
						maxOutputTokens: m.maxOutputTokens,
						toolCalling: m.capabilities?.toolCalling
					})), null, 2)}`);
					this._outputChannel.appendLine(`[ollama-dev] Found ${this._cachedModels.length} models (Ollama): ${this._cachedModels.map(m => m.name).join(', ')}`);
					return this._cachedModels;
				}

				this._outputChannel.appendLine(`[ollama-dev] Ollama /api/tags failed (HTTP ${response.status}).`);
			} catch (error) {
				if (error instanceof AggregateError) {
					this._outputChannel.appendLine(`[ollama-dev] AggregateError with ${error.errors.length} errors:`);
					for (const e of error.errors) {
						const nodeErr = e as NodeJS.ErrnoException;
						this._outputChannel.appendLine(`  - ${nodeErr.message} (code: ${nodeErr.code}, errno: ${nodeErr.errno})`);
					}
				} else {
					this._outputChannel.appendLine(`[ollama-dev] Error connecting to Ollama: ${error}`);
				}
			}
		}

		return this._cachedModels;
	}

	async provideLanguageModelChatResponse(
		model: OllamaModelInfo,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
		token: vscode.CancellationToken
	): Promise<void> {
		if (this._connectionMode === 'ssh' && !this._sshTunnel.isConnected) {
			throw new Error('SSH tunnel not connected');
		}

		const endpoint = this.getEndpoint();
		const isGguf = model.ollamaName.endsWith('.gguf') || model.id.includes('.gguf');
		const llamaHint = endpoint.includes('8081') || endpoint.includes('llama.cpp') || this._apiMode === 'llamaCpp';
		if (isGguf || llamaHint) {
			this._apiMode = 'llamaCpp';
			return this.provideLlamaCppChatResponse(model, messages, options, progress, token);
		}
		const requestId = `req-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;

		// ===== DETAILED REQUEST LOGGING =====
		this._outputChannel.appendLine(`\n[ollama-dev] ======================================================================`);
		this._outputChannel.appendLine(`[ollama-dev] REQUEST ${requestId}`);
		this._outputChannel.appendLine(`[ollama-dev] ======================================================================`);
		this._outputChannel.appendLine(`[ollama-dev] Timestamp: ${new Date().toISOString()}`);
		this._outputChannel.appendLine(`[ollama-dev] Model: ${model.name} (${model.ollamaName})`);
		this._outputChannel.appendLine(`[ollama-dev] Model ID: ${model.id}`);
		this._outputChannel.appendLine(`[ollama-dev] Model Family: ${model.family}`);
		this._outputChannel.appendLine(`[ollama-dev] Endpoint: ${endpoint}/api/chat`);
		this._outputChannel.appendLine(`[ollama-dev] ----------------------------------------------------------------------`);

		// Log request options
		this._outputChannel.appendLine(`[ollama-dev] OPTIONS:`);
		this._outputChannel.appendLine(`[ollama-dev]   Tool Mode: ${options.toolMode}`);
		this._outputChannel.appendLine(`[ollama-dev]   Tools Count: ${options.tools?.length ?? 0}`);
		if (options.modelOptions && Object.keys(options.modelOptions).length > 0) {
			this._outputChannel.appendLine(`[ollama-dev]   Model Options: ${JSON.stringify(options.modelOptions)}`);
		}
		if (options.tools && options.tools.length > 0) {
			this._outputChannel.appendLine(`[ollama-dev]   Tools: ${options.tools.map(t => t.name).join(', ')}`);
		}
		this._outputChannel.appendLine(`[ollama-dev] ----------------------------------------------------------------------`);

		// Log message summary
		this._outputChannel.appendLine(`[ollama-dev] MESSAGES (${messages.length} total):`);
		messages.forEach((msg, idx) => {
			const roleName = msg.role === vscode.LanguageModelChatMessageRole.User ? 'user' :
				msg.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'system';
			let contentPreview = '';
			const partTypes: string[] = [];
			for (const part of msg.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					contentPreview = part.value.substring(0, 100).replace(/\n/g, '\\n');
					partTypes.push('text');
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					partTypes.push(`tool_call(${part.name})`);
				} else if (part instanceof vscode.LanguageModelToolResultPart) {
					partTypes.push(`tool_result(${part.callId})`);
				} else {
					partTypes.push('unknown');
				}
			}
			this._outputChannel.appendLine(`[ollama-dev]   [${idx}] ${roleName}: ${partTypes.join(', ')} - "${contentPreview}${contentPreview.length >= 100 ? '...' : ''}"`);
		});
		this._outputChannel.appendLine(`[ollama-dev] ----------------------------------------------------------------------`);

		// First pass: collect tool call information to map callId -> toolName
		// This is needed because tool results reference callId but Ollama needs tool_name
		const toolCallIdToName = new Map<string, string>();
		for (const msg of messages) {
			for (const part of msg.content) {
				if (part instanceof vscode.LanguageModelToolCallPart) {
					toolCallIdToName.set(part.callId, part.name);
				}
			}
		}

		// Convert VS Code messages to Ollama format
		// Use flatMap because a single VS Code message with tool results needs to become
		// multiple Ollama messages (one 'tool' message per tool result)
		const ollamaMessages: OllamaChatMessage[] = messages.flatMap(msg => {
			const result: OllamaChatMessage[] = [];
			let textContent = '';
			let thinkingContent = '';
			const toolCalls: OllamaToolCall[] = [];
			const toolResults: { callId: string; content: string }[] = [];
			const images: string[] = [];

			for (const part of msg.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textContent += part.value;
				} else if (part instanceof vscode.LanguageModelThinkingPart) {
					// Handle thinking parts - accumulate thinking content
					if (typeof part.value === 'string') {
						thinkingContent += part.value;
					} else if (Array.isArray(part.value)) {
						thinkingContent += part.value.join('');
					}
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					// Convert VS Code tool call to Ollama format
					// Also store the mapping of callId -> name for later tool results
					toolCallIdToName.set(part.callId, part.name);
					toolCalls.push({
						function: {
							name: part.name,
							arguments: part.input as Record<string, unknown>
						}
					});
				} else if (part instanceof vscode.LanguageModelToolResultPart) {
					// Tool results need to become separate 'tool' role messages in Ollama
					const resultContent = part.content.map(c => {
						if (c instanceof vscode.LanguageModelTextPart) {
							return c.value;
						}
						return '';
					}).join('');
					toolResults.push({ callId: part.callId, content: resultContent });
				} else if (part instanceof vscode.LanguageModelDataPart) {
					// Handle image data for multimodal models
					// Ollama expects base64 encoded images
					if (part.mimeType.startsWith('image/')) {
						const base64Data = Buffer.from(part.data).toString('base64');
						images.push(base64Data);
						this._outputChannel.appendLine(`[ollama-dev] Added image (${part.mimeType}, ${part.data.length} bytes)`);
					}
				}
			}

			// Build the main message (user/assistant/system) with any text content, thinking, and tool calls
			// Only add if there's text content, thinking, tool calls, or images
			if (textContent || thinkingContent || toolCalls.length > 0 || images.length > 0) {
				const baseMessage: OllamaChatMessage = {
					role: msg.role === vscode.LanguageModelChatMessageRole.User ? 'user' :
						msg.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'system',
					content: textContent
				};

				// Include thinking content for assistant messages (per Ollama streaming docs)
				if (thinkingContent && baseMessage.role === 'assistant') {
					baseMessage.thinking = thinkingContent;
				}

				if (toolCalls.length > 0) {
					baseMessage.tool_calls = toolCalls;
				}

				if (images.length > 0) {
					baseMessage.images = images;
				}

				result.push(baseMessage);
			}

			// Add separate 'tool' role messages for each tool result
			for (const toolResult of toolResults) {
				const toolName = toolCallIdToName.get(toolResult.callId);
				if (toolName) {
					result.push({
						role: 'tool',
						content: toolResult.content,
						tool_name: toolName
					});
					this._outputChannel.appendLine(`[ollama-dev] Created tool result message for: ${toolName} (callId: ${toolResult.callId})`);
				} else {
					// Fallback: if we can't find the tool name, send as user message
					this._outputChannel.appendLine(`[ollama-dev] WARNING: Could not find tool name for callId: ${toolResult.callId}, sending as user message`);
					result.push({
						role: 'user',
						content: `Tool result: ${toolResult.content}`
					});
				}
			}

			return result;
		});

		const normalizedOllamaMessages = normalizeMessagesForAlternatingTemplate(ollamaMessages, this._outputChannel);
		if (normalizedOllamaMessages.length !== ollamaMessages.length) {
			this._outputChannel.appendLine(`[ollama-dev] Normalized messages for llama.cpp template constraints: ${ollamaMessages.length} -> ${normalizedOllamaMessages.length}`);
		}

		// Convert VS Code tools to Ollama format
		const ollamaTools: OllamaTool[] | undefined = options.tools?.map(tool => {
			const inputSchema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] } | undefined;

			// Ensure 'explanation' is marked as required if it exists in properties
			// Many VS Code tools require this field for the tool call to be valid
			let required = inputSchema?.required ? [...inputSchema.required] : [];
			const properties = inputSchema?.properties ? { ...inputSchema.properties } : {};

			// If the tool has an 'explanation' property but it's not required, add it to required
			if (properties['explanation'] && !required.includes('explanation')) {
				required = ['explanation', ...required];
				this._outputChannel.appendLine(`[ollama-dev] Added 'explanation' to required fields for tool: ${tool.name}`);
			}

			return {
				type: 'function' as const,
				function: {
					name: tool.name,
					description: tool.description || '',
					parameters: {
						type: 'object' as const,
						properties: properties,
						required: required.length > 0 ? required : undefined
					}
				}
			};
		});

		const toolNameToParams = new Map<string, { required?: string[]; properties?: Record<string, unknown> }>();
		for (const t of options.tools ?? []) {
			const inputSchema = t.inputSchema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
			toolNameToParams.set(t.name, {
				required: inputSchema?.required,
				properties: inputSchema?.properties
			});
		}

		const inferToolNameFromRawArgs = (rawArgsStr: string): string | undefined => {
			let bestName: string | undefined;
			let bestScore = 0;
			for (const [name, params] of toolNameToParams) {
				let score = 0;
				const keys = new Set<string>();
				if (params.required) {
					for (const k of params.required) {
						keys.add(k);
					}
				}
				if (params.properties) {
					for (const k of Object.keys(params.properties)) {
						keys.add(k);
					}
				}
				for (const k of keys) {
					if (rawArgsStr.includes(`"${k}"`) || rawArgsStr.includes(`${k}`)) {
						score++;
					}
				}
				if (score > bestScore) {
					bestScore = score;
					bestName = name;
				}
			}
			return bestName;
		};

		const coerceToolArgsToObject = (rawArgs: unknown, toolName: string | undefined): Record<string, unknown> => {
			let parsed: unknown = rawArgs ?? {};
			if (typeof rawArgs === 'string') {
				try {
					parsed = rawArgs ? JSON.parse(rawArgs) : {};
				} catch {
					parsed = rawArgs;
				}
			}

			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}

			const params = toolName ? toolNameToParams.get(toolName) : undefined;
			const raw = typeof parsed === 'string' ? parsed : (typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs));
			if (params?.required && params.required.length > 0) {
				const obj: Record<string, unknown> = {};
				for (const key of params.required) {
					obj[key] = raw ?? '';
				}
				return obj;
			}
			if (params?.properties && Object.hasOwn(params.properties, 'query')) {
				return { query: raw ?? '' };
			}

			// Last resort: wrap in a value field so the payload is always an object
			return { value: raw ?? '' };
		};

		// Extract model options from VS Code's modelOptions
		const modelOpts = options.modelOptions as Record<string, unknown> | undefined;
		const temperature = typeof modelOpts?.temperature === 'number' ? modelOpts.temperature : undefined;
		const seed = typeof modelOpts?.seed === 'number' ? modelOpts.seed : undefined;
		const topK = typeof modelOpts?.top_k === 'number' ? modelOpts.top_k : undefined;
		const topP = typeof modelOpts?.top_p === 'number' ? modelOpts.top_p : undefined;

		// ---------------------------------------------------------------------------
		// THINKING MODEL DETECTION
		// ---------------------------------------------------------------------------
		// Check if this is a thinking/reasoning model that supports `think: true`.
		// When enabled, the model will output its reasoning process in a <think> block.
		//
		// SUPPORTED: qwen3 (non-coder), deepseek-r1, deepseek-v3, qwq
		// NOT SUPPORTED: qwen3-coder (explicitly stated in HuggingFace docs)
		//
		// TODO: Verify thinking support when adding new models
		// @see https://docs.ollama.com/capabilities/thinking
		// @see https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct ("does not generate <think> blocks")
		// ---------------------------------------------------------------------------
		const modelNameLower = model.ollamaName.toLowerCase();
		const isThinkingModel = (modelNameLower.includes('qwen3') && !modelNameLower.includes('coder')) ||
			modelNameLower.includes('deepseek-r1') ||
			modelNameLower.includes('deepseek-v3') ||
			modelNameLower.includes('qwq') ||
			modelOpts?.think === true;

		const requestBody: OllamaChatRequest = {
			model: model.ollamaName,
			messages: normalizedOllamaMessages,
			stream: true,
			tools: ollamaTools,
			keep_alive: '30m',  // Keep model loaded for 30 minutes to avoid reload delays
			...(isThinkingModel && { think: true }),  // Enable thinking for thinking models
			options: {
				num_ctx: 65536,  // Request 64K context window from Ollama (was 131072)
				num_predict: 16384,  // Max output tokens - matches maxOutputTokens
				...(temperature !== undefined && { temperature }),
				...(seed !== undefined && { seed }),
				...(topK !== undefined && { top_k: topK }),
				...(topP !== undefined && { top_p: topP }),
			}
		};

		// Log Ollama request details
		this._outputChannel.appendLine(`[ollama-dev] OLLAMA REQUEST BODY:`);
		this._outputChannel.appendLine(`[ollama-dev]   Model: ${requestBody.model}`);
		this._outputChannel.appendLine(`[ollama-dev]   Stream: ${requestBody.stream}`);
		this._outputChannel.appendLine(`[ollama-dev]   Think: ${requestBody.think || false}`);
		this._outputChannel.appendLine(`[ollama-dev]   Messages: ${requestBody.messages.length}`);
		this._outputChannel.appendLine(`[ollama-dev]   Options: num_ctx=${requestBody.options?.num_ctx}, num_predict=${requestBody.options?.num_predict}${temperature !== undefined ? `, temp=${temperature}` : ''}${seed !== undefined ? `, seed=${seed}` : ''}`);
		if (ollamaTools && ollamaTools.length > 0) {
			this._outputChannel.appendLine(`[ollama-dev]   Tools: ${ollamaTools.length} (${ollamaTools.map(t => t.function.name).join(', ')})`);
			// Log first tool's full structure for debugging
			this._outputChannel.appendLine(`[ollama-dev]   First tool sample: ${JSON.stringify(ollamaTools[0], null, 2).substring(0, 500)}`);
		} else {
			this._outputChannel.appendLine(`[ollama-dev]   Tools: NONE - Model will not be able to use tools!`);
		}
		this._outputChannel.appendLine(`[ollama-dev] ----------------------------------------------------------------------`);

		let lastAttemptStart = Date.now();

		const runStream = async (useTools: boolean) => {
			const startTime = Date.now();
			lastAttemptStart = startTime;
			let toolCallIdCounter = 0;
			let firstTokenReceived = false;
			let textTokenCount = 0;
			let toolCallCount = 0;
			let accumulatedContent = '';  // Accumulate content for Qwen3-Coder XML parsing
			const isQwen3Coder = isQwen3CoderModel(model.ollamaName);
			const body = useTools ? requestBody : { ...requestBody, tools: undefined };
			const toolIndexToCallId = new Map<number, string>();
			const pendingToolCalls = new Map<number, { name?: string; argsFragments: string[]; argsObject?: Record<string, unknown>; emitted: boolean }>();
			let nextToolIndex = 0;

			const emitToolCall = (callId: string, toolName: string, rawArgs: unknown) => {
				const argsObj = coerceToolArgsToObject(rawArgs, toolName);
				if (!Object.hasOwn(argsObj, 'explanation')) {
					const argsPreview = Object.keys(argsObj).slice(0, 3).join(', ');
					argsObj['explanation'] = `Calling ${toolName}${argsPreview ? ` with ${argsPreview}` : ''}`;
				}
				this._outputChannel.appendLine(`[ollama-dev]     -> ${toolName}(${JSON.stringify(argsObj).substring(0, 200)}${JSON.stringify(argsObj).length > 200 ? '...' : ''})`);
				progress.report(new vscode.LanguageModelToolCallPart(callId, toolName, argsObj));
			};

			const flushPendingToolCalls = (reason: string) => {
				if (pendingToolCalls.size === 0) {
					return;
				}
				this._outputChannel.appendLine(`[ollama-dev]   [tool] Flushing ${pendingToolCalls.size} pending tool call(s) (reason=${reason})`);
				for (const [idx, pending] of pendingToolCalls) {
					if (pending.emitted) {
						continue;
					}
					let toolName = pending.name?.trim();
					const rawArgsStr = pending.argsFragments.join('');
					if (!toolName && rawArgsStr) {
						toolName = inferToolNameFromRawArgs(rawArgsStr);
						if (toolName) {
							this._outputChannel.appendLine(`[ollama-dev]     [!] Inferred tool name '${toolName}' for tool_call[${idx}] from arguments.`);
						}
					}
					if (!toolName) {
						this._outputChannel.appendLine(`[ollama-dev]     [!] Skipping tool_call[${idx}] because function name is missing.`);
						continue;
					}
					const callId = toolIndexToCallId.get(idx) ?? `ollama-tool-${toolCallIdCounter++}`;
					toolIndexToCallId.set(idx, callId);
					const rawArgs = pending.argsObject ?? rawArgsStr;
					emitToolCall(callId, toolName, rawArgs);
					toolCallCount++;
					pending.emitted = true;
				}
				pendingToolCalls.clear();
			};

			this._outputChannel.appendLine(`[ollama-dev] STREAMING RESPONSE...${useTools ? '' : ' (tools disabled)'}`);
			if (isQwen3Coder) {
				this._outputChannel.appendLine(`[ollama-dev]   [*] Qwen3-Coder detected - will parse XML tool call format`);
			}
			if (!useTools) {
				this._outputChannel.appendLine(`[ollama-dev]   [!] Tools disabled because model reported lack of tool support.`);
			}

			await httpStreamRequest(
				`${endpoint}/api/chat`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body)
				},
				(chunk: string) => {
					const lines = chunk.split('\n').filter((line: string) => line.trim());
					for (const line of lines) {
						try {
							const parsed = JSON.parse(line) as OllamaChatStreamChunk;

							// Track time to first token
							if (!firstTokenReceived && (parsed.message?.content || parsed.message?.tool_calls)) {
								firstTokenReceived = true;
								const timeToFirstToken = Date.now() - startTime;
								this._outputChannel.appendLine(`[ollama-dev]   Time to first token: ${timeToFirstToken}ms`);
							}

							// Handle thinking content (for reasoning models like DeepSeek-R1)
							if (parsed.message?.thinking) {
								this._outputChannel.appendLine(`[ollama-dev]   Thinking: ${parsed.message.thinking.substring(0, 100)}${parsed.message.thinking.length > 100 ? '...' : ''}`);
								progress.report(new vscode.LanguageModelThinkingPart(parsed.message.thinking));
							}

							// Handle text content
							if (parsed.message?.content) {
								textTokenCount++;
								accumulatedContent += parsed.message.content;

								// For Qwen3-Coder, check if we're inside a tool call block
								// If so, don't stream text content to the user - we'll parse it as tool calls later
								if (isQwen3Coder && (
									accumulatedContent.includes('<tool_call>') ||
									parsed.message.content.includes('<tool_call>') ||
									parsed.message.content.includes('<function=')
								)) {
									// Don't stream tool call XML to user, we'll parse it at the end
									// But keep accumulating
								} else {
									progress.report(new vscode.LanguageModelTextPart(parsed.message.content));
								}
							}

							// Handle standard Ollama tool calls (non-Qwen3-Coder models)
							if (parsed.message?.tool_calls && parsed.message.tool_calls.length > 0) {
								this._outputChannel.appendLine(`[ollama-dev]   [tool] Received ${parsed.message.tool_calls.length} tool call(s)`);
								for (const toolCall of parsed.message.tool_calls) {
									const rawName = toolCall.function?.name?.trim();
									const idx = typeof toolCall.function?.index === 'number' ? toolCall.function.index : nextToolIndex++;
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

									const rawArgs = (toolCall.function as unknown as { arguments?: unknown })?.arguments;
									if (typeof rawArgs === 'string') {
										pending.argsFragments.push(rawArgs);
									} else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
										pending.argsObject = rawArgs as Record<string, unknown>;
									}

									// Emit immediately only when we have a non-empty name and a valid object args.
									// Otherwise buffer and flush when the stream completes.
									if (!pending.emitted && pending.name && pending.argsObject) {
										emitToolCall(callId, pending.name, pending.argsObject);
										pending.emitted = true;
										toolCallCount++;
									}
								}
							}

							// When response is complete, parse any Qwen3-Coder XML tool calls
							if (parsed.done) {
								flushPendingToolCalls('done');
								// Parse Qwen3-Coder XML tool calls from accumulated content
								if (isQwen3Coder && accumulatedContent.includes('<tool_call>')) {
									this._outputChannel.appendLine(`[ollama-dev]   Parsing Qwen3-Coder XML tool calls...`);
									const xmlToolCalls = parseQwen3CoderToolCalls(accumulatedContent);

									if (xmlToolCalls.length > 0) {
										this._outputChannel.appendLine(`[ollama-dev]   Found ${xmlToolCalls.length} XML tool call(s)`);
										toolCallCount += xmlToolCalls.length;

										for (const toolCall of xmlToolCalls) {
											const callId = `ollama-tool-${toolCallIdCounter++}`;
											const toolArgs = toolCall.arguments;

											// Ensure tool call arguments have required 'explanation' field
											if (toolArgs && typeof toolArgs === 'object' && !Object.hasOwn(toolArgs, 'explanation')) {
												const argsPreview = Object.keys(toolArgs).slice(0, 3).join(', ');
												(toolArgs as Record<string, unknown>)['explanation'] = `Calling ${toolCall.name} with ${argsPreview}`;
												this._outputChannel.appendLine(`[ollama-dev]     [!] Added missing 'explanation' field`);
											}

											this._outputChannel.appendLine(`[ollama-dev]     -> ${toolCall.name}(${JSON.stringify(toolArgs).substring(0, 200)}${JSON.stringify(toolArgs).length > 200 ? '...' : ''})`);
											progress.report(new vscode.LanguageModelToolCallPart(
												callId,
												toolCall.name,
												toolArgs
											));
										}

										// Stream any content that was before the first tool call
										const preToolContent = accumulatedContent.split('<tool_call>')[0].trim();
										if (preToolContent) {
											this._outputChannel.appendLine(`[ollama-dev]   Pre-tool content: ${preToolContent.substring(0, 100)}...`);
											// Note: We already streamed this content above for non-tool-call parts
										}
									} else {
										this._outputChannel.appendLine(`[ollama-dev]   WARNING: Found <tool_call> tags but failed to parse any tool calls`);
										this._outputChannel.appendLine(`[ollama-dev]   Content preview: ${accumulatedContent.substring(0, 500)}`);
									}
								}

								const totalDuration = Date.now() - startTime;
								this._outputChannel.appendLine(`[ollama-dev] ----------------------------------------------------------------------`);
								this._outputChannel.appendLine(`[ollama-dev] RESPONSE COMPLETE (${requestId})`);
								this._outputChannel.appendLine(`[ollama-dev]   Total Duration: ${totalDuration}ms`);
								this._outputChannel.appendLine(`[ollama-dev]   Text Chunks: ${textTokenCount}`);
								this._outputChannel.appendLine(`[ollama-dev]   Tool Calls: ${toolCallCount}`);
								if (parsed.prompt_eval_count !== undefined || parsed.eval_count !== undefined) {
									const promptTokens = parsed.prompt_eval_count || 0;
									const completionTokens = parsed.eval_count || 0;
									const totalTokens = promptTokens + completionTokens;
									this._outputChannel.appendLine(`[ollama-dev]   Token Usage:`);
									this._outputChannel.appendLine(`[ollama-dev]     - Prompt: ${promptTokens}`);
									this._outputChannel.appendLine(`[ollama-dev]     - Completion: ${completionTokens}`);
									this._outputChannel.appendLine(`[ollama-dev]     - Total: ${totalTokens}`);
								}
								if (parsed.total_duration) {
									this._outputChannel.appendLine(`[ollama-dev]   Ollama Timing:`);
									this._outputChannel.appendLine(`[ollama-dev]     - Total: ${(parsed.total_duration / 1e9).toFixed(2)}s`);
									this._outputChannel.appendLine(`[ollama-dev]     - Prompt Eval: ${((parsed.prompt_eval_duration || 0) / 1e9).toFixed(2)}s`);
									this._outputChannel.appendLine(`[ollama-dev]     - Generation: ${((parsed.eval_duration || 0) / 1e9).toFixed(2)}s`);
									if (parsed.eval_count && parsed.eval_duration) {
										const tokensPerSecond = parsed.eval_count / (parsed.eval_duration / 1e9);
										this._outputChannel.appendLine(`[ollama-dev]     - Speed: ${tokensPerSecond.toFixed(1)} tokens/sec`);
									}
								}
								this._outputChannel.appendLine(`[ollama-dev] ======================================================================\n`);
							}
						} catch {
							// Skip malformed JSON lines
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
			const errorDuration = Date.now() - lastAttemptStart;
			const message = error instanceof Error ? error.message : String(error);
			this._outputChannel.appendLine(`[ollama-dev] Request failed after ${errorDuration}ms: ${message}`);
			if (message.toLowerCase().includes('does not support tools')) {
				this._outputChannel.appendLine(`[ollama-dev] Model reported it does not support tools. Retrying without tools...`);
				await runStream(false);
				return;
			}

			this._outputChannel.appendLine(`[ollama-dev] ----------------------------------------------------------------------`);
			this._outputChannel.appendLine(`[ollama-dev] REQUEST FAILED (${requestId})`);
			this._outputChannel.appendLine(`[ollama-dev]   Duration: ${errorDuration}ms`);
			this._outputChannel.appendLine(`[ollama-dev]   Error: ${error}`);
			this._outputChannel.appendLine(`[ollama-dev] ======================================================================\n`);
			throw error;
		}
	}

	private async provideLlamaCppChatResponse(
		model: OllamaModelInfo,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
		token: vscode.CancellationToken
	): Promise<void> {
		const endpoint = this.getEndpoint();
		const requestId = `req-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
		const temperature = options.modelOptions?.temperature ?? 0.15;
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
			const inputSchema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
			let required = inputSchema?.required ? [...inputSchema.required] : [];
			const properties = inputSchema?.properties ? { ...inputSchema.properties } : {};
			if (properties['explanation'] && !required.includes('explanation')) {
				required = ['explanation', ...required];
			}
			return {
				type: 'function',
				function: {
					name: tool.name,
					description: tool.description || tool.name,
					parameters: {
						type: 'object',
						properties,
						required: required.length > 0 ? required : undefined
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

		const toolNameToParams = new Map<string, { required?: string[]; properties?: Record<string, unknown> }>();
		for (const t of oaTools ?? []) {
			toolNameToParams.set(t.function.name, t.function.parameters);
		}

		const requestBody: OpenAIChatRequest = {
			model: model.ollamaName,
			messages: normalizedOaMessages,
			stream: true,
			tools: oaTools,
			temperature,
			max_tokens: maxTokens
		};

		const pendingToolCalls = new Map<number, { id: string; name?: string; args: string[] }>();
		const coerceToolArgs = (rawArgsStr: string, toolName: string | undefined): Record<string, unknown> => {
			let parsed: unknown = {};
			try {
				parsed = rawArgsStr ? JSON.parse(rawArgsStr) : {};
			} catch {
				parsed = rawArgsStr;
			}

			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}

			const params = toolName ? toolNameToParams.get(toolName) : undefined;
			const raw = typeof parsed === 'string' ? parsed : rawArgsStr;
			if (params?.required && params.required.length > 0) {
				const obj: Record<string, unknown> = {};
				for (const key of params.required) {
					obj[key] = raw ?? '';
				}
				return obj;
			}
			if (params?.properties && Object.hasOwn(params.properties, 'query')) {
				return { query: raw ?? '' };
			}

			// Last resort: wrap in a value field so the payload is always an object
			return { value: raw ?? '' };
		};

		const inferToolNameFromRaw = (rawArgsStr: string): string | undefined => {
			let bestName: string | undefined;
			let bestScore = 0;
			for (const [name, params] of toolNameToParams) {
				let score = 0;
				const keys = new Set<string>();
				if (params.required) {
					for (const k of params.required) {
						keys.add(k);
					}
				}
				if (params.properties) {
					for (const k of Object.keys(params.properties)) {
						keys.add(k);
					}
				}
				for (const k of keys) {
					if (rawArgsStr.includes(`"${k}"`) || rawArgsStr.includes(`${k}`)) {
						score++;
					}
				}
				if (score > bestScore) {
					bestScore = score;
					bestName = name;
				}
			}
			return bestName;
		};

		const flushPendingToolCalls = (reason: string) => {
			if (pendingToolCalls.size === 0) {
				return;
			}
			this._outputChannel.appendLine(`[ollama-dev] (llama.cpp) Flushing ${pendingToolCalls.size} pending tool call(s) on finish_reason=${reason}`);
			for (const [idx, pending] of pendingToolCalls) {
				const rawArgsStr = pending.args.join('');
				let toolName = pending.name?.trim() || toolIndexToExplicitName.get(idx) || toolIndexToName.get(idx);
				if (!toolName) {
					toolName = inferToolNameFromRaw(rawArgsStr);
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
				const argsObj = coerceToolArgs(rawArgsStr, toolName);

				if (!Object.hasOwn(argsObj, 'explanation')) {
					const argsPreview = Object.keys(argsObj).slice(0, 3).join(', ');
					argsObj['explanation'] = `Calling ${toolName}${argsPreview ? ` with ${argsPreview}` : ''}`;
				}

				progress.report(new vscode.LanguageModelToolCallPart(pending.id, toolName, argsObj));
				this._outputChannel.appendLine(`[ollama-dev] (llama.cpp) -> tool_call[${idx}] ${toolName}(${JSON.stringify(argsObj).substring(0, 200)}${JSON.stringify(argsObj).length > 200 ? '...' : ''})`);
			}
			pendingToolCalls.clear();
		};

		this._outputChannel.appendLine(`[ollama-dev] (llama.cpp) REQUEST ${requestId}`);
		this._outputChannel.appendLine(`[ollama-dev] Patch: ${LLAMA_CPP_PATCH_MARKER}`);
		this._outputChannel.appendLine(`[ollama-dev] Endpoint: ${endpoint}/v1/chat/completions`);
		this._outputChannel.appendLine(`[ollama-dev] Model: ${model.name}`);
		this._outputChannel.appendLine(`[ollama-dev] Messages: raw=${oaMessages.length}, final=${normalizedOaMessages.length}`);
		this._outputChannel.appendLine(`[ollama-dev] Tools: ${oaTools?.length ?? 0}`);
		const roleTrace = normalizedOaMessages.slice(0, 120).map((m, i) => {
			const toolCallsLen = m.role === 'assistant' && m.tool_calls ? m.tool_calls.length : 0;
			const hasToolCallsProp = m.role === 'assistant' && Object.prototype.hasOwnProperty.call(m, 'tool_calls');
			return `[${i}] ${m.role}${toolCallsLen ? `(tool_calls:${toolCallsLen})` : ''}${hasToolCallsProp && !toolCallsLen ? '(tool_calls:0)' : ''}`;
		}).join(' ');
		this._outputChannel.appendLine(`[ollama-dev] Role trace (first 120): ${roleTrace}`);
		this._outputChannel.appendLine(`[ollama-dev] ----------------------------------------------------------------------`);

		let toolCallCounter = 0;
		const toolIndexToId = new Map<number, string>();
		const toolIdToIndex = new Map<string, number>();
		const toolIndexToName = new Map<number, string>();
		const toolIndexToExplicitName = new Map<number, string>();
		let lastOpenToolIndex: number | undefined;
		const startTime = Date.now();

		try {
			await httpStreamRequest(
				`${endpoint}/v1/chat/completions`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(requestBody)
				},
				(chunk: string) => {
					const lines = chunk.split('\n').filter((line: string) => line.trim().startsWith('data:'));
					for (const line of lines) {
						const payload = line.replace(/^data:\s*/, '').trim();
						if (!payload || payload === '[DONE]') {
							continue;
						}
						try {
							const parsed = JSON.parse(payload) as OpenAIStreamChunk;
							const choice = parsed.choices?.[0];
							const delta = choice?.delta;

							if (delta?.content) {
								progress.report(new vscode.LanguageModelTextPart(delta.content));
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
										const inferredName = rawName || toolIndexToName.get(idx) || inferToolNameFromRaw(rawArgs);
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
										const inferredName = inferToolNameFromRaw(rawArgs);
										if (inferredName) {
											pending.name = inferredName;
											toolIndexToName.set(idx, inferredName);
										}
									}

									if (rawArgs) {
										pending.args.push(rawArgs);
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
						} catch (err) {
							// Skip malformed chunks
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
			this._outputChannel.appendLine(`[ollama-dev] Patch: ${LLAMA_CPP_PATCH_MARKER}`);
			this._outputChannel.appendLine(`[ollama-dev] Error: ${message}`);
			if (pendingToolCalls.size > 0) {
				flushPendingToolCalls('error');
				lastOpenToolIndex = undefined;
			}
			const finalViolation = getLlamaCppAlternationViolation(normalizedOaMessages);
			this._outputChannel.appendLine(`[ollama-dev] Final alternation check: ${finalViolation ?? 'ok'}`);
			const trace = normalizedOaMessages.slice(0, 80).map((m, i) => {
				const toolCallsLen = m.role === 'assistant' && m.tool_calls ? m.tool_calls.length : 0;
				const hasToolCalls = m.role === 'assistant' && toolCallsLen > 0;
				const hasToolCallsProp = m.role === 'assistant' && Object.prototype.hasOwnProperty.call(m, 'tool_calls');
				const toolId = m.role === 'tool' ? (m.tool_call_id ?? '?') : '';
				const extra = m.role === 'assistant' ? `${hasToolCalls ? '(tool_calls)' : ''}${hasToolCallsProp && toolCallsLen === 0 ? '(tool_calls:0)' : ''}` : '';
				return `[${i}] ${m.role}${extra}${toolId ? `(${toolId})` : ''}`;
			}).join(' ');
			this._outputChannel.appendLine(`[ollama-dev] Final role trace (first 80): ${trace}`);
			throw error;
		}
	}

	async provideTokenCount(_model: OllamaModelInfo, text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
		// Rough estimate: ~4 chars per token
		if (typeof text === 'string') {
			return Math.ceil(text.length / 4);
		}
		let totalChars = 0;
		for (const part of text.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				totalChars += part.value.length;
			}
		}
		return Math.ceil(totalChars / 4);
	}

	dispose(): void {
		this._disposables.forEach(d => d.dispose());
		this._onDidChange.dispose();
	}
}

let provider: OllamaLanguageModelProvider | undefined;
let sshTunnel: SshTunnel | undefined;
let outputChannel: vscode.OutputChannel | undefined;

/**
 * Silently attempt to connect SSH tunnel using stored configuration.
 * Returns true if connected, false if no config or connection failed.
 */
async function silentConnect(): Promise<boolean> {
	const config = vscode.workspace.getConfiguration();
	const connectionMode = (config.get<string>(OLLAMA_CONNECTION_MODE_CONFIG) as ConnectionMode) || 'ssh';
	const localEndpoint = config.get<string>(OLLAMA_LOCAL_ENDPOINT_CONFIG) || 'http://127.0.0.1:11434';

	if (connectionMode === 'local') {
		outputChannel?.appendLine(`[ollama-dev] Connection mode is 'local' - using ${localEndpoint}`);
		provider?.setConnectionMode('local', localEndpoint);
		return true;
	}

	const remoteHost = config.get<string>(OLLAMA_REMOTE_HOST_CONFIG);

	if (!remoteHost) {
		outputChannel?.appendLine('[ollama-dev] No remote host configured, skipping auto-connect');
		return false;
	}

	const remotePort = config.get<number>(OLLAMA_REMOTE_PORT_CONFIG) || 11434;
	const localPort = config.get<number>(OLLAMA_LOCAL_PORT_CONFIG) || 43134;

	outputChannel?.appendLine(`[ollama-dev] Auto-connecting to ${remoteHost}...`);

	const connected = await sshTunnel!.connect(remoteHost, remotePort, localPort);

	if (connected) {
		outputChannel?.appendLine(`[ollama-dev] Auto-connected to ${remoteHost}`);
		provider!.setLocalPort(localPort);
		provider!.setConnectionMode('ssh');
		return true;
	} else {
		outputChannel?.appendLine(`[ollama-dev] Auto-connect failed for ${remoteHost}`);
		return false;
	}
}

async function promptAndConnect(context: vscode.ExtensionContext): Promise<boolean> {
	const config = vscode.workspace.getConfiguration();
	const connectionMode = (config.get<string>(OLLAMA_CONNECTION_MODE_CONFIG) as ConnectionMode) || 'ssh';

	if (connectionMode === 'local') {
		const endpoint = config.get<string>(OLLAMA_LOCAL_ENDPOINT_CONFIG) || 'http://127.0.0.1:11434';
		provider?.setConnectionMode('local', endpoint);
		vscode.window.showInformationMessage(`Ollama: Using local endpoint ${endpoint}`);
		return true;
	}

	// Get stored or prompt for remote host
	let remoteHost = config.get<string>(OLLAMA_REMOTE_HOST_CONFIG);
	if (!remoteHost) {
		remoteHost = await vscode.window.showInputBox({
			title: 'Ollama Remote Host',
			prompt: 'Enter the SSH host for the remote Ollama server (e.g., user@192.168.1.100)',
			placeHolder: 'user@hostname-or-ip',
			ignoreFocusOut: true
		});

		if (!remoteHost) {
			vscode.window.showWarningMessage('Ollama: No remote host specified');
			return false;
		}

		// Save the configuration
		await config.update(OLLAMA_REMOTE_HOST_CONFIG, remoteHost, vscode.ConfigurationTarget.Global);
	}

	const remotePort = config.get<number>(OLLAMA_REMOTE_PORT_CONFIG) || 11434;
	const localPort = config.get<number>(OLLAMA_LOCAL_PORT_CONFIG) || 43134;

	// Connect SSH tunnel
	const connected = await sshTunnel!.connect(remoteHost, remotePort, localPort);

	if (connected) {
		vscode.window.showInformationMessage(`Ollama: Connected to ${remoteHost}`);
		provider!.setLocalPort(localPort);
		return true;
	} else {
		const retry = await vscode.window.showErrorMessage(
			`Failed to connect to ${remoteHost}. Check the Output panel for details.`,
			'Retry', 'Change Host', 'Cancel'
		);

		if (retry === 'Retry') {
			return promptAndConnect(context);
		} else if (retry === 'Change Host') {
			await config.update(OLLAMA_REMOTE_HOST_CONFIG, undefined, vscode.ConfigurationTarget.Global);
			return promptAndConnect(context);
		}
		return false;
	}
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	outputChannel = vscode.window.createOutputChannel('Ollama Dev');
	context.subscriptions.push(outputChannel);

	outputChannel.appendLine('[ollama-dev] Activating Ollama language model provider');
	outputChannel.appendLine(`[ollama-dev] Patch: ${LLAMA_CPP_PATCH_MARKER} (source=${__filename})`);

	sshTunnel = new SshTunnel(outputChannel);
	context.subscriptions.push(sshTunnel);

	provider = new OllamaLanguageModelProvider(outputChannel, sshTunnel);

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand('ollamaDev.connect', () => promptAndConnect(context)),
		vscode.commands.registerCommand('ollamaDev.disconnect', () => {
			sshTunnel?.disconnect();
			vscode.window.showInformationMessage('Ollama: Disconnected');
		}),
		vscode.commands.registerCommand('ollamaDev.reconnect', async () => {
			sshTunnel?.disconnect();
			await promptAndConnect(context);
		}),
		vscode.commands.registerCommand('ollamaDev.changeHost', async () => {
			const config = vscode.workspace.getConfiguration();
			await config.update(OLLAMA_REMOTE_HOST_CONFIG, undefined, vscode.ConfigurationTarget.Global);
			sshTunnel?.disconnect();
			await promptAndConnect(context);
		}),
		vscode.commands.registerCommand('ollamaDev.toggleConnectionMode', async () => {
			const config = vscode.workspace.getConfiguration();
			const current = (config.get<string>(OLLAMA_CONNECTION_MODE_CONFIG) as ConnectionMode) || 'ssh';
			const next = current === 'ssh' ? 'local' : 'ssh';
			await config.update(OLLAMA_CONNECTION_MODE_CONFIG, next, vscode.ConfigurationTarget.Global);
			if (next === 'local') {
				const endpoint = config.get<string>(OLLAMA_LOCAL_ENDPOINT_CONFIG) || 'http://127.0.0.1:11434';
				provider?.setConnectionMode('local', endpoint);
				sshTunnel?.disconnect();
				vscode.window.showInformationMessage(`Ollama: Switched to local mode (${endpoint})`);
			} else {
				vscode.window.showInformationMessage('Ollama: Switched to SSH mode. Use "Ollama: Connect to Remote" to connect.');
			}
		})
	);

	// Register the language model provider
	const registration = vscode.lm.registerLanguageModelChatProvider('ollama', {
		onDidChangeLanguageModelChatInformation: provider.onDidChangeLanguageModelChatInformation,
		provideLanguageModelChatInformation: (options, token) => provider!.provideLanguageModelChatInformation(options, token),
		provideLanguageModelChatResponse: (model, messages, options, progress, token) =>
			provider!.provideLanguageModelChatResponse(model as OllamaModelInfo, messages, options, progress, token),
		provideTokenCount: (model, text, token) => provider!.provideTokenCount(model as OllamaModelInfo, text, token)
	});

	context.subscriptions.push(registration);
	context.subscriptions.push(provider);

	// Auto-connect on activation (silent - no prompts)
	const connected = await silentConnect();
	if (!connected) {
		outputChannel.appendLine('[ollama-dev] Auto-connect not available. Use "Ollama: Connect to Remote" command to connect.');
	}

	outputChannel.appendLine('[ollama-dev] Ollama language model provider registered');
}

export function deactivate(): void {
	sshTunnel?.dispose();
	provider?.dispose();
	provider = undefined;
	sshTunnel = undefined;
}
