import { describe, expect, it } from 'vitest';
import { customError, defaultRemind, durationShort, isUsageNote, isWeeklyNote, meter, remindAllowed, resetDate, weeklyStatus, weeklyThreshold } from './usagealert';

describe('weekly usage alert helpers', () => {
  it('knows weekly and usage notes', () => {
    expect(isWeeklyNote({ type: 'system', topic: 'weekly_usage' })).toBe(true);
    expect(isWeeklyNote({ type: 'escalation', topic: 'weekly_usage' })).toBe(false);
    expect(isUsageNote({ type: 'system', topic: 'five_hour' })).toBe(true);
    expect(isUsageNote({ type: 'system' })).toBe(false);
  });

  it('uses remind-at over the setting', () => {
    expect(weeklyThreshold({}, { warnAtWeeklyPct: 75 })).toBe(75);
    expect(weeklyThreshold({ weeklyRemindAt: 90 }, { warnAtWeeklyPct: 75 })).toBe(90);
  });

  it('places the fill and the alert marker', () => {
    expect(meter(84.4, 75)).toEqual({ fill: 84, marker: 75, over: true });
    expect(meter(120, -5)).toEqual({ fill: 100, marker: 0, over: true });
    expect(meter(40, 75).over).toBe(false);
  });

  it('picks a default reminder above the current usage', () => {
    expect(defaultRemind(84)).toBe(90);
    expect(defaultRemind(80)).toBe(85);
    expect(defaultRemind(92)).toBe(95);
    expect(defaultRemind(96)).toBeNull();
    expect(remindAllowed(85, 84)).toBe(true);
    expect(remindAllowed(84, 84)).toBe(false);
  });

  it('checks a custom percentage', () => {
    expect(customError('', 84)).toBe('Enter a percentage');
    expect(customError('88%', 84)).toBeNull();
    expect(customError('80', 84)).toBe('Pick more than the current 84%');
    expect(customError('101', 84)).toMatch(/1 to 100/);
    expect(customError('8.5', 1)).toMatch(/whole/);
  });

  it('formats the reset', () => {
    const d = new Date(2026, 9, 4, 19, 0); // Sun 4 Oct 2026, local
    expect(resetDate(d.toISOString())).toBe('Sun 4 Oct, 19:00');
    expect(resetDate(d.toISOString(), false)).toBe('Sun 4 Oct');
    expect(resetDate('nope')).toBe('');
    expect(durationShort((2 * 24 + 22) * 3_600_000)).toBe('2d 22h');
    expect(durationShort(312 * 60_000)).toBe('5h 12m');
    expect(durationShort(12 * 60_000)).toBe('12m');
    expect(durationShort(-1)).toBe('now');
  });

  it('describes what is in force this week', () => {
    const now = Date.parse('2026-10-02T12:00:00Z');
    expect(weeklyStatus({}, { warnAtWeeklyPct: 75, weeklyAlerts: false }, now)).toMatch(/^Off/);
    expect(weeklyStatus({ weeklySnoozedUntil: '2026-10-05T17:00:00Z' }, { warnAtWeeklyPct: 75, weeklyAlerts: true }, now)).toMatch(/^Snoozed until/);
    expect(weeklyStatus({ weeklySnoozedUntil: '2026-09-01T00:00:00Z', weeklyRemindAt: 90 }, { warnAtWeeklyPct: 75, weeklyAlerts: true }, now)).toBe('This week: next note at 90%, then back to 75%');
    expect(weeklyStatus({}, { warnAtWeeklyPct: 75, weeklyAlerts: true }, now)).toBe('One note when the weekly window reaches 75%');
  });
});
