import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Agent, FeedItem, InboxItem, MusterEvent, MusterState, Note, Task } from '../types.js';
import { commitFile, gitSync, tempRepo } from '../core/testutil.js';
import type { VellumCall } from '../core/vellum.js';
import { startOrchestrator, type Orchestrator } from './server.js';
import type { PtyLauncher, PtyProcess } from './terminal.js';

class FakePty implements PtyProcess {
  static nextPid = 1000;
  pid = FakePty.nextPid++;
  written = '';
  private dataCbs: ((d: string) => void)[] = [];
  private exitCbs: ((e: { exitCode: number }) => void)[] = [];
  onData(cb: (d: string) => void) {
    this.dataCbs.push(cb);
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCbs.push(cb);
  }
  write(d: string) {
    this.written += d;
  }
  resize() {}
  kill() {
    setImmediate(() => this.exit(1));
  }
  emit(d: string) {
    for (const cb of this.dataCbs) cb(d);
  }
  exit(exitCode: number) {
    for (const cb of this.exitCbs.splice(0)) cb({ exitCode });
  }
}

interface Spawned {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  pty: FakePty;
}

let vellumCall: VellumCall = async () => '[]';
const spawned: Spawned[] = [];
const launcher: PtyLauncher = (file, args, opts) => {
  const pty = new FakePty();
  spawned.push({ file, args, cwd: opts.cwd, env: opts.env, pty });
  return pty;
};
const ptyOf = (id: string) => [...spawned].reverse().find((s) => s.env.MUSTER_AGENT === id)!.pty;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await sleep(10);
  }
}

let repo: string;
let orch: Orchestrator;

/** The identity comes from the token: a body `actor` other than "you" is sent with that agent's own token. */
const tokenFor = (body: unknown): string => {
  const actor = body && typeof body === 'object' ? (body as { actor?: unknown }).actor : undefined;
  return typeof actor === 'string' && actor !== 'you' ? orch.agentToken(actor) : orch.token;
};
async function call<T = any>(method: string, path: string, body?: unknown, token: string | null = tokenFor(body)): Promise<{ status: number; data: T }> {
  const res = await fetch(orch.url + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-muster-token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}
const ok = async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
  const r = await call<T>(method, path, body);
  if (r.status !== 200) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};
const state = async () => (await ok<{ state: MusterState }>('GET', '/api/state')).state;
const agent = async (id: string) => (await state()).agents.find((a) => a.id === id)!;

beforeAll(async () => {
  process.env.MUSTER_NO_NOTIFY = '1';
  repo = tempRepo();
  const ui = mkdtempSync(join(tmpdir(), 'muster-ui-'));
  writeFileSync(join(ui, 'index.html'), '<html><head><meta name="muster-token" content=""></head><body></body></html>');
  const muster = join(repo, '.muster');
  rmSync(muster, { recursive: true, force: true });
  await import('node:fs').then((fs) => fs.mkdirSync(muster, { recursive: true }));
  writeFileSync(join(muster, 'config.json'), JSON.stringify({ claudePath: 'C:/fake/claude.exe', testCommand: 'node -e "console.log(42)"' }));
  orch = await startOrchestrator({
    repoRoot: repo,
    port: 0,
    launcher,
    uiDir: ui,
    vellumCall: (...a) => vellumCall(...a),
    log: () => {},
    timings: { enterDelayMs: 5, firstPromptDelayMs: 5, nudgeDebounceMs: 10 },
  });
});

afterAll(async () => {
  await orch?.shutdown();
  rmSync(repo, { recursive: true, force: true });
});

describe('orchestrator API', () => {
  it('requires the token except for health, and writes server.json', async () => {
    expect((await call('GET', '/api/health', undefined, null)).data).toMatchObject({ ok: true });
    expect((await call('GET', '/api/state', undefined, null)).status).toBe(401);
    expect((await call('GET', '/api/state', undefined, 'wrong')).status).toBe(401);
    expect(existsSync(join(repo, '.muster', 'server.json'))).toBe(true);
  });

  it('serves the dashboard with the token injected', async () => {
    const html = await (await fetch(orch.url + '/')).text();
    expect(html).toContain(`<meta name="muster-token" content="${orch.token}">`);
    expect((await fetch(orch.url + '/assets/missing.js')).status).toBe(404);
  });

  it('creates and starts a Captain on startup', async () => {
    const captain = await agent('captain');
    expect(captain).toMatchObject({ role: 'captain', branch: 'main', model: 'opus', status: 'starting' });
    const s = spawned[0];
    expect(s.file).toBe('C:/fake/claude.exe');
    expect(s.cwd).toBe(orch.store.state.repoRoot);
    expect(s.args.slice(0, 4)).toEqual(['--session-id', captain.sessionId, '--model', 'opus']);
    expect(s.env).toMatchObject({ MUSTER_AGENT: 'captain', MUSTER_ROLE: 'captain', MUSTER_TOKEN: orch.agentToken('captain'), MUSTER_BASE_BRANCH: 'main', MUSTER_URL: orch.url });
    await ok('POST', '/api/agents/captain/event', { event: 'session-start' });
    expect((await agent('captain')).status).toBe('idle');
  });

  it('auto-accepts the folder trust prompt once', async () => {
    const pty = ptyOf('captain');
    pty.written = '';
    pty.emit('\x1b[1mDo you trust the files in this folder?\x1b[0m\r\n');
    pty.emit('\x1b[5;2H❯ 1. Yes, proceed\x1b[6;4H2. No, exit\x1b[8;2HEnter to confirm');
    pty.emit('Do you trust the files in this folder? Enter to confirm');
    await sleep(500);
    expect(pty.written).toBe('\r');
  });

  it('spawns crew in a worktree and types its first prompt after SessionStart', async () => {
    expect((await call('POST', '/api/agents', { actor: 'crew-9' })).status).toBe(401); // no such agent, so no valid token
    const crew = await ok<Agent>('POST', '/api/agents', { actor: 'you' });
    expect(crew).toMatchObject({ id: 'crew-2', role: 'crew', branch: 'crew-2/work', model: 'sonnet' });
    expect(existsSync(join(crew.worktree, 'README.md'))).toBe(true);
    await ok('POST', '/api/agents/crew-2/event', { event: 'session-start' });
    await until(() => ptyOf('crew-2').written.includes('\r'));
    expect(ptyOf('crew-2').written).toBe('[muster] You are crew-2, crew. Call claim_task to pick up work.\r');
    await ok('POST', '/api/agents/crew-2/event', { event: 'prompt' });
    expect((await agent('crew-2')).status).toBe('working');
  });

  it('types input and returns ANSI-stripped output', async () => {
    const pty = ptyOf('crew-2');
    pty.written = '';
    await ok('POST', '/api/agents/crew-2/input', { text: 'line one\nline two', submit: true });
    expect(pty.written).toBe('line one line two\r');
    pty.emit('\x1b[32mhello\x1b[0m world\r\n');
    expect((await ok<{ text: string }>('GET', '/api/agents/crew-2/output?lines=1')).text).toBe('hello world');
  });

  it('runs a task from claim to merge', async () => {
    const task = await ok<Task>('POST', '/api/tasks', { title: 'Share dialog', description: 'add it', actor: 'captain' });
    expect(task).toMatchObject({ id: 'T1', status: 'ready', stations: ['build', 'review'] });
    const claimed = await ok<Task>('POST', '/api/tasks/claim', { actor: 'crew-2' });
    expect(claimed).toMatchObject({ id: 'T1', status: 'in_progress', assignee: 'crew-2', branch: 'crew-2/share-dialog' });
    const crew = await agent('crew-2');
    expect(crew.branch).toBe('crew-2/share-dialog');
    expect(gitSync(crew.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('crew-2/share-dialog');

    commitFile(crew.worktree, 'share.ts', 'export const share = true;\n');
    const diff = await ok('GET', '/api/agents/crew-2/diff');
    expect(diff).toMatchObject({ branch: 'crew-2/share-dialog', base: 'main' });
    expect(diff.diff).toContain('+export const share = true;');
    const tests = await ok('POST', '/api/agents/crew-2/tests');
    expect(tests).toMatchObject({ exitCode: 0 });
    expect(tests.output.trim()).toBe('42');

    expect((await call('POST', '/api/agents/crew-2/merge', { actor: 'you' })).status).toBe(409); // not flagged yet
    await ok('POST', '/api/tasks/T1/done', { actor: 'crew-2', summary: 'dialog works' });
    expect((await call('POST', '/api/tasks/T1/review', { actor: 'crew-2', summary: 'me' })).status).toBe(403);
    const reviewed = await ok<Task>('POST', '/api/tasks/T1/review', { actor: 'captain', summary: 'tested' });
    expect(reviewed.status).toBe('ready_for_merge');
    expect((await ok<Note[]>('GET', '/api/notes?needsYou=1')).map((n) => n.type)).toEqual(['review']);

    expect((await call('POST', '/api/agents/crew-2/merge', { actor: 'captain' })).status).toBe(403);
    const merged = await ok('POST', '/api/agents/crew-2/merge', { actor: 'you' });
    expect(merged.ok).toBe(true);
    expect(gitSync(repo, 'log', '-1', '--format=%s')).toBe('Merge crew-2/share-dialog (T1 Share dialog)');
    expect((await ok<Task[]>('GET', '/api/tasks'))[0].status).toBe('merged');
    expect(await ok<Note[]>('GET', '/api/notes?needsYou=1')).toEqual([]);
  });

  it('routes notes, replies and messages to inboxes and nudges idle agents', async () => {
    const note = await ok<Note>('POST', '/api/notes', { actor: 'crew-2', type: 'question', text: 'Which icon set?' });
    expect((await ok<InboxItem[]>('GET', '/api/inbox/captain?unread=1')).map((i) => i.noteId)).toContain(note.id);

    const captainPty = ptyOf('captain');
    await ok('POST', '/api/agents/captain/event', { event: 'prompt' }); // confirms the nudges typed so far
    captainPty.written = '';
    await ok('POST', '/api/agents/captain/event', { event: 'stop' });
    await until(() => captainPty.written.endsWith('\r'));
    expect(captainPty.written).toMatch(/^\[muster\] You have \d+ new items? \(.*\)\. Call read_inbox\.\r$/);

    await ok('POST', `/api/notes/${note.id}/reply`, { actor: 'captain', text: 'Lucide', close: true });
    const polled = await ok<Note[]>(`GET`, '/api/notes?from=crew-2&type=question');
    expect(polled[0]).toMatchObject({ open: false, replies: [{ from: 'captain', text: 'Lucide' }] });
    expect((await ok<InboxItem[]>('GET', '/api/inbox/crew-2?unread=1')).map((i) => i.kind)).toContain('reply');
    await ok('POST', '/api/inbox/crew-2/read', {});
    expect(await ok('GET', '/api/inbox/crew-2?unread=1')).toEqual([]);

    const msg = await ok<FeedItem>('POST', '/api/messages', { actor: 'you', to: 'everyone', text: 'lunch' });
    expect(msg).toMatchObject({ kind: 'message', from: 'you', to: 'everyone' });
    const feed = await ok<FeedItem[]>('GET', '/api/feed?agent=crew-2&limit=500');
    expect(feed.at(-1)?.text).toBe('lunch');

    expect((await call('POST', '/api/escalate', { actor: 'crew-2', text: 'x' })).status).toBe(403);
    const esc = await ok<Note>('POST', '/api/escalate', { actor: 'captain', text: 'Pick a price', noteId: note.id });
    expect(esc).toMatchObject({ type: 'escalation', to: 'you', open: true });
  });

  it('turns a permission wait into a stuck note and clears it on the next prompt', async () => {
    await ok('POST', '/api/agents/crew-2/event', { event: 'notification', detail: 'Claude needs your permission to use Bash', kind: 'permission_prompt' });
    expect((await agent('crew-2')).status).toBe('stuck');
    const stuck = (await ok<Note[]>('GET', '/api/notes?open=1&type=stuck&from=crew-2'))[0];
    expect(stuck.text).toBe('Waiting for permission: Claude needs your permission to use Bash');
    await ok('POST', '/api/agents/crew-2/event', { event: 'prompt' });
    expect((await agent('crew-2')).status).toBe('working');
    expect(await ok('GET', '/api/notes?open=1&type=stuck&from=crew-2')).toEqual([]);
    await ok('POST', '/api/agents/crew-2/event', { event: 'stop' });
    expect((await agent('crew-2')).status).toBe('done'); // it reported T1 done and holds nothing
  });

  it('hands a branch on to the next station and sends it back to the builder', async () => {
    await ok<Agent>('POST', '/api/agents', { actor: 'captain' }); // crew-3
    const t = await ok<Task>('POST', '/api/tasks', { title: 'Invite API', stations: ['build', 'test'], assignee: 'crew-2', actor: 'captain' });
    expect(t).toMatchObject({ status: 'in_progress', assignee: 'crew-2', branch: 'crew-2/invite-api' }); // a fresh branch: T1's is merged
    commitFile((await agent('crew-2')).worktree, 'invite.ts', 'export const invite = 1;\n');

    const handed = await ok<Task>('POST', `/api/tasks/${t.id}/handoff`, { actor: 'crew-2', to: 'crew-3', note: 'please test' });
    const crew3 = await agent('crew-3');
    expect(crew3.branch).toBe('crew-3/invite-api');
    expect(handed).toMatchObject({ stationIndex: 1, assignee: 'crew-3', branch: 'crew-3/invite-api' });
    expect(existsSync(join(crew3.worktree, 'invite.ts'))).toBe(true);

    await ok('POST', '/api/agents/crew-2/stop', { actor: 'you' });
    const back = await ok<Task>('POST', `/api/tasks/${t.id}/sendback`, { actor: 'you', note: 'rename the route' });
    expect(back).toMatchObject({ stationIndex: 0, assignee: 'crew-2', status: 'in_progress' });
    expect((await agent('crew-2')).status).toBe('starting'); // woken up to take it back
  });

  it('streams state and terminal output over websockets', async () => {
    const events = new WebSocket(`${orch.url.replace('http', 'ws')}/ws/events?token=${orch.token}`);
    const first = await new Promise<MusterEvent>((r) => events.once('message', (d) => r(JSON.parse(String(d)))));
    expect(first.type).toBe('state');
    events.close();

    ptyOf('crew-2').emit('backlog-marker');
    const term = new WebSocket(`${orch.url.replace('http', 'ws')}/ws/term/crew-2?token=${orch.token}`);
    const backlog = await new Promise<string>((r) => term.once('message', (d) => r(String(d))));
    expect(backlog).toContain('backlog-marker');
    const live = new Promise<string>((r) => term.once('message', (d) => r(String(d))));
    ptyOf('crew-2').emit('live-chunk');
    expect(await live).toBe('live-chunk');

    // A screen clear and its redraw arrive as separate PTY chunks ~16ms apart; clients must get them as one message.
    const frame = new Promise<string>((r) => term.once('message', (d) => r(String(d))));
    ptyOf('crew-2').emit('old[?25l[2J');
    await sleep(16);
    ptyOf('crew-2').emit('[Hnew screen');
    expect(await frame).toBe('old[?25l[2J[Hnew screen');
    ptyOf('crew-2').written = '';
    term.send(JSON.stringify({ type: 'input', data: 'zq-input' }));
    await until(() => ptyOf('crew-2').written.includes('zq-input'));
    term.close();

    const bad = new WebSocket(`${orch.url.replace('http', 'ws')}/ws/events?token=nope`);
    await new Promise<void>((r) => bad.once('error', () => r()));
  });

  it('refuses spawns and claims while paused', async () => {
    await ok('POST', '/api/usage', { agentId: 'crew-2', rate_limits: { five_hour: { used_percentage: 85, resets_at: Math.floor(Date.now() / 1000) + 3600 } } });
    expect((await ok('GET', '/api/usage')).paused).toBe(true);
    const r = await call('POST', '/api/agents', { actor: 'you' });
    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/^Paused: 5-hour window at 85%/);
    expect((await call('POST', '/api/tasks/claim', { actor: 'crew-2' })).status).toBe(409);
    await ok('POST', '/api/usage', { agentId: 'crew-2', rate_limits: { five_hour: { used_percentage: 10 } } });
    expect((await ok('GET', '/api/state')).paused).toBe(false);
  });

  it('enforces maxCrew and one design agent', async () => {
    await ok('PATCH', '/api/config', { maxCrew: 1, bogus: 1 });
    expect((await ok('GET', '/api/config')).bogus).toBeUndefined();
    expect((await call('POST', '/api/agents', { actor: 'you' })).status).toBe(409);
    const design = await ok<Agent>('POST', '/api/agents', { actor: 'captain', role: 'design' });
    expect(design).toMatchObject({ id: 'design', role: 'design' });
    expect((await call('POST', '/api/agents', { actor: 'you', role: 'design' })).status).toBe(409);
  });

  it('changes roles: a new Captain demotes the old one into a worktree', async () => {
    const before = spawned.length;
    const promoted = await ok<Agent>('POST', '/api/agents/crew-2/role', { role: 'captain', actor: 'you' });
    expect(promoted).toMatchObject({ role: 'captain', branch: 'main', model: 'opus' });
    const old = await agent('captain');
    expect(old).toMatchObject({ role: 'crew', branch: 'captain/work' });
    expect(existsSync(join(old.worktree, 'README.md'))).toBe(true);
    const restarted = spawned.slice(before);
    expect(restarted.map((s) => s.env.MUSTER_AGENT).sort()).toEqual(['captain', 'crew-2']);
    // both had submitted a prompt, so both sessions resume
    const argsOf = (id: string) => restarted.find((s) => s.env.MUSTER_AGENT === id)!.args;
    expect(argsOf('crew-2')[0]).toBe('--resume');
    expect(argsOf('captain')[0]).toBe('--resume');
    expect(restarted.find((s) => s.env.MUSTER_AGENT === 'crew-2')!.cwd).toBe(orch.store.state.repoRoot);
  });

  it('stops, restarts and deletes agents', async () => {
    expect((await ok<Agent>('POST', '/api/agents/design/stop', { actor: 'you' })).status).toBe('stopped');
    const again = await ok<Agent>('POST', '/api/agents/design/start', { actor: 'you' });
    expect(again.status).toBe('starting');
    expect(spawned.at(-1)!.args[0]).toBe('--session-id'); // never prompted, so nothing to resume

    ptyOf('design').exit(1); // a crash
    await until(() => orch.store.state.agents.find((a) => a.id === 'design')!.status === 'stopped');

    await ok('DELETE', '/api/agents/design?removeWorktree=1');
    expect((await state()).agents.map((a) => a.id)).not.toContain('design');
    expect(existsSync(join(repo, '.muster', 'worktrees', 'design'))).toBe(false);
  });

  it('diffs and merges a specific branch or task', async () => {
    const d = await ok('GET', '/api/agents/captain/diff?branch=crew-2/invite-api&stat=1');
    expect(d).toMatchObject({ branch: 'crew-2/invite-api', base: 'main', diff: '' });
    expect(d.stat).toContain('invite.ts');
    expect((await call('GET', '/api/agents/captain/diff?branch=--output=x')).status).toBe(404);

    expect((await call('POST', '/api/agents/captain/merge', { actor: 'you', taskId: 'T2' })).status).toBe(409);
    const built = await ok<Task>('POST', '/api/tasks/T2/done', { actor: 'crew-2', summary: 'renamed' });
    if (built.status === 'ready') {
      // done finished the build station; the test station still has to run
      await ok('POST', '/api/tasks/T2/assign', { agentId: 'captain', actor: 'crew-2' }); // the old Captain is crew now
      await ok('POST', '/api/tasks/T2/done', { actor: 'captain', summary: 'tested' });
    }
    await ok('POST', '/api/tasks/T2/review', { actor: 'crew-2', summary: 'ok' }); // crew-2 is the Captain now
    const merged = await ok('POST', '/api/agents/captain/merge', { actor: 'you', taskId: 'T2' });
    expect(merged.ok).toBe(true);
    // the test station's branch carries the build, so that's what merges
    expect(gitSync(repo, 'log', '-1', '--format=%s')).toMatch(/^Merge (crew-2|captain)\/invite-api \(T2 Invite API\)$/);
  });

  it('saves vellumEdit and rejects unknown values', async () => {
    expect((await ok('GET', '/api/config')).vellumEdit).toBe('ask');
    expect((await ok('PATCH', '/api/config', { vellumEdit: 'never' })).vellumEdit).toBe('never');
    expect((await call('PATCH', '/api/config', { vellumEdit: 'sometimes' })).status).toBe(400);
    expect((await ok('PATCH', '/api/config', { vellumEdit: null })).vellumEdit).toBe('ask');
  });

  it('saves and clears vellumFile', async () => {
    expect((await ok('PATCH', '/api/config', { vellumFile: 'F1' })).vellumFile).toBe('F1');
    expect((await ok('PATCH', '/api/config', { vellumFile: null })).vellumFile).toBeUndefined();
    await ok('PATCH', '/api/config', { vellumFile: 'F2' });
    expect((await ok('PATCH', '/api/config', { vellumFile: '' })).vellumFile).toBeUndefined();
    await ok('PATCH', '/api/config', { vellumFile: 'F3' });
    for (const bad of [5, { id: 'x' }, true, ['F1']]) expect((await call('PATCH', '/api/config', { vellumFile: bad })).status).toBe(400);
    expect((await ok('GET', '/api/config')).vellumFile).toBe('F3'); // a rejected patch changes nothing
    await ok('PATCH', '/api/config', { vellumFile: null });
  });

  it('unsets config keys patched to null', async () => {
    await ok('PATCH', '/api/config', { vellum: { command: 'node', args: ['v.js'] }, maxCrew: 4 });
    expect((await ok('GET', '/api/config')).vellum).toEqual({ command: 'node', args: ['v.js'] });
    const cfg = await ok('PATCH', '/api/config', { vellum: null, maxCrew: null });
    expect(cfg.vellum).toBeUndefined();
    expect(cfg.maxCrew).toBe(3);
  });

  it('serves the Vellum status, cached, and refreshes on ?refresh=1', async () => {
    await ok('PATCH', '/api/config', { vellum: { command: 'node', args: ['v.js'] } });
    let calls = 0;
    vellumCall = async () => (calls++, JSON.stringify([{ id: 'F1', name: 'Wall', pages: [{}, {}], updatedAt: 1700000000000 }]));
    const first = await ok('GET', '/api/vellum?refresh=1');
    expect(first).toMatchObject({ status: 'connected', files: [{ id: 'F1', name: 'Wall', pages: 2, updated: '2023-11-14T22:13:20.000Z' }] });
    expect(await ok('GET', '/api/vellum')).toEqual(first);
    expect(calls).toBe(1);
    vellumCall = async () => {
      throw new Error('boom');
    };
    expect(await ok('GET', '/api/vellum?refresh=1')).toMatchObject({ status: 'unreachable', message: 'boom', files: [] });
    await ok('PATCH', '/api/config', { vellum: null });
  });

  it('serves stations from .muster/stations: agents read, only you write', async () => {
    const list = async () => ok<any[]>('GET', '/api/stations');
    expect((await list()).map((s) => s.name)).toEqual(['build', 'design', 'test', 'review']);
    expect(existsSync(join(repo, '.muster', 'stations', 'build.md'))).toBe(true);
    const put = await ok('PUT', '/api/stations/lint', { role: 'crew', guideline: '# Lint - run eslint.' });
    expect(put).toMatchObject({ name: 'lint', role: 'crew', builtin: false, guideline: '# Lint - run eslint.' });
    expect(await ok('GET', '/api/stations/lint')).toEqual(put);
    expect((await call('PUT', '/api/stations/lint', { guideline: 'x', actor: 'crew-2' })).status).toBe(403);
    expect((await call('GET', '/api/stations', undefined, orch.agentToken('crew-2'))).status).toBe(200);
    expect((await call('PUT', '/api/stations/review', { role: 'crew' })).status).toBe(400);
    expect((await call('DELETE', '/api/stations/review')).status).toBe(400);
    expect((await call('GET', '/api/stations/nope')).status).toBe(404);
    expect((await ok<any[]>('DELETE', '/api/stations/lint')).map((s) => s.name)).not.toContain('lint');
  });

  it('shuts down, then resumes the agents that were running on the next start', async () => {
    const running = orch.store.state.agents.filter((a) => a.status !== 'stopped').map((a) => a.id).sort();
    await orch.shutdown();
    expect(existsSync(join(repo, '.muster', 'server.json'))).toBe(false);

    const before = spawned.length;
    orch = await startOrchestrator({ repoRoot: repo, port: 0, launcher, log: () => {} });
    const resumed = spawned.slice(before);
    expect(resumed.map((s) => s.env.MUSTER_AGENT).sort()).toEqual(running);
    expect(resumed.find((s) => s.env.MUSTER_AGENT === 'crew-2')!.args[0]).toBe('--resume');
  });
});
