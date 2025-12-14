/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Parse Qwen3-Coder's special XML tool call format.
 *
 * IMPORTANT: Qwen3-Coder uses a CUSTOM XML format instead of standard JSON tool calls.
 * This is different from most other models which use Ollama's native tool_calls format.
 *
 * XML Format:
 * ```xml
 * <tool_call>
 * <function=function_name>
 * <parameter=param1>value1</parameter>
 * <parameter=param2>value2</parameter>
 * </function>
 * </tool_call>
 * ```
 *
 * @see https://huggingface.co/Qwen/Qwen3-Coder-480B-A35B-Instruct/blob/main/qwen3coder_tool_parser.py
 * @see https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct
 */
export interface ParsedQwenToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

export function parseQwen3CoderToolCalls(content: string): ParsedQwenToolCall[] {
	const toolCalls: ParsedQwenToolCall[] = [];

	// Regex to find tool call blocks
	const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
	const functionRegex = /<function=([^>]+)>([\s\S]*?)<\/function>/;
	const parameterRegex = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g;

	let match;
	while ((match = toolCallRegex.exec(content)) !== null) {
		const toolCallContent = match[1];
		const funcMatch = functionRegex.exec(toolCallContent);

		if (funcMatch) {
			const functionName = funcMatch[1].trim();
			const parametersContent = funcMatch[2];
			const args: Record<string, unknown> = {};

			let paramMatch;
			while ((paramMatch = parameterRegex.exec(parametersContent)) !== null) {
				const paramName = paramMatch[1].trim();
				let paramValue: unknown = paramMatch[2].trim();

				// Remove leading/trailing newlines from parameter values
				if (typeof paramValue === 'string') {
					paramValue = paramValue.replace(/^\n+|\n+$/g, '');
					const strValue = paramValue as string;

					// Try to parse as JSON if it looks like JSON
					if ((strValue.startsWith('{') && strValue.endsWith('}')) ||
						(strValue.startsWith('[') && strValue.endsWith(']'))) {
						try {
							paramValue = JSON.parse(strValue);
						} catch {
							// Keep as string if not valid JSON
						}
					} else if (strValue.toLowerCase() === 'true') {
						paramValue = true;
					} else if (strValue.toLowerCase() === 'false') {
						paramValue = false;
					} else if (strValue.toLowerCase() === 'null') {
						paramValue = null;
					} else if (!isNaN(Number(strValue)) && strValue !== '') {
						// Try to parse as number
						const num = Number(strValue);
						if (Number.isInteger(num) && strValue.indexOf('.') === -1) {
							paramValue = parseInt(strValue, 10);
						} else {
							paramValue = num;
						}
					}
				}

				args[paramName] = paramValue;
			}

			toolCalls.push({
				name: functionName,
				arguments: args
			});
		}
	}

	return toolCalls;
}

/**
 * Check if model is Qwen3-Coder which uses special XML tool call format.
 */
export function isQwen3CoderModel(modelName: string): boolean {
	const lowerName = modelName.toLowerCase();
	return lowerName.includes('qwen3') && lowerName.includes('coder');
}
