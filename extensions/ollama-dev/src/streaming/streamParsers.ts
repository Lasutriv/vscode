/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Incremental NDJSON parser.
 *
 * - Maintains an internal buffer for partial lines across chunks.
 * - Returns parsed JSON objects for complete, non-empty lines.
 * - Ignores malformed JSON lines (mirrors our tolerant streaming behavior).
 */
export class NdjsonStreamParser<T> {
	private _buffer = '';

	push(chunk: string): T[] {
		this._buffer += chunk;

		const out: T[] = [];
		const lines = this._buffer.split('\n');
		this._buffer = lines.pop() ?? '';

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}

			try {
				out.push(JSON.parse(trimmed) as T);
			} catch {
				// Ignore malformed JSON lines.
			}
		}

		return out;
	}

	flush(): T[] {
		// Try parsing a final non-newline-terminated line.
		const trimmed = this._buffer.trim();
		this._buffer = '';
		if (!trimmed) {
			return [];
		}
		try {
			return [JSON.parse(trimmed) as T];
		} catch {
			return [];
		}
	}
}

/**
 * Incremental SSE parser for events that encode JSON payloads in `data:` lines.
 *
 * - Maintains an internal buffer for partial lines across chunks.
 * - Returns parsed JSON payloads for complete `data:` lines.
 * - Skips blank payloads and `[DONE]`.
 * - Ignores malformed JSON payloads.
 */
export class SseDataJsonStreamParser<T> {
	private _buffer = '';

	push(chunk: string): T[] {
		this._buffer += chunk;

		const out: T[] = [];
		const lines = this._buffer.split('\n');
		this._buffer = lines.pop() ?? '';

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || !trimmed.startsWith('data:')) {
				continue;
			}

			const payload = trimmed.replace(/^data:\s*/, '').trim();
			if (!payload || payload === '[DONE]') {
				continue;
			}

			try {
				out.push(JSON.parse(payload) as T);
			} catch {
				// Ignore malformed payloads.
			}
		}

		return out;
	}

	flush(): T[] {
		// Best-effort parse of a trailing line.
		return this.push('\n');
	}
}
