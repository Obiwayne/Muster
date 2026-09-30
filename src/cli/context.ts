// Shared plumbing for CLI commands: output, repo discovery, HTTP to the orchestrator.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { musterFetch, serverInfo, type ServerInfo } from '../client.js';
import { colors, type Colors } from './format.js';

export class CliError extends Error {}

export const NOT_RUNNING = "Muster isn't running in this repo — run `muster up`";

export interface Ctx {
  cwd: string;
  /** Overrides repo discovery (tests). */
  repoRoot?: string;
  out(s: string): void;
  c: Colors;
  now(): Date;
  /** Opens a URL in the default browser (overridable in tests). */
  openUrl(url: string): void;
}

export function defaultCtx(): Ctx {
  return {
    cwd: process.cwd(),
    out: (s) => process.stdout.write(s + '\n'),
    c: colors(Boolean(process.stdout.isTTY) && !process.env.NO_COLOR),
    now: () => new Date(),
    openUrl,
  };
}

/** Package root: dist/cli/context.js -> ../.. */
export function musterHome(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * The main checkout's root, even when run from inside a crew worktree
 * (.muster lives in the main checkout). Honours MUSTER_REPO like client.ts.
 */
export function gitMainRoot(cwd: string): string | null {
  if (process.env.MUSTER_REPO) return process.env.MUSTER_REPO;
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common && /[\\/]\.git$/.test(common)) return resolve(dirname(common));
  return resolve(top);
}

export function repoRoot(ctx: Ctx): string {
  if (ctx.repoRoot) return ctx.repoRoot;
  const root = gitMainRoot(ctx.cwd);
  if (!root) throw new CliError('Not inside a git repository. Run muster from your project folder.');
  return root;
}

export interface ServerFile {
  port: number;
  pid: number;
  /** Only in server.json files from before 0.1.1; the human token now lives outside the repo (core/tokens.ts). */
  token?: string;
  startedAt: string;
}

export function readServerFile(root: string): ServerFile | null {
  const file = join(root, '.muster', 'server.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ServerFile;
  } catch {
    return null;
  }
}

export function requireServer(ctx: Ctx): ServerInfo {
  const info = serverInfo(repoRoot(ctx));
  if (!info) throw new CliError(NOT_RUNNING);
  return info;
}

export async function healthy(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(url + '/api/health', { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

function isConnectionError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const cause = (e as { cause?: { code?: string } }).cause;
  return (
    (e.name === 'TypeError' && /fetch failed/i.test(e.message)) ||
    ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(cause?.code ?? '')
  );
}

/** musterFetch with CLI-friendly errors. */
export async function api<T>(ctx: Ctx, path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const root = repoRoot(ctx);
  if (!serverInfo(root)) throw new CliError(NOT_RUNNING);
  try {
    return await musterFetch<T>(path, { ...opts, repoRoot: root });
  } catch (e) {
    if (isConnectionError(e)) throw new CliError(NOT_RUNNING);
    throw new CliError(e instanceof Error ? e.message : String(e));
  }
}

export function openUrl(url: string): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' });
  child.on('error', () => {});
  child.unref();
}

export function dashboardUrl(info: ServerInfo): string {
  return info.url.replace(/\/$/, '') + '/';
}
