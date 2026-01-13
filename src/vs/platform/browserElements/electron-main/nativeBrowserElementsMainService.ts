/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrowserType, IConsoleLogEntry, IConsoleLogsResult, ICurrentUrlResult, IElementData, INativeBrowserElementsService, IBrowserTargetLocator } from '../common/browserElements.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { IRectangle } from '../../window/common/window.js';
import { BrowserWindow, webContents } from 'electron';
import { IAuxiliaryWindow } from '../../auxiliaryWindow/electron-main/auxiliaryWindow.js';
import { ICodeWindow } from '../../window/electron-main/window.js';
import { IAuxiliaryWindowsMainService } from '../../auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { IWindowsMainService } from '../../windows/electron-main/windows.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { AddFirstParameterToFunctions } from '../../../base/common/types.js';
import { IBrowserViewMainService } from '../../browserView/electron-main/browserViewMainService.js';
import { ILogService } from '../../log/common/log.js';

export const INativeBrowserElementsMainService = createDecorator<INativeBrowserElementsMainService>('browserElementsMainService');
export interface INativeBrowserElementsMainService extends AddFirstParameterToFunctions<INativeBrowserElementsService, Promise<unknown> /* only methods, not events */, number | undefined /* window ID */> { }

interface NodeDataResponse {
	outerHTML: string;
	computedStyle: string;
	bounds: IRectangle;
}

export class NativeBrowserElementsMainService extends Disposable implements INativeBrowserElementsMainService {
	_serviceBrand: undefined;

	constructor(
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@IAuxiliaryWindowsMainService private readonly auxiliaryWindowsMainService: IAuxiliaryWindowsMainService,
		@IBrowserViewMainService private readonly browserViewMainService: IBrowserViewMainService,
		@ILogService private readonly logService: ILogService
	) {
		super();
	}

	get windowId(): never { throw new Error('Not implemented in electron-main'); }

	/**
	 * Find the webview target that matches the given locator.
	 * Checks either webviewId or browserViewId depending on what's provided.
	 */
	async findWebviewTarget(debuggers: Electron.Debugger, locator: IBrowserTargetLocator): Promise<string | undefined> {
		const { targetInfos } = await debuggers.sendCommand('Target.getTargets');

		if (locator.webviewId) {
			let extensionId = '';
			for (const targetInfo of targetInfos) {
				try {
					const url = new URL(targetInfo.url);
					if (url.searchParams.get('id') === locator.webviewId) {
						extensionId = url.searchParams.get('extensionId') || '';
						break;
					}
				} catch (err) {
					// ignore
				}
			}
			if (!extensionId) {
				return undefined;
			}

			// search for webview via search parameters
			const target = targetInfos.find((targetInfo: { url: string }) => {
				try {
					const url = new URL(targetInfo.url);
					const isLiveServer = extensionId === 'ms-vscode.live-server' && url.searchParams.get('serverWindowId') === locator.webviewId;
					const isSimpleBrowser = extensionId === 'vscode.simple-browser' && url.searchParams.get('id') === locator.webviewId && url.searchParams.has('vscodeBrowserReqId');
					if (isLiveServer || isSimpleBrowser) {
						return true;
					}
					return false;
				} catch (e) {
					return false;
				}
			});
			return target?.targetId;
		}

		if (locator.browserViewId) {
			const webContentsInstance = this.browserViewMainService.tryGetBrowserView(locator.browserViewId)?.webContents;
			const target = targetInfos.find((targetInfo: { targetId: string; type: string }) => {
				if (targetInfo.type !== 'page') {
					return false;
				}

				return webContents.fromDevToolsTargetId(targetInfo.targetId) === webContentsInstance;
			});
			return target?.targetId;
		}

		return undefined;
	}

	async waitForWebviewTargets(debuggers: Electron.Debugger, locator: IBrowserTargetLocator): Promise<string | undefined> {
		const start = Date.now();
		const timeout = 10000;

		while (Date.now() - start < timeout) {
			const targetId = await this.findWebviewTarget(debuggers, locator);
			if (targetId) {
				return targetId;
			}

			// Wait for a short period before checking again
			await new Promise(resolve => setTimeout(resolve, 500));
		}

		debuggers.detach();
		return undefined;
	}

	async startDebugSession(windowId: number | undefined, token: CancellationToken, locator: IBrowserTargetLocator, cancelAndDetachId?: number): Promise<void> {
		const window = this.windowById(windowId);
		if (!window?.win) {
			return undefined;
		}

		// Find the simple browser webview
		const allWebContents = webContents.getAllWebContents();
		const simpleBrowserWebview = allWebContents.find(webContent => webContent.id === window.id);

		if (!simpleBrowserWebview) {
			return undefined;
		}

		const debuggers = simpleBrowserWebview.debugger;
		if (!debuggers.isAttached()) {
			debuggers.attach();
		}

		try {
			const matchingTargetId = await this.waitForWebviewTargets(debuggers, locator);
			if (!matchingTargetId) {
				if (debuggers.isAttached()) {
					debuggers.detach();
				}
				throw new Error('No target found');
			}

		} catch (e) {
			if (debuggers.isAttached()) {
				debuggers.detach();
			}
			throw new Error('No target found');
		}

		window.win.webContents.on('ipc-message', async (event, channel, closedCancelAndDetachId) => {
			if (channel === `vscode:cancelCurrentSession${cancelAndDetachId}`) {
				if (cancelAndDetachId !== closedCancelAndDetachId) {
					return;
				}
				if (debuggers.isAttached()) {
					debuggers.detach();
				}
				if (window.win) {
					window.win.webContents.removeAllListeners('ipc-message');
				}
			}
		});
	}

	async finishOverlay(debuggers: Electron.Debugger, sessionId: string | undefined): Promise<void> {
		if (debuggers.isAttached() && sessionId) {
			await debuggers.sendCommand('Overlay.setInspectMode', {
				mode: 'none',
				highlightConfig: {
					showInfo: false,
					showStyles: false
				}
			}, sessionId);
			await debuggers.sendCommand('Overlay.hideHighlight', {}, sessionId);
			await debuggers.sendCommand('Overlay.disable', {}, sessionId);
			debuggers.detach();
		}
	}

	async getElementData(windowId: number | undefined, rect: IRectangle, token: CancellationToken, locator: IBrowserTargetLocator, cancellationId?: number): Promise<IElementData | undefined> {
		const window = this.windowById(windowId);
		if (!window?.win) {
			return undefined;
		}

		// Find the simple browser webview
		const allWebContents = webContents.getAllWebContents();
		const simpleBrowserWebview = allWebContents.find(webContent => webContent.id === window.id);

		if (!simpleBrowserWebview) {
			return undefined;
		}

		const debuggers = simpleBrowserWebview.debugger;
		if (!debuggers.isAttached()) {
			debuggers.attach();
		}

		let targetSessionId: string | undefined = undefined;
		try {
			const targetId = await this.findWebviewTarget(debuggers, locator);
			const { sessionId } = await debuggers.sendCommand('Target.attachToTarget', {
				targetId: targetId,
				flatten: true,
			});

			targetSessionId = sessionId;

			await debuggers.sendCommand('DOM.enable', {}, sessionId);
			await debuggers.sendCommand('CSS.enable', {}, sessionId);
			await debuggers.sendCommand('Overlay.enable', {}, sessionId);
			await debuggers.sendCommand('Debugger.enable', {}, sessionId);
			await debuggers.sendCommand('Runtime.enable', {}, sessionId);

			await debuggers.sendCommand('Runtime.evaluate', {
				expression: `(function() {
							const style = document.createElement('style');
							style.id = '__pseudoBlocker__';
							style.textContent = '*::before, *::after { pointer-events: none !important; }';
							document.head.appendChild(style);
						})();`,
			}, sessionId);

			// slightly changed default CDP debugger inspect colors
			await debuggers.sendCommand('Overlay.setInspectMode', {
				mode: 'searchForNode',
				highlightConfig: {
					showInfo: true,
					showRulers: false,
					showStyles: true,
					showAccessibilityInfo: true,
					showExtensionLines: false,
					contrastAlgorithm: 'aa',
					contentColor: { r: 173, g: 216, b: 255, a: 0.8 },
					paddingColor: { r: 150, g: 200, b: 255, a: 0.5 },
					borderColor: { r: 120, g: 180, b: 255, a: 0.7 },
					marginColor: { r: 200, g: 220, b: 255, a: 0.4 },
					eventTargetColor: { r: 130, g: 160, b: 255, a: 0.8 },
					shapeColor: { r: 130, g: 160, b: 255, a: 0.8 },
					shapeMarginColor: { r: 130, g: 160, b: 255, a: 0.5 },
					gridHighlightConfig: {
						rowGapColor: { r: 140, g: 190, b: 255, a: 0.3 },
						rowHatchColor: { r: 140, g: 190, b: 255, a: 0.7 },
						columnGapColor: { r: 140, g: 190, b: 255, a: 0.3 },
						columnHatchColor: { r: 140, g: 190, b: 255, a: 0.7 },
						rowLineColor: { r: 120, g: 180, b: 255 },
						columnLineColor: { r: 120, g: 180, b: 255 },
						rowLineDash: true,
						columnLineDash: true
					},
					flexContainerHighlightConfig: {
						containerBorder: {
							color: { r: 120, g: 180, b: 255 },
							pattern: 'solid'
						},
						itemSeparator: {
							color: { r: 140, g: 190, b: 255 },
							pattern: 'solid'
						},
						lineSeparator: {
							color: { r: 140, g: 190, b: 255 },
							pattern: 'solid'
						},
						mainDistributedSpace: {
							hatchColor: { r: 140, g: 190, b: 255, a: 0.7 },
							fillColor: { r: 140, g: 190, b: 255, a: 0.4 }
						},
						crossDistributedSpace: {
							hatchColor: { r: 140, g: 190, b: 255, a: 0.7 },
							fillColor: { r: 140, g: 190, b: 255, a: 0.4 }
						},
						rowGapSpace: {
							hatchColor: { r: 140, g: 190, b: 255, a: 0.7 },
							fillColor: { r: 140, g: 190, b: 255, a: 0.4 }
						},
						columnGapSpace: {
							hatchColor: { r: 140, g: 190, b: 255, a: 0.7 },
							fillColor: { r: 140, g: 190, b: 255, a: 0.4 }
						}
					},
					flexItemHighlightConfig: {
						baseSizeBox: {
							hatchColor: { r: 130, g: 170, b: 255, a: 0.6 }
						},
						baseSizeBorder: {
							color: { r: 120, g: 180, b: 255 },
							pattern: 'solid'
						},
						flexibilityArrow: {
							color: { r: 130, g: 190, b: 255 }
						}
					},
				},
			}, sessionId);
		} catch (e) {
			debuggers.detach();
			throw new Error('No target found', e);
		}

		if (!targetSessionId) {
			debuggers.detach();
			throw new Error('No target session id found');
		}

		const nodeData = await this.getNodeData(targetSessionId, debuggers, window.win, cancellationId);
		await this.finishOverlay(debuggers, targetSessionId);

		const zoomFactor = simpleBrowserWebview.getZoomFactor();
		const absoluteBounds = {
			x: rect.x + nodeData.bounds.x,
			y: rect.y + nodeData.bounds.y,
			width: nodeData.bounds.width,
			height: nodeData.bounds.height
		};

		const clippedBounds = {
			x: Math.max(absoluteBounds.x, rect.x),
			y: Math.max(absoluteBounds.y, rect.y),
			width: Math.max(0, Math.min(absoluteBounds.x + absoluteBounds.width, rect.x + rect.width) - Math.max(absoluteBounds.x, rect.x)),
			height: Math.max(0, Math.min(absoluteBounds.y + absoluteBounds.height, rect.y + rect.height) - Math.max(absoluteBounds.y, rect.y))
		};

		const scaledBounds = {
			x: clippedBounds.x * zoomFactor,
			y: clippedBounds.y * zoomFactor,
			width: clippedBounds.width * zoomFactor,
			height: clippedBounds.height * zoomFactor
		};

		return { outerHTML: nodeData.outerHTML, computedStyle: nodeData.computedStyle, bounds: scaledBounds };
	}

	private findHostWebviewContents(window: BrowserWindow, browserType: BrowserType): Electron.WebContents | undefined {
		const allWebContents = webContents.getAllWebContents();
		const hostId = window.webContents.id;

		const matchesBrowserType = (url: string) => {
			if (browserType === BrowserType.SimpleBrowser) {
				return url.includes('simple-browser');
			}
			if (browserType === BrowserType.LiveServer) {
				return url.includes('browser-preview') || url.includes('live-server');
			}
			return false;
		};

		let hostedWebview = allWebContents.find(webContent => {
			try {
				return webContent.getType?.() === 'webview'
					&& webContent.hostWebContents?.id === hostId
					&& matchesBrowserType(webContent.getURL());
			} catch {
				return false;
			}
		});

		// Fallback to old heuristic (in case hostWebContents is not set as expected)
		if (!hostedWebview) {
			hostedWebview = allWebContents.find(webContent => {
				try {
					return webContent.getType?.() === 'webview' && matchesBrowserType(webContent.getURL());
				} catch {
					return false;
				}
			});
		}

		return hostedWebview;
	}

	private tryParseUrl(value: string): URL | undefined {
		try {
			return new URL(value);
		} catch {
			return undefined;
		}
	}

	private findTargetIdForBrowserType(targetInfos: Array<{ targetId: string; url: string; type?: string }>, browserType: BrowserType, windowId: number): string | undefined {
		if (browserType === BrowserType.SimpleBrowser) {
			const candidates: Array<{ targetId: string; reqId?: number }> = [];
			for (const info of targetInfos) {
				const url = this.tryParseUrl(info.url);
				if (!url) {
					continue;
				}
				if (url.searchParams.get('extensionId') !== 'vscode.simple-browser') {
					continue;
				}
				if (!url.searchParams.has('vscodeBrowserReqId')) {
					continue;
				}
				const reqIdRaw = url.searchParams.get('vscodeBrowserReqId');
				const reqId = reqIdRaw ? Number(reqIdRaw) : undefined;
				candidates.push({ targetId: info.targetId, reqId: Number.isFinite(reqId) ? reqId : undefined });
			}

			candidates.sort((a, b) => (b.reqId ?? 0) - (a.reqId ?? 0));
			return candidates[0]?.targetId;
		}

		if (browserType === BrowserType.LiveServer) {
			for (const info of targetInfos) {
				const url = this.tryParseUrl(info.url);
				if (!url) {
					continue;
				}
				if (url.searchParams.get('extensionId') === 'ms-vscode.live-server' && url.searchParams.get('id')) {
					return info.targetId;
				}
				if (url.pathname.includes('browser-preview') || url.pathname.includes('live-server')) {
					return info.targetId;
				}
			}
		}

		// last resort: try to find anything that looks like a content page
		return targetInfos.find(t => t.type === 'page')?.targetId;
	}

	async getConsoleLogs(windowId: number | undefined, token: CancellationToken, browserType: BrowserType, durationMs: number = 3000): Promise<IConsoleLogsResult> {
		const window = this.windowById(windowId);
		if (!window?.win) {
			return { success: false, url: '', logs: [], error: 'Window not found' };
		}

		const hostedWebview = this.findHostWebviewContents(window.win, browserType);
		if (!hostedWebview) {
			return { success: false, url: '', logs: [], error: 'Browser webview not found' };
		}

		const debuggers = hostedWebview.debugger;
		const wasAttached = debuggers.isAttached();
		if (!wasAttached) {
			debuggers.attach();
		}

		let sessionId: string | undefined;
		let targetUrl = '';
		const logs: IConsoleLogEntry[] = [];
		try {
			const { targetInfos } = await debuggers.sendCommand('Target.getTargets') as unknown as { targetInfos: Array<{ targetId: string; url: string; type?: string }> };
			const targetId = this.findTargetIdForBrowserType(targetInfos, browserType, windowId ?? 0);
			if (!targetId) {
				return { success: false, url: '', logs: [], error: 'Could not find browser target' };
			}

			const attachResult = await debuggers.sendCommand('Target.attachToTarget', { targetId, flatten: true });
			sessionId = (attachResult as { sessionId: string }).sessionId;

			await debuggers.sendCommand('Runtime.enable', {}, sessionId);
			await debuggers.sendCommand('Log.enable', {}, sessionId);

			const { result } = await debuggers.sendCommand('Runtime.evaluate', { expression: 'window.location.href', returnByValue: true }, sessionId) as unknown as { result: { value?: string } };
			targetUrl = result?.value ?? '';

			type IConsoleMessageParams = {
				type?: string;
				args?: Array<{ type: string; value?: unknown; description?: string }>;
				timestamp?: number;
				stackTrace?: { callFrames?: Array<{ url: string; lineNumber: number; columnNumber: number }> };
				entry?: {
					level?: string;
					text?: string;
					timestamp?: number;
					url?: string;
					lineNumber?: number;
					stackTrace?: { callFrames?: Array<{ url: string; lineNumber: number; columnNumber: number }> };
				};
			};

			const onMessage = (event: Electron.Event, method: string, params: IConsoleMessageParams, messageSessionId?: string) => {
				if (messageSessionId !== sessionId) {
					return;
				}

				if (method === 'Runtime.consoleAPICalled') {
					const type = this.mapConsoleType(String(params.type ?? 'log'));
					const message = this.formatConsoleArgs(Array.isArray(params.args) ? params.args : []);
					const stackTrace = params.stackTrace?.callFrames?.[0];
					logs.push({
						type,
						timestamp: typeof params.timestamp === 'number' ? params.timestamp * 1000 : Date.now(),
						message,
						url: stackTrace?.url,
						lineNumber: stackTrace?.lineNumber,
						columnNumber: stackTrace?.columnNumber,
						stackTrace: params.stackTrace?.callFrames?.map(f => `  at ${f.url}:${f.lineNumber}:${f.columnNumber}`).join('\n'),
					});
					return;
				}

				if (method === 'Log.entryAdded') {
					const entry = params.entry;
					if (entry) {
						logs.push({
							type: this.mapLogLevel(String(entry.level ?? 'log')),
							timestamp: typeof entry.timestamp === 'number' ? entry.timestamp * 1000 : Date.now(),
							message: String(entry.text ?? ''),
							url: entry.url,
							lineNumber: entry.lineNumber,
							stackTrace: entry.stackTrace?.callFrames?.map(f => `  at ${f.url}:${f.lineNumber}:${f.columnNumber}`).join('\n'),
						});
					}
				}
			};

			debuggers.on('message', onMessage);
			try {
				await new Promise<void>(resolve => {
					const timeoutHandle = setTimeout(resolve, durationMs);
					const disposable = token.onCancellationRequested(() => {
						clearTimeout(timeoutHandle);
						disposable.dispose();
						resolve();
					});
				});
			} finally {
				debuggers.off('message', onMessage);
			}

			return { success: true, url: targetUrl, logs: logs.sort((a, b) => a.timestamp - b.timestamp) };
		} catch (error) {
			this.logService.error('[browserElements] getConsoleLogs: error', error);
			return { success: false, url: targetUrl, logs: [], error: String(error) };
		} finally {
			try {
				if (sessionId) {
					await debuggers.sendCommand('Target.detachFromTarget', { sessionId });
				}
			} catch {
				// ignore
			}
			if (!wasAttached && debuggers.isAttached()) {
				debuggers.detach();
			}
		}
	}

	async getCurrentUrl(windowId: number | undefined, token: CancellationToken, browserType: BrowserType): Promise<ICurrentUrlResult> {
		const window = this.windowById(windowId);
		if (!window?.win) {
			return { success: false, url: '', error: 'Window not found' };
		}

		const hostedWebview = this.findHostWebviewContents(window.win, browserType);
		if (!hostedWebview) {
			return { success: false, url: '', error: 'Browser webview not found' };
		}

		const debuggers = hostedWebview.debugger;
		const wasAttached = debuggers.isAttached();
		if (!wasAttached) {
			debuggers.attach();
		}

		let sessionId: string | undefined;
		try {
			const { targetInfos } = await debuggers.sendCommand('Target.getTargets') as unknown as { targetInfos: Array<{ targetId: string; url: string; type?: string }> };
			const targetId = this.findTargetIdForBrowserType(targetInfos, browserType, windowId ?? 0);
			if (!targetId) {
				return { success: false, url: '', error: 'Could not find browser target' };
			}

			const attachResult = await debuggers.sendCommand('Target.attachToTarget', { targetId, flatten: true });
			sessionId = (attachResult as { sessionId: string }).sessionId;
			await debuggers.sendCommand('Runtime.enable', {}, sessionId);
			const { result } = await debuggers.sendCommand('Runtime.evaluate', { expression: 'window.location.href', returnByValue: true }, sessionId) as unknown as { result: { value?: string } };
			return { success: true, url: result?.value ?? '' };
		} catch (error) {
			this.logService.error('[browserElements] getCurrentUrl: error', error);
			return { success: false, url: '', error: String(error) };
		} finally {
			try {
				if (sessionId) {
					await debuggers.sendCommand('Target.detachFromTarget', { sessionId });
				}
			} catch {
				// ignore
			}
			if (!wasAttached && debuggers.isAttached()) {
				debuggers.detach();
			}
		}
	}

	private mapConsoleType(type: string): 'log' | 'info' | 'warn' | 'error' | 'debug' {
		switch (type) {
			case 'warning':
				return 'warn';
			case 'error':
				return 'error';
			case 'info':
				return 'info';
			case 'debug':
				return 'debug';
			default:
				return 'log';
		}
	}

	private mapLogLevel(level: string): 'log' | 'info' | 'warn' | 'error' | 'debug' {
		switch (level) {
			case 'warning':
				return 'warn';
			case 'error':
				return 'error';
			case 'info':
				return 'info';
			case 'verbose':
				return 'debug';
			default:
				return 'log';
		}
	}

	private formatConsoleArgs(args: Array<{ type: string; value?: unknown; description?: string }>): string {
		return args.map(arg => {
			if (arg.value !== undefined) {
				if (typeof arg.value === 'object') {
					try {
						return JSON.stringify(arg.value);
					} catch {
						return String(arg.value);
					}
				}
				return String(arg.value);
			}
			return arg.description || `[${arg.type}]`;
		}).join(' ');
	}

	async getNodeData(sessionId: string, debuggers: Electron.Debugger, window: BrowserWindow, cancellationId?: number): Promise<NodeDataResponse> {
		return new Promise((resolve, reject) => {
			const onMessage = async (event: Electron.Event, method: string, params: { backendNodeId: number }) => {
				if (method === 'Overlay.inspectNodeRequested') {
					debuggers.off('message', onMessage);
					await debuggers.sendCommand('Runtime.evaluate', {
						expression: `(() => {
										const style = document.getElementById('__pseudoBlocker__');
										if (style) style.remove();
									})();`,
					}, sessionId);

					const backendNodeId = params?.backendNodeId;
					if (!backendNodeId) {
						throw new Error('Missing backendNodeId in inspectNodeRequested event');
					}

					try {
						await debuggers.sendCommand('DOM.getDocument', {}, sessionId);
						const { nodeIds } = await debuggers.sendCommand('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [backendNodeId] }, sessionId);
						if (!nodeIds || nodeIds.length === 0) {
							throw new Error('Failed to get node IDs.');
						}
						const nodeId = nodeIds[0];

						const { model } = await debuggers.sendCommand('DOM.getBoxModel', { nodeId }, sessionId);
						if (!model) {
							throw new Error('Failed to get box model.');
						}

						const content = model.content;
						const margin = model.margin;
						const x = Math.min(margin[0], content[0]);
						const y = Math.min(margin[1], content[1]);
						const width = Math.max(margin[2] - margin[0], content[2] - content[0]);
						const height = Math.max(margin[5] - margin[1], content[5] - content[1]);

						const matched = await debuggers.sendCommand('CSS.getMatchedStylesForNode', { nodeId }, sessionId);
						if (!matched) {
							throw new Error('Failed to get matched css.');
						}

						const formatted = this.formatMatchedStyles(matched);
						const { outerHTML } = await debuggers.sendCommand('DOM.getOuterHTML', { nodeId }, sessionId);
						if (!outerHTML) {
							throw new Error('Failed to get outerHTML.');
						}

						resolve({
							outerHTML,
							computedStyle: formatted,
							bounds: { x, y, width, height }
						});
					} catch (err) {
						debuggers.off('message', onMessage);
						debuggers.detach();
						reject(err);
					}
				}
			};

			window.webContents.on('ipc-message', async (event, channel, closedCancellationId) => {
				if (channel === `vscode:cancelElementSelection${cancellationId}`) {
					if (cancellationId !== closedCancellationId) {
						return;
					}
					debuggers.off('message', onMessage);
					await this.finishOverlay(debuggers, sessionId);
					window.webContents.removeAllListeners('ipc-message');
				}
			});

			debuggers.on('message', onMessage);
		});
	}

	formatMatchedStyles(matched: { inlineStyle?: { cssProperties?: Array<{ name: string; value: string }> }; matchedCSSRules?: Array<{ rule: { selectorList: { selectors: Array<{ text: string }> }; origin: string; style: { cssProperties: Array<{ name: string; value: string }> } } }>; inherited?: Array<{ inlineStyle?: { cssText: string }; matchedCSSRules?: Array<{ rule: { selectorList: { selectors: Array<{ text: string }> }; origin: string; style: { cssProperties: Array<{ name: string; value: string }> } } }> }> }): string {
		const lines: string[] = [];

		// inline
		if (matched.inlineStyle?.cssProperties?.length) {
			lines.push('/* Inline style */');
			lines.push('element {');
			for (const prop of matched.inlineStyle.cssProperties) {
				if (prop.name && prop.value) {
					lines.push(`  ${prop.name}: ${prop.value};`);
				}
			}
			lines.push('}\n');
		}

		// matched
		if (matched.matchedCSSRules?.length) {
			for (const ruleEntry of matched.matchedCSSRules) {
				const rule = ruleEntry.rule;
				const selectors = rule.selectorList.selectors.map(s => s.text).join(', ');
				lines.push(`/* Matched Rule from ${rule.origin} */`);
				lines.push(`${selectors} {`);
				for (const prop of rule.style.cssProperties) {
					if (prop.name && prop.value) {
						lines.push(`  ${prop.name}: ${prop.value};`);
					}
				}
				lines.push('}\n');
			}
		}

		// inherited rules
		if (matched.inherited?.length) {
			let level = 1;
			for (const inherited of matched.inherited) {
				const inline = inherited.inlineStyle;
				if (inline) {
					lines.push(`/* Inherited from ancestor level ${level} (inline) */`);
					lines.push('element {');
					lines.push(inline.cssText);
					lines.push('}\n');
				}

				const rules = inherited.matchedCSSRules || [];
				for (const ruleEntry of rules) {
					const rule = ruleEntry.rule;
					const selectors = rule.selectorList.selectors.map(s => s.text).join(', ');
					lines.push(`/* Inherited from ancestor level ${level} (${rule.origin}) */`);
					lines.push(`${selectors} {`);
					for (const prop of rule.style.cssProperties) {
						if (prop.name && prop.value) {
							lines.push(`  ${prop.name}: ${prop.value};`);
						}
					}
					lines.push('}\n');
				}
				level++;
			}
		}

		return '\n' + lines.join('\n');
	}

	private windowById(windowId: number | undefined, fallbackCodeWindowId?: number): ICodeWindow | IAuxiliaryWindow | undefined {
		return this.codeWindowById(windowId) ?? this.auxiliaryWindowById(windowId) ?? this.codeWindowById(fallbackCodeWindowId);
	}

	private codeWindowById(windowId: number | undefined): ICodeWindow | undefined {
		if (typeof windowId !== 'number') {
			return undefined;
		}

		return this.windowsMainService.getWindowById(windowId);
	}

	private auxiliaryWindowById(windowId: number | undefined): IAuxiliaryWindow | undefined {
		if (typeof windowId !== 'number') {
			return undefined;
		}

		const contents = webContents.fromId(windowId);
		if (!contents) {
			return undefined;
		}

		return this.auxiliaryWindowsMainService.getWindowByWebContents(contents);
	}
}
