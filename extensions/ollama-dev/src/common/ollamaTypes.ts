/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export interface OllamaModel {
	name: string;
	model: string;
	modified_at: string;
	size: number;
	digest: string;
	details: {
		parent_model: string;
		format: string;
		family: string;
		families: string[];
		parameter_size: string;
		quantization_level: string;
	};
}

export interface OllamaTagsResponse {
	models: OllamaModel[];
}

export interface OllamaToolCall {
	type?: 'function';
	function: {
		index?: number;
		name: string;
		arguments: Record<string, unknown>;
	};
}

export interface OllamaChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	tool_calls?: OllamaToolCall[];
	tool_name?: string;
	images?: string[];
	thinking?: string;
}

export interface OllamaTool {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: {
			type: 'object';
			properties: Record<string, unknown>;
			required?: string[];
		};
	};
}

export interface OllamaChatRequest {
	model: string;
	messages: OllamaChatMessage[];
	stream: boolean;
	tools?: OllamaTool[];
	format?: 'json' | Record<string, unknown>;
	think?: boolean;
	keep_alive?: string | number;
	options?: {
		num_ctx?: number;
		num_predict?: number;
		temperature?: number;
		seed?: number;
		top_k?: number;
		top_p?: number;
		repeat_penalty?: number;
		stop?: string[];
	};
}

export interface OllamaChatStreamChunk {
	model: string;
	created_at: string;
	message: {
		role: string;
		content: string;
		tool_calls?: OllamaToolCall[];
		thinking?: string;
		images?: string[] | null;
	};
	done: boolean;
	done_reason?: string;
	prompt_eval_count?: number;
	eval_count?: number;
	total_duration?: number;
	load_duration?: number;
	prompt_eval_duration?: number;
	eval_duration?: number;
}

export interface OllamaModelInfo extends vscode.LanguageModelChatInformation {
	ollamaName: string;
}
