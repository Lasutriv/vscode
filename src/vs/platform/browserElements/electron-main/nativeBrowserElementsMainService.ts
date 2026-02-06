/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrowserType, IConsoleLogsResult, IConsoleLogEntry, ICurrentUrlResult, IElementData, INativeBrowserElementsService, IBrowserTargetLocator } from '../common/browserElements.js';
import { ILogService } from '../../log/common/log.js';
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

export const INativeBrowserElementsMainService = createDecorator<INativeBrowserElementsMainService>('browserElementsMainService');
export interface INativeBrowserElementsMainService extends AddFirstParameterToFunctions<INativeBrowserElementsService, Promise<unknown> /* only methods, not events */, number | undefined /* window ID */> { }

interface NodeDataResponse {
	outerHTML: string;
	computedStyle: string;
	bounds: IRectangle;
}

interface TargetInfo {
	targetId: string;
	url: string;
	type?: string;
}

interface IFrameInfo {
	src: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

export class NativeBrowserElementsMainService extends Disposable implements INativeBrowserElementsMainService {
	_serviceBrand: undefined;

	constructor(
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@IAuxiliaryWindowsMainService private readonly auxiliaryWindowsMainService: IAuxiliaryWindowsMainService,
		@ILogService private readonly logService: ILogService,
		@IBrowserViewMainService private readonly browserViewMainService: IBrowserViewMainService
	) {
		super();
	}

	get windowId(): never { throw new Error('Not implemented in electron-main'); }

	private findHostWebviewContents(window: BrowserWindow, locator?: IBrowserTargetLocator, browserType?: BrowserType): Electron.WebContents | undefined {
		if (locator?.browserViewId) {
			return this.browserViewMainService.tryGetBrowserView(locator.browserViewId)?.webContents;
		}

		const allWebContents = webContents.getAllWebContents();
		const hostId = window.webContents.id;
		const webviewId = locator?.webviewId;

		const matchesLocator = (url: string) => {
			if (!webviewId) {
				return false;
			}
			try {
				const parsed = new URL(url);
				return parsed.searchParams.get('id') === webviewId;
			} catch {
				return false;
			}
		};

		const matchesBrowserType = (url: string) => {
			if (!browserType) {
				return false;
			}
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
					&& (matchesLocator(webContent.getURL()) || matchesBrowserType(webContent.getURL()));
			} catch {
				return false;
			}
		});

		// Fallback to old heuristic (in case hostWebContents is not set as expected)
		if (!hostedWebview) {
			hostedWebview = allWebContents.find(webContent => {
				try {
					return webContent.getType?.() === 'webview'
						&& (matchesLocator(webContent.getURL()) || matchesBrowserType(webContent.getURL()));
				} catch {
					return false;
				}
			});
		}

		return hostedWebview;
	}

	private parseTargetUrl(targetInfo: TargetInfo): URL | undefined {
		try {
			return new URL(targetInfo.url);
		} catch {
			return undefined;
		}
	}

	private async getSimpleBrowserTargets(debuggers: Electron.Debugger): Promise<{ outerTargetId?: string; contentTargetId?: string }> {
		const targetInfosResult = await (debuggers.sendCommand as unknown as (command: string) => Promise<unknown>)('Target.getTargets');
		const { targetInfos } = targetInfosResult as { targetInfos: TargetInfo[] };

		const outerTargets: Array<{ info: TargetInfo; url: URL }> = [];
		const candidates: Array<{ info: TargetInfo; url: URL; reqId?: number }> = [];

		for (const info of targetInfos) {
			const url = this.parseTargetUrl(info);
			if (!url) {
				continue;
			}

			if (url.searchParams.get('extensionId') === 'vscode.simple-browser') {
				outerTargets.push({ info, url });
			}

			if (url.searchParams.has('vscodeBrowserReqId')) {
				const reqIdRaw = url.searchParams.get('vscodeBrowserReqId');
				const reqId = reqIdRaw ? Number(reqIdRaw) : undefined;
				candidates.push({ info, url, reqId: Number.isFinite(reqId) ? reqId : undefined });
			}
		}

		const outerTarget = outerTargets.find(t => t.url.searchParams.has('id')) ?? outerTargets[0];
		const outerId = outerTarget?.url.searchParams.get('id');

		const matchingContentCandidates = outerId
			? candidates.filter(t => t.url.searchParams.get('id') === outerId)
			: candidates;

		matchingContentCandidates.sort((a, b) => (b.reqId ?? 0) - (a.reqId ?? 0));
		const contentTarget = matchingContentCandidates[0];

		return {
			outerTargetId: outerTarget?.info.targetId,
			contentTargetId: contentTarget?.info.targetId
		};
	}

	private async getTopLevelIFrameInfo(debuggers: Electron.Debugger, sessionId: string): Promise<IFrameInfo | undefined> {
		try {
			const evalResult = await debuggers.sendCommand('Runtime.evaluate', {
				expression: `(() => {
					const iframes = Array.from(document.querySelectorAll('iframe'));
					const infos = iframes.map(iframe => {
						const rect = iframe.getBoundingClientRect();
						return {
							src: iframe.src || iframe.getAttribute('src') || '',
							x: rect.x,
							y: rect.y,
							width: rect.width,
							height: rect.height
						};
					});
					infos.sort((a, b) => (b.width * b.height) - (a.width * a.height));
					return infos[0] || null;
				})()`,
				returnByValue: true,
			}, sessionId);

			const value = (evalResult as { result?: { value?: IFrameInfo | null } }).result?.value;
			return value ?? undefined;
		} catch {
			return undefined;
		}
	}

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
				} catch {
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
				} catch {
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

	async findWebviewTargetByBrowserType(debuggers: Electron.Debugger, windowId: number, browserType: BrowserType): Promise<string | undefined> {
		const targetInfosResult = await (debuggers.sendCommand as unknown as (command: string) => Promise<unknown>)('Target.getTargets');
		const { targetInfos } = targetInfosResult as { targetInfos: TargetInfo[] };
		this.logService.info(`[browserElements] findWebviewTarget: inspecting ${targetInfos.length} targets for windowId=${windowId} browserType=${browserType}`);

		if (browserType === BrowserType.SimpleBrowser) {
			const { outerTargetId, contentTargetId } = await this.getSimpleBrowserTargets(debuggers);
			if (contentTargetId) {
				return contentTargetId;
			}
			if (outerTargetId) {
				return outerTargetId;
			}
		}

		// First try strict parameter matching
		const matchingTarget = targetInfos.find((targetInfo: { url: string }) => {
			try {
				const url = new URL(targetInfo.url);
				if (browserType === BrowserType.LiveServer) {
					return url.searchParams.get('id') && url.searchParams.get('extensionId') === 'ms-vscode.live-server';
				} else if (browserType === BrowserType.SimpleBrowser) {
					return url.searchParams.get('parentId') === windowId.toString() && url.searchParams.get('extensionId') === 'vscode.simple-browser';
				}
				return false;
			} catch {
				return false;
			}
		});

		return matchingTarget?.targetId;
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

		const hostedWebview = this.findHostWebviewContents(window.win, locator);

		if (!hostedWebview) {
			return undefined;
		}

		const debuggers = hostedWebview.debugger;
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

		const hostedWebview = this.findHostWebviewContents(window.win, locator);

		if (!hostedWebview) {
			return undefined;
		}

		const debuggers = hostedWebview.debugger;
		if (!debuggers.isAttached()) {
			debuggers.attach();
		}

		let targetSessionId: string | undefined = undefined;
		let iframeOffset: IRectangle | undefined;
		let shouldApplyIFrameOffset = false;
		try {
			let targetId = await this.findWebviewTarget(debuggers, locator);
			if (!targetId) {
				throw new Error('No target found');
			}

			// For Simple Browser, attempt to attach to both outer + content targets so we can
			// accurately translate element bounds from iframe coordinates into the webview.
			if (locator.webviewId) {
				const { outerTargetId, contentTargetId } = await this.getSimpleBrowserTargets(debuggers);
				shouldApplyIFrameOffset = Boolean(contentTargetId);
				if (outerTargetId) {
					const { sessionId: outerSessionId } = await debuggers.sendCommand('Target.attachToTarget', {
						targetId: outerTargetId,
						flatten: true,
					});

					try {
						await debuggers.sendCommand('Runtime.enable', {}, outerSessionId);
						const iframe = await this.getTopLevelIFrameInfo(debuggers, outerSessionId);
						if (iframe && iframe.width > 0 && iframe.height > 0) {
							iframeOffset = { x: iframe.x, y: iframe.y, width: iframe.width, height: iframe.height };
						}
					} finally {
						try {
							await debuggers.sendCommand('Target.detachFromTarget', { sessionId: outerSessionId }, undefined);
						} catch {
							// ignore
						}
					}
				}

				if (contentTargetId) {
					targetId = contentTargetId;
				}
			}

			const { sessionId } = await debuggers.sendCommand('Target.attachToTarget', {
				targetId,
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

		const zoomFactor = hostedWebview.getZoomFactor();
		const offsetX = shouldApplyIFrameOffset ? (iframeOffset?.x ?? 0) : 0;
		const offsetY = shouldApplyIFrameOffset ? (iframeOffset?.y ?? 0) : 0;
		const absoluteBounds = {
			x: rect.x + offsetX + nodeData.bounds.x,
			y: rect.y + offsetY + nodeData.bounds.y,
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

	async getConsoleLogs(windowId: number | undefined, token: CancellationToken, browserType: BrowserType, durationMs: number = 3000): Promise<IConsoleLogsResult> {
		this.logService.info(`[browserElements] consoleLogs: invoked windowId=${windowId} browserType=${browserType}`);
		const window = this.windowById(windowId);
		if (!window?.win) {
			this.logService.warn(`[browserElements] consoleLogs: window not found for id ${windowId}`);
			return { success: false, url: '', logs: [], error: 'Window not found' };
		}
		const windowWin = window.win;
		if (!windowWin) {
			this.logService.warn(`[browserElements] consoleLogs: BrowserWindow missing for id ${windowId}`);
			return { success: false, url: '', logs: [], error: 'Window not found' };
		}

		// Locate the simple-browser webview webContents hosted by this window
		const allWebContents = webContents.getAllWebContents();
		const simpleBrowserWebview = allWebContents.find(webContent => {
			try {
				return webContent.getType?.() === 'webview'
					&& webContent.getURL().includes('simple-browser');
			} catch (e) {
				return false;
			}
		});

		if (!simpleBrowserWebview) {
			this.logService.warn(`[browserElements] consoleLogs: simple-browser webview not found. host=${windowWin.webContents.id}, candidates=${allWebContents.length}`);
			for (const wc of allWebContents) {
				try {
					this.logService.warn(`[browserElements] candidate id=${wc.id} type=${wc.getType?.()} host=${wc.hostWebContents?.id} url=${wc.getURL?.()}`);
				} catch (e) {
					this.logService.warn(`[browserElements] candidate id=${wc.id} (failed to read url/type): ${e}`);
				}
			}
			return { success: false, url: '', logs: [], error: 'Simple browser webview not found' };
		}

		this.logService.info(`[browserElements] consoleLogs: found webview id=${simpleBrowserWebview.id} host=${simpleBrowserWebview.hostWebContents?.id} url=${simpleBrowserWebview.getURL()}`);

		const debuggers = simpleBrowserWebview.debugger;
		if (!debuggers.isAttached()) {
			debuggers.attach();
		}

		let targetSessionId: string | undefined;
		let targetUrl: string = '';

		try {
			const targetId = await this.findWebviewTargetByBrowserType(debuggers, windowId!, browserType);
			if (!targetId) {
				this.logService.warn('[browserElements] consoleLogs: could not find webview target for CDP attach');
				debuggers.detach();
				return { success: false, url: '', logs: [], error: 'Could not find browser target' };
			}

			const { sessionId } = await debuggers.sendCommand('Target.attachToTarget', {
				targetId: targetId,
				flatten: true,
			});

			targetSessionId = sessionId;

			// Enable Runtime to get console messages
			await debuggers.sendCommand('Runtime.enable', {}, sessionId);
			await debuggers.sendCommand('Log.enable', {}, sessionId);

			// Get the current URL
			const { result: urlResult } = await debuggers.sendCommand('Runtime.evaluate', {
				expression: 'window.location.href',
				returnByValue: true,
			}, sessionId);
			targetUrl = urlResult?.value || '';

			// Collect console logs for the specified duration
			const logs: IConsoleLogEntry[] = [];

			const onMessage = (event: Electron.Event, method: string, params: {
				type?: string;
				args?: Array<{ type: string; value?: unknown; description?: string }>;
				timestamp?: number;
				stackTrace?: { callFrames: Array<{ url: string; lineNumber: number; columnNumber: number }> };
				entry?: { level: string; text: string; timestamp: number; url?: string; lineNumber?: number; stackTrace?: { callFrames: Array<{ url: string; lineNumber: number; columnNumber: number }> } };
			}, targetId?: string) => {
				if (targetId !== targetSessionId) {
					return;
				}

				if (method === 'Runtime.consoleAPICalled') {
					const type = this.mapConsoleType(params.type || 'log');
					const message = this.formatConsoleArgs(params.args || []);
					const stackTrace = params.stackTrace?.callFrames?.[0];

					logs.push({
						type,
						timestamp: params.timestamp ? params.timestamp * 1000 : Date.now(),
						message,
						url: stackTrace?.url,
						lineNumber: stackTrace?.lineNumber,
						columnNumber: stackTrace?.columnNumber,
						stackTrace: params.stackTrace?.callFrames?.map(f => `  at ${f.url}:${f.lineNumber}:${f.columnNumber}`).join('\n'),
					});
				} else if (method === 'Log.entryAdded') {
					const entry = params.entry;
					if (entry) {
						logs.push({
							type: this.mapLogLevel(entry.level),
							timestamp: entry.timestamp * 1000,
							message: entry.text,
							url: entry.url,
							lineNumber: entry.lineNumber,
							stackTrace: entry.stackTrace?.callFrames?.map(f => `  at ${f.url}:${f.lineNumber}:${f.columnNumber}`).join('\n'),
						});
					}
				}
			};

			debuggers.on('message', onMessage);

			// Wait for the specified duration to collect logs
			await new Promise<void>((resolve) => {
				const timeoutId = setTimeout(() => {
					resolve();
				}, durationMs);

				if (token.isCancellationRequested) {
					clearTimeout(timeoutId);
					resolve();
				}

				token.onCancellationRequested(() => {
					clearTimeout(timeoutId);
					resolve();
				});
			});

			debuggers.off('message', onMessage);

			// Detach from target
			await debuggers.sendCommand('Target.detachFromTarget', { sessionId }, undefined);
			debuggers.detach();

			return {
				success: true,
				url: targetUrl,
				logs: logs.sort((a, b) => a.timestamp - b.timestamp),
			};

		} catch (error) {
			if (debuggers.isAttached()) {
				debuggers.detach();
			}
			this.logService.error(`[browserElements] consoleLogs: error during capture`, error);
			return { success: false, url: targetUrl, logs: [], error: String(error) };
		}
	}

	async getCurrentUrl(windowId: number | undefined, token: CancellationToken, browserType: BrowserType): Promise<ICurrentUrlResult> {
		this.logService.trace(`[browserElements] currentUrl: invoked windowId=${windowId} browserType=${browserType}`);
		if (typeof windowId !== 'number') {
			return { success: false, url: '', error: 'Window not found' };
		}
		const window = this.windowById(windowId);
		if (!window?.win) {
			return { success: false, url: '', error: 'Window not found' };
		}
		const windowWin = window.win;
		if (!windowWin) {
			return { success: false, url: '', error: 'Window not found' };
		}

		const allWebContents = webContents.getAllWebContents();
		let simpleBrowserWebview = allWebContents.find(webContent => {
			try {
				return webContent.getType?.() === 'webview'
					&& webContent.hostWebContents?.id === windowWin.webContents.id
					&& webContent.getURL().includes('simple-browser');
			} catch {
				return false;
			}
		});

		// Fallback to old heuristic (in case hostWebContents is not set as expected)
		if (!simpleBrowserWebview) {
			simpleBrowserWebview = allWebContents.find(webContent => {
				try {
					return webContent.getType?.() === 'webview'
						&& webContent.getURL().includes('simple-browser');
				} catch {
					return false;
				}
			});
		}

		if (!simpleBrowserWebview) {
			return { success: false, url: '', error: 'Simple browser webview not found' };
		}

		const debuggers = simpleBrowserWebview.debugger;
		const wasAttached = debuggers.isAttached();
		if (!wasAttached) {
			debuggers.attach();
		}

		let targetUrl = '';
		let sessionId: string | undefined;
		try {
			const targetId = await this.findWebviewTargetByBrowserType(debuggers, windowId, browserType);
			if (!targetId) {
				return { success: false, url: '', error: 'Could not find browser target' };
			}

			const attachResult = await debuggers.sendCommand('Target.attachToTarget', {
				targetId,
				flatten: true,
			});
			sessionId = attachResult.sessionId;

			await debuggers.sendCommand('Runtime.enable', {}, sessionId);
			const { result } = await debuggers.sendCommand('Runtime.evaluate', {
				expression: 'window.location.href',
				returnByValue: true,
			}, sessionId);
			targetUrl = result?.value || '';

			await debuggers.sendCommand('Target.detachFromTarget', { sessionId }, undefined);
			return { success: true, url: targetUrl };
		} catch (error) {
			this.logService.error('[browserElements] currentUrl: error', error);
			return { success: false, url: targetUrl, error: String(error) };
		} finally {
			try {
				if (sessionId) {
					await debuggers.sendCommand('Target.detachFromTarget', { sessionId }, undefined);
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
			case 'warning': return 'warn';
			case 'error': return 'error';
			case 'info': return 'info';
			case 'debug': return 'debug';
			default: return 'log';
		}
	}

	private mapLogLevel(level: string): 'log' | 'info' | 'warn' | 'error' | 'debug' {
		switch (level) {
			case 'warning': return 'warn';
			case 'error': return 'error';
			case 'info': return 'info';
			case 'verbose': return 'debug';
			default: return 'log';
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

	formatMatchedStyles(matched: { inlineStyle?: { cssProperties?: Array<{ name: string; value: string }> }; matchedCSSRules?: Array<{ rule: { selectorList: { selectors: Array<{ text: string }> }; origin: string; style: { cssProperties: Array<{ name: string; value: string }> } } }>; inherited?: Array<{ matchedCSSRules?: Array<{ rule: { selectorList: { selectors: Array<{ text: string }> }; origin: string; style: { cssProperties: Array<{ name: string; value: string }> } } }> }> }): string {
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
