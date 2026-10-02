// Roadmap routes through the HTTP API: who may write, the approval note, and goals on tasks.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Agent, MusterState, Roadmap, RoadmapGoal, RoadmapProgress, Task } from '../types.js';
import { tempRepo } from '../core/testutil.js';
import { startOrchestrator, type Orchestrator } from './server.js';
import type { PtyLauncher, PtyProcess } from './terminal.js';

class FakePty implements PtyProcess {
  static nextPid = 7000;
  pid = FakePty.nextPid++;
  private exitCbs: ((e: { exitCode: number }) => void)[] = [];
  onData() {}
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCbs.push(cb);
  }
  write() {}
  resize() {}
  kill() {
    setImmediate(() => this.exitCbs.splice(0).forEach((cb) => cb({ exitCode: 1 })));
  }
}
const launcher: PtyLauncher = () => new FakePty();

let repo: string;
let orch: Orchestrator;

/** Calls as `actor` with its own token (the body actor is overwritten by the server anyway). */
async function call<T = any>(actor: string, method: string, path: string, body: Record<string, unknown> = {}): Promise<{ status: number; data: T }> {
  const token = actor === 'you' ? orch.token : orch.agentToken(actor);
  const res = await fetch(orch.url + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-muster-token': token },
    body: method === 'GET' ? undefined : JSON.stringify({ actor, ...body }),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}
async function ok<T = any>(actor: string, method: string, path: string, body?: Record<string, unknown>): Promise<T> {
  const r = await call<T>(actor, method, path, body);
  if (r.status !== 200) throw new Error(`${actor} ${method} ${path} → ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
const state = () => orch.store.state as MusterState;
const captainInbox = () => state().inbox.filter((i) => i.agentId === 'captain').map((i) => i.text);
type Reply = { roadmap: Roadmap | null; progress: RoadmapProgress | null };

const plan = {
  title: 'shop v1',
  summary: 'A shop.',
  launchDate: '2099-01-01',
  stages: [
    { title: 'Foundations', description: '', start: '2026-01-01', due: '2099-01-01', exitCriteria: ['CI green'], goals: [{ title: 'Auth', description: '' }, { title: 'Catalog', description: '' }] },
    { title: 'Checkout', description: '', exitCriteria: [], goals: [{ title: 'Cart', description: '' }] },
  ],
};

beforeAll(async () => {
  process.env.MUSTER_NO_NOTIFY = '1';
  repo = tempRepo();
  const ui = mkdtempSync(join(tmpdir(), 'muster-ui-'));
  writeFileSync(join(ui, 'index.html'), '<html></html>');
  mkdirSync(join(repo, '.muster'), { recursive: true });
  writeFileSync(join(repo, '.muster', 'config.json'), JSON.stringify({ lines: { feature: { label: 'Feature', stations: ['build'] } }, claudePath: 'C:/fake/claude.exe' }));
  orch = await startOrchestrator({ repoRoot: repo, port: 0, launcher, uiDir: ui, log: () => {}, timings: { enterDelayMs: 1, firstPromptDelayMs: 1, nudgeDebounceMs: 10 } });
  await ok<Agent>('you', 'POST', '/api/agents', {}); // crew-2
});

afterAll(async () => {
  await orch?.shutdown();
  rmSync(repo, { recursive: true, force: true });
});

describe('roadmap API', () => {
  it('starts empty, and only the Captain or you write it', async () => {
    expect(await ok<Reply>('you', 'GET', '/api/roadmap')).toEqual({ roadmap: null, progress: null });
    expect((await call('crew-2', 'PUT', '/api/roadmap', plan)).status).toBe(403);
    expect((await call('captain', 'PUT', '/api/roadmap', { ...plan, stages: [] })).status).toBe(400);
    expect((await call('captain', 'PATCH', '/api/roadmap/stages/M1', { title: 'x' })).status).toBe(404);
  });

  it('drafts, sends back and approves: the note opens, closes and the Captain is told', async () => {
    const draft = await ok<Reply>('captain', 'PUT', '/api/roadmap', plan);
    expect(draft.roadmap).toMatchObject({ status: 'draft', revision: 0, createdBy: 'captain' });
    expect(draft.progress).toMatchObject({ overall: { done: 0, total: 0, percent: 0 }, currentStageId: 'M1' });
    const note = state().notes.find((n) => n.id === draft.roadmap!.noteId)!;
    expect(note).toMatchObject({ type: 'approval', to: 'you', open: true });
    expect(note.taskId).toBeUndefined();
    expect((await ok('you', 'GET', '/api/notes?needsYou=1')).map((n: { id: string }) => n.id)).toContain(note.id);
    // re-saving the draft (same ids) updates the note
    const ids = { ...plan, stages: plan.stages.map((s, i) => ({ ...s, id: `M${i + 1}`, goals: s.goals.map((g, j) => ({ ...g, id: draft.roadmap!.stages[i].goalIds[j] })) })) };
    await ok('captain', 'PUT', '/api/roadmap', { ...ids, summary: 'A better shop.' });
    expect(state().notes.filter((n) => n.type === 'approval')).toHaveLength(1);

    // approve/reject are yours only; the task approve route doesn't touch it
    expect((await call('captain', 'POST', '/api/roadmap/approve')).status).toBe(403);
    expect((await call('captain', 'POST', '/api/roadmap/reject', { note: 'no' })).status).toBe(403);
    expect((await call('you', 'POST', '/api/roadmap/reject', {})).status).toBe(400);
    const back = await ok<Reply>('you', 'POST', '/api/roadmap/reject', { note: 'Dates please' });
    expect(back.roadmap).toMatchObject({ status: 'draft' });
    expect(state().notes.find((n) => n.id === note.id)).toMatchObject({ open: false, replies: [{ from: 'you', text: 'Dates please' }] });
    expect(captainInbox().at(-1)).toMatch(/sent the roadmap back: Dates please/);

    const again = await ok<Reply>('captain', 'PUT', '/api/roadmap', ids);
    const note2 = again.roadmap!.noteId!;
    expect(note2).not.toBe(note.id);
    const approved = await ok<Reply>('you', 'POST', '/api/roadmap/approve');
    expect(approved.roadmap).toMatchObject({ status: 'approved', revision: 1 });
    expect(approved.roadmap!.noteId).toBeUndefined();
    expect(state().notes.find((n) => n.id === note2)!.open).toBe(false);
    expect(approved.progress).toMatchObject({ currentStageId: 'M1', currentGoalId: 'G1', health: 'on_track' });
    expect(captainInbox().at(-1)).toBe('Roadmap approved. Start M1 Foundations: break G1 Auth into tasks (post_task with goal: G1).');
    expect((await call('you', 'POST', '/api/roadmap/approve')).status).toBe(409);
  });

  it('posts tasks to goals and finishes a goal when its tasks are done', async () => {
    expect((await call('captain', 'POST', '/api/tasks', { title: 'Nope', goalId: 'G99' })).status).toBe(404);
    const t = await ok<Task>('captain', 'POST', '/api/tasks', { title: 'Cart page', goalId: 'G3' });
    expect(t.goalId).toBe('G3');
    expect(state().roadmap!.goals.find((g) => g.id === 'G3')!.status).toBe('active');
    const a = await ok<Task>('captain', 'POST', '/api/tasks', { title: 'Login', goalId: 'g1' });
    const b = await ok<Task>('captain', 'POST', '/api/tasks', { title: 'Old', goalId: 'G1' });
    // merged elsewhere; cancelling the last open task of the goal finishes it
    orch.store.state.tasks.find((x) => x.id === a.id)!.status = 'merged';
    await ok('captain', 'POST', `/api/tasks/${b.id}/cancel`, { reason: 'dropped' });
    expect(state().roadmap!.goals.find((g) => g.id === 'G1')!.status).toBe('done');
    expect(state().roadmap!.goals.find((g) => g.id === 'G2')!.status).toBe('active');
    expect(captainInbox().at(-1)).toBe('G1 done. Next: G2 Catalog — break it into tasks.');
    const p = (await ok<Reply>('you', 'GET', '/api/roadmap')).progress!;
    expect(p.goals.G1).toMatchObject({ done: 1, total: 1, percent: 100 });
    expect(state().roadmap!.goals.find((g) => g.id === 'G3')!.status).toBe('active');
  });

  it('ticks criteria, adds goals (a replan) and completes stages', async () => {
    expect((await call('crew-2', 'POST', '/api/roadmap/stages/M1/criteria/0', { done: true })).status).toBe(403);
    expect((await call('captain', 'POST', '/api/roadmap/stages/M1/criteria/x', { done: true })).status).toBe(400);
    expect((await call('captain', 'POST', '/api/roadmap/stages/M1/criteria/3', { done: true })).status).toBe(404);
    expect((await call('captain', 'POST', '/api/roadmap/stages/M1/complete')).status).toBe(409);
    expect((await call('captain', 'POST', '/api/roadmap/stages/M1/complete', { force: true })).status).toBe(403);
    const ticked = await ok<Reply>('captain', 'POST', '/api/roadmap/stages/M1/criteria/0', { done: true });
    expect(ticked.roadmap!.stages[0].exitCriteria[0]).toMatchObject({ done: true, by: 'captain' });
    expect(ticked.progress!.stages.M1).toMatchObject({ criteriaDone: 1, criteriaTotal: 1 });
    expect(ticked.roadmap!.status).toBe('approved');

    const added = await ok<Reply & { goal: RoadmapGoal }>('captain', 'POST', '/api/roadmap/goals', { stageId: 'M2', title: 'Coupons', description: '' });
    expect(added.goal).toMatchObject({ id: 'G4', stageId: 'M2', status: 'planned' });
    expect(added.roadmap).toMatchObject({ status: 'draft' });
    expect(state().notes.find((n) => n.id === added.roadmap!.noteId)).toMatchObject({ type: 'approval', open: true });
    await ok('you', 'POST', '/api/roadmap/approve');
    expect(state().roadmap!.revision).toBe(2);

    const patched = await ok<Reply>('captain', 'PATCH', '/api/roadmap/goals/G4', { title: 'Coupon codes' });
    expect(patched.roadmap!.status).toBe('approved'); // a title isn't a replan

    const done = await ok<Reply>('captain', 'POST', '/api/roadmap/stages/M1/complete');
    expect(done.roadmap!.stages.map((s) => s.status)).toEqual(['done', 'active']);
    expect(done.progress!.currentStageId).toBe('M2');
    expect(captainInbox().at(-1)).toMatch(/^M1 Foundations is complete\. Start M2 Checkout/);
    // you may force a stage with unticked criteria
    await ok('you', 'PATCH', '/api/roadmap/stages/M2', { title: 'Pay' });
    expect((await ok<Reply>('you', 'POST', '/api/roadmap/stages/M2/complete', { force: true })).progress!.health).toBe('done');
  });
});
