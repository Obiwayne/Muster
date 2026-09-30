// Task/branch flows through the HTTP API against a real git repo: one branch per task, merging the
// reviewed commit, inputs carried between stations, dependencies, one task per agent.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Agent, InboxItem, MusterState, Task } from '../types.js';
import { commitFile, gitSync, tempRepo } from '../core/testutil.js';
import { startOrchestrator, type Orchestrator } from './server.js';
import type { PtyLauncher, PtyProcess } from './terminal.js';

class FakePty implements PtyProcess {
  static nextPid = 5000;
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

/** Calls as `actor`: its own token when the orchestrator hands out per-agent tokens, and the actor in the body. */
async function call<T = any>(actor: string, method: string, path: string, body: Record<string, unknown> = {}): Promise<{ status: number; data: T }> {
  const token = actor === 'you' ? orch.token : ((orch as { agentToken?: (id: string) => string }).agentToken?.(actor) ?? orch.token);
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
const task = (id: string) => state().tasks.find((t) => t.id === id)!;
const agent = (id: string) => state().agents.find((a) => a.id === id)!;
const head = (ref: string) => gitSync(repo, 'rev-parse', ref);
const contains = (ancestor: string, ref: string) => {
  try {
    gitSync(repo, 'merge-base', '--is-ancestor', ancestor, ref);
    return true;
  } catch {
    return false;
  }
};

beforeAll(async () => {
  process.env.MUSTER_NO_NOTIFY = '1';
  repo = tempRepo();
  const ui = mkdtempSync(join(tmpdir(), 'muster-ui-'));
  writeFileSync(join(ui, 'index.html'), '<html></html>');
  mkdirSync(join(repo, '.muster'), { recursive: true });
  writeFileSync(join(repo, '.muster', 'config.json'), JSON.stringify({ claudePath: 'C:/fake/claude.exe' }));
  orch = await startOrchestrator({ repoRoot: repo, port: 0, launcher, uiDir: ui, log: () => {}, timings: { enterDelayMs: 1, firstPromptDelayMs: 1, nudgeDebounceMs: 10 } });
  await ok<Agent>('you', 'POST', '/api/agents', {}); // crew-2
  await ok<Agent>('you', 'POST', '/api/agents', {}); // crew-3
});

afterAll(async () => {
  await orch?.shutdown();
  rmSync(repo, { recursive: true, force: true });
});

describe('task flows', () => {
  it('one task per agent, and review only from review or in progress', async () => {
    await ok<Task>('captain', 'POST', '/api/tasks', { title: 'Alpha' }); // T1
    await ok<Task>('captain', 'POST', '/api/tasks', { title: 'Beta' }); // T2
    expect(await ok<Task>('crew-2', 'POST', '/api/tasks/claim')).toMatchObject({ id: 'T1', branch: 'crew-2/alpha' });

    const again = await call('crew-2', 'POST', '/api/tasks/claim');
    expect(again.status).toBe(409);
    expect(again.data.error).toMatch(/crew-2 already holds T1 Alpha/);
    expect((await call('captain', 'POST', '/api/tasks/T2/assign', { agentId: 'crew-2' })).status).toBe(409);
    expect(task('T2')).toMatchObject({ status: 'ready' });
    expect((await call('captain', 'POST', '/api/tasks/T1/assign', { agentId: 'crew-2' })).status).toBe(200); // the same task is fine

    const early = await call('captain', 'POST', '/api/tasks/T2/review', { summary: 'nothing yet' });
    expect(early.status).toBe(409);
    expect(early.data.error).toMatch(/T2 is ready/);
    expect(task('T2').status).toBe('ready');
  });

  it('merges exactly the reviewed commit and refuses a branch that moved after review', async () => {
    const wt = agent('crew-2').worktree;
    commitFile(wt, 'alpha.ts', 'export const alpha = 1;\n');
    await ok('crew-2', 'POST', '/api/tasks/T1/done', { summary: 'alpha' });
    const reviewed = await ok<Task>('captain', 'POST', '/api/tasks/T1/review', { summary: 'tested' });
    expect(reviewed.reviewedSha).toBe(head('crew-2/alpha'));

    commitFile(wt, 'late.ts', 'export const late = 1;\n'); // after the review
    const refused = await call('you', 'POST', '/api/agents/crew-2/merge', { taskId: 'T1' });
    expect(refused.status).toBe(409);
    expect(refused.data.error).toMatch(/^crew-2 committed after review .*ask the Captain to re-review$/);
    expect(existsSync(join(repo, 'alpha.ts'))).toBe(false);

    const again = await ok<Task>('captain', 'POST', '/api/tasks/T1/review', { summary: 'late.ts is fine too' });
    expect(again.reviewedSha).toBe(head('crew-2/alpha'));
    expect(state().notes.filter((n) => n.type === 'review' && n.taskId === 'T1' && n.open)).toHaveLength(1);
    await ok('you', 'POST', '/api/agents/captain/merge', { taskId: 'T1' });
    expect(gitSync(repo, 'log', '-1', '--format=%s')).toBe('Merge crew-2/alpha (T1 Alpha)');
    expect(head('HEAD^2')).toBe(again.reviewedSha);
    expect(task('T1').status).toBe('merged');
  });

  it('gives each task a fresh branch from base, and refuses while the worktree has uncommitted changes', async () => {
    const t2 = await ok<Task>('crew-2', 'POST', '/api/tasks/claim');
    expect(t2).toMatchObject({ id: 'T2', branch: 'crew-2/beta' });
    const wt = agent('crew-2').worktree;
    expect(gitSync(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('crew-2/beta');
    expect(head('crew-2/beta')).toBe(head('main')); // started from base, not from crew-2/alpha
    expect(head('crew-2/alpha')).not.toBe(head('main')); // T1's branch is untouched

    commitFile(wt, 'beta.ts', 'export const beta = 1;\n');
    await ok('crew-2', 'POST', '/api/tasks/T2/done', { summary: 'beta' });
    await ok<Task>('captain', 'POST', '/api/tasks', { title: 'Gamma' }); // T3
    writeFileSync(join(wt, 'README.md'), 'half-finished edit\n');
    const dirty = await call('crew-2', 'POST', '/api/tasks/claim');
    expect(dirty.status).toBe(409);
    expect(dirty.data.error).toMatch(/uncommitted changes on crew-2\/beta \(README\.md\)\. Commit them/);
    expect(task('T3')).toMatchObject({ status: 'ready' });

    gitSync(wt, 'checkout', '--', 'README.md');
    expect(await ok<Task>('crew-2', 'POST', '/api/tasks/claim')).toMatchObject({ id: 'T3', branch: 'crew-2/gamma' });
    expect(task('T2').branch).toBe('crew-2/beta');
  });

  it('keeps the task on the sender branch when the handoff merge conflicts, and checks inputs before done', async () => {
    await ok<Task>('captain', 'POST', '/api/tasks', { title: 'Delta', stations: ['build', 'test'], assignee: 'crew-3' }); // T4
    expect(task('T4').branch).toBe('crew-3/delta');
    commitFile(agent('crew-3').worktree, 'shared.txt', 'from crew-3\n');
    commitFile(repo, 'shared.txt', 'from main\n'); // base moves with a conflicting change

    // The receiver must be free: crew-2 holds T3.
    const busy = await call('crew-3', 'POST', '/api/tasks/T4/handoff', { to: 'crew-2', note: 'test it' });
    expect(busy.status).toBe(409);
    expect(task('T4')).toMatchObject({ assignee: 'crew-3', stationIndex: 0 });

    await ok<Agent>('you', 'POST', '/api/agents', {}); // crew-4
    await ok('crew-3', 'POST', '/api/tasks/T4/handoff', { to: 'crew-4', note: 'test it' });
    const t4 = task('T4');
    expect(t4).toMatchObject({ assignee: 'crew-4', stationIndex: 1, branch: 'crew-3/delta' });
    expect(t4.inputs).toEqual([{ branch: 'crew-3/delta', sha: head('crew-3/delta'), kind: 'station' }]);
    expect(agent('crew-4').branch).toBe('crew-4/delta');
    const inbox = await ok<InboxItem[]>('crew-4', 'GET', '/api/inbox/crew-4');
    expect(inbox.some((i) => i.kind === 'system' && /Could not merge crew-3\/delta .*conflicts in shared\.txt/.test(i.text))).toBe(true);
    const stuck = state().notes.find((n) => n.type === 'stuck' && n.from === 'crew-4' && n.taskId === 'T4')!;
    expect(stuck).toMatchObject({ open: true });
    expect(stuck.text).toMatch(/^Merge conflict: crew-3\/delta/);

    const missing = await call('crew-4', 'POST', '/api/tasks/T4/done', { summary: 'tested' });
    expect(missing.status).toBe(409);
    expect(missing.data.error).toMatch(/crew-4\/delta does not contain crew-3\/delta/);
    expect(task('T4').status).toBe('in_progress');

    const wt4 = agent('crew-4').worktree;
    try {
      gitSync(wt4, 'merge', 'crew-3/delta');
    } catch {
      /* conflict, resolved below */
    }
    writeFileSync(join(wt4, 'shared.txt'), 'from both\n');
    gitSync(wt4, 'add', 'shared.txt');
    gitSync(wt4, 'commit', '-q', '--no-edit');
    const done = await ok<Task>('crew-4', 'POST', '/api/tasks/T4/done', { summary: 'tested' });
    expect(done).toMatchObject({ status: 'review', branch: 'crew-4/delta' });
    expect(stuck.open).toBe(false);
  });

  it('merges a dependency that is ready for merge into the new task branch', async () => {
    await ok<Task>('captain', 'POST', '/api/tasks', { title: 'Epsilon', assignee: 'crew-3' }); // T5
    expect(task('T5').branch).toBe('crew-3/epsilon'); // crew-3/delta belongs to T4
    commitFile(agent('crew-3').worktree, 'eps.ts', 'export const eps = 1;\n');
    await ok('crew-3', 'POST', '/api/tasks/T5/done', { summary: 'eps' });
    const t5 = await ok<Task>('captain', 'POST', '/api/tasks/T5/review', { summary: 'ok' });

    await ok<Task>('captain', 'POST', '/api/tasks', { title: 'Zeta', dependsOn: ['T5'] }); // T6
    expect(task('T6').status).toBe('ready');
    expect(await ok<Task>('crew-4', 'POST', '/api/tasks/claim')).toMatchObject({ id: 'T6', branch: 'crew-4/zeta' });
    expect(contains(t5.reviewedSha!, 'crew-4/zeta')).toBe(true);
    expect(existsSync(join(agent('crew-4').worktree, 'eps.ts'))).toBe(true);
    expect(task('T6').inputs).toEqual([{ branch: 'crew-3/epsilon', sha: t5.reviewedSha, kind: 'dependency', taskId: 'T5' }]);
  });
});
