// Opera cookie import for the research browser (opt-in, allow-listed domains only).
//
// scripts/opera-cookies.py reads Opera's cookie DB in place with browser_cookie3 under Agent Reach's
// python and prints Playwright addCookies JSON on stdout. This module runs it, checks every cookie
// belongs to an allowed domain, and hands the cookies to the caller (ResearchBrowser adds them to the
// research profile). Values are never logged, stored elsewhere or returned by the API: only counts.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MUSTER_HOME } from '../core/paths.js';
import { cleanDomain, hostMatches } from './sites.js';

/** The subset of Playwright's cookie shape the research browser uses. */
export interface PwCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number; // unix seconds, -1 = session
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Test seam: runs `python args…` and resolves with its output. */
export type PythonRunner = (python: string, args: string[], timeoutMs: number) => Promise<RunResult>;

export const OPERA_SCRIPT = join(MUSTER_HOME, 'scripts', 'opera-cookies.py');

export const realRunner: PythonRunner = (python, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(python, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err && !stdout ? err.message : '') });
    });
  });

/** Agent Reach's python: AGENT_REACH_PYTHON, else ~/.agent-reach/venv/Scripts/python.exe (bin/python elsewhere). */
export function agentReachPython(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.AGENT_REACH_PYTHON) return env.AGENT_REACH_PYTHON;
  const venv = join(env.USERPROFILE || homedir(), '.agent-reach', 'venv');
  return platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python');
}

/** Opera's profile folder ("Opera Stable"); its cookie DB is Default/Network/Cookies, its key in Local State. */
export function operaProfileDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.MUSTER_OPERA_DIR) return env.MUSTER_OPERA_DIR;
  if (platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Opera Software', 'Opera Stable');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'com.operasoftware.Opera');
  return join(homedir(), '.config', 'opera');
}

export function operaFound(dir = operaProfileDir(), exists: (p: string) => boolean = existsSync): boolean {
  return exists(join(dir, 'Local State')) && (exists(join(dir, 'Default', 'Network', 'Cookies')) || exists(join(dir, 'Network', 'Cookies')));
}

export interface OperaExport {
  cookies: PwCookie[];
  counts: Record<string, number>; // domain → cookies found
  errors: Record<string, string>; // domain (or "*") → what failed
}

export interface OperaOptions {
  run?: PythonRunner;
  python?: string;
  script?: string;
  timeoutMs?: number;
}

const SAME_SITE = new Set(['Strict', 'Lax', 'None']);

function cleanCookie(raw: unknown): PwCookie | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.name !== 'string' || !c.name || typeof c.domain !== 'string' || !c.domain) return null;
  const secure = c.secure === true;
  let sameSite = typeof c.sameSite === 'string' && SAME_SITE.has(c.sameSite) ? (c.sameSite as PwCookie['sameSite']) : 'Lax';
  if (sameSite === 'None' && !secure) sameSite = 'Lax'; // Chrome refuses SameSite=None without Secure
  const expires = typeof c.expires === 'number' && c.expires > 0 ? Math.floor(c.expires) : -1;
  return {
    name: c.name,
    value: typeof c.value === 'string' ? c.value : '',
    domain: c.domain,
    path: typeof c.path === 'string' && c.path.startsWith('/') ? c.path : '/',
    expires,
    httpOnly: c.httpOnly === true,
    secure,
    sameSite,
  };
}

/**
 * Export Opera cookies for `domains` (each must already be a clean registrable domain the caller checked
 * against the allowlist). Cookies for any other domain are dropped, whatever the script printed.
 */
export async function exportOperaCookies(domains: string[], opts: OperaOptions = {}): Promise<OperaExport> {
  const clean = [...new Set(domains.map((d) => cleanDomain(d)).filter((d): d is string => !!d))];
  const out: OperaExport = { cookies: [], counts: {}, errors: {} };
  if (!clean.length) return out;
  const run = opts.run ?? realRunner;
  const python = opts.python ?? agentReachPython();
  const res = await run(python, [opts.script ?? OPERA_SCRIPT, ...clean], opts.timeoutMs ?? 60_000);
  let parsed: { cookies?: unknown; counts?: unknown; errors?: unknown };
  try {
    parsed = JSON.parse(res.stdout.trim().split(/\r?\n/).pop() || '');
  } catch {
    // stderr never carries values (the script only prints them on stdout), but keep it short anyway
    const why = res.stderr.trim().split(/\r?\n/).pop()?.slice(0, 200) || `exit ${res.code}`;
    out.errors['*'] = `The Opera cookie export failed: ${why}`;
    return out;
  }
  const errors = parsed.errors && typeof parsed.errors === 'object' ? (parsed.errors as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(errors)) out.errors[k] = String(v).slice(0, 200);
  for (const d of clean) out.counts[d] = 0;
  for (const raw of Array.isArray(parsed.cookies) ? parsed.cookies : []) {
    const c = cleanCookie(raw);
    if (!c) continue;
    const d = clean.find((x) => hostMatches(c.domain, x));
    if (!d) continue;
    out.cookies.push(c);
    out.counts[d]++;
  }
  return out;
}
