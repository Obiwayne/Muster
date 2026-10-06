// What the phone shows and notifies: needs-you items built from a project's state, and the per-device filter
// (prefs + quiet hours). Pure functions; the gateway feeds them the state it fetched. See docs/PHONE.md.
import type { AskQuestion, MusterState, Note, Task } from '../types.js';
import { HUMAN, isNeedsYou } from '../core/board.js';

export type NeedKind = 'review' | 'approval' | 'question' | 'escalation' | 'blocked' | 'usage' | 'stuck' | 'remote_write';
export type NeedAction = 'approve' | 'open' | 'answer' | 'commit' | 'stash' | 'send' | 'discard'; // send/discard: a held remote write

export interface NeedItem {
  id: string; // `${projectId}:${noteId}`
  projectId: string;
  projectName: string;
  kind: NeedKind;
  noteId?: string;
  taskId?: string;
  title: string;
  summary: string;
  from: string;
  createdAt: string;
  evidence?: { id: string; files: number; thumbs: string[] };
  ask?: AskQuestion[]; // escalation from the Captain's question menu: answer with POST .../notes/:nid/answer
  remote?: RemoteWriteView; // kind 'remote_write': the held write in full; Send must quote back its digest
  actions: NeedAction[];
}

/** A held remote write as the Send card shows it (docs/REMOTE.md): nothing clipped, plus when it turns overdue
 *  (`expiresAt`; it stays held and sendable after that). */
export interface RemoteWriteView {
  pendingId: string;
  kind: 'goal' | 'reply' | 'answer' | 'approve';
  projectName: string;
  client: string;
  text?: string;
  answers?: { choices?: string[]; other?: string }[];
  replyTo?: { id: string; from: string; type: string; text: string; questions?: { header: string; question: string; multiSelect: boolean; options: string[] }[] };
  taskId?: string;
  taskTitle?: string;
  createdAt: string;
  expiresAt: string;
  digest: string;
}

export interface Prefs {
  notify: { review: boolean; question: boolean; blocked: boolean; usage: boolean; stuck: boolean };
  quiet: { on: boolean; from: string; to: string };
  projects: Record<string, boolean>;
}

export const DEFAULT_PREFS: Prefs = {
  notify: { review: true, question: true, blocked: true, usage: false, stuck: false },
  quiet: { on: true, from: '22:00', to: '07:00' },
  projects: {},
};

export const clonePrefs = (p: Prefs): Prefs => JSON.parse(JSON.stringify(p)) as Prefs;

const firstLine = (text: string, max: number): string => {
  const line = (text.split(/\r?\n/).find((l) => l.trim()) ?? '').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

function evidenceOf(projectId: string, task: Task | undefined): NeedItem['evidence'] {
  const e = task?.evidence?.at(-1);
  if (!task || !e) return undefined;
  const thumbs = e.files
    .filter((f) => f.kind === 'image' && IMAGE.test(f.name))
    .slice(0, 3)
    .map((f) => `/api/projects/${projectId}/tasks/${encodeURIComponent(task.id)}/evidence/${encodeURIComponent(e.id)}/${encodeURIComponent(f.name)}`);
  return { id: e.id, files: e.files.length, thumbs };
}

/** One open needs-you note as a phone item, or null when the phone has nothing to show or do for it. */
export function needFromNote(state: MusterState, n: Note, projectId: string, projectName: string): NeedItem | null {
  if (!isNeedsYou(n) || n.topic === 'stale_build') return null;
  const task = n.taskId ? state.tasks.find((t) => t.id === n.taskId) : undefined;
  let kind: NeedKind;
  let actions: NeedAction[];
  let title: string;
  if (n.type === 'review') {
    // Only a flagged task you haven't approved yet waits on you; an approved one waits on the Captain's merge.
    if (!task || task.status !== 'ready_for_merge' || task.mergeApproval) return null;
    kind = 'review';
    actions = ['approve', 'open'];
    title = task.title;
  } else if (n.type === 'approval') {
    kind = 'approval';
    actions = task && task.status === 'awaiting_approval' ? ['approve', 'open'] : ['open'];
    title = task?.title ?? (n.topic === 'roadmap' ? 'Roadmap needs your approval' : firstLine(n.text, 80));
  } else if (n.type === 'escalation') {
    kind = 'escalation';
    actions = ['answer', 'open'];
    title = n.ask ? 'The Captain asks you' : 'The Captain needs you';
  } else if (n.topic === 'checkout') {
    kind = 'blocked';
    actions = ['commit', 'stash'];
    title = 'A merge is blocked';
  } else if (n.topic === 'weekly_usage' || n.topic === 'five_hour') {
    kind = 'usage';
    actions = ['open'];
    title = n.topic === 'weekly_usage' ? 'Weekly usage' : 'Five-hour usage';
  } else if (n.topic === 'remote') {
    kind = 'question';
    actions = ['open'];
    title = 'Remote access';
  } else if (n.type === 'stuck') {
    kind = 'stuck';
    actions = ['answer', 'open'];
    title = `${n.from} is stuck`;
  } else {
    if (n.to !== HUMAN) return null;
    kind = 'question';
    actions = n.type === 'system' ? ['open'] : ['answer', 'open'];
    title = n.type === 'question' ? `Question from ${n.from}` : `${n.from} wrote to you`;
  }
  return {
    id: `${projectId}:${n.id}`,
    projectId,
    projectName,
    kind,
    noteId: n.id,
    ...(task ? { taskId: task.id } : {}),
    title,
    summary: firstLine(n.ask?.[0]?.question ?? n.text, 140),
    from: n.from,
    createdAt: n.createdAt,
    ...(kind === 'review' || kind === 'approval' ? { evidence: evidenceOf(projectId, task) } : {}),
    ...(kind === 'escalation' && n.ask ? { ask: n.ask } : {}),
    actions,
  };
}

/** Every needs-you item of one project, newest first. */
export function needsFromState(state: MusterState, projectId: string, projectName: string): NeedItem[] {
  const out: NeedItem[] = [];
  for (const n of state.notes) {
    const item = needFromNote(state, n, projectId, projectName);
    if (item) out.push(item);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The notify switch that governs a kind. */
export function prefKey(kind: NeedKind): keyof Prefs['notify'] {
  switch (kind) {
    case 'review':
    case 'approval':
      return 'review';
    case 'question':
    case 'escalation':
    case 'remote_write':
      return 'question';
    case 'blocked':
      return 'blocked';
    case 'usage':
      return 'usage';
    case 'stuck':
      return 'stuck';
  }
}

const minutes = (hhmm: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

/** Quiet hours in the PC's local time; a window like 22:00–07:00 wraps midnight. */
export function inQuietHours(quiet: Prefs['quiet'], now: Date): boolean {
  if (!quiet.on) return false;
  const from = minutes(quiet.from);
  const to = minutes(quiet.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return from < to ? t >= from && t < to : t >= from || t < to;
}

/** Whether a new item should reach (notify) this device. During quiet hours only 'blocked' does. */
export function shouldNotify(item: NeedItem, prefs: Prefs, now: Date): boolean {
  if (prefs.projects[item.projectId] === false) return false;
  if (!prefs.notify[prefKey(item.kind)]) return false;
  // A held remote write is something you just asked Claude for, so it reaches you in quiet hours too.
  if (inQuietHours(prefs.quiet, now) && item.kind !== 'blocked' && item.kind !== 'remote_write') return false;
  return true;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** PUT /api/prefs and PUT /admin/send: a partial prefs object merged over `current`. Throws a message on bad input. */
export function mergePrefs(current: Prefs, patch: unknown): Prefs {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Prefs must be an object');
  const p = patch as Record<string, unknown>;
  const next = clonePrefs(current);
  for (const k of Object.keys(p)) if (!['notify', 'quiet', 'projects'].includes(k)) throw new Error(`Unknown pref "${k}"`);
  if (p.notify !== undefined) {
    if (!p.notify || typeof p.notify !== 'object') throw new Error('notify must be an object');
    for (const [k, v] of Object.entries(p.notify)) {
      if (!(k in next.notify)) throw new Error(`Unknown notify switch "${k}"`);
      if (typeof v !== 'boolean') throw new Error(`notify.${k} must be true or false`);
      next.notify[k as keyof Prefs['notify']] = v;
    }
  }
  if (p.quiet !== undefined) {
    if (!p.quiet || typeof p.quiet !== 'object') throw new Error('quiet must be an object');
    const q = p.quiet as Record<string, unknown>;
    if (q.on !== undefined) {
      if (typeof q.on !== 'boolean') throw new Error('quiet.on must be true or false');
      next.quiet.on = q.on;
    }
    for (const k of ['from', 'to'] as const) {
      if (q[k] === undefined) continue;
      if (typeof q[k] !== 'string' || !TIME.test(q[k] as string)) throw new Error(`quiet.${k} must be a time like "22:00"`);
      next.quiet[k] = q[k] as string;
    }
  }
  if (p.projects !== undefined) {
    if (!p.projects || typeof p.projects !== 'object' || Array.isArray(p.projects)) throw new Error('projects must be an object of { id: boolean }');
    for (const [k, v] of Object.entries(p.projects)) {
      if (typeof v !== 'boolean') throw new Error(`projects.${k} must be true or false`);
      next.projects[k] = v;
    }
  }
  return next;
}
