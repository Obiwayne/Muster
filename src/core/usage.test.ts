import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type MusterState } from '../types.js';
import { dismissNote, isNeedsYou, listNotes } from './board.js';
import { emptyState } from './store.js';
import { makeAgent } from './testutil.js';
import { applyUsage, assertNotPaused, parseResetsAt, parseWindow, refreshGuard, setWeeklyAlert } from './usage.js';

const config = { ...DEFAULT_CONFIG };
let s: MusterState;
const report = (five: number, week: number, resets_at: number | string = Math.floor(Date.now() / 1000) + 3600) =>
  applyUsage(s, config, { agentId: 'crew-2', rate_limits: { five_hour: { used_percentage: five, resets_at }, seven_day: { used_percentage: week } }, cost: { total_cost_usd: 1.25 } });

beforeEach(() => {
  s = emptyState('/repo');
  s.agents.push(makeAgent('captain', 'captain'), makeAgent('crew-2', 'crew'));
});

describe('parsing', () => {
  it('accepts unix seconds, milliseconds, numeric strings and ISO', () => {
    const iso = '2026-09-30T21:40:00.000Z';
    const secs = Date.parse(iso) / 1000;
    expect(parseResetsAt(secs)).toBe(iso);
    expect(parseResetsAt(secs * 1000)).toBe(iso);
    expect(parseResetsAt(String(secs))).toBe(iso);
    expect(parseResetsAt(iso)).toBe(iso);
    expect(parseResetsAt('not a date')).toBeUndefined();
    expect(parseResetsAt(undefined)).toBeUndefined();
  });

  it('clamps percentages and ignores missing windows', () => {
    expect(parseWindow({ used_percentage: 140 })?.usedPercentage).toBe(100);
    expect(parseWindow({ used_percentage: '42.5' })?.usedPercentage).toBe(42.5);
    expect(parseWindow({})).toBeUndefined();
    expect(parseWindow(undefined)).toBeUndefined();
  });
});

describe('guard', () => {
  it('records cost per agent', () => {
    report(10, 10);
    expect(s.usage.perAgentCostUsd['crew-2']).toBe(1.25);
    expect(s.agents[1].costUsd).toBe(1.25);
  });

  it('pauses at the 5-hour threshold and resumes below it, with system notes', () => {
    report(79.9, 10);
    expect(s.usage.paused).toBe(false);
    expect(() => assertNotPaused(s)).not.toThrow();
    report(83, 10);
    expect(s.usage.paused).toBe(true);
    expect(() => assertNotPaused(s)).toThrow(/^Paused: 5-hour window at 83% \(resets \d\d:\d\d\)$/);
    report(20, 10);
    expect(s.usage.paused).toBe(false);
    expect(listNotes(s, { type: 'system' }).map((n) => n.text.split(':')[0])).toEqual(['Resumed', 'Paused']);
  });

  it('un-pauses once the reset time has passed', () => {
    report(90, 10);
    expect(s.usage.paused).toBe(true);
    applyUsage(s, config, {}, Date.now() + 2 * 3600_000);
    expect(s.usage.paused).toBe(false);
  });

  it('warns once about the weekly window, as a Needs-you note', () => {
    expect(report(10, 74)).toEqual([]);
    const first = report(10, 76);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatch(/Weekly usage at 76%/);
    expect(report(10, 80)).toEqual([]);
    const needsYou = listNotes(s, { needsYou: true });
    expect(needsYou).toHaveLength(1);
    expect(needsYou[0]).toMatchObject({ type: 'system', to: 'you', open: true });
    expect(s.usage.weeklyWarned).toBe(true);
  });
});

describe('weekly alerts', () => {
  const week = (pct: number, resets_at?: number) => applyUsage(s, config, { rate_limits: { seven_day: { used_percentage: pct, resets_at } } });
  const status = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as { status?: number }).status;
    }
    return 200;
  };

  it('tags notes with their topic', () => {
    report(90, 80);
    expect(s.notes.map((n) => n.topic)).toEqual(['five_hour', 'weekly_usage']);
  });

  it('remind me again at N%: the next alert waits for it and replaces the open one', () => {
    week(76);
    const first = s.notes.find((n) => n.topic === 'weekly_usage')!;
    expect(status(() => setWeeklyAlert(s, 'captain', { action: 'remind_at', percent: 90 }))).toBe(403);
    expect(status(() => setWeeklyAlert(s, 'you', { action: 'remind_at', percent: 70 }))).toBe(400); // under current 76
    expect(status(() => setWeeklyAlert(s, 'you', { action: 'remind_at', percent: 101 }))).toBe(400);
    expect(status(() => setWeeklyAlert(s, 'you', { action: 'remind_at', percent: 90, noteId: 'N99' }))).toBe(404);
    expect(s.usage.weeklyRemindAt).toBeUndefined();
    setWeeklyAlert(s, 'you', { action: 'remind_at', percent: 90, noteId: first.id });
    expect(first).toMatchObject({ open: false, dismissed: true });
    expect(s.usage).toMatchObject({ weeklyRemindAt: 90, weeklyWarned: false });
    expect(week(85)).toEqual([]);
    expect(week(91)).toHaveLength(1);
    expect(listNotes(s, { needsYou: true })).toHaveLength(1);
    expect(listNotes(s, { type: 'system' })).toHaveLength(1); // the dismissed one is hidden
    expect(listNotes(s, { type: 'system', dismissed: true })).toHaveLength(2);
  });

  it("don't remind me this week: silent until the weekly reset, then everything clears", () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    week(76, reset);
    setWeeklyAlert(s, 'you', { action: 'snooze_week' });
    expect(s.usage.weeklySnoozedUntil).toBe(new Date(reset * 1000).toISOString());
    setWeeklyAlert(s, 'you', { action: 'remind_at', percent: 95 });
    expect(week(99, reset)).toEqual([]);
    refreshGuard(s, config, (reset + 10) * 1000); // the week resets
    expect(s.usage.weeklySnoozedUntil).toBeUndefined();
    expect(s.usage.weeklyRemindAt).toBeUndefined();
    expect(s.usage.weeklyWarned).toBe(false);
    expect(week(80)).toHaveLength(1); // the base threshold again
  });

  it('a drop under the base threshold is a new week', () => {
    week(80);
    setWeeklyAlert(s, 'you', { action: 'remind_at', percent: 90 });
    week(10);
    expect(s.usage.weeklyRemindAt).toBeUndefined();
    expect(week(76)).toHaveLength(1);
  });

  it('never remind me: alerts are off while weeklyAlerts is false', () => {
    expect(setWeeklyAlert(s, 'you', { action: 'never' })).toEqual({ configPatch: { weeklyAlerts: false } });
    expect(applyUsage(s, { ...config, weeklyAlerts: false }, { rate_limits: { seven_day: { used_percentage: 99 } } })).toEqual([]);
    expect(status(() => setWeeklyAlert(s, 'you', { action: 'later' }))).toBe(400);
  });

  it('dismissed notes are closed, hidden and never Needs you', () => {
    week(80);
    const n = s.notes[0];
    expect(isNeedsYou(n)).toBe(true);
    expect(status(() => dismissNote(s, n.id, 'captain'))).toBe(403);
    dismissNote(s, n.id, 'you');
    n.open = true; // even if something reopened it
    expect(isNeedsYou(n)).toBe(false);
    expect(listNotes(s)).toHaveLength(0);
  });
});
