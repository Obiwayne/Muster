// Typed client for the orchestrator HTTP API (see docs/ARCHITECTURE.md).
import type {
  Agent, FeedItem, InboxItem, MusterConfig, MusterState, Note, NoteType, Role, Task, UsageState, VellumStatus,
} from '../../src/types';

/** Token: injected <meta name="muster-token">, else ?token= in the URL, else VITE_MUSTER_TOKEN (dev). */
export function getToken(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="muster-token"]')?.content?.trim();
  if (meta) return meta;
  const q = new URLSearchParams(location.search).get('token');
  if (q) return q;
  return (import.meta.env.VITE_MUSTER_TOKEN as string | undefined) ?? '';
}

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        'x-muster-token': getToken(),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Cannot reach the Muster orchestrator', 0);
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && data.error) || (typeof data === 'string' && data) || `${res.status} ${res.statusText}`;
    throw new ApiError(String(msg), res.status);
  }
  return data as T;
}

const enc = encodeURIComponent;
const YOU = 'you';

export interface DiffResult { branch: string; base: string; stat: string; diff: string }
export interface TestResult { command: string; exitCode: number; output: string }

export const api = {
  health: () => req<{ ok: boolean; version: string }>('GET', '/api/health'),
  state: () => req<{ state: MusterState; config: MusterConfig; paused: boolean }>('GET', '/api/state'),
  config: () => req<MusterConfig>('GET', '/api/config'),
  patchConfig: (patch: Partial<MusterConfig>) => req<MusterConfig>('PATCH', '/api/config', patch),

  addAgent: (body: { name?: string; role?: Role; taskId?: string }) => req<Agent>('POST', '/api/agents', { ...body, actor: YOU }),
  setRole: (id: string, role: Role) => req<Agent>('POST', `/api/agents/${enc(id)}/role`, { role, actor: YOU }),
  stopAgent: (id: string) => req<Agent>('POST', `/api/agents/${enc(id)}/stop`, { actor: YOU }),
  startAgent: (id: string) => req<Agent>('POST', `/api/agents/${enc(id)}/start`, { actor: YOU }),
  removeAgent: (id: string, removeWorktree = false) => req<{ ok: boolean }>('DELETE', `/api/agents/${enc(id)}${removeWorktree ? '?removeWorktree=1' : ''}`),
  input: (id: string, text: string, submit = true) => req<{ ok: boolean }>('POST', `/api/agents/${enc(id)}/input`, { text, submit }),
  output: (id: string, lines = 80) => req<{ text: string }>('GET', `/api/agents/${enc(id)}/output?lines=${lines}`),
  /** `branch` is an extension the contract doesn't have yet: the orchestrator diffs the agent's
   *  current branch, so callers must check the returned `branch` before trusting the numbers. */
  diff: (id: string, stat = false, branch?: string) => {
    const p = new URLSearchParams();
    if (stat) p.set('stat', '1');
    if (branch) p.set('branch', branch);
    return req<DiffResult>('GET', `/api/agents/${enc(id)}/diff${p.size ? '?' + p : ''}`);
  },
  runTests: (id: string) => req<TestResult>('POST', `/api/agents/${enc(id)}/tests`),
  /** `taskId` names the task to merge (its reviewed commit), so the agent's current branch doesn't matter. */
  merge: (id: string, taskId?: string, force = false) =>
    req<{ ok: boolean; output: string }>('POST', `/api/agents/${enc(id)}/merge`, { force, actor: YOU, ...(taskId ? { taskId } : {}) }),

  ask: (text: string) => req<{ ok: boolean }>('POST', '/api/ask', { text }),

  tasks: () => req<Task[]>('GET', '/api/tasks'),
  createTask: (body: { title: string; description: string; dependsOn?: string[]; stations?: string[]; assignee?: string }) =>
    req<Task>('POST', '/api/tasks', { ...body, actor: YOU }),
  sendBack: (taskId: string, note: string) => req<Task>('POST', `/api/tasks/${enc(taskId)}/sendback`, { actor: YOU, note }),

  notes: (q: { open?: boolean; type?: NoteType; needsYou?: boolean } = {}) => {
    const p = new URLSearchParams();
    if (q.open) p.set('open', '1');
    if (q.type) p.set('type', q.type);
    if (q.needsYou) p.set('needsYou', '1');
    return req<Note[]>('GET', `/api/notes${p.size ? '?' + p : ''}`);
  },
  reply: (noteId: string, text: string, close = false) => req<Note>('POST', `/api/notes/${enc(noteId)}/reply`, { actor: YOU, text, close }),
  closeNote: (noteId: string) => req<Note>('POST', `/api/notes/${enc(noteId)}/close`, { actor: YOU }),
  message: (to: string, text: string) => req<FeedItem>('POST', '/api/messages', { actor: YOU, to, text }),
  feed: (q: { limit?: number; before?: string; agent?: string } = {}) => {
    const p = new URLSearchParams();
    p.set('limit', String(q.limit ?? 200));
    if (q.before) p.set('before', q.before);
    if (q.agent) p.set('agent', q.agent);
    return req<FeedItem[]>('GET', `/api/feed?${p}`);
  },
  inbox: (agentId: string) => req<InboxItem[]>('GET', `/api/inbox/${enc(agentId)}`),
  /** A 404 (older orchestrator without the route) is reported as status 'error', not thrown. */
  vellum: (refresh = false): Promise<VellumStatus> =>
    req<VellumStatus>('GET', `/api/vellum${refresh ? '?refresh=1' : ''}`).catch((e) => {
      if (e instanceof ApiError && e.status === 404) return { status: 'error', message: 'This Muster orchestrator has no /api/vellum yet. Restart it on the latest build.', checkedAt: new Date().toISOString(), files: [] };
      throw e;
    }),
  usage: () => req<UsageState & { paused: boolean }>('GET', '/api/usage'),
};
