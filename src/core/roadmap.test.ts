import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type MusterState, type Task } from '../types.js';
import { inboxFor } from './board.js';
import { addGoal, advanceRoadmap, approveRoadmap, completeStage, computeProgress, patchGoal, patchStage, rejectRoadmap, setRoadmap, tickCriterion, type RoadmapInput } from './roadmap.js';
import { emptyState, migrate } from './store.js';
import { cancelTask, createTask, markMerged } from './tasks.js';
import { makeAgent } from './testutil.js';

let s: MusterState;
const config = { ...DEFAULT_CONFIG, defaultStations: ['build', 'review'] };

const plan = (): RoadmapInput => ({
  title: 'shop v1',
  summary: 'A shop.',
  launchDate: '2026-12-01',
  stages: [
    { title: 'Foundations', description: 'base', start: '2026-10-01', due: '2026-10-11', exitCriteria: ['CI green', 'Login works'], goals: [{ title: 'Auth', description: '' }, { title: 'Catalog', description: '' }] },
    { title: 'Checkout', description: 'pay', start: '2026-10-12', due: '2026-10-31', exitCriteria: ['Pays'], goals: [{ title: 'Cart', description: '' }] },
  ],
});
const task = (title: string, goalId: string): Task => createTask(s, config, { title, goalId, actor: 'captain' });
const captainInbox = () => inboxFor(s, 'captain').map((i) => i.text);
const approvalNotes = () => s.notes.filter((n) => n.type === 'approval');

beforeEach(() => {
  s = emptyState('/repo');
  s.agents.push(makeAgent('captain', 'captain'), makeAgent('crew-2', 'crew'));
});

describe('roadmap', () => {
  it('drafts with fresh ids and one approval note that re-saves update', () => {
    const { roadmap, note, noteOpened } = setRoadmap(s, plan(), 'captain');
    expect(roadmap).toMatchObject({ status: 'draft', revision: 0, createdBy: 'captain' });
    expect(roadmap.stages.map((x) => [x.id, x.goalIds])).toEqual([['M1', ['G1', 'G2']], ['M2', ['G3']]]);
    expect(roadmap.stages[0].exitCriteria).toEqual([{ text: 'CI green', done: false }, { text: 'Login works', done: false }]);
    expect(noteOpened).toBe(true);
    expect(note).toMatchObject({ type: 'approval', to: 'you', open: true, from: 'muster' });
    expect(note!.taskId).toBeUndefined(); // never mistaken for a task's approval
    expect(note!.text).toMatch(/^Roadmap ready for your approval/);
    const again = setRoadmap(s, { ...plan(), title: 'shop v1.0' }, 'captain');
    expect(again.noteOpened).toBe(false);
    expect(approvalNotes()).toHaveLength(1);
    expect(approvalNotes()[0].text).toContain('shop v1.0');
  });

  it('only the Captain or you write it', () => {
    expect(() => setRoadmap(s, plan(), 'crew-2')).toThrow(expect.objectContaining({ status: 403 }));
  });

  it('validates stages, goals, titles and dates', () => {
    const bad = (mut: (p: RoadmapInput) => void) => {
      const p = plan();
      mut(p);
      expect(() => setRoadmap(s, p, 'captain')).toThrow(expect.objectContaining({ status: 400 }));
    };
    bad((p) => (p.stages = []));
    bad((p) => (p.stages = Array.from({ length: 13 }, (_, i) => ({ title: `S${i}` }))));
    bad((p) => (p.stages[0].goals = Array.from({ length: 13 }, (_, i) => ({ title: `G${i}` }))));
    bad((p) => (p.stages[0].title = 'x'.repeat(121)));
    bad((p) => (p.stages[0].due = '2026-02-30'));
    bad((p) => (p.stages[0].start = '2026-11-01'));
    bad((p) => (p.stages[0].goals![0].due = 'soon'));
    bad((p) => (p.title = ' '));
    expect(s.roadmap).toBeUndefined();
    expect(s.nextIds.stage).toBe(1);
  });

  it('keeps ids, status and ticks of known entries; refuses dropping goals with tasks', () => {
    setRoadmap(s, plan(), 'captain');
    approveRoadmap(s, 'you');
    tickCriterion(s, 'M1', 0, true, 'captain');
    task('Login', 'G1');
    const p = plan();
    p.stages[0].id = 'M1';
    p.stages[0].goals = [{ id: 'G1', title: 'Auth!' }, { title: 'Search' }];
    p.stages[1].id = 'm2';
    p.stages[1].goals = [{ id: 'G3', title: 'Cart' }];
    p.stages.push({ id: 'M99', title: 'Launch' });
    const r = setRoadmap(s, p, 'captain').roadmap;
    expect(r.stages.map((x) => [x.id, x.status, x.goalIds])).toEqual([['M1', 'active', ['G1', 'G4']], ['M2', 'planned', ['G3']], ['M3', 'planned', []]]);
    expect(r.goals.find((g) => g.id === 'G1')).toMatchObject({ title: 'Auth!', status: 'active' });
    expect(r.stages[0].exitCriteria[0]).toMatchObject({ text: 'CI green', done: true, by: 'captain' });
    expect(r.status).toBe('draft'); // G2 removed, G4 and M3 added: a replan
    const drop = plan();
    drop.stages[0].goals = [];
    expect(() => setRoadmap(s, drop, 'captain')).toThrow(expect.objectContaining({ status: 409, message: expect.stringMatching(/G1 Auth! \(T1\)/) }));
  });

  it('draft rule: text edits keep it approved, dates and goal changes need approval again', () => {
    setRoadmap(s, plan(), 'captain');
    approveRoadmap(s, 'you');
    const ids = (p: RoadmapInput) => {
      p.stages.forEach((st, i) => {
        st.id = `M${i + 1}`;
        st.goals?.forEach((g, j) => (g.id = s.roadmap!.stages[i].goalIds[j]));
      });
      return p;
    };
    const text = ids(plan());
    text.summary = 'A better shop.';
    text.stages[0].description = 'new words';
    text.stages[0].exitCriteria = ['CI green', 'Login works', 'Docs'];
    const kept = setRoadmap(s, text, 'captain');
    expect(kept.roadmap).toMatchObject({ status: 'approved', revision: 1 });
    expect(kept.note).toBeUndefined();
    tickCriterion(s, 'M1', 0, true, 'captain');
    patchStage(s, 'M1', { title: 'Base' }, 'captain');
    patchGoal(s, 'G2', { status: 'active' }, 'captain');
    expect(s.roadmap!.status).toBe('approved');
    const c = patchStage(s, 'M2', { due: '2026-11-05' }, 'captain');
    expect(c).toMatchObject({ roadmap: { status: 'draft' }, noteOpened: true });
    expect(approveRoadmap(s, 'you')).toMatchObject({ status: 'approved', revision: 2 });
    expect(addGoal(s, { stageId: 'M2', title: 'Coupons' }, 'captain')).toMatchObject({ goal: { id: 'G4', status: 'planned' }, roadmap: { status: 'draft' } });
    expect(s.roadmap!.stages[1].goalIds).toEqual(['G3', 'G4']);
  });

  it('approve starts M1 and G1 and closes the note; reject replies, closes and keeps it a draft', () => {
    setRoadmap(s, plan(), 'captain');
    expect(() => approveRoadmap(s, 'captain')).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => rejectRoadmap(s, 'you', ' ')).toThrow(expect.objectContaining({ status: 400 }));
    const r = rejectRoadmap(s, 'you', 'Split checkout');
    expect(r.status).toBe('draft');
    expect(approvalNotes()[0]).toMatchObject({ open: false, replies: [{ from: 'you', text: 'Split checkout' }] });
    expect(captainInbox().at(-1)).toMatch(/sent the roadmap back: Split checkout/);
    expect(setRoadmap(s, plan(), 'captain').noteOpened).toBe(true); // a new note after a send-back (no ids given: fresh M3/M4, G4–G6)
    approveRoadmap(s, 'you');
    expect(s.roadmap).toMatchObject({ status: 'approved', revision: 1 });
    expect(approvalNotes().every((n) => !n.open)).toBe(true);
    expect(s.roadmap!.noteId).toBeUndefined();
    expect(s.roadmap!.stages.map((x) => x.status)).toEqual(['active', 'planned']);
    expect(s.roadmap!.goals.map((g) => g.status)).toEqual(['active', 'planned', 'planned']);
    expect(captainInbox().at(-1)).toBe('Roadmap approved. Start M3 Foundations: break G4 Auth into tasks (post_task with goal: G4).');
    expect(() => approveRoadmap(s, 'you')).toThrow(expect.objectContaining({ status: 409 }));
  });

  it('tasks name goals: unknown 404, a planned goal becomes active', () => {
    setRoadmap(s, plan(), 'captain');
    approveRoadmap(s, 'you');
    expect(() => task('X', 'G42')).toThrow(expect.objectContaining({ status: 404 }));
    expect(s.tasks).toHaveLength(0);
    expect(task('Cart page', 'g3').goalId).toBe('G3');
    expect(s.roadmap!.goals.find((g) => g.id === 'G3')!.status).toBe('active');
  });

  it('finishes goals as their tasks merge, moves on and tells the Captain', () => {
    setRoadmap(s, plan(), 'captain');
    approveRoadmap(s, 'you');
    const a = task('Login', 'G1');
    const b = task('Logout', 'G1');
    const c = task('Old idea', 'G1');
    markMerged(s, a, 'captain');
    expect(s.roadmap!.goals[0].status).toBe('active');
    cancelTask(s, c.id, 'captain', 'dropped');
    expect(advanceRoadmap(s)).toEqual([]);
    markMerged(s, b, 'captain');
    expect(s.roadmap!.goals.map((g) => g.status)).toEqual(['done', 'active', 'planned']);
    expect(captainInbox().at(-1)).toBe('G1 done. Next: G2 Catalog — break it into tasks.');
    expect(s.feed.some((f) => f.text === 'G1 Auth done')).toBe(true);
    const d = task('List', 'G2');
    markMerged(s, d, 'captain');
    expect(captainInbox().slice(-2)).toEqual(['G2 done.', 'All goals of M1 are done. Check its exit criteria (check_criterion) and complete_stage.']);
  });

  it('completes a stage only with its criteria ticked, unless you force it', () => {
    setRoadmap(s, plan(), 'captain');
    approveRoadmap(s, 'you');
    expect(() => completeStage(s, 'M1', 'captain')).toThrow(expect.objectContaining({ status: 409, message: expect.stringContaining('1. CI green') }));
    expect(() => completeStage(s, 'M1', 'captain', true)).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => tickCriterion(s, 'M1', 5, true, 'captain')).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => tickCriterion(s, 'M1', 0, true, 'crew-2')).toThrow(expect.objectContaining({ status: 403 }));
    tickCriterion(s, 'M1', 0, true, 'captain');
    tickCriterion(s, 'M1', 1, true, 'captain');
    tickCriterion(s, 'M1', 1, false, 'captain');
    expect(s.roadmap!.stages[0].exitCriteria[1]).toEqual({ text: 'Login works', done: false });
    tickCriterion(s, 'M1', 1, true, 'you');
    const { next, goal } = completeStage(s, 'M1', 'captain');
    expect(s.roadmap!.stages.map((x) => x.status)).toEqual(['done', 'active']);
    expect([next?.id, goal?.id, goal?.status]).toEqual(['M2', 'G3', 'active']);
    expect(captainInbox().at(-1)).toBe('M1 Foundations is complete. Start M2 Checkout: break G3 Cart into tasks (post_task with goal: G3).');
    expect(() => completeStage(s, 'M1', 'you')).toThrow(expect.objectContaining({ status: 409 }));
    completeStage(s, 'M2', 'you', true);
    expect(computeProgress(s, '2026-10-20')!.health).toBe('done');
  });

  it('counts progress and health', () => {
    setRoadmap(s, plan(), 'captain');
    expect(computeProgress(s, '2026-09-30')).toMatchObject({
      overall: { done: 0, total: 0, percent: 0 },
      health: 'not_started', // both stages planned and starting later
      daysToLaunch: 62,
      currentStageId: 'M1',
    });
    approveRoadmap(s, 'you');
    const t = [task('a', 'G1'), task('b', 'G1'), task('c', 'G1'), task('d', 'G2')];
    cancelTask(s, task('e', 'G2').id, 'captain', 'no');
    markMerged(s, t[0], 'captain');
    s.tasks[1].assignee = 'crew-2';
    let p = computeProgress(s, '2026-10-02')!;
    expect(p.goals.G1).toEqual({ done: 1, total: 3, percent: 33, agents: ['crew-2'] });
    expect(p.goals.G2).toEqual({ done: 0, total: 1, percent: 0, agents: [] });
    expect(p.stages.M1).toEqual({ done: 1, total: 4, percent: 25, health: 'on_track', criteriaDone: 0, criteriaTotal: 2 });
    expect(p.stages.M2.health).toBe('not_started');
    expect(p).toMatchObject({ overall: { done: 1, total: 4, percent: 25 }, health: 'on_track', currentStageId: 'M1', currentGoalId: 'G1', daysToLaunch: 60 });
    // 10 days from Oct 1 to Oct 11: on Oct 6, 50% elapsed and 25% done → at risk (25% < 35%)
    p = computeProgress(s, '2026-10-06')!;
    expect(p.stages.M1.health).toBe('at_risk');
    expect(p.health).toBe('at_risk');
    expect(computeProgress(s, '2026-10-04')!.stages.M1.health).toBe('on_track'); // 30% elapsed: 25% ≥ 15%
    p = computeProgress(s, '2026-10-12')!;
    expect(p.stages.M1.health).toBe('late');
    expect(p.stages.M2.health).toBe('on_track'); // planned but its start has come
    expect(p.health).toBe('late');
    // cancelled goals drop out of stage/overall counts
    patchGoal(s, 'G2', { status: 'cancelled' }, 'you');
    expect(computeProgress(s, '2026-10-02')!.stages.M1).toMatchObject({ done: 1, total: 3, percent: 33 });
    expect(computeProgress({ ...s, roadmap: undefined }, '2026-10-02')).toBeNull();
  });

  it('migrates old state files without stage/goal ids', () => {
    const old = { nextIds: { agent: 3, task: 4, note: 1, feed: 1, inbox: 1 } } as unknown as MusterState;
    expect(migrate(old, '/r').nextIds).toMatchObject({ agent: 3, task: 4, stage: 1, goal: 1 });
    setRoadmap(s, plan(), 'captain');
    const raw = JSON.parse(JSON.stringify(s));
    delete raw.nextIds.stage;
    delete raw.nextIds.goal;
    expect(migrate(raw, '/r').nextIds).toMatchObject({ stage: 3, goal: 4 });
  });
});
