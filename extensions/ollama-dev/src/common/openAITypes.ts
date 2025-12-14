/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { OllamaTool } from './ollamaTypes';

export interface OpenAIChatMessage {
	role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
	content?: string | null;
	name?: string;
	tool_call_id?: string;
	tool_calls?: Array<{
		id?: string;
		type: 'function';
		function: { name: string; arguments: string };
	}>;
}

export interface OpenAIChatRequest {
	model: string;
	messages: OpenAIChatMessage[];
	stream: boolean;
	tools?: OllamaTool[];
	temperature?: number;
	max_tokens?: number;
}

export interface OpenAIStreamChunk {
	id?: string;
	choices: Array<{
		delta: {
			content?: string;
			tool_calls?: Array<{
				id?: string;
				index?: number;
				type: 'function';
				function: { name: string; arguments: string };
			}>;
		};
		finish_reason?: string;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
}
