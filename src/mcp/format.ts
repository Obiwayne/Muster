// Pure formatting helpers for muster-mcp tool results. Agents read these, so keep them short.
import { formatEvidence } from '../core/evidence.js';
import type { Agent, InboxItem, Note, NoteType, Task } from '../types.js';

export function relTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '?';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '?';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1).trimEnd() + '…' : one;
}

function replies(n: number): string {
  return n === 1 ? '1 reply' : `${n} replies`;
}

/** `N14 [stuck] crew-3 · T4 · 4m ago · "Which token format…" (1 reply)` */
export function formatNoteLine(n: Note, now: number = Date.now(), maxText = 140): string {
  const parts = [`${n.id} [${n.type}] ${n.from}${n.to ? ` → ${n.to}` : ''}`];
  if (n.taskId) parts.push(n.taskId);
  parts.push(relTime(n.createdAt, now));
  let line = `${parts.join(' · ')} · "${clip(n.text, maxText)}"`;
  if (n.replies?.length) line += ` (${replies(n.replies.length)})`;
  if (!n.open && ['stuck', 'question', 'waiting', 'review', 'approval', 'escalation'].includes(n.type)) line += ' [closed]';
  return line;
}

/** Board listing: one line per note, plus the latest replies of open notes indented below. */
export function formatBoard(notes: Note[], now: number = Date.now(), opts: { limit?: number; showReplies?: number } = {}): string {
  if (!notes.length) return 'The board is clear: no matching notes.';
  const limit = opts.limit ?? 40;
  const show = opts.showReplies ?? 2;
  const lines: string[] = [];
  for (const n of notes.slice(0, limit)) {
    lines.push(formatNoteLine(n, now));
    if (n.open && show > 0 && n.replies?.length) {
      for (const r of n.replies.slice(-show)) lines.push(`    ↳ ${r.from} · ${relTime(r.at, now)}: ${clip(r.text, 200)}`);
    }
  }
  if (notes.length > limit) lines.push(`… ${notes.length - limit} more (narrow the filter)`);
  return lines.join('\n');
}

export const BOARD_FILTERS = [
  'open', 'all', 'mine', 'to-me', 'needs-you',
  'stuck', 'question', 'waiting', 'progress', 'done', 'review', 'approval', 'escalation', 'message', 'system',
] as const;
export type BoardFilter = (typeof BOARD_FILTERS)[number];

/** Query string for GET /api/notes. */
export function boardQuery(filter: BoardFilter | undefined, me: string): string {
  const q = new URLSearchParams();
  switch (filter ?? 'open') {
    case 'open':
      q.set('open', '1');
      break;
    case 'all':
      break;
    case 'mine':
      q.set('from', me);
      break;
    case 'to-me':
      q.set('to', me);
      break;
    case 'needs-you':
      q.set('needsYou', '1');
      break;
    default:
      q.set('type', filter as NoteType);
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function formatAgentLine(a: Agent): string {
  const parts = [`${a.id} (${a.role})`, a.status, a.branch];
  if (a.taskId) parts.push(`task ${a.taskId}`);
  if (a.costUsd) parts.push(`$${a.costUsd.toFixed(2)}`);
  return parts.join(' · ');
}

export function formatAgents(agents: Agent[]): string {
  if (!agents.length) return 'No agents.';
  return agents.map(formatAgentLine).join('\n');
}

export function stationLabel(t: Task): string {
  const st = t.stations?.[t.stationIndex];
  return st ? `${st} ${t.stationIndex + 1}/${t.stations.length}` : '-';
}

export function formatTaskLine(t: Task): string {
  const parts = [`${t.id} [${t.status}] ${clip(t.title, 80)}`, `station ${stationLabel(t)}`];
  if (t.assignee) parts.push(`@${t.assignee}`);
  if (t.dependsOn?.length) parts.push(`needs ${t.dependsOn.join(',')}`);
  if (t.branch) parts.push(t.branch);
  return parts.join(' · ');
}

export function formatTasks(tasks: Task[]): string {
  if (!tasks.length) return 'No tasks on the board.';
  return tasks.map(formatTaskLine).join('\n');
}

export function formatTaskDetail(t: Task): string {
  const lines = [formatTaskLine(t)];
  if (t.stations?.length) lines.push(`Stations: ${t.stations.join(' → ')}`);
  if (t.description) lines.push('', t.description.trim());
  if (t.evidence?.length) lines.push('', formatEvidence(t));
  return lines.join('\n');
}

export function formatInbox(items: InboxItem[], now: number = Date.now()): string {
  if (!items.length) return 'Inbox empty.';
  return items
    .map((i) => {
      const ref = [i.noteId, i.taskId].filter(Boolean).join(' ');
      return `${i.id} ${i.kind} from ${i.from}${ref ? ` (${ref})` : ''} · ${relTime(i.at, now)}: ${i.text.trim()}`;
    })
    .join('\n');
}

export function truncateTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `… (${text.length - maxChars} chars cut)\n` + text.slice(text.length - maxChars);
}

export function truncateHead(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n… (${text.length - maxChars} more chars; ask the crew or use git locally for the rest)`;
}

export function formatDiff(d: { branch?: string; base?: string; stat?: string; diff?: string }, maxChars = 24000): string {
  const head = `${d.branch ?? '?'} vs ${d.base ?? '?'}`;
  const stat = (d.stat ?? '').trim();
  const diff = (d.diff ?? '').trim();
  if (!stat && !diff) return `${head}: no changes.`;
  return [head, stat, '', truncateHead(diff, maxChars)].join('\n').trim();
}

export function formatTests(r: { command?: string; exitCode?: number | null; output?: string }, maxChars = 12000): string {
  const ok = r.exitCode === 0;
  return `${ok ? 'PASS' : 'FAIL'} (exit ${r.exitCode ?? '?'}) · ${r.command ?? ''}\n${truncateTail((r.output ?? '').trim(), maxChars)}`.trim();
}

/** Is `s` an existing task id like "T3"? */
export function isTaskId(s: string): boolean {
  return /^T\d+$/i.test(s.trim());
}
