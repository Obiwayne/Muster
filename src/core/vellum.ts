// Read-only Vellum client: connects to the Vellum MCP server over stdio, only ever calls list_files.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { MusterConfig } from '../types.js';
import { vellumServer } from './claude.js';

export interface VellumStatus {
  configured: boolean;
  /** The Vellum app answered list_files. */
  connected: boolean;
  /** Why it is not connected (e.g. the Vellum app is not running). */
  error?: string;
  /** What list_files returned: parsed JSON when it is JSON, else the raw text. */
  files: unknown;
}

/** Runs one read-only tool call against the Vellum MCP; returns its text. Throws on failure. */
export type VellumCall = (server: NonNullable<MusterConfig['vellum']>, tool: 'list_files') => Promise<string>;

const TIMEOUT_MS = 8000;

export const callVellum: VellumCall = async (server, tool) => {
  const env = Object.fromEntries(Object.entries({ ...process.env, ...server.env }).filter((e): e is [string, string] => e[1] !== undefined));
  const transport = new StdioClientTransport({ command: server.command, args: server.args, env, stderr: 'ignore' });
  const client = new Client({ name: 'muster', version: '0.1.0' });
  try {
    await client.connect(transport, { timeout: TIMEOUT_MS });
    const res = (await client.callTool({ name: tool, arguments: {} }, undefined, { timeout: TIMEOUT_MS })) as {
      isError?: boolean;
      content?: { type: string; text?: string }[];
    };
    const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    if (res.isError) throw new Error(text || `${tool} failed`);
    return text;
  } finally {
    await client.close().catch(() => {});
  }
};

export async function vellumStatus(config: MusterConfig, call: VellumCall = callVellum): Promise<VellumStatus> {
  const server = vellumServer(config);
  if (!server) return { configured: false, connected: false, error: 'Vellum MCP is not configured', files: [] };
  try {
    const text = await call(server, 'list_files');
    let files: unknown = text;
    try {
      files = JSON.parse(text);
    } catch {
      /* keep the raw text */
    }
    return { configured: true, connected: true, files };
  } catch (e) {
    return { configured: true, connected: false, error: e instanceof Error ? e.message : String(e), files: [] };
  }
}
