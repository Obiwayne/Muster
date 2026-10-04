// Typed client for the orchestrator HTTP API (see docs/ARCHITECTURE.md).
import type {
  Agent, FeedItem, InboxItem, MusterConfig, MusterState, Note, NoteType, ResearchIdea, ResearchRun, ResearchSources, ResearchState, Role, Roadmap,
  RoadmapProgress, SkillInfo, Task, UsageState, VellumStatus,
} from '../../src/types';
// Phone gateway admin API types (forwarded by the orchestrator's /api/phone/*, docs/PHONE.md).
import type { PhoneNetworkMode, PhonePairCode, PhoneSendPrefs, PhoneStatus } from './phonemodel';

// TODO: import StationDef from src/types.ts once T9 (crew-6) merges.
// Contract with T12/T14 (crew-8): GET /api/lines.
export interface LineDef { name: string; label: string; stations: string[]; builtin: boolean }
export interface LinesResponse { lines: LineDef[]; defaultLine: string }
export interface StationDef { name: string; role: 'crew' | 'design' | 'captain' | 'human'; guideline: string; builtin: boolean; skills?: string[] }

/** Token: injected <meta name="muster-token">, else ?token= in the URL, else VITE_MUSTER_TOKEN (dev). */
export function getToken(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="muster-token"]')?.content?.trim();
  if (meta) return meta;
  const q = new URLSearchParams(location.search).get('token');
  if (q) return q;
  return (import.meta.env.VITE_MUSTER_TOKEN as string | undefined) ?? '';
}

/**
 * The orchestrator makes a new token every time it starts, so after a restart this page holds a stale one
 * and every request and socket is refused. The page the server serves always carries the current token:
 * fetch it again and swap it in. Returns true when the token changed.
 */
let refreshing: Promise<boolean> | null = null;
export function refreshToken(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await fetch('/', { cache: 'no-store' });
      if (!res.ok) return false;
      const fresh = /<meta name="muster-token" content="([^"]*)"/.exec(await res.text())?.[1]?.trim();
      if (!fresh || fresh === getToken()) return false;
      let meta = document.querySelector<HTMLMetaElement>('meta[name="muster-token"]');
      if (!meta) {
        meta = document.createElement('meta');
        meta.name = 'muster-token';
        document.head.append(meta);
      }
      meta.content = fresh;
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function req<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
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
  if (res.status === 401 && !retried && (await refreshToken())) return req<T>(method, path, body, true);
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && data.error) || (typeof data === 'string' && data) || `${res.status} ${res.statusText}`;
    throw new ApiError(String(msg), res.status);
  }
  return data as T;
}

/** A file from the API (evidence), as a Blob. Same token handling as req(). */
async function reqBlob(path: string, retried = false): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { 'x-muster-token': getToken() } });
  } catch {
    throw new ApiError('Cannot reach the Muster orchestrator', 0);
  }
  if (res.status === 401 && !retried && (await refreshToken())) return reqBlob(path, true);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { msg = (await res.json()).error ?? msg; } catch { /* not JSON */ }
    throw new ApiError(msg, res.status);
  }
  return res.blob();
}

const enc = encodeURIComponent;
const YOU = 'you';

export interface DiffResult { branch: string; base: string; stat: string; diff: string }
export interface TestResult { command: string; exitCode: number; output: string }

export interface RoadmapResponse { roadmap: Roadmap | null; progress: RoadmapProgress | null }

export interface GhStatus { installed: boolean; authed: boolean; user?: string }
export interface ProjectInfo { name: string; root: string; remoteUrl?: string; gh: GhStatus }

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
  /** Closes the note and hides it from the board (kept in state for history). */
  dismissNote: (noteId: string) => req<Note>('POST', `/api/notes/${enc(noteId)}/dismiss`, { actor: YOU }),
  /** What happens after a weekly usage alert; `noteId` is dismissed in the same call. */
  weeklyAlert: (body: { action: 'remind_at' | 'snooze_week' | 'never'; percent?: number; noteId?: string }) =>
    req<{ usage: UsageState; config: MusterConfig }>('POST', '/api/usage/weekly-alert', { actor: YOU, ...body }),
  message: (to: string, text: string) => req<FeedItem>('POST', '/api/messages', { actor: YOU, to, text }),
  /** Toggles your reaction on a crew-chat line (one of REACTION_EMOJI). */
  react: (feedId: string, emoji: string) => req<FeedItem>('POST', `/api/feed/${enc(feedId)}/react`, { actor: YOU, emoji }),
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
  lines: () => req<LinesResponse>('GET', '/api/lines'),
  saveLine: (name: string, body: { stations: string[]; label?: string }) => req<LineDef>('PUT', `/api/lines/${enc(name)}`, body),
  approve: (taskId: string, note?: string) => req<Task>('POST', `/api/tasks/${enc(taskId)}/approve`, { actor: YOU, ...(note ? { note } : {}) }),
  /** You're happy with the Captain's review: the Captain merges it (merge_task) and pushes. */
  approveMerge: (taskId: string) => req<Task>('POST', `/api/tasks/${enc(taskId)}/approve-merge`, { actor: YOU }),
  commitCheckout: () => req<{ ok: boolean; sha?: string; waiting: string[] }>('POST', '/api/checkout/commit', { actor: YOU }),
  stashCheckout: () => req<{ ok: boolean; stashed: boolean; waiting: string[] }>('POST', '/api/checkout/stash', { actor: YOU }),
  reject: (taskId: string, note: string) => req<Task>('POST', `/api/tasks/${enc(taskId)}/reject`, { actor: YOU, note }),
  stations: () => req<StationDef[]>('GET', '/api/stations'),
  skills: () => req<SkillInfo[]>('GET', '/api/skills'),
  evidenceFile: (taskId: string, entry: string, file: string) => reqBlob(`/api/tasks/${enc(taskId)}/evidence/${enc(entry)}/${enc(file)}`),
  saveStation: (name: string, body: { role?: StationDef['role']; guideline?: string; skills?: string[] }) =>
    req<StationDef>('PUT', `/api/stations/${enc(name)}`, body),
  deleteStation: (name: string) => req<StationDef[]>('DELETE', `/api/stations/${enc(name)}`),
  project: () => req<ProjectInfo>('GET', '/api/project'),
  createGithub: (body: { name: string; private?: boolean; description?: string }) => req<{ url: string }>('POST', '/api/project/github', body),
  usage: () => req<UsageState & { paused: boolean }>('GET', '/api/usage'),

  // phone (Settings → Phone): each call goes to this orchestrator, which starts the gateway when it isn't running
  phoneStatus: () => req<PhoneStatus>('GET', '/api/phone/status'),
  /** A new 6-character code (valid 2 minutes, single use); it invalidates the previous one. */
  phonePairCode: () => req<PhonePairCode>('POST', '/api/phone/pair-code'),
  phoneSetNetwork: (mode: PhoneNetworkMode) => req<unknown>('PUT', '/api/phone/network', { mode }),
  phoneUnlink: (deviceId: string) => req<unknown>('DELETE', `/api/phone/devices/${enc(deviceId)}`),
  phoneTest: () => req<unknown>('POST', '/api/phone/test'),
  phoneSendPrefs: () => req<PhoneSendPrefs>('GET', '/api/phone/send'),
  phoneSetSendPrefs: (prefs: PhoneSendPrefs) => req<PhoneSendPrefs>('PUT', '/api/phone/send', prefs),

  // roadmap (the Captain owns the plan; you approve it, send it back, tick criteria)
  roadmap: () => req<RoadmapResponse>('GET', '/api/roadmap'),
  approveRoadmap: () => req<RoadmapResponse>('POST', '/api/roadmap/approve', { actor: YOU }),
  rejectRoadmap: (note: string) => req<RoadmapResponse>('POST', '/api/roadmap/reject', { actor: YOU, note }),
  checkCriterion: (stageId: string, index: number, done: boolean) =>
    req<RoadmapResponse>('POST', `/api/roadmap/stages/${enc(stageId)}/criteria/${index}`, { actor: YOU, done }),
  completeStage: (stageId: string, force = false) =>
    req<RoadmapResponse>('POST', `/api/roadmap/stages/${enc(stageId)}/complete`, { actor: YOU, ...(force ? { force } : {}) }),

  // research (scout finds ideas; you approve, reject or ask the Captain about them)
  research: () => req<ResearchState>('GET', '/api/research'),
  startResearch: (body: { sources: ResearchSources; focus?: string; depth: 'quick' | 'thorough' }) =>
    req<ResearchRun>('POST', '/api/research/runs', { actor: YOU, ...body }),
  cancelResearch: (runId: string) => req<ResearchRun>('POST', `/api/research/runs/${enc(runId)}/cancel`, { actor: YOU }),
  askIdea: (ideaId: string, text: string) => req<ResearchIdea>('POST', `/api/research/ideas/${enc(ideaId)}/ask`, { actor: YOU, text }),
  approveIdea: (ideaId: string) => req<ResearchIdea>('POST', `/api/research/ideas/${enc(ideaId)}/approve`, { actor: YOU }),
  rejectIdea: (ideaId: string, note?: string) => req<ResearchIdea>('POST', `/api/research/ideas/${enc(ideaId)}/reject`, { actor: YOU, ...(note ? { note } : {}) }),
  reopenIdea: (ideaId: string) => req<ResearchIdea>('POST', `/api/research/ideas/${enc(ideaId)}/reopen`, { actor: YOU }),
};
