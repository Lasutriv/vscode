/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
import fs from 'fs';
import path from 'path';
import { run } from '../esbuild-webview-common.mts';

const srcDir = path.join(import.meta.dirname, 'chat-webview-src');
const outDir = path.join(import.meta.dirname, 'chat-webview-out');
const codiconCssCandidates = [
	path.join(import.meta.dirname, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
	path.join(import.meta.dirname, '..', '..', 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
];
const codiconCssPath = codiconCssCandidates.find(candidate => fs.existsSync(candidate));

if (!codiconCssPath) {
	throw new Error(`Could not find codicon.css. Checked: ${codiconCssCandidates.join(', ')}`);
}

run({
	entryPoints: {
		'index': path.join(srcDir, 'index.ts'),
		'index-editor': path.join(srcDir, 'index-editor.ts'),
		'codicon': codiconCssPath,
	},
	srcDir,
	outdir: outDir,
	additionalOptions: {
		loader: {
			'.ttf': 'dataurl',
		}
	}
}, process.argv);
