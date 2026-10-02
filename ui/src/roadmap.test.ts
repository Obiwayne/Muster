import { describe, expect, it } from 'vitest';
import type { FeedItem, Roadmap, Task } from '../../src/types';
import {
  DAY, average, barSpan, currentStageId, frac, labelStep, launchText, localDay, mergedAt, mergedPerDay, mondayOf, nextStage,
  parseDay, recentlyLanded, shortDate, shortDay, stageFeed, stageGoals, stageWeights, timelineScale, todayFrac, columnIndex, columnStarts,
} from './roadmap';

const d = (s: string) => parseDay(s)!;

function roadmap(over: Partial<Roadmap> = {}): Roadmap {
  return {
    title: 'wall-education v1.0', summary: '', launchDate: '2026-11-14', status: 'approved', revision: 1,
    createdBy: 'captain', updatedAt: '2026-10-01T00:00:00Z',
    stages: [
      { id: 'M1', title: 'Foundations', description: '', start: '2026-09-08', due: '2026-09-19', status: 'done', exitCriteria: [], goalIds: ['G1'] },
      { id: 'M2', title: 'Sharing', description: '', start: '2026-09-29', due: '2026-10-17', status: 'active', exitCriteria: [], goalIds: ['G3', 'G2'] },
      { id: 'M3', title: 'Launch', description: '', start: '2026-10-19', due: '2026-11-07', status: 'planned', exitCriteria: [], goalIds: ['G4'] },
    ],
    goals: [
      { id: 'G1', stageId: 'M1', title: 'Repo', description: '', status: 'done' },
      { id: 'G2', stageId: 'M2', title: 'Invites', description: '', status: 'active' },
      { id: 'G3', stageId: 'M2', title: 'Roles', description: '', status: 'planned' },
      { id: 'G4', stageId: 'M3', title: 'Hardening', description: '', status: 'planned' },
      { id: 'G5', stageId: 'M2', title: 'Stray', description: '', status: 'planned' },
    ],
    ...over,
  };
}

function task(id: string, status: Task['status'], over: Partial<Task> = {}): Task {
  return {
    id, title: id, description: '', dependsOn: [], stations: ['build', 'review'], stationIndex: 0, status,
    createdBy: 'captain', createdAt: '2026-09-20T10:00:00Z', updatedAt: '2026-09-30T10:00:00Z', history: [], ...over,
  };
}

describe('dates', () => {
  it('parses days as UTC midnight and finds the Monday', () => {
    expect(d('2026-10-02')).toBe(Date.UTC(2026, 9, 2));
    expect(parseDay('2026-10-02T15:00:00Z')).toBe(Date.UTC(2026, 9, 2));
    expect(parseDay('soon')).toBeUndefined();
    expect(mondayOf(d('2026-10-02'))).toBe(d('2026-09-28')); // Friday → Monday
    expect(mondayOf(d('2026-09-28'))).toBe(d('2026-09-28'));
    expect(mondayOf(d('2026-10-04'))).toBe(d('2026-09-28')); // Sunday belongs to the week before
  });
  it('formats short dates', () => {
    expect(shortDay(d('2026-11-14'))).toBe('Nov 14');
    expect(shortDate('2026-09-08')).toBe('Sep 8');
    expect(shortDate(undefined)).toBe('');
    expect(localDay(new Date(2026, 9, 2, 23, 30))).toBe(d('2026-10-02'));
  });
  it('words the launch countdown', () => {
    expect(launchText(43)).toBe('43 days to launch');
    expect(launchText(1)).toBe('1 day to launch');
    expect(launchText(0)).toBe('launch day');
    expect(launchText(-2)).toBe('2 days past launch');
    expect(launchText(undefined)).toBe('');
  });
});

describe('timeline scale', () => {
  const today = d('2026-10-02');
  it('runs from the Monday of the first stage start to the launch date', () => {
    const sc = timelineScale(roadmap(), today);
    expect(sc.start).toBe(d('2026-09-07'));
    // Sep 7 → Nov 14 inclusive is 10 weeks
    expect(sc.cols).toBe(10);
    expect(sc.unit).toBe(7 * DAY);
    expect(columnStarts(sc).map(shortDay).slice(0, 3)).toEqual(['Sep 7', 'Sep 14', 'Sep 21']);
  });
  it('uses day columns for a roadmap of four weeks or less', () => {
    const r = roadmap({ launchDate: '2026-10-07', stages: [{ id: 'M1', title: 'x', description: '', start: '2026-10-02', due: '2026-10-03', status: 'active', exitCriteria: [], goalIds: [] }], goals: [] });
    const sc = timelineScale(r, today);
    // Mon Sep 28 → Wed Oct 7 inclusive
    expect(sc).toEqual({ start: d('2026-09-28'), cols: 10, unit: DAY });
    expect(columnStarts(sc).map(shortDay).slice(0, 2)).toEqual(['Sep 28', 'Sep 29']);
    expect(columnIndex(sc, today)).toBe(4);
    const sp = barSpan(sc, '2026-10-02', '2026-10-03')!;
    expect(sp.left).toBeCloseTo(0.4);
    expect(sp.width).toBeCloseTo(0.2);
  });
  it('is at least 7 days, or 6 weeks once it needs week columns', () => {
    const r = roadmap({ launchDate: undefined, stages: [], goals: [] });
    expect(timelineScale(r, today)).toEqual({ start: d('2026-09-28'), cols: 7, unit: DAY });
    const long = roadmap({ launchDate: '2026-10-30', stages: [{ id: 'M1', title: 'x', description: '', start: '2026-10-01', due: '2026-10-03', status: 'active', exitCriteria: [], goalIds: [] }], goals: [] });
    expect(timelineScale(long, today)).toEqual({ start: d('2026-09-28'), cols: 6, unit: 7 * DAY });
  });
  it('places bars inclusive of the due day', () => {
    const sc = timelineScale(roadmap(), today);
    const sp = barSpan(sc, '2026-09-07', '2026-09-13')!;
    expect(sp.left).toBe(0);
    expect(sp.width).toBeCloseTo(1 / 10);
    // no start: one week ending on the due day
    const s2 = barSpan(sc, undefined, '2026-09-20')!;
    expect(s2.left).toBeCloseTo(1 / 10);
    // goal without dates uses the stage's
    const s3 = barSpan(sc, undefined, undefined, { start: '2026-09-14', due: '2026-09-27' })!;
    expect(s3.left).toBeCloseTo(0.1);
    expect(s3.width).toBeCloseTo(0.2);
    expect(barSpan(sc)).toBeNull();
    // clamped to the track
    expect(frac(sc, d('2025-01-01'))).toBe(0);
    expect(frac(sc, d('2030-01-01'))).toBe(1);
  });
  it('finds today', () => {
    const sc = timelineScale(roadmap(), today);
    expect(columnIndex(sc, today)).toBe(3);
    expect(columnIndex(sc, d('2030-01-01'))).toBe(-1);
    expect(todayFrac(sc, today)).toBeCloseTo((25.5) / 70);
  });
  it('thins week labels on long roadmaps', () => {
    expect(labelStep(10)).toBe(1);
    expect(labelStep(20)).toBe(2);
  });
});

describe('structure', () => {
  it('orders goals by the stage plan and keeps strays', () => {
    expect(stageGoals(roadmap(), 'M2').map((g) => g.id)).toEqual(['G3', 'G2', 'G5']);
  });
  it('finds the current and next stage', () => {
    const r = roadmap();
    expect(currentStageId(r)).toBe('M2');
    expect(currentStageId(null)).toBeUndefined();
    expect(nextStage(r, 'M2')?.id).toBe('M3');
    expect(nextStage(r, 'M3')).toBeUndefined();
  });
  it('weights the summary bar by task count', () => {
    expect(stageWeights(roadmap(), { M1: { total: 9 }, M2: { total: 0 } })).toEqual([9, 1, 1]);
  });
});

describe('tasks and feed', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  it('takes the merge time from history', () => {
    expect(mergedAt(task('T1', 'merged', { history: [{ at: '2026-10-01T09:00:00Z', agentId: 'you', kind: 'merged' }] }))).toBe('2026-10-01T09:00:00Z');
    expect(mergedAt(task('T1', 'merged'))).toBe('2026-09-30T10:00:00Z');
    expect(mergedAt(task('T1', 'review'))).toBeUndefined();
  });
  it('counts merges per day, today last', () => {
    const today = localDay(now);
    const at = (daysAgo: number) => new Date(today - daysAgo * DAY + 12 * 3600_000 + new Date(today).getTimezoneOffset() * 60_000).toISOString();
    const tasks = [
      task('T1', 'merged', { updatedAt: at(0) }),
      task('T2', 'merged', { updatedAt: at(0) }),
      task('T3', 'merged', { updatedAt: at(3) }),
      task('T4', 'merged', { updatedAt: at(40) }),
      task('T5', 'review', { updatedAt: at(0) }),
    ];
    const days = mergedPerDay(tasks, today, 12);
    expect(days).toHaveLength(12);
    expect(days[11]).toEqual({ day: today, count: 2 });
    expect(days[8].count).toBe(1);
    expect(days.reduce((s, x) => s + x.count, 0)).toBe(3);
    expect(average(days)).toBe('0.3');
    expect(average([{ count: 2 }, { count: 2 }])).toBe('2');
  });
  it('lists recently landed work, ready first then newest', () => {
    const tasks = [
      task('T1', 'merged', { updatedAt: '2026-10-01T10:00:00Z' }),
      task('T2', 'merged', { updatedAt: '2026-09-10T10:00:00Z' }),
      task('T3', 'ready_for_merge', { updatedAt: '2026-10-02T10:00:00Z' }),
      task('T4', 'merged', { updatedAt: '2026-10-02T08:00:00Z' }),
      task('T5', 'in_progress'),
    ];
    expect(recentlyLanded(tasks, now).map((x) => [x.task.id, x.ready])).toEqual([['T3', true], ['T4', false], ['T1', false]]);
  });
  it('filters the feed to a stage, newest first', () => {
    const r = roadmap();
    const tasks = [task('T1', 'in_progress', { goalId: 'G2' }), task('T2', 'in_progress', { goalId: 'G1' }), task('T3', 'cancelled', { goalId: 'G2' })];
    const f = (id: string, at: string, text: string, taskId?: string): FeedItem => ({ id, at, kind: 'event', from: 'captain', text, taskId });
    const feed = [
      f('F1', '2026-10-01T10:00:00Z', 'crew-2 claimed T1', 'T1'),
      f('F2', '2026-10-01T11:00:00Z', 'crew-3 claimed T2', 'T2'),
      f('F3', '2026-10-01T12:00:00Z', 'G3 done. Next: G2'),
      f('F4', '2026-10-01T13:00:00Z', 'M2 is underway'),
      f('F5', '2026-10-01T14:00:00Z', 'M22 and G20 are not ours'),
      f('F6', '2026-10-01T15:00:00Z', 'cancelled one', 'T3'),
    ];
    expect(stageFeed(feed, r, tasks, 'M2').map((x) => x.id)).toEqual(['F4', 'F3', 'F1']);
    expect(stageFeed(feed, r, tasks, 'M2', 1).map((x) => x.id)).toEqual(['F4']);
  });
});

describe('progress labels', () => {
  it('say what a percent is based on', async () => {
    const { stageCount, stageBasis, goalCount, overallText } = await import('./roadmap');
    const base = { done: 0, total: 0, percent: 75, criteriaDone: 3, criteriaTotal: 4 };
    expect(stageCount(base)).toBe('75%');
    expect(stageCount({ ...base, done: 1, total: 4 })).toBe('1/4');
    expect(stageBasis({ ...base, basis: 'criteria' })).toBe('no tasks linked yet · 3/4 exit criteria met');
    expect(goalCount({ done: 0, total: 0 }, 'done')).toBe('✓');
    expect(goalCount({ done: 0, total: 0 }, 'active')).toBe('–');
    expect(overallText({ done: 0, total: 0, unlinked: 21 })).toBe('no tasks linked yet · 21 not on the roadmap');
    expect(overallText({ done: 2, total: 5 })).toBe('2 / 5 tasks');
  });
});
