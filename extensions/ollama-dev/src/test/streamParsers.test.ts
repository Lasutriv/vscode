/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { describe, it } from 'mocha';

import { NdjsonStreamParser, SseDataJsonStreamParser } from '../streaming/streamParsers';

describe('ollama-dev streamParsers', () => {
	it('parses NDJSON across chunk boundaries', () => {
		const p = new NdjsonStreamParser<{ a: number }>();
		assert.deepStrictEqual(p.push('{"a":1}\n{"a":'), [{ a: 1 }]);
		assert.deepStrictEqual(p.push('2}\n\n{"a":3}\n'), [{ a: 2 }, { a: 3 }]);
		assert.deepStrictEqual(p.flush(), []);
	});

	it('ignores malformed NDJSON lines but continues', () => {
		const p = new NdjsonStreamParser<{ ok: boolean }>();
		const out = p.push('{"ok":true}\n{not json}\n{"ok":false}\n');
		assert.deepStrictEqual(out, [{ ok: true }, { ok: false }]);
	});

	it('parses SSE data: JSON across chunk boundaries and ignores [DONE]', () => {
		const p = new SseDataJsonStreamParser<{ x: number }>();
		assert.deepStrictEqual(p.push('data: {"x":1}\n\n'), [{ x: 1 }]);
		assert.deepStrictEqual(p.push('data: {"x":'), []);
		assert.deepStrictEqual(p.push('2}\n\ndata: [DONE]\n'), [{ x: 2 }]);
	});

	it('ignores non-data lines and malformed payloads', () => {
		const p = new SseDataJsonStreamParser<{ y: string }>();
		const out = p.push('event: message\ndata: {"y":"ok"}\n\ndata: {nope}\n');
		assert.deepStrictEqual(out, [{ y: 'ok' }]);
	});
});
