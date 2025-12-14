/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolSchema } from '../backends/backendTypes';

export type ToolInputSchema = { required?: string[]; properties?: Record<string, unknown> };

/**
 * Normalizes a tool input schema so downstream code can safely use it.
 *
 * - Always clones `required`/`properties`
 * - If `properties.explanation` exists, ensures `required` includes `explanation`
 */
export function normalizeToolInputSchema(inputSchema: ToolInputSchema | undefined): ToolSchema {
	const properties = inputSchema?.properties ? { ...inputSchema.properties } : {};
	let required = inputSchema?.required ? [...inputSchema.required] : undefined;

	if (Object.hasOwn(properties, 'explanation')) {
		if (!required) {
			required = ['explanation'];
		} else if (!required.includes('explanation')) {
			required = ['explanation', ...required];
		}
	}

	return { properties, required };
}

export function getToolNameToParams(tools: readonly { name: string; inputSchema?: ToolInputSchema }[] | undefined): Map<string, ToolSchema> {
	const map = new Map<string, ToolSchema>();
	for (const t of tools ?? []) {
		map.set(t.name, normalizeToolInputSchema(t.inputSchema));
	}
	return map;
}

export function inferToolNameFromRawArgs(rawArgsStr: string, toolNameToParams: ReadonlyMap<string, ToolSchema>): string | undefined {
	let bestName: string | undefined;
	let bestScore = 0;
	for (const [name, params] of toolNameToParams) {
		let score = 0;
		const keys = new Set<string>();
		if (params.required) {
			for (const k of params.required) {
				keys.add(k);
			}
		}
		if (params.properties) {
			for (const k of Object.keys(params.properties)) {
				keys.add(k);
			}
		}
		for (const k of keys) {
			if (rawArgsStr.includes(`\"${k}\"`) || rawArgsStr.includes(`${k}`)) {
				score++;
			}
		}
		if (score > bestScore) {
			bestScore = score;
			bestName = name;
		}
	}
	return bestName;
}

export function coerceToolArgsFromUnknown(rawArgs: unknown, toolName: string | undefined, toolNameToParams: ReadonlyMap<string, ToolSchema>): Record<string, unknown> {
	let parsed: unknown = rawArgs ?? {};
	if (typeof rawArgs === 'string') {
		try {
			parsed = rawArgs ? JSON.parse(rawArgs) : {};
		} catch {
			parsed = rawArgs;
		}
	}

	if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
		return parsed as Record<string, unknown>;
	}

	const params = toolName ? toolNameToParams.get(toolName) : undefined;
	const raw = typeof parsed === 'string' ? parsed : (typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs));

	return coerceToolArgsFromString(raw ?? '', toolName, toolNameToParams, params);
}

export function coerceToolArgsFromString(rawArgsStr: string, toolName: string | undefined, toolNameToParams: ReadonlyMap<string, ToolSchema>, paramsOverride?: ToolSchema): Record<string, unknown> {
	let parsed: unknown = {};
	try {
		parsed = rawArgsStr ? JSON.parse(rawArgsStr) : {};
	} catch {
		parsed = rawArgsStr;
	}

	if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
		return parsed as Record<string, unknown>;
	}

	const params = paramsOverride ?? (toolName ? toolNameToParams.get(toolName) : undefined);
	const raw = typeof parsed === 'string' ? parsed : rawArgsStr;

	if (params?.required && params.required.length > 0) {
		const obj: Record<string, unknown> = {};
		for (const key of params.required) {
			obj[key] = raw ?? '';
		}
		return obj;
	}

	if (params?.properties && Object.hasOwn(params.properties, 'query')) {
		return { query: raw ?? '' };
	}

	return { value: raw ?? '' };
}

export function ensureToolExplanationField(argsObj: Record<string, unknown>, toolName: string): void {
	if (Object.hasOwn(argsObj, 'explanation')) {
		return;
	}
	const argsPreview = Object.keys(argsObj).slice(0, 3).join(', ');
	argsObj['explanation'] = `Calling ${toolName}${argsPreview ? ` with ${argsPreview}` : ''}`;
}
