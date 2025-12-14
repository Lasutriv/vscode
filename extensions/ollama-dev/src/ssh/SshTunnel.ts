/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';

export class SshTunnel implements vscode.Disposable {
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

		return new Promise(resolve => {
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
		return new Promise(resolve => {
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
			this._outputChannel.appendLine('[SSH] Disconnecting tunnel...');
			this._process.kill();
			this._process = undefined;
			this._isConnected = false;
		}
	}

	dispose(): void {
		this.disconnect();
	}
}
