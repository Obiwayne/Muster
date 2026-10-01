// Formatting and derived-data helpers shared by the pages.
import type { Agent, MusterState, Note, NoteType, Role, Task } from '../../src/types';
import { STATION_ROLE } from '../../src/types';

export const YOU = 'you';

// The name the person running Muster gave (Settings → Your name). "you" is still the actor id.
let userName: string | undefined;
export function setUserName(name: string | undefined): void {
  userName = name?.trim() || undefined;
}
/** Display name for an actor id: the user's own name instead of "you". */
export function displayName(id: string): string {
  return id === YOU ? (userName ?? 'you') : id;
}

export function roleOf(state: MusterState, who: string): Role | 'you' | 'muster' {
  if (who === 'you') return 'you';
  const a = state.agents.find((x) => x.id === who);
  if (a) return a.role;
  if (who === 'captain') return 'captain';
  if (who === 'muster') return 'muster';
  return who.startsWith('design') ? 'design' : 'crew';
}

export function stationRole(station: string): Role {
  return STATION_ROLE[station] ?? 'crew';
}

/** Avatar initial: captain → C, crew-2 → 2, design → D, you → Y. */
export function initial(who: string): string {
  if (who === YOU && userName) return userName[0].toUpperCase();
  const m = /-(\w+)$/.exec(who);
  if (m && m[1].length <= 2) return m[1].toUpperCase();
  return (who[0] ?? '?').toUpperCase();
}

export function ms(iso?: string): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** "now", "4m", "2h", "3d" */
export function ageShort(iso?: string): string {
  const d = Date.now() - ms(iso);
  if (!iso || d < 45_000) return 'now';
  const m = Math.round(d / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** "just now", "2m ago", "1h ago" */
export function ago(iso?: string): string {
  const s = ageShort(iso);
  return s === 'now' ? 'just now' : `${s} ago`;
}

/** "42 min ago", "2 h ago" */
export function agoLong(iso?: string): string {
  const d = Date.now() - ms(iso);
  const m = Math.round(d / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function hhmm(iso?: string): string {
  const d = new Date(ms(iso));
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function dayLabel(iso: string): string {
  const d = new Date(ms(iso));
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'TODAY';
  if (same(d, y)) return 'YESTERDAY';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase();
}

/** Reset time: "1h 48m" within a day, else weekday ("Mon"). */
export function resetsIn(iso?: string): string {
  if (!iso) return '';
  const d = ms(iso) - Date.now();
  if (d <= 0) return 'now';
  const m = Math.round(d / 60_000);
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return new Date(ms(iso)).toLocaleDateString(undefined, { weekday: 'short' });
}

export const NOTE_BADGE: Record<NoteType | 'approval', string> = {
  approval: 'b-warm',
  stuck: 'b-stuck',
  question: 'b-captain',
  waiting: 'b-design',
  progress: 'neutral',
  done: 'b-success',
  review: 'b-crew',
  escalation: 'b-warm',
  message: 'neutral',
  system: 'neutral',
};

export function noteLabel(t: NoteType | 'approval'): string {
  return t === 'escalation' ? 'Needs you' : t === 'approval' ? 'Approval' : t;
}

export function isNeedsYou(n: Note): boolean {
  return n.open && (n.type === 'escalation' || n.type === 'review' || (n.type as string) === 'approval' || n.to === YOU);
}

/** A stuck/question note counts as escalated if the note is addressed to you or an open escalation mentions it. */
export function isEscalated(state: MusterState, n: Note): boolean {
  if (n.to === YOU) return true;
  return state.notes.some((e) => e.type === 'escalation' && e.open && new RegExp(`\\b${n.id}\\b`).test(e.text));
}

export function openStuck(state: MusterState, agentId: string): Note[] {
  return state.notes.filter((n) => n.open && n.type === 'stuck' && n.from === agentId);
}

export function taskById(state: MusterState, id?: string): Task | undefined {
  return id ? state.tasks.find((t) => t.id === id) : undefined;
}

/** The crew agent that owns a task's branch (branches are "<agentId>/<slug>"). */
export function branchOwner(state: MusterState, task: Task): Agent | undefined {
  const byBranch = task.branch ? state.agents.find((a) => a.branch === task.branch) : undefined;
  if (byBranch) return byBranch;
  const holder = state.agents.find((a) => a.taskId === task.id && a.role !== 'captain');
  if (holder) return holder;
  const prefix = task.branch?.split('/')[0];
  return state.agents.find((a) => a.id === prefix);
}

export function branchOwnerId(state: MusterState, task: Task): string | undefined {
  return branchOwner(state, task)?.id ?? task.branch?.split('/')[0];
}

export function taskIsStuck(state: MusterState, task: Task): Note | undefined {
  return state.notes.find((n) => n.open && n.type === 'stuck' && (n.taskId === task.id
    || (task.assignee && n.from === task.assignee && state.agents.find((a) => a.id === task.assignee)?.taskId === task.id)));
}

/** Short status word for the sidebar (fixed-width column). */
export function agentStatusWord(state: MusterState, a: Agent): string {
  if (a.role === 'captain' && a.status === 'working' && state.tasks.some((t) => t.status === 'review')) return 'reviewing';
  return a.status;
}

/** Longer status for a tile header, e.g. "T3 · build → test", "stuck · 4 min", "waiting on crew-3". */
export function agentStatusLong(state: MusterState, a: Agent): { text: string; stuck: boolean } {
  if (a.status === 'stuck') {
    const n = openStuck(state, a.id)[0];
    const since = n?.createdAt ?? a.lastActivityAt;
    const m = Math.max(0, Math.round((Date.now() - ms(since)) / 60_000));
    return { text: `stuck · ${m} min`, stuck: true };
  }
  if (a.status === 'waiting') {
    const w = state.notes.find((n) => n.open && n.type === 'waiting' && n.from === a.id);
    return { text: w?.to ? `waiting on ${w.to}` : 'waiting', stuck: false };
  }
  if (a.status === 'stopped' || a.status === 'starting' || a.status === 'done') return { text: a.status, stuck: false };
  if (a.role === 'captain') {
    const rev = state.tasks.find((t) => t.status === 'review');
    if (rev && a.status === 'working') return { text: `reviewing ${branchOwnerId(state, rev) ?? rev.id}`, stuck: false };
    return { text: a.status, stuck: false };
  }
  const t = taskById(state, a.taskId);
  if (t) {
    const cur = t.stations[t.stationIndex];
    const next = t.stations[t.stationIndex + 1];
    return { text: `${t.id} · ${cur}${next ? ` → ${next}` : ''}`, stuck: false };
  }
  return { text: a.status, stuck: false };
}

export function sortedAgents(state: MusterState): Agent[] {
  return [...state.agents].sort((a, b) => (a.role === 'captain' ? -1 : b.role === 'captain' ? 1 : 0));
}

export function idNum(id: string): number {
  return Number(id.replace(/\D/g, '')) || 0;
}

export interface FileStat { path: string; add: number; del: number }

/** Per-file +/- from a unified diff. */
export function parseDiffFiles(diff: string): FileStat[] {
  const files: FileStat[] = [];
  let cur: FileStat | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(line);
      cur = { path: m ? m[1] : line.slice(11), add: 0, del: 0 };
      files.push(cur);
    } else if (cur && line.startsWith('+++ ') ) {
      const p = line.slice(4).replace(/^b\//, '');
      if (p !== '/dev/null') cur.path = p;
    } else if (cur && line.startsWith('+') && !line.startsWith('+++')) cur.add++;
    else if (cur && line.startsWith('-') && !line.startsWith('---')) cur.del++;
  }
  return files;
}

/** Totals from `git diff --stat` ("3 files changed, 96 insertions(+), 4 deletions(-)"), or from a diff. */
export function statTotals(stat: string, diff = ''): { files: number; add: number; del: number } | null {
  const m = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(stat);
  if (m) return { files: +m[1], add: +(m[2] ?? 0), del: +(m[3] ?? 0) };
  if (diff) {
    const f = parseDiffFiles(diff);
    return { files: f.length, add: f.reduce((s, x) => s + x.add, 0), del: f.reduce((s, x) => s + x.del, 0) };
  }
  if (!stat.trim()) return { files: 0, add: 0, del: 0 };
  return null;
}

/** "12 passed" / "2 failed" from a test run's output, falling back to the exit code. */
export function summarizeTests(r: { exitCode: number; output: string }): { text: string; ok: boolean } {
  const failed = /(\d+)\s+(?:tests?\s+)?fail(?:ed|ing|ures?)?/i.exec(r.output);
  const passed = /(\d+)\s+(?:tests?\s+)?pass(?:ed|ing)?/i.exec(r.output);
  if (r.exitCode !== 0) return { text: failed ? `${failed[1]} failed` : `exit ${r.exitCode}`, ok: false };
  return { text: passed ? `${passed[1]} passed` : 'passed', ok: true };
}
