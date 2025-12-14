/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Configuration keys
export const LLAMA_CPP_PATCH_MARKER = '2025-12-14-alternation-safety-net-v3';
export const OLLAMA_REMOTE_HOST_CONFIG = 'ollamaDev.remoteHost';
export const OLLAMA_REMOTE_PORT_CONFIG = 'ollamaDev.remotePort';
export const OLLAMA_LOCAL_PORT_CONFIG = 'ollamaDev.localPort';
export const OLLAMA_CONNECTION_MODE_CONFIG = 'ollamaDev.connectionMode';
export const OLLAMA_LOCAL_ENDPOINT_CONFIG = 'ollamaDev.localEndpoint';

export type ConnectionMode = 'ssh' | 'local';
export type ApiMode = 'ollama' | 'llamaCpp';
