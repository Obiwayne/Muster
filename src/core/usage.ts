// Usage guard: reads the status-line rate limits and pauses new work at the thresholds.
import type { MusterConfig, MusterState, RateWindow, UsageState } from '../types.js';
import { addFeed, closeNoteIfOpen, dismissNote, findAgent, HUMAN, nowIso, postNote, requireNote, SYSTEM } from './board.js';
import { badRequest, conflict, forbidden } from './errors.js';

interface RawWindow {
  used_percentage?: number | string;
  resets_at?: number | string;
}

export interface RawUsage {
  agentId?: string;
  rate_limits?: { five_hour?: RawWindow; seven_day?: RawWindow };
  cost?: { total_cost_usd?: number };
}

/** resets_at arrives as unix seconds, unix milliseconds, a numeric string or an ISO string. */
export function parseResetsAt(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : /^\d+(\.\d+)?$/.test(String(v)) ? Number(v) : NaN;
  const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function parseWindow(raw: RawWindow | undefined): RateWindow | undefined {
  if (!raw || raw.used_percentage === undefined || raw.used_percentage === null) return undefined;
  const pct = Number(raw.used_percentage);
  if (!Number.isFinite(pct)) return undefined;
  return { usedPercentage: Math.max(0, Math.min(100, pct)), resetsAt: parseResetsAt(raw.resets_at) };
}

const hhmm = (iso?: string) => (iso ? new Date(iso).toTimeString().slice(0, 5) : '');

export function pauseReason(state: MusterState): string {
  const w = state.usage.fiveHour;
  const pct = Math.round(w?.usedPercentage ?? 0);
  return `Paused: 5-hour window at ${pct}%${w?.resetsAt ? ` (resets ${hhmm(w.resetsAt)})` : ''}`;
}

export function assertNotPaused(state: MusterState): void {
  if (state.usage.paused) throw conflict(pauseReason(state));
}

/** Records a status-line report and re-evaluates the guard. Returns texts to notify the human about. */
export function applyUsage(state: MusterState, config: MusterConfig, raw: RawUsage, now = Date.now()): string[] {
  const u = state.usage;
  const five = parseWindow(raw.rate_limits?.five_hour);
  const week = parseWindow(raw.rate_limits?.seven_day);
  if (five) u.fiveHour = five;
  // Within a week the percentage only grows: a drop below the base threshold means the week was reset.
  if (week && u.sevenDay && week.usedPercentage < u.sevenDay.usedPercentage && week.usedPercentage < config.warnAtWeeklyPct) resetWeek(u);
  if (week) u.sevenDay = week;
  u.updatedAt = nowIso();
  const cost = Number(raw.cost?.total_cost_usd);
  if (raw.agentId && Number.isFinite(cost)) {
    u.perAgentCostUsd[raw.agentId] = cost;
    const agent = findAgent(state, raw.agentId);
    if (agent) agent.costUsd = cost;
  }
  return refreshGuard(state, config, now);
}

/**
 * Recomputes `paused` and the weekly alert. A window whose reset time has passed counts as 0% until the
 * next report. Posts system notes on transitions. The weekly alert fires once per threshold
 * (`weeklyRemindAt ?? warnAtWeeklyPct`), never while snoozed or with `weeklyAlerts` off; a new week
 * (the reset passed here, or applyUsage saw usage drop back under the base threshold) clears the reminder, the
 * snooze and the flag.
 */
export function refreshGuard(state: MusterState, config: MusterConfig, now = Date.now()): string[] {
  const u = state.usage;
  const notify: string[] = [];
  let newWeek = false;
  for (const w of [u.fiveHour, u.sevenDay]) {
    if (w?.resetsAt && Date.parse(w.resetsAt) <= now) {
      w.usedPercentage = 0;
      w.resetsAt = undefined;
      if (w === u.sevenDay) newWeek = true;
    }
  }

  const paused = (u.fiveHour?.usedPercentage ?? 0) >= config.pauseAtFiveHourPct;
  if (paused !== u.paused) {
    u.paused = paused;
    const text = paused
      ? `${pauseReason(state)}. New spawns, claims and assignments are on hold until the window resets.`
      : 'Resumed: the 5-hour window is below the pause threshold again.';
    postNote(state, { actor: SYSTEM, type: 'system', text, topic: 'five_hour' });
    addFeed(state, { kind: 'event', from: SYSTEM, text });
  }

  const weekPct = u.sevenDay?.usedPercentage ?? 0;
  if (newWeek) resetWeek(u);
  if (u.weeklySnoozedUntil && Date.parse(u.weeklySnoozedUntil) <= now) delete u.weeklySnoozedUntil;
  const threshold = u.weeklyRemindAt ?? config.warnAtWeeklyPct;
  if (weekPct < threshold) u.weeklyWarned = false; // e.g. the threshold was raised in Settings
  const quiet = config.weeklyAlerts === false || !!u.weeklySnoozedUntil;
  if (weekPct >= threshold && !u.weeklyWarned && !quiet) {
    u.weeklyWarned = true;
    const text = `Weekly usage at ${Math.round(weekPct)}%${u.sevenDay?.resetsAt ? ` (resets ${new Date(u.sevenDay.resetsAt).toLocaleString()})` : ''}. Consider slowing down.`;
    // One weekly alert on the board at a time: the new one replaces any still open.
    for (const n of state.notes) if (n.topic === 'weekly_usage' && n.open) closeNoteIfOpen(n);
    postNote(state, { actor: SYSTEM, type: 'system', text, to: HUMAN, topic: 'weekly_usage' }).open = true; // stays on "Needs you" until cleared
    notify.push(text);
  }
  return notify;
}

function resetWeek(u: UsageState): void {
  u.weeklyWarned = false;
  delete u.weeklyRemindAt;
  delete u.weeklySnoozedUntil;
}

export type WeeklyAlertAction = 'remind_at' | 'snooze_week' | 'never';
const WEEKLY_ACTIONS: WeeklyAlertAction[] = ['remind_at', 'snooze_week', 'never'];

/**
 * POST /api/usage/weekly-alert (you only). remind_at: the next alert at `percent` (1–100, above the current
 * weekly %); snooze_week: no alerts until the weekly reset (or 7 days); never: returns `{ weeklyAlerts: false }`
 * for the caller to save in config.json. `noteId` is dismissed in the same call.
 */
export function setWeeklyAlert(
  state: MusterState,
  actor: string,
  input: { action: unknown; percent?: unknown; noteId?: unknown },
  now = Date.now(),
): { configPatch?: Pick<MusterConfig, 'weeklyAlerts'> } {
  if (actor !== HUMAN) throw forbidden('Only you can change the weekly usage alert');
  const action = input.action as WeeklyAlertAction;
  if (!WEEKLY_ACTIONS.includes(action)) throw badRequest(`action must be one of ${WEEKLY_ACTIONS.join(', ')}`);
  if (input.noteId !== undefined && input.noteId !== null && typeof input.noteId !== 'string') throw badRequest('noteId must be a note id like "N12"');
  if (typeof input.noteId === 'string' && input.noteId) requireNote(state, input.noteId); // 404 before anything changes
  const u = state.usage;
  const current = u.sevenDay?.usedPercentage ?? 0;
  let configPatch: Pick<MusterConfig, 'weeklyAlerts'> | undefined;
  if (action === 'remind_at') {
    const pct = typeof input.percent === 'string' && input.percent.trim() ? Number(input.percent) : input.percent;
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 1 || pct > 100) throw badRequest('percent must be a number from 1 to 100');
    if (pct <= current) throw badRequest(`percent must be above the current weekly usage (${Math.round(current)}%)`);
    u.weeklyRemindAt = pct;
    u.weeklyWarned = false;
  } else if (action === 'snooze_week') {
    u.weeklySnoozedUntil = u.sevenDay?.resetsAt ?? new Date(now + 7 * 86_400_000).toISOString();
  } else configPatch = { weeklyAlerts: false };
  if (typeof input.noteId === 'string' && input.noteId) dismissNote(state, input.noteId, actor);
  const what = action === 'remind_at' ? `remind again at ${u.weeklyRemindAt}%` : action === 'snooze_week' ? 'no more weekly alerts this week' : 'weekly alerts off';
  addFeed(state, { kind: 'event', from: actor, text: `weekly usage alert: ${what}` });
  return configPatch ? { configPatch } : {};
}
