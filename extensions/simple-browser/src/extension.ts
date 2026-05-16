/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SimpleBrowserManager } from './simpleBrowserManager';
import { SimpleBrowserView } from './simpleBrowserView';

declare class URL {
	constructor(input: string, base?: string | URL);
	hostname: string;
}

const openApiCommand = 'simpleBrowser.api.open';
const showCommand = 'simpleBrowser.show';
const integratedBrowserCommand = 'workbench.action.browser.open';

// Toolbar commands
const screenshotCommand = 'simpleBrowser.screenshotPage';
const screenshotEditorCommand = 'simpleBrowser.screenshotEditor';
const zoomInCommand = 'simpleBrowser.zoomIn';
const zoomOutCommand = 'simpleBrowser.zoomOut';
const zoomResetCommand = 'simpleBrowser.zoomReset';
const printPageCommand = 'simpleBrowser.printPage';
const toggleDevToolsCommand = 'simpleBrowser.toggleDevTools';
const pageSearchCommand = 'simpleBrowser.pageSearch';
const captureConsoleCommand = 'simpleBrowser.captureConsole';
const getConsoleLogsCommand = 'simpleBrowser.getConsoleLogs';

const enabledHosts = new Set<string>([
	'localhost',
	// localhost IPv4
	'127.0.0.1',
	// localhost IPv6
	'[0:0:0:0:0:0:0:1]',
	'[::1]',
	// all interfaces IPv4
	'0.0.0.0',
	// all interfaces IPv6
	'[0:0:0:0:0:0:0:0]',
	'[::]'
]);

const openerId = 'simpleBrowser.open';

/**
 * Checks if the integrated browser should be used instead of the simple browser
 */
async function shouldUseIntegratedBrowser(): Promise<boolean> {
	const commands = await vscode.commands.getCommands(true);
	return commands.includes(integratedBrowserCommand);
}

/**
 * Opens a URL in the integrated browser
 */
async function openInIntegratedBrowser(url?: string): Promise<void> {
	await vscode.commands.executeCommand(integratedBrowserCommand, url);
}

export function activate(context: vscode.ExtensionContext) {

	const manager = new SimpleBrowserManager(context.extensionUri);
	context.subscriptions.push(manager);

	context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(SimpleBrowserView.viewType, {
		deserializeWebviewPanel: async (panel, state) => {
			manager.restore(panel, state);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand(showCommand, async (url?: string) => {
		if (await shouldUseIntegratedBrowser()) {
			return openInIntegratedBrowser(url);
		}

		if (!url) {
			url = await vscode.window.showInputBox({
				placeHolder: vscode.l10n.t("https://example.com"),
				prompt: vscode.l10n.t("Enter url to visit")
			});
		}

		if (url) {
			manager.show(url);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand(openApiCommand, async (url: vscode.Uri, showOptions?: {
		preserveFocus?: boolean;
		viewColumn: vscode.ViewColumn;
	}) => {
		if (await shouldUseIntegratedBrowser()) {
			await openInIntegratedBrowser(url.toString(true));
		} else {
			manager.show(url, showOptions);
		}
	}));

	context.subscriptions.push(vscode.window.registerExternalUriOpener(openerId, {
		canOpenExternalUri(uri: vscode.Uri) {
			// We have to replace the IPv6 hosts with IPv4 because URL can't handle IPv6.
			const originalUri = new URL(uri.toString(true));
			if (enabledHosts.has(originalUri.hostname)) {
				return isWeb()
					? vscode.ExternalUriOpenerPriority.Default
					: vscode.ExternalUriOpenerPriority.Option;
			}

			return vscode.ExternalUriOpenerPriority.None;
		},
		async openExternalUri(resolveUri: vscode.Uri) {
			if (await shouldUseIntegratedBrowser()) {
				await openInIntegratedBrowser(resolveUri.toString(true));
			} else {
				return manager.show(resolveUri, {
					viewColumn: vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active
				});
			}
		}
	}, {
		schemes: ['http', 'https'],
		label: vscode.l10n.t("Open in simple browser"),
	}));

	// Screenshot Page Command - captures only the Simple Browser content using native API with bounds
	context.subscriptions.push(vscode.commands.registerCommand(screenshotCommand, async () => {
		const activeView = manager.activeView;
		if (!activeView) {
			vscode.window.showWarningMessage(vscode.l10n.t("No Simple Browser is currently active"));
			return;
		}

		try {
			// Use the workbench-level command with browserOnly option
			// This captures the editor container bounds using native Electron screenshot APIs
			await vscode.commands.executeCommand<boolean>('simpleBrowser.screenshotToChat', { browserOnly: true });
		} catch (error) {
			vscode.window.showErrorMessage(vscode.l10n.t("Failed to capture screenshot: {0}", String(error)));
		}
	}));

	// Screenshot Editor Command - captures full editor window using native Electron API
	context.subscriptions.push(vscode.commands.registerCommand(screenshotEditorCommand, async () => {
		const activeView = manager.activeView;
		if (!activeView) {
			vscode.window.showWarningMessage(vscode.l10n.t("No Simple Browser is currently active"));
			return;
		}

		try {
			// Use the workbench-level command without browserOnly to capture full window
			await vscode.commands.executeCommand<boolean>('simpleBrowser.screenshotToChat', { browserOnly: false });
		} catch (error) {
			vscode.window.showErrorMessage(vscode.l10n.t("Failed to capture screenshot: {0}", String(error)));
		}
	}));

	// Zoom In Command
	context.subscriptions.push(vscode.commands.registerCommand(zoomInCommand, () => {
		const activeView = manager.activeView;
		if (!activeView) {
			vscode.window.showWarningMessage(vscode.l10n.t("No Simple Browser is currently active"));
			return;
		}
		activeView.zoom('in');
	}));

	// Zoom Out Command
	context.subscriptions.push(vscode.commands.registerCommand(zoomOutCommand, () => {
		const activeView = manager.activeView;
		if (!activeView) {
			vscode.window.showWarningMessage(vscode.l10n.t("No Simple Browser is currently active"));
			return;
		}
		activeView.zoom('out');
	}));

	// Zoom Reset Command
	context.subscriptions.push(vscode.commands.registerCommand(zoomResetCommand, () => {
		const activeView = manager.activeView;
		if (!activeView) {
			vscode.window.showWarningMessage(vscode.l10n.t("No Simple Browser is currently active"));
			return;
		}
		activeView.zoom('reset');
	}));

	// Print Page Command
	context.subscriptions.push(vscode.commands.registerCommand(printPageCommand, () => {
		const activeView = manager.activeView;
		if (!activeView) {
			vscode.window.showWarningMessage(vscode.l10n.t("No Simple Browser is currently active"));
			return;
		}
		activeView.printPage();
	}));

	// Toggle DevTools Command
	context.subscriptions.push(vscode.commands.registerCommand(toggleDevToolsCommand, () => {
		const activeView = manager.activeView;
		if (!activeView) {
			vscode.window.showWarningMessage(vscode.l10n.t("No Simple Browser is currently active"));
			return;
		}
		activeView.toggleDevTools();
	}));

	// Page Search Command
	context.subscriptions.push(vscode.commands.registerCommand(pageSearchCommand, () => {
		const activeView = manager.activeView;
		if (!activeView) {
			vscode.window.showWarningMessage(vscode.l10n.t("No Simple Browser is currently active"));
			return;
		}
		activeView.pageSearch();
	}));

	// Capture Console Command - sends console logs to chat
	context.subscriptions.push(vscode.commands.registerCommand(captureConsoleCommand, async () => {
		const activeView = manager.activeView;
		if (!activeView) {
			vscode.window.showWarningMessage(vscode.l10n.t("No Simple Browser is currently active"));
			return;
		}

		try {
			// Use the workbench-level command to send console logs to chat
			await vscode.commands.executeCommand('simpleBrowser.consoleToChat');
		} catch (error) {
			vscode.window.showErrorMessage(vscode.l10n.t("Failed to capture console logs: {0}", String(error)));
		}
	}));

	// Get Console Logs Command - used as a fallback from workbench when CDP capture is unavailable
	context.subscriptions.push(vscode.commands.registerCommand(getConsoleLogsCommand, async () => {
		const activeView = manager.activeView;
		if (!activeView) {
			return { success: false, url: '', error: 'no-active-browser' };
		}

		return activeView.captureConsoleLogs();
	}));
}

function isWeb(): boolean {
	return !(typeof process === 'object' && !!process.versions.node) && vscode.env.uiKind === vscode.UIKind.Web;
}
