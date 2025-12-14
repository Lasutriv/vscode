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
	OLLAMA_REMOTE_HOST_CONFIG,
	OLLAMA_REMOTE_PORT_CONFIG,
	type ConnectionMode,
} from './common/constants';
import type { OllamaModelInfo } from './common/ollamaTypes';
import { OllamaLanguageModelProvider } from './provider/OllamaLanguageModelProvider';
import { SshTunnel } from './ssh/SshTunnel';

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
