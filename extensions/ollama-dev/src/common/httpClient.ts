/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as http from 'http';

// Helper function to make HTTP requests using Node.js http module
export function httpRequest(url: string, options: { method: string; headers?: Record<string, string>; body?: string }, outputChannel?: vscode.OutputChannel): Promise<{ status: number; body: string }> {
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

		const req = http.request(reqOptions, res => {
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
			outputChannel?.appendLine('[HTTP] Request timeout');
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
export function httpStreamRequest(
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

		const req = http.request(reqOptions, res => {
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
				outputChannel?.appendLine('[HTTP] Stream completed');
				resolve();
			});
		});

		req.on('timeout', () => {
			outputChannel?.appendLine('[HTTP] Stream timeout');
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
