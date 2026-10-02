// Pure helpers for the weekly usage alert (board view + Settings → Usage). No DOM here.
import type { MusterConfig, Note, UsageState } from '../../src/types';

export const REMIND_OPTIONS = [85, 90, 95];

export function isWeeklyNote(n: Pick<Note, 'type' | 'topic'>): boolean {
  return n.type === 'system' && n.topic === 'weekly_usage';
}

export function isUsageNote(n: Pick<Note, 'type' | 'topic'>): boolean {
  return n.type === 'system' && (n.topic === 'weekly_usage' || n.topic === 'five_hour');
}

/** The threshold the weekly alert fires at now: "remind me again at" for this week, else the setting. */
export function weeklyThreshold(u: Pick<UsageState, 'weeklyRemindAt'>, c: Pick<MusterConfig, 'warnAtWeeklyPct'>): number {
  return u.weeklyRemindAt ?? c.warnAtWeeklyPct;
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

/** Meter numbers: fill width and marker position, both in % of the track. */
export function meter(nowPct: number, alertPct: number): { fill: number; marker: number; over: boolean } {
  return { fill: clamp(Math.round(nowPct)), marker: clamp(alertPct), over: nowPct >= alertPct };
}

/** Default "remind me again at": the first option at least 5 points above now, else the first above now. */
export function defaultRemind(nowPct: number, options = REMIND_OPTIONS): number | null {
  return options.find((p) => p >= nowPct + 5) ?? options.find((p) => p > nowPct) ?? null;
}

export function remindAllowed(p: number, nowPct: number): boolean {
  return Number.isInteger(p) && p >= 1 && p <= 100 && p > nowPct;
}

/** Error text for a custom percentage, or null when it is fine. */
export function customError(raw: string, nowPct: number): string | null {
  const t = raw.trim().replace(/%$/, '');
  if (!t) return 'Enter a percentage';
  const v = Number(t);
  if (!Number.isInteger(v) || v < 1 || v > 100) return 'Enter a whole percentage from 1 to 100';
  if (v <= nowPct) return `Pick more than the current ${Math.round(nowPct)}%`;
  return null;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "Sun 5 Oct, 19:00" (local time). */
export function resetDate(iso: string, withTime = true): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
  return withTime ? `${day}, ${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}

/** "2d 22h", "5h 12m", "12m", "now". */
export function durationShort(ms: number): string {
  if (ms <= 0) return 'now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Subtitle for Settings → Usage → weekly alerts: what is in force this week. */
export function weeklyStatus(u: Pick<UsageState, 'weeklyRemindAt' | 'weeklySnoozedUntil'>, c: Pick<MusterConfig, 'warnAtWeeklyPct' | 'weeklyAlerts'>, now = Date.now()): string {
  if (c.weeklyAlerts === false) return 'Off. The 5-hour pause still applies';
  if (u.weeklySnoozedUntil && Date.parse(u.weeklySnoozedUntil) > now) return `Snoozed until the reset on ${resetDate(u.weeklySnoozedUntil, false)}`;
  if (u.weeklyRemindAt) return `This week: next note at ${u.weeklyRemindAt}%, then back to ${c.warnAtWeeklyPct}%`;
  return `One note when the weekly window reaches ${c.warnAtWeeklyPct}%`;
}
