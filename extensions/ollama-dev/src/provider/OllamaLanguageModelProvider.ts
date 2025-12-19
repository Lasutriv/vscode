/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

import type { ApiMode, ConnectionMode } from '../common/constants';
import type { OllamaModelInfo } from '../common/ollamaTypes';
import type { BackendPart } from '../backends/backendTypes';
import { LlamaCppBackend } from '../backends/LlamaCppBackend';
import { OllamaBackend } from '../backends/OllamaBackend';
import type { SshTunnel } from '../ssh/SshTunnel';

export interface OllamaProviderConnectionOptions {
	localPort: number;
	connectionMode: ConnectionMode;
	localEndpoint: string;
}

export class OllamaLanguageModelProvider implements vscode.Disposable {
	private readonly _disposables: vscode.Disposable[] = [];
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

	private _cachedModels: OllamaModelInfo[] = [];
	private readonly _sshTunnel: SshTunnel;
	private readonly _outputChannel: vscode.OutputChannel;
	private readonly _ollamaBackend: OllamaBackend;
	private readonly _llamaCppBackend: LlamaCppBackend;
	private _localPort: number;
	private _connectionMode: ConnectionMode;
	private _localEndpoint: string;
	private _apiMode: ApiMode = 'ollama';

	constructor(outputChannel: vscode.OutputChannel, sshTunnel: SshTunnel, options: OllamaProviderConnectionOptions) {
		this._outputChannel = outputChannel;
		this._sshTunnel = sshTunnel;
		this._ollamaBackend = new OllamaBackend(this._outputChannel);
		this._llamaCppBackend = new LlamaCppBackend(this._outputChannel);
		this._localPort = options.localPort;
		this._connectionMode = options.connectionMode;
		this._localEndpoint = options.localEndpoint;
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
			this._outputChannel.appendLine('[ollama-dev] SSH tunnel not connected, cannot fetch models');
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
				const llamaResult = await this._llamaCppBackend.listModels(endpoint);
				if (llamaResult.isLlamaCpp) {
					forceLlamaEndpoint = true;
					this._apiMode = 'llamaCpp';
					this._cachedModels = llamaResult.models;
					return llamaResult.models;
				}
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
			this._outputChannel.appendLine('[ollama-dev] llama.cpp forced by endpoint but /v1/models returned no models. Skipping /api/tags.');
			return this._cachedModels;
		}

		// Only use /api/tags if not llama.cpp
		if (!forceLlamaEndpoint) {
			try {
				const ollamaResult = await this._ollamaBackend.listModels(endpoint);
				this._apiMode = ollamaResult.apiMode;
				this._cachedModels = ollamaResult.models;
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
		const reportPart = (part: BackendPart) => {
			switch (part.type) {
				case 'text':
					progress.report(new vscode.LanguageModelTextPart(part.value));
					break;
				case 'thinking':
					progress.report(new vscode.LanguageModelThinkingPart(part.value));
					break;
				case 'toolCall':
					progress.report(new vscode.LanguageModelToolCallPart(part.callId, part.name, part.input));
					break;
			}
		};

		if (isGguf || llamaHint) {
			this._apiMode = 'llamaCpp';
			return this._llamaCppBackend.provideChatResponse(endpoint, model, messages, options, reportPart, token);
		}
		return this._ollamaBackend.provideChatResponse(endpoint, model, messages, options, reportPart, token);
	}

	async provideTokenCount(_model: OllamaModelInfo, text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
		const endpoint = this.getEndpoint();
		const isGguf = _model.ollamaName.endsWith('.gguf') || _model.id.includes('.gguf');
		const llamaHint = endpoint.includes('8081') || endpoint.includes('llama.cpp') || this._apiMode === 'llamaCpp';

		if (isGguf || llamaHint) {
			this._apiMode = 'llamaCpp';
			return this._llamaCppBackend.provideTokenCount(endpoint, _model, text);
		}

		// Fallback: rough estimate for Ollama and unknown backends (~4 chars per token).
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
