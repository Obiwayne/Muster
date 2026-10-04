// The projects the gateway knows (desktop recent list + roots orchestrators registered), whether each is running,
// and requests to a running project's orchestrator on 127.0.0.1 as "you" (its human token, core/tokens.ts).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { readHumanToken, repoKey } from '../core/tokens.js';

export interface Project {
  id: string;
  name: string;
  root: string;
  running: boolean;
  port?: number;
}

/** The desktop app's settings file (Electron userData of the "muster" app), which holds `recent`. */
export function desktopSettingsFile(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'muster', 'settings.json');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'muster', 'settings.json');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'muster', 'settings.json');
}

export function recentRoots(file: string | null): string[] {
  if (!file) return [];
  try {
    const recent = JSON.parse(readFileSync(file, 'utf8')).recent;
    return Array.isArray(recent) ? recent.filter((r: unknown): r is string => typeof r === 'string') : [];
  } catch {
    return [];
  }
}

function projectName(root: string): string {
  try {
    const name = JSON.parse(readFileSync(join(root, '.muster', 'config.json'), 'utf8')).projectName;
    if (typeof name === 'string' && name.trim()) return name.trim();
  } catch {
    /* no config yet */
  }
  return basename(root);
}

function serverPort(root: string): number | undefined {
  try {
    const port = JSON.parse(readFileSync(join(root, '.muster', 'server.json'), 'utf8')).port;
    return typeof port === 'number' ? port : undefined;
  } catch {
    return undefined;
  }
}

async function healthy(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Every known project (deduplicated by id), with running = its server.json port answers /api/health. */
export async function listProjects(roots: string[]): Promise<Project[]> {
  const seen = new Map<string, string>();
  for (const r of roots) {
    const root = resolve(r);
    const id = repoKey(root);
    if (!seen.has(id) && existsSync(root)) seen.set(id, root);
  }
  return Promise.all(
    [...seen].map(async ([id, root]) => {
      const port = serverPort(root);
      const running = port !== undefined && (await healthy(port));
      return { id, name: projectName(root), root, running, ...(running ? { port } : {}) };
    }),
  );
}

export class OrchestratorError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A raw request to a running project's orchestrator as "you". */
export async function orchestratorFetch(p: Project, method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<Response> {
  if (!p.running || !p.port) throw new OrchestratorError(409, `${p.name} isn't running`);
  const token = readHumanToken(p.root);
  if (!token) throw new OrchestratorError(503, `No token for ${p.name}; restart Muster in that project`);
  try {
    return await fetch(`http://127.0.0.1:${p.port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-muster-token': token },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new OrchestratorError(502, `${p.name} did not answer: ${e instanceof Error ? e.message : e}`);
  }
}

/** A JSON request to an orchestrator; its 4xx/5xx come back as OrchestratorError with its message. */
export async function orchestratorJson<T>(p: Project, method: string, path: string, body?: unknown): Promise<T> {
  const res = await orchestratorFetch(p, method, path, body);
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new OrchestratorError(res.status, (data as { error?: string } | null)?.error ?? `${p.name} answered ${res.status}`);
  return data as T;
}
