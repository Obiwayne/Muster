import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type MusterState } from '../types.js';
import { inboxFor, listNotes } from './board.js';
import { emptyState } from './store.js';
import { assignTask, claimTask, createTask, doneTask, handoffTask, hasReportedDone, markMerged, requestReview, sendBack } from './tasks.js';
import { makeAgent } from './testutil.js';

let s: MusterState;
const config = { ...DEFAULT_CONFIG };

beforeEach(() => {
  s = emptyState('/repo');
  s.agents.push(makeAgent('captain', 'captain'), makeAgent('crew-2', 'crew'), makeAgent('crew-3', 'crew'), makeAgent('design', 'design'));
});

describe('tasks', () => {
  it('defaults stations and always ends with review', () => {
    const a = createTask(s, config, { title: 'A', actor: 'captain' });
    expect(a.stations).toEqual(['build', 'review']);
    const b = createTask(s, config, { title: 'B', stations: ['build', 'review', 'test'], actor: 'captain' });
    expect(b.stations).toEqual(['build', 'test', 'review']);
    expect([a.id, b.id]).toEqual(['T1', 'T2']);
  });

  it('blocks on dependencies until they reach ready_for_merge', () => {
    const api = createTask(s, config, { title: 'API', actor: 'captain' });
    const tests = createTask(s, config, { title: 'Tests', dependsOn: ['t1'], actor: 'captain' });
    expect(tests.status).toBe('blocked');
    expect(claimTask(s, 'crew-2')?.id).toBe('T1');
    expect(claimTask(s, 'crew-3')).toBeNull();
    doneTask(s, api.id, 'crew-2', 'built');
    requestReview(s, api.id, 'captain', 'looks good');
    expect(tests.status).toBe('ready');
    expect(claimTask(s, 'crew-3')?.id).toBe('T2');
  });

  it('keeps an assigned task blocked until its dependency is done', () => {
    createTask(s, config, { title: 'API', actor: 'captain' });
    const t = createTask(s, config, { title: 'UI', dependsOn: ['T1'], assignee: 'crew-3', actor: 'captain' });
    expect(t.status).toBe('blocked');
    expect(t.assignee).toBe('crew-3');
    markMerged(s, s.tasks[0], 'you');
    expect(t.status).toBe('in_progress');
  });

  it('claims by station role, oldest first', () => {
    createTask(s, config, { title: 'Design check', stations: ['design'], actor: 'captain' });
    createTask(s, config, { title: 'Build 1', actor: 'captain' });
    createTask(s, config, { title: 'Build 2', actor: 'captain' });
    expect(claimTask(s, 'crew-2')?.title).toBe('Build 1');
    expect(claimTask(s, 'design')?.title).toBe('Design check');
    expect(claimTask(s, 'design')).toBeNull();
    const t = claimTask(s, 'crew-3')!;
    expect(t.title).toBe('Build 2');
    expect(t.assignee).toBe('crew-3');
    expect(t.branch).toBe('crew-3/work');
    expect(s.agents.find((a) => a.id === 'crew-3')!.taskId).toBe(t.id);
  });

  it('hands off through stations to review', () => {
    const t = createTask(s, config, { title: 'Share dialog', stations: ['build', 'test', 'design'], actor: 'captain' });
    claimTask(s, 'crew-2');

    const r1 = handoffTask(s, t.id, 'crew-2', 'crew-3', 'built, please test');
    expect(r1.fromBranch).toBe('crew-2/work');
    expect(r1.receiver?.id).toBe('crew-3');
    expect(t).toMatchObject({ stationIndex: 1, status: 'in_progress', assignee: 'crew-3' });
    expect(s.agents.find((a) => a.id === 'crew-2')!.taskId).toBeUndefined();
    expect(inboxFor(s, 'crew-3').map((i) => i.kind)).toEqual(['handoff']);

    handoffTask(s, t.id, 'crew-3', undefined, 'tests pass');
    expect(t).toMatchObject({ stationIndex: 2, status: 'ready', assignee: undefined });
    expect(claimTask(s, 'crew-2')).toBeNull(); // the design station is for the design crew
    expect(claimTask(s, 'design')?.id).toBe(t.id);

    handoffTask(s, t.id, 'design', undefined, 'matches the framework');
    expect(t).toMatchObject({ stationIndex: 3, status: 'review', assignee: 'captain' });
    expect(inboxFor(s, 'captain').some((i) => i.kind === 'review' && i.taskId === t.id)).toBe(true);
    expect(hasReportedDone(s, s.agents.find((a) => a.id === 'design')!)).toBe(true);
  });

  it('refuses handoff from an agent that does not hold the task', () => {
    const t = createTask(s, config, { title: 'X', actor: 'captain' });
    claimTask(s, 'crew-2');
    expect(() => handoffTask(s, t.id, 'crew-3', undefined, 'mine now')).toThrow(/held by crew-2/);
  });

  it('done jumps to review and posts a Done note', () => {
    const t = createTask(s, config, { title: 'X', stations: ['build', 'test'], actor: 'captain' });
    claimTask(s, 'crew-2');
    doneTask(s, t.id, 'crew-2', 'all green');
    expect(t).toMatchObject({ status: 'review', assignee: 'captain', stationIndex: 2 });
    const done = listNotes(s, { type: 'done' });
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ from: 'crew-2', open: false, taskId: t.id });
  });

  it('review is Captain-only and opens a Needs-you note', () => {
    const t = createTask(s, config, { title: 'X', actor: 'captain' });
    claimTask(s, 'crew-2');
    doneTask(s, t.id, 'crew-2', 'ok');
    expect(() => requestReview(s, t.id, 'crew-2', 'self review')).toThrow(/Only the Captain/);
    const { note } = requestReview(s, t.id, 'captain', 'tested');
    expect(t.status).toBe('ready_for_merge');
    expect(listNotes(s, { needsYou: true }).map((n) => n.id)).toEqual([note.id]);
  });

  it('sendback returns the task to the original builder and closes the review note', () => {
    const t = createTask(s, config, { title: 'X', stations: ['build', 'test'], actor: 'captain' });
    claimTask(s, 'crew-2');
    handoffTask(s, t.id, 'crew-2', 'crew-3', 'test it');
    doneTask(s, t.id, 'crew-3', 'tested');
    requestReview(s, t.id, 'captain', 'ok');
    expect(() => sendBack(s, t.id, 'crew-3', 'no')).toThrow(/Captain or you/);

    sendBack(s, t.id, 'you', 'button is misaligned');
    expect(t).toMatchObject({ status: 'in_progress', stationIndex: 0, assignee: 'crew-2' });
    expect(listNotes(s, { needsYou: true })).toHaveLength(0);
    expect(inboxFor(s, 'crew-2').at(-1)?.text).toMatch(/misaligned/);
  });

  it('refuses claim and assign while paused', () => {
    createTask(s, config, { title: 'X', actor: 'captain' });
    s.usage.paused = true;
    s.usage.fiveHour = { usedPercentage: 83 };
    expect(() => claimTask(s, 'crew-2')).toThrow(/Paused: 5-hour window at 83%/);
    expect(() => assignTask(s, 'T1', 'crew-2', 'captain')).toThrow(/Paused/);
  });

  it('only the Captain or you can assign', () => {
    createTask(s, config, { title: 'X', actor: 'captain' });
    expect(() => assignTask(s, 'T1', 'crew-3', 'crew-2')).toThrow(/Only the Captain or you/);
    const t = assignTask(s, 'T1', 'crew-3', 'you');
    expect(t.assignee).toBe('crew-3');
    expect(inboxFor(s, 'crew-3')[0]).toMatchObject({ kind: 'assignment', taskId: 'T1', from: 'you' });
  });
});
