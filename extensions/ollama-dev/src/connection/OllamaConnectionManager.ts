/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

import {
	OLLAMA_CONNECTION_MODE_CONFIG,
	OLLAMA_LOCAL_ENDPOINT_CONFIG,
	OLLAMA_LOCAL_PORT_CONFIG,
	OLLAMA_REMOTE_HOST_CONFIG,
	OLLAMA_REMOTE_PORT_CONFIG,
	type ConnectionMode,
} from '../common/constants';
import type { OllamaLanguageModelProvider } from '../provider/OllamaLanguageModelProvider';
import type { SshTunnel } from '../ssh/SshTunnel';

export class OllamaConnectionManager implements vscode.Disposable {
	private readonly _disposables: vscode.Disposable[] = [];
	private readonly _onDidChangeConnection = new vscode.EventEmitter<void>();
	readonly onDidChangeConnection = this._onDidChangeConnection.event;

	constructor(
		private readonly _outputChannel: vscode.OutputChannel,
		private readonly _sshTunnel: SshTunnel,
		private readonly _provider: OllamaLanguageModelProvider,
	) {
		this._disposables.push(this._onDidChangeConnection);

		this._applyConfigToProvider();

		this._disposables.push(
			vscode.workspace.onDidChangeConfiguration(e => {
				if (
					e.affectsConfiguration(OLLAMA_REMOTE_HOST_CONFIG) ||
					e.affectsConfiguration(OLLAMA_REMOTE_PORT_CONFIG) ||
					e.affectsConfiguration(OLLAMA_LOCAL_PORT_CONFIG) ||
					e.affectsConfiguration(OLLAMA_CONNECTION_MODE_CONFIG) ||
					e.affectsConfiguration(OLLAMA_LOCAL_ENDPOINT_CONFIG)
				) {
					this._applyConfigToProvider();
					this._onDidChangeConnection.fire();
				}
			})
		);
	}

	private _applyConfigToProvider(): void {
		const config = vscode.workspace.getConfiguration();
		const connectionMode = (config.get<string>(OLLAMA_CONNECTION_MODE_CONFIG) as ConnectionMode) || 'ssh';
		const localPort = config.get<number>(OLLAMA_LOCAL_PORT_CONFIG) || 43134;
		const localEndpoint = config.get<string>(OLLAMA_LOCAL_ENDPOINT_CONFIG) || 'http://127.0.0.1:11434';

		this._provider.setLocalPort(localPort);
		this._provider.setConnectionMode(connectionMode, localEndpoint);
	}

	private _getConfig(): {
		connectionMode: ConnectionMode;
		localEndpoint: string;
		localPort: number;
		remoteHost: string | undefined;
		remotePort: number;
	} {
		const config = vscode.workspace.getConfiguration();
		return {
			connectionMode: (config.get<string>(OLLAMA_CONNECTION_MODE_CONFIG) as ConnectionMode) || 'ssh',
			localEndpoint: config.get<string>(OLLAMA_LOCAL_ENDPOINT_CONFIG) || 'http://127.0.0.1:11434',
			localPort: config.get<number>(OLLAMA_LOCAL_PORT_CONFIG) || 43134,
			remoteHost: config.get<string>(OLLAMA_REMOTE_HOST_CONFIG),
			remotePort: config.get<number>(OLLAMA_REMOTE_PORT_CONFIG) || 11434,
		};
	}

	/**
	 * Attempts to connect using stored configuration.
	 * No user prompts.
	 */
	async connectFromConfig(): Promise<boolean> {
		const { connectionMode, localEndpoint, localPort, remoteHost, remotePort } = this._getConfig();

		if (connectionMode === 'local') {
			this._outputChannel.appendLine(`[ollama-dev] Connection mode is 'local' - using ${localEndpoint}`);
			this._provider.setConnectionMode('local', localEndpoint);
			this._onDidChangeConnection.fire();
			return true;
		}

		if (!remoteHost) {
			this._outputChannel.appendLine('[ollama-dev] No remote host configured, skipping auto-connect');
			return false;
		}

		this._outputChannel.appendLine(`[ollama-dev] Auto-connecting to ${remoteHost}...`);
		const connected = await this._sshTunnel.connect(remoteHost, remotePort, localPort);
		if (connected) {
			this._outputChannel.appendLine(`[ollama-dev] Auto-connected to ${remoteHost}`);
			this._provider.setLocalPort(localPort);
			this._provider.setConnectionMode('ssh');
			this._onDidChangeConnection.fire();
			return true;
		}

		this._outputChannel.appendLine(`[ollama-dev] Auto-connect failed for ${remoteHost}`);
		return false;
	}

	async connectInteractive(): Promise<boolean> {
		const { connectionMode } = this._getConfig();

		if (connectionMode === 'local') {
			const { localEndpoint } = this._getConfig();
			this._provider.setConnectionMode('local', localEndpoint);
			vscode.window.showInformationMessage(vscode.l10n.t('Ollama: Using local endpoint {0}', localEndpoint));
			this._onDidChangeConnection.fire();
			return true;
		}

		return this._promptAndConnect();
	}

	private async _promptAndConnect(): Promise<boolean> {
		const config = vscode.workspace.getConfiguration();
		let remoteHost = config.get<string>(OLLAMA_REMOTE_HOST_CONFIG);
		if (!remoteHost) {
			remoteHost = await vscode.window.showInputBox({
				title: vscode.l10n.t('Ollama Remote Host'),
				prompt: vscode.l10n.t('Enter the SSH host for the remote Ollama server (e.g., user@192.168.1.100)'),
				placeHolder: vscode.l10n.t('user@hostname-or-ip'),
				ignoreFocusOut: true
			});

			if (!remoteHost) {
				vscode.window.showWarningMessage(vscode.l10n.t('Ollama: No remote host specified'));
				return false;
			}

			await config.update(OLLAMA_REMOTE_HOST_CONFIG, remoteHost, vscode.ConfigurationTarget.Global);
		}

		const remotePort = config.get<number>(OLLAMA_REMOTE_PORT_CONFIG) || 11434;
		const localPort = config.get<number>(OLLAMA_LOCAL_PORT_CONFIG) || 43134;

		const connected = await this._sshTunnel.connect(remoteHost, remotePort, localPort);
		if (connected) {
			vscode.window.showInformationMessage(vscode.l10n.t('Ollama: Connected to {0}', remoteHost));
			this._provider.setLocalPort(localPort);
			this._provider.setConnectionMode('ssh');
			this._onDidChangeConnection.fire();
			return true;
		}

		const retryLabel = vscode.l10n.t('Retry');
		const changeHostLabel = vscode.l10n.t('Change Host');
		const cancelLabel = vscode.l10n.t('Cancel');

		const retry = await vscode.window.showErrorMessage(
			vscode.l10n.t('Failed to connect to {0}. Check the Output panel for details.', remoteHost),
			retryLabel, changeHostLabel, cancelLabel
		);

		if (retry === retryLabel) {
			return this._promptAndConnect();
		}

		if (retry === changeHostLabel) {
			await config.update(OLLAMA_REMOTE_HOST_CONFIG, undefined, vscode.ConfigurationTarget.Global);
			return this._promptAndConnect();
		}

		return false;
	}

	disconnect(): void {
		this._sshTunnel.disconnect();
		vscode.window.showInformationMessage(vscode.l10n.t('Ollama: Disconnected'));
		this._onDidChangeConnection.fire();
	}

	async reconnect(): Promise<boolean> {
		this._sshTunnel.disconnect();
		this._onDidChangeConnection.fire();
		return this.connectInteractive();
	}

	async changeHostAndConnect(): Promise<boolean> {
		const config = vscode.workspace.getConfiguration();
		await config.update(OLLAMA_REMOTE_HOST_CONFIG, undefined, vscode.ConfigurationTarget.Global);
		this._sshTunnel.disconnect();
		this._onDidChangeConnection.fire();
		return this.connectInteractive();
	}

	async toggleConnectionMode(): Promise<void> {
		const config = vscode.workspace.getConfiguration();
		const current = (config.get<string>(OLLAMA_CONNECTION_MODE_CONFIG) as ConnectionMode) || 'ssh';
		const next: ConnectionMode = current === 'ssh' ? 'local' : 'ssh';
		await config.update(OLLAMA_CONNECTION_MODE_CONFIG, next, vscode.ConfigurationTarget.Global);

		if (next === 'local') {
			const endpoint = config.get<string>(OLLAMA_LOCAL_ENDPOINT_CONFIG) || 'http://127.0.0.1:11434';
			this._provider.setConnectionMode('local', endpoint);
			this._sshTunnel.disconnect();
			vscode.window.showInformationMessage(vscode.l10n.t('Ollama: Switched to local mode ({0})', endpoint));
		} else {
			vscode.window.showInformationMessage(vscode.l10n.t('Ollama: Switched to SSH mode. Use "Ollama: Connect to Remote" to connect.'));
		}

		this._onDidChangeConnection.fire();
	}

	dispose(): void {
		this._sshTunnel.disconnect();
		for (const d of this._disposables) {
			d.dispose();
		}
		this._disposables.length = 0;
	}
}
