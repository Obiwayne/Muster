// Read-only Vellum client: connects to the Vellum MCP server over stdio and only ever calls list_files.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { MusterConfig, VellumFile, VellumStatus } from '../types.js';
import { vellumServer } from './claude.js';

type Server = NonNullable<MusterConfig['vellum']>;

/** list_files is the only tool this module may call. */
export type VellumCall = (server: Server, tool: 'list_files', signal: AbortSignal) => Promise<string>;

/** A tool error reported by Vellum (as opposed to failing to reach it). */
export class VellumToolError extends Error {}

export const DEADLINE_MS = 5000;
export const CACHE_MS = 30_000;

export const callVellum: VellumCall = async (server, tool, signal) => {
  const env = Object.fromEntries(Object.entries({ ...process.env, ...server.env }).filter((e): e is [string, string] => e[1] !== undefined));
  const transport = new StdioClientTransport({ command: server.command, args: server.args, env, stderr: 'ignore' });
  const client = new Client({ name: 'muster', version: '0.1.0' });
  const abort = () => void client.close().catch(() => {});
  signal.addEventListener('abort', abort);
  try {
    await client.connect(transport, { signal });
    const res = (await client.callTool({ name: tool, arguments: {} }, undefined, { signal })) as {
      isError?: boolean;
      content?: { type: string; text?: string }[];
    };
    const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    if (res.isError) throw new VellumToolError(text || `${tool} failed`);
    return text;
  } finally {
    signal.removeEventListener('abort', abort);
    await client.close().catch(() => {});
  }
};

const isoOf = (v: unknown): string | undefined => {
  if (typeof v !== 'number' && typeof v !== 'string') return undefined;
  const d = new Date(typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

/** Maps list_files output (an array, or an object holding one) to VellumFile[]; undefined if it is not that. */
export function parseFiles(text: string): VellumFile[] | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) data = (data as { files?: unknown }).files;
  if (!Array.isArray(data)) return undefined;
  const files: VellumFile[] = [];
  for (const f of data) {
    if (!f || typeof f !== 'object' || typeof f.id !== 'string') continue;
    const pages = Array.isArray(f.pages) ? f.pages.length : Number.isFinite(f.pages) ? Number(f.pages) : Number.isFinite(f.pageCount) ? Number(f.pageCount) : 0;
    const updated = isoOf(f.updatedAt);
    files.push({ id: f.id, name: typeof f.name === 'string' ? f.name : f.id, pages, ...(updated ? { updated } : {}) });
  }
  return files;
}

export interface VellumCheckerOptions {
  call?: VellumCall;
  /** Where the default Vellum MCP entry is looked for (see vellumServer). */
  defaultEntry?: string;
  deadlineMs?: number;
  cacheMs?: number;
  now?: () => number;
}

/** Checks Vellum at most once per cache window; concurrent checks share one in-flight run. */
export function createVellumChecker(opts: VellumCheckerOptions = {}) {
  const call = opts.call ?? callVellum;
  const deadlineMs = opts.deadlineMs ?? DEADLINE_MS;
  const cacheMs = opts.cacheMs ?? CACHE_MS;
  const now = opts.now ?? Date.now;
  let cached: { key: string; at: number; result: VellumStatus } | undefined;
  let inflight: { key: string; promise: Promise<VellumStatus> } | undefined;

  async function run(server: Server): Promise<VellumStatus> {
    const result = (status: VellumStatus['status'], files: VellumFile[] = [], message?: string): VellumStatus => ({
      status,
      ...(message ? { message } : {}),
      checkedAt: new Date(now()).toISOString(),
      files,
    });
    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new Error(`Vellum did not answer within ${Math.round(deadlineMs / 1000)}s`));
      }, deadlineMs);
    });
    try {
      const text = await Promise.race([call(server, 'list_files', ac.signal), deadline]);
      const files = parseFiles(text);
      return files ? result('connected', files) : result('error', [], 'Vellum returned a file list Muster could not read');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return result(e instanceof VellumToolError ? 'error' : 'unreachable', [], message);
    } finally {
      clearTimeout(timer);
      ac.abort(); // stops the child on every path
    }
  }

  return {
    async check(config: MusterConfig, refresh = false): Promise<VellumStatus> {
      const server = vellumServer(config, opts.defaultEntry);
      if (!server) return { status: 'not_configured', message: 'Set the Vellum MCP path in Settings', checkedAt: new Date(now()).toISOString(), files: [] };
      const key = JSON.stringify(server);
      if (!refresh && cached?.key === key && now() - cached.at < cacheMs) return cached.result;
      if (!refresh && inflight?.key === key) return inflight.promise;
      const promise = run(server).then((result) => {
        cached = { key, at: now(), result };
        return result;
      });
      const mine = { key, promise };
      inflight = mine;
      void promise.finally(() => {
        if (inflight === mine) inflight = undefined;
      });
      return promise;
    },
  };
}
