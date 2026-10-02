// Pure helpers for the Roadmap pages: date/week maths for the timeline, bar positions,
// and the derived lists (recently landed, merged per day, stage activity). No DOM here.
import type { FeedItem, Roadmap, RoadmapGoal, RoadmapHealth, RoadmapStage, Task } from '../../src/types';

export const DAY = 86_400_000;
const WEEK = 7 * DAY;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "YYYY-MM-DD" (or the date part of an ISO string) → UTC midnight of that calendar day. */
export function parseDay(s?: string): number | undefined {
  const m = s ? /^(\d{4})-(\d{2})-(\d{2})/.exec(s) : null;
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : undefined;
}

/** The local calendar day of a moment, as UTC midnight (so it compares with parseDay values). */
export function localDay(t: number | string | Date = Date.now()): number {
  const d = new Date(typeof t === 'string' ? Date.parse(t) : t);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Monday of the week that holds `day`. */
export function mondayOf(day: number): number {
  const wd = new Date(day).getUTCDay(); // 0 = Sunday
  return day - ((wd + 6) % 7) * DAY;
}

/** "Oct 2" */
export function shortDay(day: number): string {
  const d = new Date(day);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "Oct 2" from "YYYY-MM-DD" (taken as is) or a full ISO time (taken in local time). */
export function shortDate(s?: string): string {
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return shortDay(parseDay(s)!);
  const t = Date.parse(s);
  return Number.isNaN(t) ? '' : shortDay(localDay(t));
}

/** Whole days from `from` to `to` (both day values). */
export function daysBetween(from: number, to: number): number {
  return Math.round((to - from) / DAY);
}

// ---------------------------------------------------------------- timeline scale

export interface Scale {
  start: number; // first column (UTC midnight); a Monday
  cols: number; // number of columns
  unit: number; // ms per column: DAY for short roadmaps, else a week
}

const defined = <T>(x: T | undefined): x is T => x !== undefined;

/** Roadmaps spanning this many days or fewer get one column per day. */
export const DAY_COLUMNS_UP_TO = 28;

/**
 * Columns from the Monday of the earliest stage start to the launch date / last due date
 * (whichever is later, and at least today). Up to four weeks: day columns (at least 7);
 * longer: week columns (at least `minWeeks`).
 */
export function timelineScale(r: Pick<Roadmap, 'stages' | 'goals' | 'launchDate'>, today: number, minWeeks = 6): Scale {
  const starts = [...r.stages.map((s) => parseDay(s.start)), ...r.goals.map((g) => parseDay(g.start))].filter(defined);
  const ends = [...r.stages.map((s) => parseDay(s.due)), ...r.goals.map((g) => parseDay(g.due)), parseDay(r.launchDate)].filter(defined);
  const stageStarts = r.stages.map((s) => parseDay(s.start)).filter(defined);
  const first = stageStarts.length ? Math.min(...stageStarts) : starts.length ? Math.min(...starts) : ends.length ? Math.min(today, ...ends) : today;
  const start = mondayOf(first);
  const last = Math.max(today, first, ...ends);
  const days = Math.round((last + DAY - start) / DAY);
  if (days <= DAY_COLUMNS_UP_TO) return { start, cols: Math.max(7, days), unit: DAY };
  return { start, cols: Math.max(minWeeks, Math.ceil(days / 7)), unit: WEEK };
}

/** Start of each column. */
export function columnStarts(sc: Scale): number[] {
  return Array.from({ length: sc.cols }, (_, i) => sc.start + i * sc.unit);
}

/** Position of a moment on the track, 0..1 (clamped). */
export function frac(sc: Scale, t: number): number {
  const f = (t - sc.start) / (sc.cols * sc.unit);
  return Math.min(1, Math.max(0, f));
}

/** Index of the column holding `day`, or -1 when it is outside the timeline. */
export function columnIndex(sc: Scale, day: number): number {
  const i = Math.floor((day - sc.start) / sc.unit);
  return i >= 0 && i < sc.cols ? i : -1;
}

/** The today line sits in the middle of today's column. */
export function todayFrac(sc: Scale, today: number): number {
  return frac(sc, today + DAY / 2);
}

export interface Span { left: number; width: number } // fractions of the track

/**
 * Bar for a [start, due] window, inclusive of the due day. Missing ends fall back to `fallback`
 * (e.g. a goal without dates uses its stage's), then to one week from the known end.
 * Null when there are no dates at all.
 */
export function barSpan(sc: Scale, start?: string, due?: string, fallback?: { start?: string; due?: string }): Span | null {
  let s = parseDay(start) ?? parseDay(fallback?.start);
  let e = parseDay(due) ?? parseDay(fallback?.due);
  if (s === undefined && e === undefined) return null;
  if (s === undefined) s = e! - 6 * DAY;
  if (e === undefined) e = s + 6 * DAY;
  if (e < s) [s, e] = [e, s];
  const left = frac(sc, s);
  const right = frac(sc, e + DAY);
  return { left, width: Math.max(0, right - left) };
}

/** CSS for a span: left/width in percent. */
export function spanStyle(sp: Span): { left: string; width: string } {
  return { left: `${(sp.left * 100).toFixed(3)}%`, width: `${(sp.width * 100).toFixed(3)}%` };
}

/** Show every n-th column label so they don't collide on long roadmaps. */
export function labelStep(cols: number, maxLabels = 14): number {
  return Math.max(1, Math.ceil(cols / maxLabels));
}

// ---------------------------------------------------------------- roadmap structure

/** First stage that isn't done (what the nav shows when progress isn't fetched yet). */
export function currentStageId(r?: Roadmap | null): string | undefined {
  return r?.stages.find((s) => s.status !== 'done')?.id;
}

export function stageById(r: Roadmap, id?: string): RoadmapStage | undefined {
  return id ? r.stages.find((s) => s.id === id) : undefined;
}

/** A stage's goals in plan order (goalIds), plus any goal that points at the stage but isn't listed. */
export function stageGoals(r: Roadmap, stageId: string): RoadmapGoal[] {
  const st = stageById(r, stageId);
  const byId = new Map(r.goals.map((g) => [g.id, g]));
  const out = (st?.goalIds ?? []).map((id) => byId.get(id)).filter(defined);
  for (const g of r.goals) if (g.stageId === stageId && !out.includes(g)) out.push(g);
  return out;
}

/** The stage after `stageId` that isn't done yet. */
export function nextStage(r: Roadmap, stageId?: string): RoadmapStage | undefined {
  const i = r.stages.findIndex((s) => s.id === stageId);
  return i < 0 ? undefined : r.stages.slice(i + 1).find((s) => s.status !== 'done');
}

/** Flex weights for the summary bar: a stage's task count, at least 1 so empty stages still show. */
export function stageWeights(r: Roadmap, totals: Record<string, { total: number } | undefined>): number[] {
  return r.stages.map((s) => Math.max(1, totals[s.id]?.total ?? 0));
}

/** Tasks that deliver a stage's goals (not cancelled). */
export function stageTasks(r: Roadmap, tasks: Task[], stageId: string): Task[] {
  const goals = new Set(stageGoals(r, stageId).map((g) => g.id));
  return tasks.filter((t) => t.goalId && goals.has(t.goalId) && t.status !== 'cancelled');
}

export function stageOfTask(r: Roadmap, t: Task): string | undefined {
  return t.goalId ? r.goals.find((g) => g.id === t.goalId)?.stageId : undefined;
}

export const HEALTH: Record<RoadmapHealth, { label: string; color: string }> = {
  on_track: { label: 'On track', color: 'var(--color-success)' },
  at_risk: { label: 'At risk', color: 'var(--color-warm)' },
  late: { label: 'Late', color: 'var(--color-stuck)' },
  not_started: { label: 'Not started', color: 'var(--color-muted)' },
  done: { label: 'Done', color: 'var(--color-success)' },
};

export function launchText(days?: number): string {
  if (days === undefined) return '';
  if (days === 0) return 'launch day';
  if (days < 0) return `${-days} ${days === -1 ? 'day' : 'days'} past launch`;
  return `${days} ${days === 1 ? 'day' : 'days'} to launch`;
}

// ---------------------------------------------------------------- tasks and feed

/** When a task was merged (its 'merged' history event, else updatedAt); undefined if not merged. */
export function mergedAt(t: Task): string | undefined {
  if (t.status !== 'merged') return undefined;
  for (let i = t.history.length - 1; i >= 0; i--) if (t.history[i].kind === 'merged') return t.history[i].at;
  return t.updatedAt;
}

/** Merged tasks per local day for the `days` days ending today (oldest first). */
export function mergedPerDay(tasks: Task[], today: number, days = 12): { day: number; count: number }[] {
  const out = Array.from({ length: days }, (_, i) => ({ day: today - (days - 1 - i) * DAY, count: 0 }));
  const first = out[0].day;
  for (const t of tasks) {
    const at = mergedAt(t);
    if (!at) continue;
    const d = localDay(at);
    const i = Math.round((d - first) / DAY);
    if (i >= 0 && i < days) out[i].count++;
  }
  return out;
}

export interface Landed { task: Task; at: string; ready: boolean }

/** Ready-to-merge and merged tasks from the last `days` days, newest first. */
export function recentlyLanded(tasks: Task[], now: number, days = 7, limit = 5): Landed[] {
  const since = now - days * DAY;
  const out: Landed[] = [];
  for (const t of tasks) {
    if (t.status === 'ready_for_merge') out.push({ task: t, at: t.updatedAt, ready: true });
    else if (t.status === 'merged') out.push({ task: t, at: mergedAt(t)!, ready: false });
  }
  return out
    .filter((x) => Date.parse(x.at) >= since)
    .sort((a, b) => (a.ready !== b.ready ? (a.ready ? -1 : 1) : Date.parse(b.at) - Date.parse(a.at)))
    .slice(0, limit);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Feed items about a stage: its tasks, or text naming the stage or one of its goals. Newest first. */
export function stageFeed(feed: FeedItem[], r: Roadmap, tasks: Task[], stageId: string, limit = 30): FeedItem[] {
  const ids = new Set(stageTasks(r, tasks, stageId).map((t) => t.id));
  const names = [stageId, ...stageGoals(r, stageId).map((g) => g.id)].map(esc);
  const re = new RegExp(`\\b(${names.join('|')})\\b`);
  return feed
    .filter((f) => (f.taskId && ids.has(f.taskId)) || re.test(f.text))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
}

/** Merged tasks per day, averaged over the days shown, one decimal. */
export function average(counts: { count: number }[]): string {
  if (!counts.length) return '0';
  const avg = counts.reduce((s, c) => s + c.count, 0) / counts.length;
  return avg.toFixed(1).replace(/\.0$/, '');
}

/** Station label for a task in progress: "Building", "Testing"… */
export function stationWord(station: string): string {
  const map: Record<string, string> = { build: 'Building', test: 'Testing', design: 'Design check', plan: 'Planning', review: 'Captain review', discover: 'Discovery', concept: 'Concept' };
  return map[station] ?? (station ? station[0].toUpperCase() + station.slice(1) : 'In progress');
}
