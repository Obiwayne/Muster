// Media routes through the HTTP API: who may call them, herald's queue and lifecycle, the board note and the event.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MediaPiece, MediaStore, MediaSummary, MusterState, Task } from '../types.js';
import { tempRepo } from '../core/testutil.js';
import { startOrchestrator, type Orchestrator } from './server.js';
import type { PtyLauncher, PtyProcess } from './terminal.js';

const typed: string[] = [];
class FakePty implements PtyProcess {
  static nextPid = 9000;
  pid = FakePty.nextPid++;
  private exitCbs: ((e: { exitCode: number }) => void)[] = [];
  onData() {}
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCbs.push(cb);
  }
  write(data: string) {
    typed.push(data);
  }
  resize() {}
  kill() {
    setImmediate(() => this.exitCbs.splice(0).forEach((cb) => cb({ exitCode: 1 })));
  }
}
const launches: { cwd: string }[] = [];
const launcher: PtyLauncher = (_file, _args, opts) => {
  launches.push({ cwd: opts.cwd });
  return new FakePty();
};

let repo: string;
let orch: Orchestrator;
let task: Task;

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
const herald = () => state().agents.find((a) => a.id === 'herald');
const piece = (id: string) => orch.media.store.pieces.find((p) => p.id === id);
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const posts = (text = 'Teachers approve posts first.') => ['x', 'linkedin', 'bluesky'].map((platform) => ({ platform, versions: [text] }));

beforeAll(async () => {
  process.env.MUSTER_NO_NOTIFY = '1';
  repo = tempRepo();
  const ui = mkdtempSync(join(tmpdir(), 'muster-ui-'));
  writeFileSync(join(ui, 'index.html'), '<html></html>');
  mkdirSync(join(repo, '.muster'), { recursive: true });
  writeFileSync(join(repo, '.muster', 'config.json'), JSON.stringify({ lines: { feature: { label: 'Feature', stations: ['build'] } }, claudePath: 'C:/fake/claude.exe', maxCrew: 1, projectName: 'wall' }));
  orch = await startOrchestrator({
    repoRoot: repo,
    port: 0,
    launcher,
    uiDir: ui,
    log: () => {},
    timings: { enterDelayMs: 1, firstPromptDelayMs: 1, nudgeDebounceMs: 10, scoutStopDelayMs: 20, stopConfirmMs: 200 },
  });
  task = await ok<Task>('you', 'POST', '/api/tasks', { title: 'Approval queue' });
});

afterAll(async () => {
  await orch?.shutdown();
  rmSync(repo, { recursive: true, force: true });
});

describe('media API', () => {
  it('starts empty; herald is never added by hand; only you ask for pieces', async () => {
    const store = await ok<MediaStore>('you', 'GET', '/api/media');
    expect(store).toMatchObject({ pieces: [], suggestions: [], houseStyle: expect.stringMatching(/Plain words/) });
    expect(await ok<MediaSummary>('you', 'GET', '/api/media/summary')).toMatchObject({ review: 0, drafting: 0, openSuggestions: 0 });
    expect((await call('you', 'POST', '/api/agents', { role: 'media' })).status).toBe(400);
    expect((await call('captain', 'POST', '/api/media/pieces', { kind: 'social', about: [{ kind: 'task', ref: task.id }] })).status).toBe(403);
    expect((await call('you', 'POST', '/api/media/pieces', { kind: 'social', about: [{ kind: 'task', ref: 'T99' }] })).status).toBe(400);
  });

  it('a new piece starts herald at the repo root, outside maxCrew, with its first prompt', async () => {
    const p = await ok<MediaPiece>('you', 'POST', '/api/media/pieces', { kind: 'social', about: [{ kind: 'task', ref: task.id }], note: 'For teachers' });
    expect(p).toMatchObject({ id: 'MP1', status: 'queued' });
    await until(() => herald() !== undefined && piece('MP1')?.status === 'drafting');
    expect(herald()).toMatchObject({ role: 'media', worktree: repo, branch: 'main' });
    expect(launches.at(-1)!.cwd).toBe(repo);
    await ok('herald', 'POST', '/api/agents/herald/event', { event: 'session-start' });
    await until(() => typed.includes('[muster] You are herald (media). Draft MP1: call media_brief and start.'));
    expect(state().feed.some((f) => f.text.startsWith('herald started MP1'))).toBe(true);
    // A second piece waits its turn.
    await ok('you', 'POST', '/api/media/pieces', { kind: 'article', about: [{ kind: 'task', ref: task.id }] });
    expect(piece('MP2')!.status).toBe('queued');
  });

  it('the brief is herald\'s (and yours); drafts and finish only from herald', async () => {
    expect((await call('captain', 'GET', '/api/media/brief')).status).toBe(403);
    const { text } = await ok<{ text: string }>('herald', 'GET', '/api/media/brief');
    expect(text).toContain('# MP1 · Social post for wall');
    expect(text).toContain('Note from the user: For teachers');
    expect((await ok<{ text: string }>('you', 'GET', '/api/media/brief')).text).toBe(text);
    expect((await call('captain', 'POST', '/api/media/pieces/MP1/draft', { title: 'x' })).status).toBe(403);
    expect((await call('you', 'POST', '/api/media/pieces/MP1/edit', { title: 'x' })).status).toBe(409); // herald is writing it
    expect((await call('herald', 'POST', '/api/media/pieces/current/finish')).status).toBe(409); // nothing written yet
    const saved = await ok<MediaPiece>('herald', 'POST', '/api/media/pieces/current/draft', { title: 'Approve before publish', posts: posts(), progress: 'writing X', claims: [{ quote: 'approve posts first', sources: [] }] });
    expect(saved).toMatchObject({ title: 'Approve before publish', progress: 'writing X' });
    expect((await ok<MediaSummary>('you', 'GET', '/api/media/summary')).working).toEqual({ id: 'MP1', title: 'Approve before publish', progress: 'writing X' });
  });

  it('finish puts it in review with a board note, and hands herald the next piece', async () => {
    const typedBefore = typed.length;
    const p = await ok<MediaPiece>('herald', 'POST', '/api/media/pieces/MP1/finish', { summary: 'Three platforms.' });
    expect(p.status).toBe('review');
    const note = state().notes.at(-1)!;
    expect(note).toMatchObject({ topic: 'media', to: 'you', open: true });
    expect(note.text.split('\n')[0]).toBe('herald finished MP1 · Approve before publish');
    await until(() => piece('MP2')?.status === 'drafting');
    await until(() => typed.slice(typedBefore).includes('[muster] You are herald (media). Draft MP2: call media_brief and start.'));
    expect(orch.agents.isRunning('herald')).toBe(true);
  });

  it('approve waits for unsourced claims; confirm, approve, used settle the note', async () => {
    expect((await call('herald', 'POST', '/api/media/pieces/MP1/approve')).status).toBe(403);
    expect((await call('you', 'POST', '/api/media/pieces/MP1/approve')).status).toBe(409);
    await ok('you', 'POST', '/api/media/pieces/MP1/claims/C1/confirm');
    expect((await ok<MediaPiece>('you', 'POST', '/api/media/pieces/MP1/approve')).status).toBe('approved');
    expect(state().notes.find((n) => n.topic === 'media')).toMatchObject({ open: false, dismissed: true });
    expect((await ok<MediaPiece>('you', 'POST', '/api/media/pieces/MP1/used')).status).toBe('used');
    expect((await call('herald', 'PUT', '/api/media/style', { text: 'x' })).status).toBe(403);
    expect(await ok('you', 'PUT', '/api/media/style', { text: 'Warm and short.' })).toEqual({ houseStyle: 'Warm and short.' });
  });

  it('herald exiting mid-draft fails the piece; retry queues it and restarts herald', async () => {
    await orch.agents.stop('herald', 'test');
    expect(piece('MP2')).toMatchObject({ status: 'failed', error: 'herald stopped: test' });
    expect((await call('you', 'POST', '/api/media/pieces/MP2/retry')).status).toBe(200);
    await until(() => piece('MP2')?.status === 'drafting' && orch.agents.isRunning('herald'));
  });

  it('deleting the piece herald is on stops herald; asking for changes queues a finished piece again', async () => {
    await ok('you', 'DELETE', '/api/media/pieces/MP2');
    await until(() => herald()!.status === 'stopped');
    expect(piece('MP2')).toBeUndefined();
    await ok('you', 'POST', '/api/media/pieces/MP1/ask', { text: 'Shorter' });
    await until(() => piece('MP1')?.status === 'drafting' && orch.agents.isRunning('herald'));
    await ok('herald', 'POST', '/api/media/pieces/MP1/draft', { posts: posts('Shorter.') });
    await ok('herald', 'POST', '/api/media/pieces/MP1/finish');
    expect(piece('MP1')!.requests[0].doneAt).toBeTruthy();
    await until(() => herald()!.status === 'stopped'); // queue empty → stopped after reading the result
  });

  it('suggestions: the Captain suggests merged features; you write or dismiss them', async () => {
    expect((await call('herald', 'POST', '/api/media/suggestions', { task: task.id, title: 't', why: 'w' })).status).toBe(403);
    expect((await call('captain', 'POST', '/api/media/suggestions', { task: task.id, title: 't', why: 'w' })).status).toBe(409); // not merged
    const t = state().tasks.find((x) => x.id === task.id)!;
    t.status = 'merged';
    t.history.push({ at: new Date().toISOString(), agentId: 'captain', kind: 'merged' });
    const sg = await ok('captain', 'POST', '/api/media/suggestions', { task: task.id, title: 'Approve before publish', why: 'Teachers asked.' });
    expect(sg).toMatchObject({ id: 'MS1', trigger: 'feature', status: 'open' });
    expect((await call('captain', 'POST', '/api/media/suggestions/MS1/accept')).status).toBe(403);
    const { pieces } = await ok<{ pieces: MediaPiece[] }>('you', 'POST', '/api/media/suggestions/MS1/accept');
    expect(pieces.map((p) => p.kind)).toEqual(['social', 'website']);
    expect(await ok('you', 'POST', '/api/media/suggestions/dismiss-all')).toEqual({ dismissed: 0 });
  });
});
