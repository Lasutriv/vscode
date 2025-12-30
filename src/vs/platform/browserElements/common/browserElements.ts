/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { IRectangle } from '../../window/common/window.js';

export const INativeBrowserElementsService = createDecorator<INativeBrowserElementsService>('nativeBrowserElementsService');

export interface IElementData {
	readonly outerHTML: string;
	readonly computedStyle: string;
	readonly bounds: IRectangle;
}

export interface IConsoleLogEntry {
	readonly type: 'log' | 'info' | 'warn' | 'error' | 'debug';
	readonly timestamp: number;
	readonly message: string;
	readonly stackTrace?: string;
	readonly url?: string;
	readonly lineNumber?: number;
	readonly columnNumber?: number;
}

export interface IConsoleLogsResult {
	readonly success: boolean;
	readonly url: string;
	readonly logs: IConsoleLogEntry[];
	readonly error?: string;
}

export interface ICurrentUrlResult {
	readonly success: boolean;
	readonly url: string;
	readonly error?: string;
}

export enum BrowserType {
	SimpleBrowser = 'simpleBrowser',
	LiveServer = 'liveServer',
}


export interface INativeBrowserElementsService {

	readonly _serviceBrand: undefined;

	// Properties
	readonly windowId: number;

	getElementData(rect: IRectangle, token: CancellationToken, browserType: BrowserType, cancellationId?: number): Promise<IElementData | undefined>;

	startDebugSession(token: CancellationToken, browserType: BrowserType, cancelAndDetachId?: number): Promise<void>;

	getConsoleLogs(token: CancellationToken, browserType: BrowserType, durationMs?: number): Promise<IConsoleLogsResult>;

	getCurrentUrl(token: CancellationToken, browserType: BrowserType): Promise<ICurrentUrlResult>;
}
