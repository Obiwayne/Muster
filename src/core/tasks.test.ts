import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type MusterState } from '../types.js';
import { inboxFor, listNotes, postNote } from './board.js';
import { emptyState } from './store.js';
import { assignTask, cancelTask, claimTask, createTask, doneTask, handoffTask, hasReportedDone, markMerged, MERGE_CONFLICT, requestReview, sendBack, untake } from './tasks.js';
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
    expect(claimTask(s, 'crew-3')?.title).toBe('Build 2');
    expect(claimTask(s, 'captain')).toBeNull(); // nothing at the review station
    const t = s.tasks[2];
    expect(t.assignee).toBe('crew-3');
    expect(t.branch).toBeUndefined(); // the branch is settled by AgentManager.syncTaskBranch
    expect(s.agents.find((a) => a.id === 'crew-3')!.taskId).toBe(t.id);
  });

  it('hands off through stations to review', () => {
    const t = createTask(s, config, { title: 'Share dialog', stations: ['build', 'test', 'design'], actor: 'captain' });
    claimTask(s, 'crew-2');

    const r1 = handoffTask(s, t.id, 'crew-2', 'crew-3', 'built, please test', { branch: 'crew-2/share-dialog', sha: 'a'.repeat(40) });
    expect(r1.fromBranch).toBe('crew-2/share-dialog');
    expect(t.inputs).toEqual([{ branch: 'crew-2/share-dialog', sha: 'a'.repeat(40), kind: 'station' }]);
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

  it('done finishes the current station: on to the next one, then to review, with a Done note each time', () => {
    const t = createTask(s, config, { title: 'X', stations: ['build', 'test'], actor: 'captain' });
    claimTask(s, 'crew-2');
    doneTask(s, t.id, 'crew-2', 'built');
    expect(t).toMatchObject({ status: 'ready', assignee: undefined, stationIndex: 1 });
    expect(s.inbox.some((i) => i.agentId === 'crew-3' && i.taskId === t.id && /test station/.test(i.text))).toBe(true);
    expect(claimTask(s, 'crew-3')?.id).toBe(t.id);
    doneTask(s, t.id, 'crew-3', 'all green');
    expect(t).toMatchObject({ status: 'review', assignee: 'captain', stationIndex: 2 });
    const done = listNotes(s, { type: 'done' });
    expect(done).toHaveLength(2);
    expect(done[0]).toMatchObject({ open: false, taskId: t.id });
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

  it('gives an agent one task at a time: claim, assign, handoff and sendback refuse while it holds another', () => {
    const a = createTask(s, config, { title: 'A', stations: ['build', 'test'], actor: 'captain' });
    const b = createTask(s, config, { title: 'B', actor: 'captain' });
    claimTask(s, 'crew-2'); // A
    expect(() => claimTask(s, 'crew-2')).toThrow(/crew-2 already holds T1 A \(in_progress\)/);
    expect(() => assignTask(s, b.id, 'crew-2', 'captain')).toThrow(/already holds T1/);
    expect(b).toMatchObject({ status: 'ready' });
    expect(b.assignee).toBeUndefined();
    expect(assignTask(s, a.id, 'crew-2', 'captain').assignee).toBe('crew-2'); // the task it holds is fine

    assignTask(s, b.id, 'crew-3', 'captain');
    expect(() => handoffTask(s, a.id, 'crew-2', 'crew-3', 'test it')).toThrow(/crew-3 already holds T2/);
    expect(a).toMatchObject({ stationIndex: 0, assignee: 'crew-2' }); // nothing moved

    handoffTask(s, a.id, 'crew-2', undefined, 'anyone can test');
    claimTask(s, 'crew-2'); // A again, at the test station
    doneTask(s, a.id, 'crew-2', 'ok');
    expect(claimTask(s, 'crew-2')).toBeNull(); // free again, nothing left
    assignTask(s, createTask(s, config, { title: 'C', actor: 'captain' }).id, 'crew-2', 'captain');
    expect(() => sendBack(s, a.id, 'captain', 'again')).toThrow(/crew-2 already holds T3/);
    expect(a.status).toBe('review');
  });

  it('flags for merge only from review or in progress (or ready_for_merge again, to re-review)', () => {
    const t = createTask(s, config, { title: 'X', actor: 'captain' });
    expect(() => requestReview(s, t.id, 'captain', 'nothing yet')).toThrow(/T1 is ready; only work in review or in progress/);
    expect(t.status).toBe('ready');
    claimTask(s, 'crew-2');
    requestReview(s, t.id, 'captain', 'looks done', { branch: 'crew-2/x', sha: 'a'.repeat(40) });
    expect(t).toMatchObject({ status: 'ready_for_merge', branch: 'crew-2/x', reviewedSha: 'a'.repeat(40) });
    requestReview(s, t.id, 'captain', 'new commit reviewed', { branch: 'crew-2/x', sha: 'b'.repeat(40) });
    expect(t.reviewedSha).toBe('b'.repeat(40));
    expect(listNotes(s, { type: 'review', open: true })).toHaveLength(1);
    markMerged(s, t, 'you');
    expect(() => requestReview(s, t.id, 'captain', 'again')).toThrow(/T1 is merged/);
    sendBack; // (send-back clears the reviewed commit: covered in the API flow)
  });

  it('validates before creating: a refused assignee leaves no half-created task', () => {
    createTask(s, config, { title: 'Held', assignee: 'crew-2', actor: 'captain' });
    const before = { tasks: s.tasks.length, next: s.nextIds.task, feed: s.feed.length };
    expect(() => createTask(s, config, { title: 'Second', assignee: 'crew-2', actor: 'captain' })).toThrow(/already holds T1/);
    s.usage.paused = true;
    expect(() => createTask(s, config, { title: 'Paused', assignee: 'crew-3', actor: 'captain' })).toThrow(/Paused/);
    s.usage.paused = false;
    expect(() => createTask(s, config, { title: 'Nobody', assignee: 'crew-9', actor: 'captain' })).toThrow(/No agent "crew-9"/);
    expect(() => createTask(s, config, { title: 'Not yours', assignee: 'crew-3', actor: 'crew-2' })).toThrow(/Only the Captain or you/);
    expect({ tasks: s.tasks.length, next: s.nextIds.task, feed: s.feed.length }).toEqual(before);
  });

  it('closes the merge-conflict stuck note once a station hands on a branch with every input', () => {
    const t = createTask(s, config, { title: 'X', stations: ['build', 'test'], actor: 'captain' });
    claimTask(s, 'crew-2');
    handoffTask(s, t.id, 'crew-2', 'crew-3', 'test', { branch: 'crew-2/x', sha: 'a'.repeat(40) });
    const note = postNote(s, { actor: 'crew-3', type: 'stuck', taskId: t.id, text: `${MERGE_CONFLICT} crew-2/x into crew-3/x` });
    doneTask(s, t.id, 'crew-3', 'resolved and tested', { branch: 'crew-3/x', sha: 'c'.repeat(40) });
    expect(note.open).toBe(false);
    expect(t.branch).toBe('crew-3/x');
  });

  it('untake puts a task back on the board', () => {
    const t = createTask(s, config, { title: 'X', actor: 'captain' });
    claimTask(s, 'crew-2');
    untake(s, t, s.agents[1], 'dirty worktree');
    expect(t.status).toBe('ready');
    expect(t.assignee).toBeUndefined();
    expect(s.agents[1].taskId).toBeUndefined();
  });
});

describe('cancelTask', () => {
  it('drops a task: nobody can claim it, its holder is told, its notes close', () => {
    const t = createTask(s, config, { title: 'Old idea', actor: 'captain' });
    claimTask(s, 'crew-2');
    postNote(s, { actor: 'crew-2', type: 'question', taskId: t.id, text: 'scope?' });
    expect(() => cancelTask(s, t.id, 'crew-3', 'nope')).toThrow(/cancel tasks/);
    cancelTask(s, t.id, 'captain', 'superseded by T9');
    expect(t).toMatchObject({ status: 'cancelled', assignee: undefined });
    expect(s.agents.find((a) => a.id === 'crew-2')!.taskId).toBeUndefined();
    expect(s.inbox.some((i) => i.agentId === 'crew-2' && /cancelled T1 Old idea: superseded by T9/.test(i.text))).toBe(true);
    expect(s.notes.every((n) => n.taskId !== t.id || !n.open)).toBe(true);
    expect(claimTask(s, 'crew-3')).toBeNull();
    expect(() => cancelTask(s, t.id, 'you', 'again')).toThrow(/already cancelled/);
  });
});
