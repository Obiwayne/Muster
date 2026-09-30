import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type MusterState } from '../types.js';
import { listNotes } from './board.js';
import { emptyState } from './store.js';
import { makeAgent } from './testutil.js';
import { applyUsage, assertNotPaused, parseResetsAt, parseWindow } from './usage.js';

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
