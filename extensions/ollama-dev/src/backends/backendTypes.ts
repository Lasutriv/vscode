/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type ToolSchema = { required?: string[]; properties?: Record<string, unknown> };

export type BackendPart =
	| { type: 'text'; value: string }
	| { type: 'thinking'; value: string }
	| { type: 'toolCall'; callId: string; name: string; input: Record<string, unknown> };
