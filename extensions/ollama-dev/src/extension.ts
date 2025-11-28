/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';

// Configuration keys
const OLLAMA_REMOTE_HOST_CONFIG = 'ollamaDev.remoteHost';
const OLLAMA_REMOTE_PORT_CONFIG = 'ollamaDev.remotePort';
const OLLAMA_LOCAL_PORT_CONFIG = 'ollamaDev.localPort';

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
		const reqOptions: http.RequestOptions = {
			hostname: urlObj.hostname,
			port: urlObj.port || 80,
			path: urlObj.pathname + urlObj.search,
			method: options.method,
			headers: options.headers || {},
			timeout: 300000 // 5 minute timeout for streaming
		};

		outputChannel?.appendLine(`[HTTP] Streaming request ${options.method} ${url}`);

		const req = http.request(reqOptions, (res) => {
			if (res.statusCode !== 200) {
				outputChannel?.appendLine(`[HTTP] Stream error: HTTP ${res.statusCode}`);
				reject(new Error(`HTTP ${res.statusCode}`));
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

	constructor(outputChannel: vscode.OutputChannel, sshTunnel: SshTunnel) {
		this._outputChannel = outputChannel;
		this._sshTunnel = sshTunnel;
		this._localPort = vscode.workspace.getConfiguration().get<number>(OLLAMA_LOCAL_PORT_CONFIG) || 43134;

		// Watch for configuration changes
		this._disposables.push(
			vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
				if (e.affectsConfiguration(OLLAMA_REMOTE_HOST_CONFIG) ||
					e.affectsConfiguration(OLLAMA_REMOTE_PORT_CONFIG) ||
					e.affectsConfiguration(OLLAMA_LOCAL_PORT_CONFIG)) {
					this._onDidChange.fire();
				}
			})
		);
	}

	private getEndpoint(): string {
		return `http://127.0.0.1:${this._localPort}`;
	}

	setLocalPort(port: number): void {
		this._localPort = port;
	}

	async provideLanguageModelChatInformation(_options: vscode.PrepareLanguageModelChatModelOptions, _token: vscode.CancellationToken): Promise<OllamaModelInfo[]> {
		if (!this._sshTunnel.isConnected) {
			this._outputChannel.appendLine(`[ollama-dev] SSH tunnel not connected, cannot fetch models`);
			return this._cachedModels;
		}

		const endpoint = this.getEndpoint();

		try {
			this._outputChannel.appendLine(`[ollama-dev] Fetching models from ${endpoint}/api/tags`);

			const response = await httpRequest(`${endpoint}/api/tags`, {
				method: 'GET',
				headers: { 'Content-Type': 'application/json' }
			}, this._outputChannel);

			if (response.status !== 200) {
				this._outputChannel.appendLine(`[ollama-dev] Failed to fetch models: HTTP ${response.status}`);
				return this._cachedModels;
			}

			const data = JSON.parse(response.body) as OllamaTagsResponse;

			this._cachedModels = data.models.map(model => ({
				id: `ollama/${model.name}`,
				name: model.name,
				vendor: 'ollama',
				ollamaName: model.name,
				family: model.details?.family || 'unknown',
				version: model.details?.parameter_size || '1.0',
				detail: '0x',  // Shows in "Multiplier" column - 0x cost since these are local models
				isUserSelectable: true,
				capabilities: {
					// Enable tool calling - Ollama supports native tool calling via the tools parameter
					toolCalling: true,
					agentMode: true,
					// Hint which edit tools the model supports
					// 'multi-find-replace': Find and replace multiple text snippets across documents
					// 'find-replace': Find and replace text in a document
					// These help VS Code know how to use the model for file editing
					editTools: ['multi-find-replace', 'find-replace'],
				},
				// IMPORTANT: Match advertised limits to actual num_ctx sent to Ollama
				// Using 128K context to avoid summarization triggering and context blow-up issues
				maxInputTokens: 131072,   // 128K context - must match num_ctx in request options
				maxOutputTokens: 16384    // 16K output limit
			}));

			// Log the model metadata for debugging
			this._outputChannel.appendLine(`[ollama-dev] Model metadata: ${JSON.stringify(this._cachedModels.map(m => ({
				id: m.id,
				maxInputTokens: m.maxInputTokens,
				maxOutputTokens: m.maxOutputTokens,
				toolCalling: m.capabilities?.toolCalling
			})), null, 2)}`);

			this._outputChannel.appendLine(`[ollama-dev] Found ${this._cachedModels.length} models: ${this._cachedModels.map(m => m.name).join(', ')}`);
			return this._cachedModels;

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
			return this._cachedModels;
		}
	}

	async provideLanguageModelChatResponse(
		model: OllamaModelInfo,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
		token: vscode.CancellationToken
	): Promise<void> {
		if (!this._sshTunnel.isConnected) {
			throw new Error('SSH tunnel not connected');
		}

		const endpoint = this.getEndpoint();
		const requestId = `req-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;

		// ===== DETAILED REQUEST LOGGING =====
		this._outputChannel.appendLine(`\n[ollama-dev] ═══════════════════════════════════════════════════════════════`);
		this._outputChannel.appendLine(`[ollama-dev] REQUEST ${requestId}`);
		this._outputChannel.appendLine(`[ollama-dev] ═══════════════════════════════════════════════════════════════`);
		this._outputChannel.appendLine(`[ollama-dev] Timestamp: ${new Date().toISOString()}`);
		this._outputChannel.appendLine(`[ollama-dev] Model: ${model.name} (${model.ollamaName})`);
		this._outputChannel.appendLine(`[ollama-dev] Model ID: ${model.id}`);
		this._outputChannel.appendLine(`[ollama-dev] Model Family: ${model.family}`);
		this._outputChannel.appendLine(`[ollama-dev] Endpoint: ${endpoint}/api/chat`);
		this._outputChannel.appendLine(`[ollama-dev] ───────────────────────────────────────────────────────────────`);

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
		this._outputChannel.appendLine(`[ollama-dev] ───────────────────────────────────────────────────────────────`);

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
		this._outputChannel.appendLine(`[ollama-dev] ───────────────────────────────────────────────────────────────`);

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
			messages: ollamaMessages,
			stream: true,
			tools: ollamaTools,
			keep_alive: '30m',  // Keep model loaded for 30 minutes to avoid reload delays
			...(isThinkingModel && { think: true }),  // Enable thinking for thinking models
			options: {
				num_ctx: 131072,  // Request 128K context window from Ollama
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
		this._outputChannel.appendLine(`[ollama-dev] ───────────────────────────────────────────────────────────────`);

		const requestStartTime = Date.now();

		try {
			let toolCallIdCounter = 0;
			let firstTokenReceived = false;
			let textTokenCount = 0;
			let toolCallCount = 0;
			let accumulatedContent = '';  // Accumulate content for Qwen3-Coder XML parsing
			const isQwen3Coder = isQwen3CoderModel(model.ollamaName);

			this._outputChannel.appendLine(`[ollama-dev] STREAMING RESPONSE...`);
			if (isQwen3Coder) {
				this._outputChannel.appendLine(`[ollama-dev]   [*] Qwen3-Coder detected - will parse XML tool call format`);
			}

			await httpStreamRequest(
				`${endpoint}/api/chat`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(requestBody)
				},
				(chunk: string) => {
					const lines = chunk.split('\n').filter((line: string) => line.trim());
					for (const line of lines) {
						try {
							const parsed = JSON.parse(line) as OllamaChatStreamChunk;

							// Track time to first token
							if (!firstTokenReceived && (parsed.message?.content || parsed.message?.tool_calls)) {
								firstTokenReceived = true;
								const timeToFirstToken = Date.now() - requestStartTime;
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
								toolCallCount += parsed.message.tool_calls.length;
								this._outputChannel.appendLine(`[ollama-dev]   🔧 Received ${parsed.message.tool_calls.length} tool call(s)`);
								for (const toolCall of parsed.message.tool_calls) {
									const callId = `ollama-tool-${toolCallIdCounter++}`;
									const toolArgs = toolCall.function.arguments;

									// Ensure tool call arguments have required 'explanation' field
									// Many VS Code tools require this field, and Ollama models sometimes omit it
									if (toolArgs && typeof toolArgs === 'object' && !Object.hasOwn(toolArgs, 'explanation')) {
										// Auto-generate an explanation from the tool name and args
										const argsPreview = Object.keys(toolArgs).slice(0, 3).join(', ');
										(toolArgs as Record<string, unknown>)['explanation'] = `Calling ${toolCall.function.name} with ${argsPreview}`;
										this._outputChannel.appendLine(`[ollama-dev]     [!] Added missing 'explanation' field`);
									}

									this._outputChannel.appendLine(`[ollama-dev]     → ${toolCall.function.name}(${JSON.stringify(toolArgs).substring(0, 200)}${JSON.stringify(toolArgs).length > 200 ? '...' : ''})`);
									progress.report(new vscode.LanguageModelToolCallPart(
										callId,
										toolCall.function.name,
										toolArgs
									));
								}
							}

							// When response is complete, parse any Qwen3-Coder XML tool calls
							if (parsed.done) {
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

											this._outputChannel.appendLine(`[ollama-dev]     → ${toolCall.name}(${JSON.stringify(toolArgs).substring(0, 200)}${JSON.stringify(toolArgs).length > 200 ? '...' : ''})`);
											progress.report(new vscode.LanguageModelToolCallPart(
												callId,
												toolCall.name,
												toolArgs
											));
										}

										// Stream any content that was before the first tool call
										const preToolContent = accumulatedContent.split('<tool_call>')[0].trim();
										if (preToolContent) {
											this._outputChannel.appendLine(`[ollama-dev]   📝 Pre-tool content: ${preToolContent.substring(0, 100)}...`);
											// Note: We already streamed this content above for non-tool-call parts
										}
									} else {
										this._outputChannel.appendLine(`[ollama-dev]   ⚠️ Found <tool_call> tags but failed to parse any tool calls`);
										this._outputChannel.appendLine(`[ollama-dev]   Content preview: ${accumulatedContent.substring(0, 500)}`);
									}
								}

								const totalDuration = Date.now() - requestStartTime;
								this._outputChannel.appendLine(`[ollama-dev] ───────────────────────────────────────────────────────────────`);
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
								this._outputChannel.appendLine(`[ollama-dev] ═══════════════════════════════════════════════════════════════\n`);
							}
						} catch {
							// Skip malformed JSON lines
						}
					}
				},
				token,
				this._outputChannel
			);

		} catch (error) {
			const errorDuration = Date.now() - requestStartTime;
			this._outputChannel.appendLine(`[ollama-dev] ───────────────────────────────────────────────────────────────`);
			this._outputChannel.appendLine(`[ollama-dev] REQUEST FAILED (${requestId})`);
			this._outputChannel.appendLine(`[ollama-dev]   Duration: ${errorDuration}ms`);
			this._outputChannel.appendLine(`[ollama-dev]   Error: ${error}`);
			this._outputChannel.appendLine(`[ollama-dev] ═══════════════════════════════════════════════════════════════\n`);
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
		return true;
	} else {
		outputChannel?.appendLine(`[ollama-dev] Auto-connect failed for ${remoteHost}`);
		return false;
	}
}

async function promptAndConnect(context: vscode.ExtensionContext): Promise<boolean> {
	const config = vscode.workspace.getConfiguration();

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
