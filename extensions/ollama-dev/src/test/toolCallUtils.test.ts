/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { describe, it } from 'mocha';

import type { ToolSchema } from '../backends/backendTypes';
import { coerceToolArgsFromString, coerceToolArgsFromUnknown, ensureToolExplanationField, getToolNameToParams, inferToolNameFromRawArgs, normalizeToolInputSchema } from '../tools/toolCallUtils';

describe('ollama-dev toolCallUtils', () => {
	it('normalizes tool schema and requires explanation when present', () => {
		const schema = normalizeToolInputSchema({
			required: ['query'],
			properties: {
				query: { type: 'string' },
				explanation: { type: 'string' }
			}
		});
		assert.deepStrictEqual(schema.required, ['explanation', 'query']);
		assert.ok(schema.properties);
		assert.ok(Object.prototype.hasOwnProperty.call(schema.properties, 'explanation'));
	});

	it('builds toolNameToParams map from tool list', () => {
		const map = getToolNameToParams([
			{ name: 'search', inputSchema: { required: ['query'], properties: { query: { type: 'string' } } } },
			{ name: 'openFile', inputSchema: { required: ['path'], properties: { path: { type: 'string' } } } },
		]);
		assert.strictEqual(map.get('search')?.required?.[0], 'query');
		assert.strictEqual(map.get('openFile')?.required?.[0], 'path');
	});

	it('infers tool name based on required/property keys', () => {
		const tools = new Map<string, ToolSchema>();
		tools.set('search', { required: ['query'], properties: { query: { type: 'string' } } });
		tools.set('openFile', { required: ['path'], properties: { path: { type: 'string' }, preview: { type: 'boolean' } } });

		assert.strictEqual(inferToolNameFromRawArgs('{"path":"/tmp/a.txt","preview":true}', tools), 'openFile');
		assert.strictEqual(inferToolNameFromRawArgs('{"query":"hello"}', tools), 'search');
	});

	it('coerces JSON string args into an object', () => {
		const tools = new Map<string, ToolSchema>();
		tools.set('t', { required: ['query'], properties: { query: { type: 'string' } } });

		assert.deepStrictEqual(coerceToolArgsFromString('{"query":"hello"}', 't', tools), { query: 'hello' });
	});

	it('coerces non-JSON string args into required keys when available', () => {
		const tools = new Map<string, ToolSchema>();
		tools.set('search', { required: ['query'], properties: { query: { type: 'string' } } });
		const obj = coerceToolArgsFromString('hello', 'search', tools);
		assert.deepStrictEqual(obj, { query: 'hello' });
	});

	it('coerces non-JSON string args into a value field when schema is unknown', () => {
		const tools = new Map<string, ToolSchema>();
		const obj = coerceToolArgsFromString('hello', undefined, tools);
		assert.deepStrictEqual(obj, { value: 'hello' });
	});

	it('coerces unknown args: object stays object', () => {
		const tools = new Map<string, ToolSchema>();
		const obj = coerceToolArgsFromUnknown({ a: 1 }, 't', tools);
		assert.deepStrictEqual(obj, { a: 1 });
	});

	it('adds explanation field if missing', () => {
		const args: Record<string, unknown> = { query: 'hello' };
		ensureToolExplanationField(args, 'search');
		assert.strictEqual(typeof args.explanation, 'string');
	});

	it('does not overwrite explanation field if present', () => {
		const args: Record<string, unknown> = { explanation: 'keep', query: 'hello' };
		ensureToolExplanationField(args, 'search');
		assert.strictEqual(args.explanation, 'keep');
	});
});
