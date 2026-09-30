// Usage guard: reads the status-line rate limits and pauses new work at the thresholds.
import type { MusterConfig, MusterState, RateWindow } from '../types.js';
import { addFeed, findAgent, HUMAN, nowIso, postNote, SYSTEM } from './board.js';
import { conflict } from './errors.js';

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
 * Recomputes `paused` and the weekly warning. A window whose reset time has passed
 * counts as 0% until the next report. Posts system notes on transitions.
 */
export function refreshGuard(state: MusterState, config: MusterConfig, now = Date.now()): string[] {
  const u = state.usage;
  const notify: string[] = [];
  for (const w of [u.fiveHour, u.sevenDay]) {
    if (w?.resetsAt && Date.parse(w.resetsAt) <= now) {
      w.usedPercentage = 0;
      w.resetsAt = undefined;
    }
  }

  const paused = (u.fiveHour?.usedPercentage ?? 0) >= config.pauseAtFiveHourPct;
  if (paused !== u.paused) {
    u.paused = paused;
    const text = paused
      ? `${pauseReason(state)}. New spawns, claims and assignments are on hold until the window resets.`
      : 'Resumed: the 5-hour window is below the pause threshold again.';
    postNote(state, { actor: SYSTEM, type: 'system', text });
    addFeed(state, { kind: 'event', from: SYSTEM, text });
  }

  const weekPct = u.sevenDay?.usedPercentage ?? 0;
  if (weekPct >= config.warnAtWeeklyPct && !u.weeklyWarned) {
    u.weeklyWarned = true;
    const text = `Weekly usage at ${Math.round(weekPct)}%${u.sevenDay?.resetsAt ? ` (resets ${new Date(u.sevenDay.resetsAt).toLocaleString()})` : ''}. Consider slowing down.`;
    postNote(state, { actor: SYSTEM, type: 'system', text, to: HUMAN }).open = true; // stays on "Needs you" until cleared
    notify.push(text);
  } else if (weekPct < config.warnAtWeeklyPct) {
    u.weeklyWarned = false;
  }
  return notify;
}
