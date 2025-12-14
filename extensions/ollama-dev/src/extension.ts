/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

import {
	LLAMA_CPP_PATCH_MARKER,
	OLLAMA_CONNECTION_MODE_CONFIG,
	OLLAMA_LOCAL_ENDPOINT_CONFIG,
	OLLAMA_LOCAL_PORT_CONFIG,
	type ConnectionMode,
} from './common/constants';
import type { OllamaModelInfo } from './common/ollamaTypes';
import { OllamaConnectionManager } from './connection/OllamaConnectionManager';
import { OllamaLanguageModelProvider } from './provider/OllamaLanguageModelProvider';
import { SshTunnel } from './ssh/SshTunnel';

let provider: OllamaLanguageModelProvider | undefined;
let sshTunnel: SshTunnel | undefined;
let connectionManager: OllamaConnectionManager | undefined;
let outputChannel: vscode.OutputChannel | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	outputChannel = vscode.window.createOutputChannel(vscode.l10n.t('Ollama Dev'));
	context.subscriptions.push(outputChannel);

	outputChannel.appendLine('[ollama-dev] Activating Ollama language model provider');
	outputChannel.appendLine(`[ollama-dev] Patch: ${LLAMA_CPP_PATCH_MARKER} (source=${__filename})`);

	sshTunnel = new SshTunnel(outputChannel);
	context.subscriptions.push(sshTunnel);

	const config = vscode.workspace.getConfiguration();
	const initialConnectionMode = (config.get<string>(OLLAMA_CONNECTION_MODE_CONFIG) as ConnectionMode) || 'ssh';
	const initialLocalPort = config.get<number>(OLLAMA_LOCAL_PORT_CONFIG) || 43134;
	const initialLocalEndpoint = config.get<string>(OLLAMA_LOCAL_ENDPOINT_CONFIG) || 'http://127.0.0.1:11434';

	provider = new OllamaLanguageModelProvider(outputChannel, sshTunnel, {
		connectionMode: initialConnectionMode,
		localPort: initialLocalPort,
		localEndpoint: initialLocalEndpoint,
	});

	connectionManager = new OllamaConnectionManager(outputChannel, sshTunnel, provider);
	context.subscriptions.push(connectionManager);

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand('ollamaDev.connect', () => connectionManager?.connectInteractive()),
		vscode.commands.registerCommand('ollamaDev.disconnect', () => connectionManager?.disconnect()),
		vscode.commands.registerCommand('ollamaDev.reconnect', () => connectionManager?.reconnect()),
		vscode.commands.registerCommand('ollamaDev.changeHost', () => connectionManager?.changeHostAndConnect()),
		vscode.commands.registerCommand('ollamaDev.toggleConnectionMode', () => connectionManager?.toggleConnectionMode())
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
	const connected = await connectionManager.connectFromConfig();
	if (!connected) {
		outputChannel.appendLine('[ollama-dev] Auto-connect not available. Use "Ollama: Connect to Remote" command to connect.');
	}

	outputChannel.appendLine('[ollama-dev] Ollama language model provider registered');
}

export function deactivate(): void {
	connectionManager?.dispose();
	connectionManager = undefined;
	sshTunnel?.dispose();
	provider?.dispose();
	provider = undefined;
	sshTunnel = undefined;
}
