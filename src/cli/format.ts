// Pure formatting helpers for the muster CLI: colours, tables, relative time, bars.
// No I/O here so everything is easy to test.
import type { Agent, FeedItem, MusterConfig, MusterState, Note, Role, Task, UsageState } from '../types.js';

// ---------------------------------------------------------------- colours

export interface Colors {
  enabled: boolean;
  amber(s: string): string;
  teal(s: string): string;
  lavender(s: string): string;
  red(s: string): string;
  green(s: string): string;
  dim(s: string): string;
  bold(s: string): string;
}

export function colors(enabled: boolean): Colors {
  const wrap = (open: string, close = '\x1b[0m') => (s: string) => (enabled ? `${open}${s}${close}` : s);
  return {
    enabled,
    amber: wrap('\x1b[38;5;214m', '\x1b[39m'),
    teal: wrap('\x1b[38;5;43m', '\x1b[39m'),
    lavender: wrap('\x1b[38;5;183m', '\x1b[39m'),
    red: wrap('\x1b[31m', '\x1b[39m'),
    green: wrap('\x1b[32m', '\x1b[39m'),
    dim: wrap('\x1b[2m', '\x1b[22m'),
    bold: wrap('\x1b[1m', '\x1b[22m'),
  };
}

export function roleColor(c: Colors, role: Role): (s: string) => string {
  return role === 'captain' ? c.amber : role === 'design' ? c.lavender : c.teal;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}
export function visibleLength(s: string): number {
  return [...stripAnsi(s)].length;
}

export function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  const chars = [...one];
  if (chars.length <= max) return one;
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

// ---------------------------------------------------------------- tables

/** Left-aligned table, two spaces between columns, ANSI-aware padding. The last column is not padded. */
export function table(headers: string[], rows: string[][], c: Colors = colors(false)): string {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => visibleLength(r[i] ?? ''))));
  const line = (r: string[], head: boolean) =>
    r
      .map((cell, i) => {
        const v = cell ?? '';
        const padded = i === r.length - 1 ? v : v + ' '.repeat(widths[i] - visibleLength(v));
        return head ? c.dim(padded) : padded;
      })
      .join('  ')
      .trimEnd();
  return [line(headers, true), ...rows.map((r) => line(r, false))].join('\n');
}

// ---------------------------------------------------------------- time

function toMs(t: string | number | Date): number {
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t; // unix seconds or ms
  if (/^\d+$/.test(t)) return toMs(Number(t));
  return new Date(t).getTime();
}

function span(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** "just now", "5m ago", "2h 10m ago", "in 3h" */
export function relativeTime(t: string | number | Date | undefined, now: Date = new Date()): string {
  if (t === undefined || t === '') return '-';
  const ms = toMs(t);
  if (Number.isNaN(ms)) return '-';
  const diff = now.getTime() - ms;
  if (Math.abs(diff) < 5000) return 'just now';
  // Past times read better coarse ("2h ago"), future times (resets) precise ("in 2h 10m").
  if (diff > 0) return `${span(diff).split(' ')[0]} ago`;
  return `in ${span(-diff)}`;
}

/** Local clock time "21:40", or "Mon 21:40" when not today. */
export function clockTime(t: string | number | Date, now: Date = new Date()): string {
  const d = new Date(toMs(t));
  if (Number.isNaN(d.getTime())) return '?';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${hm}`;
}

// ---------------------------------------------------------------- bars

export function bar(pct: number, width = 20): string {
  const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const filled = Math.round((p / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ---------------------------------------------------------------- domain views

export function needsYou(n: Note): boolean {
  return n.open && (n.type === 'escalation' || n.type === 'review' || n.to === 'you');
}

function statusCell(c: Colors, a: Agent): string {
  if (a.status === 'stuck') return c.red(a.status);
  if (a.status === 'stopped') return c.dim(a.status);
  if (a.status === 'done') return c.green(a.status);
  return a.status;
}

export function usageSummary(usage: UsageState | undefined, paused: boolean, config: Pick<MusterConfig, 'pauseAtFiveHourPct'>, c: Colors, now = new Date()): string {
  const five = usage?.fiveHour;
  const week = usage?.sevenDay;
  const parts = [
    `5h ${five ? Math.round(five.usedPercentage) + '%' : '–'}`,
    `wk ${week ? Math.round(week.usedPercentage) + '%' : '–'}`,
  ];
  let line = `Usage: ${parts.join(' · ')}`;
  if (paused) {
    const resets = five?.resetsAt ? ` (resets ${clockTime(five.resetsAt, now)})` : '';
    line += '  ' + c.red(`PAUSED: 5-hour window at ${Math.round(five?.usedPercentage ?? config.pauseAtFiveHourPct)}%${resets}`);
  }
  return line;
}

export function formatStatus(
  data: { state: MusterState; config: MusterConfig; paused: boolean },
  c: Colors,
  now: Date = new Date(),
): string {
  const { state, config, paused } = data;
  const out: string[] = [];
  const tasks = new Map(state.tasks.map((t) => [t.id, t]));
  if (state.goal) out.push(`Goal: ${truncate(state.goal.text, 100)} ${c.dim('(' + relativeTime(state.goal.at, now) + ')')}`, '');
  if (!state.agents.length) {
    out.push('No agents yet. Run `muster up` to start the Captain, `muster add` for crew.');
  } else {
    const order: Record<Role, number> = { captain: 0, crew: 1, design: 2 };
    const agents = [...state.agents].sort((a, b) => order[a.role] - order[b.role]);
    const rows = agents.map((a) => {
      const color = roleColor(c, a.role);
      const task = a.taskId ? `${a.taskId} ${truncate(tasks.get(a.taskId)?.title ?? '', 32)}`.trim() : '-';
      return [color(a.id), color(a.role), statusCell(c, a), a.branch || '-', task, relativeTime(a.lastActivityAt, now)];
    });
    out.push(table(['AGENT', 'ROLE', 'STATUS', 'BRANCH', 'TASK', 'LAST ACTIVITY'], rows, c));
  }
  out.push('');
  out.push(usageSummary(state.usage, paused, config, c, now));
  const open = state.notes.filter((n) => n.open);
  const ny = open.filter(needsYou).length;
  const stuck = open.filter((n) => n.type === 'stuck').length;
  const nyText = ny ? c.amber(`${ny} need${ny === 1 ? 's' : ''} you`) : '0 need you';
  const stuckText = stuck ? c.red(`${stuck} stuck`) : '';
  out.push(`Board: ${open.length} open note${open.length === 1 ? '' : 's'} · ${nyText}${stuckText ? ' · ' + stuckText : ''}`);
  return out.join('\n');
}

export function formatNotes(notes: Note[], c: Colors, now: Date = new Date()): string {
  if (!notes.length) return 'No notes.';
  const rows = notes.map((n) => {
    const type = n.type === 'stuck' ? c.red(n.type) : needsYou(n) ? c.amber(n.type) : n.type;
    const tags = [
      n.replies.length ? `${n.replies.length} repl${n.replies.length === 1 ? 'y' : 'ies'}` : '',
      needsYou(n) ? c.amber('needs you') : '',
      n.open ? '' : c.dim('closed'),
    ].filter(Boolean);
    return [
      n.id,
      type,
      n.from + (n.to ? ` → ${n.to}` : ''),
      n.taskId ?? '-',
      relativeTime(n.createdAt, now),
      truncate(n.text, 70) + (tags.length ? '  ' + c.dim('[') + tags.join(c.dim(', ')) + c.dim(']') : ''),
    ];
  });
  return table(['NOTE', 'TYPE', 'FROM', 'TASK', 'WHEN', 'TEXT'], rows, c);
}

export function formatTasks(tasks: Task[], c: Colors, now: Date = new Date()): string {
  if (!tasks.length) return 'No tasks yet.';
  const rows = tasks.map((t) => {
    const station = t.stations.length ? `${t.stations[t.stationIndex] ?? '?'} ${t.stationIndex + 1}/${t.stations.length}` : '-';
    const status = t.status === 'ready_for_merge' ? c.amber(t.status) : t.status === 'merged' || t.status === 'cancelled' ? c.dim(t.status) : t.status;
    return [t.id, status, station, t.assignee ?? '-', t.dependsOn.length ? t.dependsOn.join(',') : '-', relativeTime(t.updatedAt, now), truncate(t.title, 60)];
  });
  return table(['TASK', 'STATUS', 'STATION', 'ASSIGNEE', 'DEPENDS', 'UPDATED', 'TITLE'], rows, c);
}

export function formatUsage(
  usage: UsageState & { paused?: boolean },
  config: Pick<MusterConfig, 'pauseAtFiveHourPct' | 'warnAtWeeklyPct'> | undefined,
  c: Colors,
  now: Date = new Date(),
): string {
  const pauseAt = config?.pauseAtFiveHourPct ?? 80;
  const warnAt = config?.warnAtWeeklyPct ?? 75;
  const out: string[] = [];
  const windowLine = (label: string, w: UsageState['fiveHour'], limit: number, limitWord: string) => {
    if (!w) return `${label}  ${c.dim(bar(0))}  ${c.dim('no data yet')}`;
    const pct = w.usedPercentage;
    const paint = pct >= limit ? c.red : pct >= limit * 0.75 ? c.amber : c.teal;
    const reset = w.resetsAt ? `  resets ${clockTime(w.resetsAt, now)} (${relativeTime(w.resetsAt, now)})` : '';
    return `${label}  ${paint(bar(pct))}  ${String(Math.round(pct)).padStart(3)}%${reset}  ${c.dim(`${limitWord} at ${limit}%`)}`;
  };
  out.push(windowLine('5-hour', usage.fiveHour, pauseAt, 'pause'));
  out.push(windowLine('Weekly', usage.sevenDay, warnAt, 'warn'));
  out.push('');
  out.push(usage.paused ? c.red('Paused: no new work is spawned, assigned or claimed until the 5-hour window resets.') : 'Not paused.');
  const costs = Object.entries(usage.perAgentCostUsd ?? {}).filter(([, v]) => v > 0);
  if (costs.length) {
    const total = costs.reduce((s, [, v]) => s + v, 0);
    out.push('');
    out.push(
      table(
        ['AGENT', 'COST', 'SHARE', ''],
        costs
          .sort((a, b) => b[1] - a[1])
          .map(([id, v]) => [id, `$${v.toFixed(2)}`, `${Math.round((v / total) * 100)}%`, c.dim(bar((v / total) * 100, 10))]),
        c,
      ),
    );
    out.push(c.dim(`Total $${total.toFixed(2)}`));
  }
  if (usage.updatedAt) out.push(c.dim(`Updated ${relativeTime(usage.updatedAt, now)}`));
  return out.join('\n');
}

export function formatFeedItem(f: FeedItem, c: Colors, now: Date = new Date()): string {
  const time = c.dim(clockTime(f.at, now));
  switch (f.kind) {
    case 'message':
      return `${time}  ${c.bold(f.from)} → ${f.to ?? 'everyone'}  ${f.text}`;
    case 'reply':
      return `${time}  ${c.bold(f.from)} ↳ ${f.noteId ?? ''}  ${f.text}`;
    case 'note':
      return `${time}  ${c.dim(`${f.from} pinned ${f.noteType ?? 'note'} ${f.noteId ?? ''}:`)} ${f.noteType === 'stuck' ? c.red(f.text) : f.text}`;
    default:
      return `${time}  ${c.dim(`· ${f.from === 'muster' ? '' : f.from + ' '}${f.text}`)}`;
  }
}

/** Numeric part of an id like "F120" (for "newer than" comparisons). */
export function idNum(id: string): number {
  const m = /(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}
