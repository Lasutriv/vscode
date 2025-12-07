/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from './dispose';
import { generateUuid } from './uuid';


export interface ShowOptions {
	readonly preserveFocus?: boolean;
	readonly viewColumn?: vscode.ViewColumn;
}

interface ScreenshotResponse {
	readonly type: 'screenshotResult';
	readonly success: boolean;
	readonly data?: string;
	readonly error?: string;
}

interface ConsoleLogsResponse {
	readonly type: 'consoleLogsResult';
	readonly success: boolean;
	readonly url: string;
	readonly logs?: string[];
	readonly counts?: {
		log: number;
		info: number;
		warn: number;
		error: number;
	};
	readonly totalCount?: number;
	readonly error?: string;
}

export interface ConsoleCaptureResult {
	readonly success: boolean;
	readonly url: string;
	readonly logs?: string[];
	readonly counts?: {
		log: number;
		info: number;
		warn: number;
		error: number;
	};
	readonly totalCount?: number;
	readonly error?: string;
}

export class SimpleBrowserView extends Disposable {

	public static readonly viewType = 'simpleBrowser.view';
	private static readonly title = vscode.l10n.t("Simple Browser");

	private static getWebviewLocalResourceRoots(extensionUri: vscode.Uri): readonly vscode.Uri[] {
		return [
			vscode.Uri.joinPath(extensionUri, 'media')
		];
	}

	private static getWebviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
		return {
			enableScripts: true,
			enableForms: true,
			localResourceRoots: SimpleBrowserView.getWebviewLocalResourceRoots(extensionUri),
		};
	}

	private readonly _webviewPanel: vscode.WebviewPanel;

	private readonly _onDidDispose = this._register(new vscode.EventEmitter<void>());
	public readonly onDispose = this._onDidDispose.event;

	private _pendingScreenshotResolve?: (value: string | undefined) => void;
	private _pendingConsoleLogsResolve?: (value: ConsoleCaptureResult) => void;

	public static create(
		extensionUri: vscode.Uri,
		url: string,
		showOptions?: ShowOptions
	): SimpleBrowserView {
		const webview = vscode.window.createWebviewPanel(SimpleBrowserView.viewType, SimpleBrowserView.title, {
			viewColumn: showOptions?.viewColumn ?? vscode.ViewColumn.Active,
			preserveFocus: showOptions?.preserveFocus
		}, {
			retainContextWhenHidden: true,
			...SimpleBrowserView.getWebviewOptions(extensionUri)
		});
		return new SimpleBrowserView(extensionUri, url, webview);
	}

	public static restore(
		extensionUri: vscode.Uri,
		url: string,
		webviewPanel: vscode.WebviewPanel,
	): SimpleBrowserView {
		return new SimpleBrowserView(extensionUri, url, webviewPanel);
	}

	private constructor(
		private readonly extensionUri: vscode.Uri,
		url: string,
		webviewPanel: vscode.WebviewPanel,
	) {
		super();

		this._webviewPanel = this._register(webviewPanel);
		this._webviewPanel.webview.options = SimpleBrowserView.getWebviewOptions(extensionUri);

		this._register(this._webviewPanel.webview.onDidReceiveMessage(e => {
			switch (e.type) {
				case 'openExternal':
					try {
						const url = vscode.Uri.parse(e.url);
						vscode.env.openExternal(url);
					} catch {
						// Noop
					}
					break;
				case 'screenshotResult':
					{
						const response = e as ScreenshotResponse;
						if (this._pendingScreenshotResolve) {
							this._pendingScreenshotResolve(response.success ? response.data : undefined);
							this._pendingScreenshotResolve = undefined;
						}
					}
					break;
				case 'printResult':
					{
						if (!e.success && e.error === 'cross-origin') {
							vscode.window.showWarningMessage(
								vscode.l10n.t("Cannot print cross-origin content. Please use the browser's built-in print function on the original page.")
							);
						}
					}
					break;
				case 'devToolsResult':
					{
						if (e.accessible) {
							vscode.window.showInformationMessage(
								vscode.l10n.t("DevTools info logged to console (View > Developer Tools > Console)")
							);
						} else {
							vscode.window.showWarningMessage(
								vscode.l10n.t("Cannot access iframe content due to cross-origin restrictions.\n\nTo inspect this page:\n1. Copy the URL from the address bar\n2. Open in external browser\n3. Use browser DevTools (F12)")
							);
						}
					}
					break;
				case 'consoleLogsResult':
					{
						const response = e as ConsoleLogsResponse;
						if (this._pendingConsoleLogsResolve) {
							this._pendingConsoleLogsResolve({
								success: response.success,
								url: response.url,
								logs: response.logs,
								counts: response.counts,
								totalCount: response.totalCount,
								error: response.error
							});
							this._pendingConsoleLogsResolve = undefined;
						}
					}
					break;
			}
		}));

		this._register(this._webviewPanel.onDidDispose(() => {
			this.dispose();
		}));

		this._register(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('simpleBrowser.focusLockIndicator.enabled')) {
				const configuration = vscode.workspace.getConfiguration('simpleBrowser');
				this._webviewPanel.webview.postMessage({
					type: 'didChangeFocusLockIndicatorEnabled',
					focusLockEnabled: configuration.get<boolean>('focusLockIndicator.enabled', true)
				});
			}
		}));

		this.show(url);
	}

	public override dispose() {
		this._onDidDispose.fire();
		super.dispose();
	}

	public show(url: string, options?: ShowOptions) {
		this._webviewPanel.webview.html = this.getHtml(url);
		this._webviewPanel.reveal(options?.viewColumn, options?.preserveFocus);
	}

	// Screenshot Page
	public async screenshotPage(): Promise<string | undefined> {
		return new Promise((resolve) => {
			this._pendingScreenshotResolve = resolve;

			// Set a timeout in case the webview doesn't respond
			setTimeout(() => {
				if (this._pendingScreenshotResolve) {
					this._pendingScreenshotResolve(undefined);
					this._pendingScreenshotResolve = undefined;
				}
			}, 10000);

			this._webviewPanel.webview.postMessage({ type: 'requestScreenshot' });
		});
	}

	// Zoom
	public zoom(direction: 'in' | 'out' | 'reset'): void {
		this._webviewPanel.webview.postMessage({ type: 'zoom', direction });
	}

	// Print Page
	public printPage(): void {
		this._webviewPanel.webview.postMessage({ type: 'printPage' });
	}

	// Toggle DevTools
	public toggleDevTools(): void {
		this._webviewPanel.webview.postMessage({ type: 'toggleDevTools' });
	}

	// Page Search
	public pageSearch(): void {
		this._webviewPanel.webview.postMessage({ type: 'pageSearch' });
	}

	// Capture Console Logs (webview fallback)
	public async captureConsoleLogs(): Promise<ConsoleCaptureResult> {
		return new Promise((resolve) => {
			this._pendingConsoleLogsResolve = resolve;

			// Set a timeout in case the webview doesn't respond
			setTimeout(() => {
				if (this._pendingConsoleLogsResolve) {
					this._pendingConsoleLogsResolve({
						success: false,
						url: '',
						error: 'timeout'
					});
					this._pendingConsoleLogsResolve = undefined;
				}
			}, 5000);

			this._webviewPanel.webview.postMessage({ type: 'captureConsole' });
		});
	}

	private getHtml(url: string) {
		const configuration = vscode.workspace.getConfiguration('simpleBrowser');

		const nonce = generateUuid();

		const mainJs = this.extensionResourceUrl('media', 'index.js');
		const mainCss = this.extensionResourceUrl('media', 'main.css');
		const codiconsUri = this.extensionResourceUrl('media', 'codicon.css');

		return /* html */ `<!DOCTYPE html>
			<html>
			<head>
				<meta http-equiv="Content-type" content="text/html;charset=UTF-8">

				<meta http-equiv="Content-Security-Policy" content="
					default-src 'none';
					font-src data:;
					style-src ${this._webviewPanel.webview.cspSource};
					script-src 'nonce-${nonce}';
					frame-src *;
					">

				<meta id="simple-browser-settings" data-settings="${escapeAttribute(JSON.stringify({
			url: url,
			focusLockEnabled: configuration.get<boolean>('focusLockIndicator.enabled', true)
		}))}">

				<link rel="stylesheet" type="text/css" href="${mainCss}">
				<link rel="stylesheet" type="text/css" href="${codiconsUri}">
			</head>
			<body>
				<header class="header">
					<nav class="controls">
						<button
							title="${vscode.l10n.t("Back")}"
							class="back-button icon"><i class="codicon codicon-arrow-left"></i></button>

						<button
							title="${vscode.l10n.t("Forward")}"
							class="forward-button icon"><i class="codicon codicon-arrow-right"></i></button>

						<button
							title="${vscode.l10n.t("Reload")}"
							class="reload-button icon"><i class="codicon codicon-refresh"></i></button>
					</nav>

					<input class="url-input" type="text">

					<nav class="controls">
						<button
							title="${vscode.l10n.t("Open in browser")}"
							class="open-external-button icon"><i class="codicon codicon-link-external"></i></button>
					</nav>
				</header>
				<div class="content">
					<div class="iframe-focused-alert">${vscode.l10n.t("Focus Lock")}</div>
					<iframe sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"></iframe>
				</div>

				<script src="${mainJs}" nonce="${nonce}"></script>
			</body>
			</html>`;
	}

	private extensionResourceUrl(...parts: string[]): vscode.Uri {
		return this._webviewPanel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...parts));
	}
}

function escapeAttribute(value: string | vscode.Uri): string {
	return value.toString().replace(/"/g, '&quot;');
}
