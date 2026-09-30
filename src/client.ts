// Tiny HTTP client for the orchestrator, shared by the CLI, muster-mcp, hooks and the status line.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readHumanToken } from './core/tokens.js';

export interface ServerInfo {
  url: string;
  token: string;
}

export function findRepoRoot(cwd = process.cwd()): string | null {
  if (process.env.MUSTER_REPO) return process.env.MUSTER_REPO;
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Where the orchestrator is and which token to send.
 * - Inside an agent (MUSTER_AGENT set): only the agent's own MUSTER_URL/MUSTER_TOKEN. Never the human
 *   token, so `muster merge` run by an agent is refused by the server.
 * - Otherwise (you): the port from .muster/server.json and the human token from outside the repo
 *   (core/tokens.ts), falling back to MUSTER_URL/MUSTER_TOKEN when there is no server.json.
 */
export function serverInfo(repoRoot?: string): ServerInfo | null {
  const envInfo = process.env.MUSTER_URL && process.env.MUSTER_TOKEN ? { url: process.env.MUSTER_URL, token: process.env.MUSTER_TOKEN } : null;
  if (process.env.MUSTER_AGENT) return envInfo;
  const root = repoRoot ?? findRepoRoot();
  const file = root ? join(root, '.muster', 'server.json') : '';
  if (!root || !existsSync(file)) return envInfo;
  try {
    const info = JSON.parse(readFileSync(file, 'utf8')) as { port: number; token?: string };
    const token = readHumanToken(root) ?? info.token; // server.json carried the token before 0.1.1
    return token ? { url: `http://127.0.0.1:${info.port}`, token } : envInfo;
  } catch {
    return envInfo;
  }
}

export async function musterFetch<T>(
  path: string,
  opts: { method?: string; body?: unknown; repoRoot?: string; timeoutMs?: number } = {},
): Promise<T> {
  const info = serverInfo(opts.repoRoot);
  if (!info) throw new Error('Muster is not running here. Start it with `muster up`.');
  const res = await fetch(info.url + path, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', 'x-muster-token': info.token },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
  return data as T;
}
