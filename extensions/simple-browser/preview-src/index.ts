/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onceDocumentLoaded } from './events';

const vscode = acquireVsCodeApi();

function getSettings() {
	const element = document.getElementById('simple-browser-settings');
	if (element) {
		const data = element.getAttribute('data-settings');
		if (data) {
			return JSON.parse(data);
		}
	}

	throw new Error(`Could not load settings`);
}

const settings = getSettings();

const iframe = document.querySelector('iframe')!;
const header = document.querySelector('.header')!;
const input = header.querySelector<HTMLInputElement>('.url-input')!;
const forwardButton = header.querySelector<HTMLButtonElement>('.forward-button')!;
const backButton = header.querySelector<HTMLButtonElement>('.back-button')!;
const reloadButton = header.querySelector<HTMLButtonElement>('.reload-button')!;
const openExternalButton = header.querySelector<HTMLButtonElement>('.open-external-button')!;

let pendingInputUrlUpdate: string | undefined;

function setCurrentUrl(url: string): void {
	// Always persist the last known URL so restores/reloads behave intuitively.
	vscode.setState({ url });

	// Avoid clobbering the user's typing in the address bar.
	if (document.activeElement === input) {
		pendingInputUrlUpdate = url;
		return;
	}

	if (input.value !== url) {
		input.value = url;
	}
	pendingInputUrlUpdate = undefined;
}

window.addEventListener('message', e => {
	// Messages from the embedded page (iframe) are cross-origin; the only safe way to
	// observe SPA route changes is via postMessage from the app.
	if (e.source === iframe.contentWindow) {
		const data = e.data as { type?: unknown; url?: unknown } | undefined;
		if (data && data.type === 'simpleBrowser.urlChanged' && typeof data.url === 'string') {
			setCurrentUrl(data.url);
			return;
		}
	}

	// Messages from the extension host.
	if (e.data?.type === 'didNavigate' && typeof e.data.url === 'string') {
		setCurrentUrl(e.data.url);
		return;
	}

	switch (e.data.type) {
		case 'focus':
			{
				iframe.focus();
				break;
			}
		case 'didChangeFocusLockIndicatorEnabled':
			{
				toggleFocusLockIndicatorEnabled(e.data.enabled);
				break;
			}
		case 'requestScreenshot':
			{
				captureScreenshot();
				break;
			}
		case 'zoom':
			{
				handleZoom(e.data.direction);
				break;
			}
		case 'printPage':
			{
				handlePrint();
				break;
			}
		case 'toggleDevTools':
			{
				handleToggleDevTools();
				break;
			}
		case 'pageSearch':
			{
				handlePageSearch();
				break;
			}
		case 'captureConsole':
			{
				handleCaptureConsole();
				break;
			}
	}
});

onceDocumentLoaded(() => {
	setInterval(() => {
		const iframeFocused = document.activeElement?.tagName === 'IFRAME';
		document.body.classList.toggle('iframe-focused', iframeFocused);
	}, 50);

	iframe.addEventListener('load', () => {
		// Ask the embedded page (if it supports it) to start reporting URL changes.
		try {
			iframe.contentWindow?.postMessage({ type: 'simpleBrowser.init' }, '*');
		} catch {
			// Noop
		}
	});

	input.addEventListener('blur', () => {
		if (pendingInputUrlUpdate) {
			setCurrentUrl(pendingInputUrlUpdate);
		}
	});

	input.addEventListener('change', e => {
		const url = (e.target as HTMLInputElement).value;
		navigateTo(url);
	});

	forwardButton.addEventListener('click', () => {
		history.forward();
	});

	backButton.addEventListener('click', () => {
		history.back();
	});

	openExternalButton.addEventListener('click', () => {
		vscode.postMessage({
			type: 'openExternal',
			url: input.value
		});
	});

	reloadButton.addEventListener('click', () => {
		// This does not seem to trigger what we want
		// history.go(0);

		// This incorrectly adds entries to the history but does reload
		// It also always incorrectly always loads the value in the input bar,
		// which may not match the current page if the user has navigated
		navigateTo(input.value);
	});

	navigateTo(settings.url);
	input.value = settings.url;

	toggleFocusLockIndicatorEnabled(settings.focusLockIndicatorEnabled);

	function navigateTo(rawUrl: string): void {
		try {
			const url = new URL(rawUrl);

			// Try to bust the cache for the iframe
			// There does not appear to be any way to reliably do this except modifying the url
			const existing = new URLSearchParams(location.search);
			url.searchParams.append('id', existing.get('id')!);
			url.searchParams.append('vscodeBrowserReqId', Date.now().toString());

			iframe.src = url.toString();
		} catch {
			iframe.src = rawUrl;
		}

		setCurrentUrl(rawUrl);
	}
});

function toggleFocusLockIndicatorEnabled(enabled: boolean) {
	document.body.classList.toggle('enable-focus-lock-indicator', enabled);
}

// Current zoom level (percentage)
let currentZoom = 100;

// Screenshot capture
async function captureScreenshot(): Promise<void> {
	try {
		// Get the content area (where the iframe is)
		const contentArea = document.querySelector('.content') as HTMLElement;
		if (!contentArea) {
			vscode.postMessage({
				type: 'screenshotResult',
				success: false,
				error: 'Content area not found'
			});
			return;
		}

		// Use html2canvas-like approach with canvas
		const rect = contentArea.getBoundingClientRect();
		const canvas = document.createElement('canvas');
		canvas.width = rect.width * window.devicePixelRatio;
		canvas.height = rect.height * window.devicePixelRatio;
		const ctx = canvas.getContext('2d');

		if (!ctx) {
			vscode.postMessage({
				type: 'screenshotResult',
				success: false,
				error: 'Could not get canvas context'
			});
			return;
		}

		// Scale for high DPI displays
		ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

		// Fill background
		ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#ffffff';
		ctx.fillRect(0, 0, rect.width, rect.height);

		// Note: Due to cross-origin restrictions, we cannot directly capture iframe content
		// Instead, we'll capture the visible portion of the webview using a workaround
		// For same-origin iframes, we could potentially draw the content

		// Try to capture using the iframe's content if accessible
		try {
			const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
			if (iframeDoc) {
				// If we can access the iframe document (same-origin), serialize and draw
				const svgData = `
					<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}">
						<foreignObject width="100%" height="100%">
							<div xmlns="http://www.w3.org/1999/xhtml">
								${iframeDoc.documentElement.outerHTML}
							</div>
						</foreignObject>
					</svg>
				`;
				const img = new Image();
				const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
				const url = URL.createObjectURL(blob);

				await new Promise<void>((resolve, reject) => {
					img.onload = () => {
						ctx.drawImage(img, 0, 0);
						URL.revokeObjectURL(url);
						resolve();
					};
					img.onerror = () => {
						URL.revokeObjectURL(url);
						reject(new Error('Failed to load SVG'));
					};
					img.src = url;
				});
			} else {
				throw new Error('Cannot access iframe content');
			}
		} catch {
			// Fallback: Draw a placeholder message for cross-origin content
			ctx.fillStyle = '#f0f0f0';
			ctx.fillRect(0, 0, rect.width, rect.height);
			ctx.fillStyle = '#666666';
			ctx.font = '16px sans-serif';
			ctx.textAlign = 'center';
			ctx.fillText('Screenshot captured (cross-origin content)', rect.width / 2, rect.height / 2 - 10);
			ctx.fillText(`URL: ${input.value}`, rect.width / 2, rect.height / 2 + 20);
		}

		const dataUrl = canvas.toDataURL('image/png');
		vscode.postMessage({
			type: 'screenshotResult',
			success: true,
			data: dataUrl
		});
	} catch (error) {
		vscode.postMessage({
			type: 'screenshotResult',
			success: false,
			error: String(error)
		});
	}
}

// Zoom handling
function handleZoom(direction: 'in' | 'out' | 'reset'): void {
	const zoomStep = 10;
	const minZoom = 25;
	const maxZoom = 500;

	switch (direction) {
		case 'in':
			currentZoom = Math.min(maxZoom, currentZoom + zoomStep);
			break;
		case 'out':
			currentZoom = Math.max(minZoom, currentZoom - zoomStep);
			break;
		case 'reset':
			currentZoom = 100;
			break;
	}

	iframe.style.transform = `scale(${currentZoom / 100})`;
	iframe.style.transformOrigin = 'top left';

	// Adjust iframe size to compensate for scaling
	iframe.style.width = `${100 / (currentZoom / 100)}%`;
	iframe.style.height = `${100 / (currentZoom / 100)}%`;
}

// Print page
function handlePrint(): void {
	try {
		const iframeWindow = iframe.contentWindow;
		if (iframeWindow) {
			iframeWindow.print();
			vscode.postMessage({
				type: 'printResult',
				success: true
			});
		} else {
			vscode.postMessage({
				type: 'printResult',
				success: false,
				error: 'cross-origin'
			});
		}
	} catch {
		// Cross-origin restriction - notify extension
		vscode.postMessage({
			type: 'printResult',
			success: false,
			error: 'cross-origin'
		});
	}
}

// Toggle DevTools (limited in webview context)
function handleToggleDevTools(): void {
	// In a webview context, we can't directly open DevTools for the iframe
	// But we can provide helpful information
	try {
		const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
		if (iframeDoc) {
			// If we can access the document, log some debug info to console
			console.group('Simple Browser DevTools - Page Info');
			console.log('URL:', input.value);
			console.log('Title:', iframeDoc.title);
			console.log('Document Mode:', iframeDoc.compatMode);
			console.log('Character Set:', iframeDoc.characterSet);
			console.log('Ready State:', iframeDoc.readyState);
			console.log('Links:', iframeDoc.links.length);
			console.log('Images:', iframeDoc.images.length);
			console.log('Scripts:', iframeDoc.scripts.length);
			console.log('Stylesheets:', iframeDoc.styleSheets.length);
			console.groupEnd();
			vscode.postMessage({
				type: 'devToolsResult',
				accessible: true
			});
		} else {
			vscode.postMessage({
				type: 'devToolsResult',
				accessible: false
			});
		}
	} catch {
		vscode.postMessage({
			type: 'devToolsResult',
			accessible: false
		});
	}
}

// Search bar state
let searchBarVisible = false;
let searchBar: HTMLDivElement | null = null;

// Page search
function handlePageSearch(): void {
	if (searchBarVisible && searchBar) {
		// Hide search bar
		searchBar.remove();
		searchBar = null;
		searchBarVisible = false;
		clearHighlights();
		return;
	}

	// Create search bar
	searchBar = document.createElement('div');
	searchBar.className = 'search-bar';
	searchBar.innerHTML = `
		<input type="text" class="search-input" placeholder="Find in page...">
		<span class="search-count">0/0</span>
		<button class="search-prev" title="Previous">↑</button>
		<button class="search-next" title="Next">↓</button>
		<button class="search-close" title="Close">×</button>
	`;

	// Add styles
	searchBar.style.cssText = `
		position: absolute;
		top: 0;
		right: 20px;
		background: var(--vscode-input-background, #fff);
		border: 1px solid var(--vscode-input-border, #ccc);
		border-radius: 4px;
		padding: 4px 8px;
		display: flex;
		align-items: center;
		gap: 4px;
		z-index: 1000;
		box-shadow: 0 2px 8px rgba(0,0,0,0.2);
	`;

	const searchInput = searchBar.querySelector('.search-input') as HTMLInputElement;
	const searchCount = searchBar.querySelector('.search-count') as HTMLSpanElement;
	const prevBtn = searchBar.querySelector('.search-prev') as HTMLButtonElement;
	const nextBtn = searchBar.querySelector('.search-next') as HTMLButtonElement;
	const closeBtn = searchBar.querySelector('.search-close') as HTMLButtonElement;

	searchInput.style.cssText = `
		border: none;
		background: transparent;
		outline: none;
		padding: 4px;
		min-width: 200px;
		color: var(--vscode-input-foreground, #000);
	`;

	searchCount.style.cssText = `
		font-size: 12px;
		color: var(--vscode-descriptionForeground, #666);
		min-width: 40px;
	`;

	[prevBtn, nextBtn, closeBtn].forEach(btn => {
		btn.style.cssText = `
			border: none;
			background: transparent;
			cursor: pointer;
			padding: 2px 6px;
			font-size: 14px;
			color: var(--vscode-foreground, #000);
		`;
	});

	let searchMatches: Range[] = [];
	let currentMatch = 0;

	searchInput.addEventListener('input', () => {
		const query = searchInput.value;
		searchMatches = findInPage(query);
		currentMatch = searchMatches.length > 0 ? 0 : -1;
		searchCount.textContent = searchMatches.length > 0 ? `${currentMatch + 1}/${searchMatches.length}` : '0/0';
		if (currentMatch >= 0) {
			scrollToMatch(searchMatches[currentMatch]);
		}
	});

	prevBtn.addEventListener('click', () => {
		if (searchMatches.length > 0) {
			currentMatch = (currentMatch - 1 + searchMatches.length) % searchMatches.length;
			searchCount.textContent = `${currentMatch + 1}/${searchMatches.length}`;
			scrollToMatch(searchMatches[currentMatch]);
		}
	});

	nextBtn.addEventListener('click', () => {
		if (searchMatches.length > 0) {
			currentMatch = (currentMatch + 1) % searchMatches.length;
			searchCount.textContent = `${currentMatch + 1}/${searchMatches.length}`;
			scrollToMatch(searchMatches[currentMatch]);
		}
	});

	closeBtn.addEventListener('click', () => {
		handlePageSearch(); // Toggle off
	});

	searchInput.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') {
			handlePageSearch(); // Toggle off
		} else if (e.key === 'Enter') {
			if (e.shiftKey) {
				prevBtn.click();
			} else {
				nextBtn.click();
			}
		}
	});

	header.appendChild(searchBar);
	searchBarVisible = true;
	searchInput.focus();
}

// Find text in page
function findInPage(query: string): Range[] {
	clearHighlights();

	if (!query) {
		return [];
	}

	const matches: Range[] = [];

	try {
		const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
		if (!iframeDoc) {
			return [];
		}

		const walker = iframeDoc.createTreeWalker(
			iframeDoc.body,
			NodeFilter.SHOW_TEXT,
			null
		);

		const queryLower = query.toLowerCase();
		let node: Text | null;

		while ((node = walker.nextNode() as Text | null)) {
			const text = node.textContent || '';
			const textLower = text.toLowerCase();
			let index = 0;

			while ((index = textLower.indexOf(queryLower, index)) !== -1) {
				const range = iframeDoc.createRange();
				range.setStart(node, index);
				range.setEnd(node, index + query.length);
				matches.push(range);

				// Highlight the match
				const highlight = iframeDoc.createElement('mark');
				highlight.className = 'simple-browser-search-highlight';
				highlight.style.cssText = 'background-color: yellow; color: black;';

				try {
					range.surroundContents(highlight);
				} catch {
					// Range may cross element boundaries, skip highlighting
				}

				index += query.length;
			}
		}
	} catch {
		// Cross-origin restriction
	}

	return matches;
}

// Clear search highlights
function clearHighlights(): void {
	try {
		const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
		if (!iframeDoc) {
			return;
		}

		const highlights = iframeDoc.querySelectorAll('.simple-browser-search-highlight');
		highlights.forEach(highlight => {
			const parent = highlight.parentNode;
			if (parent) {
				parent.replaceChild(iframeDoc.createTextNode(highlight.textContent || ''), highlight);
				parent.normalize();
			}
		});
	} catch {
		// Cross-origin restriction
	}
}

// Scroll to search match
function scrollToMatch(range: Range): void {
	try {
		const rect = range.getBoundingClientRect();
		const iframeWindow = iframe.contentWindow;
		if (iframeWindow && rect) {
			iframeWindow.scrollTo({
				top: rect.top + iframeWindow.scrollY - 100,
				behavior: 'smooth'
			});
		}
	} catch {
		// Cross-origin restriction
	}
}

// === Console Capture (webview fallback) ===
// Note: This only works when the iframe is same-origin with the webview; for cross-origin pages,
// it will return a cross-origin error so the workbench can fall back to CDP.

interface ConsoleEntry {
	type: 'log' | 'warn' | 'error' | 'info';
	timestamp: number;
	message: string;
	stack?: string;
}

let capturedConsoleLogs: ConsoleEntry[] = [];
let consoleInterceptionActive = false;
let interceptionAttempted = false;

iframe.addEventListener('load', () => {
	interceptionAttempted = false;
	setupConsoleInterception();
});

function setupConsoleInterception(): void {
	if (interceptionAttempted) {
		return;
	}
	interceptionAttempted = true;

	try {
		const iframeWindow = iframe.contentWindow;
		if (!iframeWindow) {
			consoleInterceptionActive = false;
			return;
		}

		const testAccess = iframeWindow.document;
		if (!testAccess) {
			consoleInterceptionActive = false;
			return;
		}

		const iframeConsole = iframeWindow.console;
		if (!iframeConsole) {
			consoleInterceptionActive = false;
			return;
		}

		capturedConsoleLogs = [];
		consoleInterceptionActive = true;

		const originalLog = iframeConsole.log.bind(iframeConsole);
		const originalWarn = iframeConsole.warn.bind(iframeConsole);
		const originalError = iframeConsole.error.bind(iframeConsole);
		const originalInfo = iframeConsole.info.bind(iframeConsole);

		const serializeArgs = (args: unknown[]): string => {
			return args.map(arg => {
				if (arg === undefined) { return 'undefined'; }
				if (arg === null) { return 'null'; }
				if (typeof arg === 'object') {
					try { return JSON.stringify(arg, null, 2); } catch { return String(arg); }
				}
				return String(arg);
			}).join(' ');
		};

		const extractStack = (args: unknown[]): string | undefined => {
			for (const arg of args) {
				if (arg instanceof Error && arg.stack) { return arg.stack; }
			}
			return undefined;
		};

		iframeConsole.log = (...args: unknown[]) => {
			capturedConsoleLogs.push({ type: 'log', timestamp: Date.now(), message: serializeArgs(args) });
			originalLog(...args);
		};

		iframeConsole.warn = (...args: unknown[]) => {
			capturedConsoleLogs.push({ type: 'warn', timestamp: Date.now(), message: serializeArgs(args), stack: extractStack(args) });
			originalWarn(...args);
		};

		iframeConsole.error = (...args: unknown[]) => {
			capturedConsoleLogs.push({ type: 'error', timestamp: Date.now(), message: serializeArgs(args), stack: extractStack(args) });
			originalError(...args);
		};

		iframeConsole.info = (...args: unknown[]) => {
			capturedConsoleLogs.push({ type: 'info', timestamp: Date.now(), message: serializeArgs(args) });
			originalInfo(...args);
		};

		iframeWindow.addEventListener('error', (event) => {
			capturedConsoleLogs.push({
				type: 'error',
				timestamp: Date.now(),
				message: `Uncaught Error: ${event.message}`,
				stack: `at ${event.filename}:${event.lineno}:${event.colno}`
			});
		});

		iframeWindow.addEventListener('unhandledrejection', (event) => {
			const reason = event.reason;
			capturedConsoleLogs.push({
				type: 'error',
				timestamp: Date.now(),
				message: `Unhandled Promise Rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
				stack: reason instanceof Error ? reason.stack : undefined
			});
		});

	} catch {
		consoleInterceptionActive = false;
	}
}

function handleCaptureConsole(): void {
	const url = input.value;

	if (!consoleInterceptionActive && !interceptionAttempted) {
		setupConsoleInterception();
	}

	if (!consoleInterceptionActive) {
		vscode.postMessage({
			type: 'consoleLogsResult',
			success: false,
			error: 'cross-origin',
			url: url
		});
		return;
	}

	const formattedLogs = capturedConsoleLogs.map(entry => {
		const time = new Date(entry.timestamp).toISOString();
		const typeLabel = entry.type.toUpperCase().padEnd(5);
		let logLine = `[${time}] ${typeLabel}: ${entry.message}`;
		if (entry.stack) { logLine += `\n    Stack: ${entry.stack}`; }
		return logLine;
	});

	const counts = {
		log: capturedConsoleLogs.filter(e => e.type === 'log').length,
		info: capturedConsoleLogs.filter(e => e.type === 'info').length,
		warn: capturedConsoleLogs.filter(e => e.type === 'warn').length,
		error: capturedConsoleLogs.filter(e => e.type === 'error').length
	};

	vscode.postMessage({
		type: 'consoleLogsResult',
		success: true,
		url: url,
		logs: formattedLogs,
		counts: counts,
		totalCount: capturedConsoleLogs.length
	});
}
