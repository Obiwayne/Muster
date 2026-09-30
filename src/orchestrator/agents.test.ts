import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type MusterConfig } from '../types.js';
import { ensureDirs, musterPaths } from '../core/paths.js';
import { Store } from '../core/store.js';
import { addInbox } from '../core/board.js';
import { createTask } from '../core/tasks.js';
import { gitSync, tempRepo } from '../core/testutil.js';
import { AgentManager, type AgentManagerOptions, type Timings } from './agents.js';
import { nodePtyLauncher, type PtyLauncher, type PtyProcess } from './terminal.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function setup(launcher: PtyLauncher, timings: Partial<Timings> = {}, extra: Partial<AgentManagerOptions> = {}, configPatch: Partial<MusterConfig> = {}) {
  const repo = tempRepo();
  const paths = musterPaths(repo);
  ensureDirs(paths);
  const store = new Store(paths);
  const config = { ...DEFAULT_CONFIG, claudePath: 'claude.exe', ...configPatch };
  const agents = new AgentManager({ store, paths, config: () => config, server: () => ({ url: 'http://127.0.0.1:1', token: 't' }), launcher, claudePath: () => 'claude.exe', timings, ...extra });
  cleanups.push(() => {
    agents.dispose();
    rmSync(repo, { recursive: true, force: true });
  });
  return { store, agents, paths, config, repo };
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('AgentManager', () => {
  it('pipes real PTY output into the ring buffer and marks the agent stopped on exit', async () => {
    // Same PTY path as claude, with the command swapped for a one-liner.
    const echo: PtyLauncher = (_file, _args, opts) =>
      nodePtyLauncher(process.platform === 'win32' ? 'cmd.exe' : 'sh', process.platform === 'win32' ? ['/c', 'echo hi from pty'] : ['-c', 'echo hi from pty'], opts);
    const { store, agents } = setup(echo);
    await agents.create({ role: 'captain', actor: 'muster' });
    await until(() => store.state.agents[0].status === 'stopped');
    expect(agents.output('captain')).toContain('hi from pty');
    expect(store.state.feed.at(-1)?.text).toBe('captain exited (code 0)');
  }, 20_000);

  it('keeps output while running', async () => {
    const node: PtyLauncher = (_file, _args, opts) => nodePtyLauncher(process.execPath, ['-e', 'console.log("hi from node"); setTimeout(() => {}, 3000)'], opts);
    const { agents } = setup(node);
    await agents.create({ role: 'captain', actor: 'muster' });
    await until(() => agents.output('captain').includes('hi from node'));
    await agents.stop('captain');
    expect(agents.isRunning('captain')).toBe(false);
  }, 20_000);

  it('stops idle crew with no task after the idle timeout', async () => {
    const fake: PtyLauncher = () => {
      let exit: (e: { exitCode: number }) => void = () => {};
      return { pid: 1, onData() {}, onExit: (cb) => (exit = cb), write() {}, resize() {}, kill: () => setImmediate(() => exit({ exitCode: 0 })) };
    };
    const { store, agents } = setup(fake, { idleShutdownMs: 50 });
    await agents.create({ role: 'crew', actor: 'muster' });
    agents.handleEvent('crew-2', 'stop');
    expect(store.state.agents[0].status).toBe('idle');
    await until(() => store.state.agents[0].status === 'stopped', 3000);
    expect(store.state.feed.some((f) => f.text === 'crew-2 stopped: idle with no task')).toBe(true);
  });

  // A fake PTY whose screen the test controls, recording everything written to it.
  function screenPty() {
    const written: string[] = [];
    let emit: (d: string) => void = () => {};
    const launcher: PtyLauncher = () => ({ pid: 1, onData: (cb) => (emit = cb), onExit() {}, write: (d) => written.push(d), resize() {}, kill() {} });
    return { launcher, written, show: (text: string) => emit(text) };
  }

  it('settles an interrupted turn: no Stop hook, but the screen says Interrupted', async () => {
    const pty = screenPty();
    const { store, agents } = setup(pty.launcher, { quietMs: 60 });
    await agents.create({ role: 'crew', actor: 'muster' });
    agents.handleEvent('crew-2', 'notification', 'Claude needs your permission', 'permission_prompt');
    const note = store.state.notes.at(-1)!;
    expect(store.state.agents[0].status).toBe('stuck');
    pty.show('Do you want to proceed?\r\n 1. Yes\r\n 3. No\r\n');
    await new Promise((r) => setTimeout(r, 150));
    agents.watchQuietTerminals();
    expect(store.state.agents[0].status).toBe('stuck'); // the prompt is still on screen
    pty.show('\x1b[2J  ⎿  Interrupted · What should Claude do instead?\r\n❯ ');
    await new Promise((r) => setTimeout(r, 150));
    agents.watchQuietTerminals();
    expect(store.state.agents[0].status).toBe('idle');
    expect(note.open).toBe(false);
  });

  it('presses Enter again when a typed line was swallowed', async () => {
    const pty = screenPty();
    const { agents } = setup(pty.launcher, { enterDelayMs: 1, submitCheckMs: 40 });
    await agents.create({ role: 'crew', actor: 'muster' });
    agents.handleEvent('crew-2', 'stop');
    await agents.type('crew-2', '[muster] You have 1 new item. Call read_inbox.');
    pty.show('❯ [muster] You have 1 new item. Call read_inbox.');
    await until(() => pty.written.filter((w) => w === '\r').length >= 2, 2000);

    // Once the prompt hook arrives, no more Enters.
    agents.handleEvent('crew-2', 'prompt');
    const enters = pty.written.filter((w) => w === '\r').length;
    await new Promise((r) => setTimeout(r, 150));
    expect(pty.written.filter((w) => w === '\r').length).toBe(enters);
  });
});

// A fake PTY per spawn, recorded by agent id.
class CtlPty implements PtyProcess {
  static nextPid = 9000;
  pid = CtlPty.nextPid++;
  written = '';
  exitOnKill = true;
  private dataCb: (d: string) => void = () => {};
  private exitCb: (e: { exitCode: number }) => void = () => {};
  onData(cb: (d: string) => void) {
    this.dataCb = cb;
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCb = cb;
  }
  write(d: string) {
    this.written += d;
  }
  resize() {}
  kill() {
    if (this.exitOnKill) setImmediate(() => this.exitCb({ exitCode: 0 }));
  }
  emit(d: string) {
    this.dataCb(d);
  }
}

function ctlLauncher(failFor: string[] = []) {
  const spawns: { id: string; args: string[]; pty: CtlPty }[] = [];
  const launcher: PtyLauncher = (_file, args, opts) => {
    const id = opts.env.MUSTER_AGENT;
    if (failFor.includes(id)) throw new Error(`cannot spawn ${id}`);
    const pty = new CtlPty();
    spawns.push({ id, args, pty });
    return pty;
  };
  return { launcher, spawns, last: (id: string) => [...spawns].reverse().find((s) => s.id === id)!.pty };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SYS = 'muster';

describe('AgentManager after the first live run', () => {
  it('keeps terminal listeners per agent id: attached while stopped, and across restarts', async () => {
    const f = ctlLauncher();
    const { agents } = setup(f.launcher);
    const got: string[] = [];
    const detach = agents.attach('crew-2', (d) => got.push(d)); // before the agent even exists
    await agents.create({ role: 'crew', actor: SYS });
    f.last('crew-2').emit('first run');
    await agents.stop('crew-2');
    await agents.start('crew-2');
    f.last('crew-2').emit('second run');
    expect(got).toContain('first run');
    expect(got).toContain('second run');
    expect(got.some((d) => /── crew-2 started .* ──/.test(d))).toBe(true); // separator between the two runs
    expect(agents.backlog('crew-2')).toMatch(/first run[\s\S]*crew-2 started[\s\S]*second run/);
    detach();
    f.last('crew-2').emit('after detach');
    expect(got).not.toContain('after detach');
  });

  it('reserves the agent before any await, so parallel spawns respect maxCrew and one design agent', async () => {
    const f = ctlLauncher();
    const { agents, store } = setup(f.launcher, {}, {}, { maxCrew: 1 });
    const crew = await Promise.allSettled([agents.create({ role: 'crew', actor: SYS }), agents.create({ role: 'crew', actor: SYS })]);
    expect(crew.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(String((crew.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/Crew limit reached \(1\/1 running\)/);
    const design = await Promise.allSettled([agents.create({ role: 'design', actor: SYS }), agents.create({ role: 'design', actor: SYS })]);
    expect(design.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(store.state.agents.map((a) => a.role).sort()).toEqual(['crew', 'design']);
  });

  it('removes the reserved record when creating the worktree fails', async () => {
    const f = ctlLauncher();
    const { agents, store, repo } = setup(f.launcher);
    gitSync(repo, 'worktree', 'add', '-q', '-b', 'crew-x/work', join(repo, 'elsewhere'));
    await expect(agents.create({ role: 'crew', name: 'crew-x', actor: SYS })).rejects.toThrow(/already (checked out|used by worktree)/);
    expect(store.state.agents).toEqual([]);
    expect(f.spawns).toEqual([]);
  });

  it('tells a resumed agent that holds a task to continue it', async () => {
    const f = ctlLauncher();
    const { agents, store, config } = setup(f.launcher, { firstPromptDelayMs: 1, enterDelayMs: 1 });
    await agents.create({ role: 'crew', actor: SYS });
    createTask(store.state, config, { title: 'Build it', assignee: 'crew-2', actor: 'you' });
    agents.handleEvent('crew-2', 'prompt'); // makes the session resumable
    await agents.stop('crew-2');
    await agents.start('crew-2');
    const run = f.spawns.at(-1)!;
    expect(run.args[0]).toBe('--resume');
    agents.handleEvent('crew-2', 'session-start');
    await until(() => run.pty.written.endsWith('\r'), 2000);
    expect(run.pty.written).toBe('[muster] You were restarted. Continue T1 Build it; call read_inbox first.\r');
  });

  it('resumeAll: one agent that fails to start does not stop the others; a missing worktree is recreated', async () => {
    const f = ctlLauncher();
    const { agents, store, paths, config } = setup(f.launcher);
    for (let i = 0; i < 3; i++) await agents.create({ role: 'crew', actor: SYS }); // crew-2..4
    await agents.stopAll();
    agents.dispose();
    const crew4 = store.state.agents.find((a) => a.id === 'crew-4')!;
    rmSync(crew4.worktree, { recursive: true, force: true });

    const g = ctlLauncher(['crew-3']);
    const logs: string[] = [];
    const again = new AgentManager({ store, paths, config: () => config, server: () => ({ url: 'http://127.0.0.1:1', token: 't' }), launcher: g.launcher, claudePath: () => 'claude.exe', log: (m) => logs.push(m) });
    cleanups.push(() => again.dispose());
    await again.resumeAll();
    expect(g.spawns.map((s) => s.id).sort()).toEqual(['captain', 'crew-2', 'crew-4']);
    expect(store.state.agents.find((a) => a.id === 'crew-3')!.status).toBe('stopped');
    expect(store.state.feed.some((x) => x.text === 'crew-3 could not be resumed: cannot spawn crew-3')).toBe(true);
    expect(existsSync(join(crew4.worktree, 'README.md'))).toBe(true);
    expect(gitSync(crew4.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('crew-4/work');
  });

  it('stop() makes sure the process is gone, and never starts a second copy while it lives', async () => {
    const f = ctlLauncher();
    let alive = true;
    const kills: number[] = [];
    const { agents } = setup(f.launcher, { stopConfirmMs: 40 }, { isAlive: () => alive, killPid: (pid) => kills.push(pid) });
    await agents.create({ role: 'crew', actor: SYS });
    const pty = f.last('crew-2');
    pty.exitOnKill = false; // taskkill "succeeded" but the process lives on
    await agents.stop('crew-2');
    expect(kills).toEqual([pty.pid]); // killed a second time
    await expect(agents.start('crew-2')).rejects.toMatchObject({ status: 409, message: /previous process \(pid \d+\) is still running/ });
    expect(f.spawns).toHaveLength(1);

    alive = false;
    await agents.start('crew-2');
    expect(f.spawns).toHaveLength(2);
  });

  it('marks nudged items delivered only after a prompt hook, nudges again without one, and waits for a typing human', async () => {
    const f = ctlLauncher();
    const { agents, store } = setup(f.launcher, { firstPromptDelayMs: 1, enterDelayMs: 1, nudgeDebounceMs: 5, nudgeConfirmMs: 80, humanHoldMs: 150, submitCheckMs: 60_000 });
    await agents.create({ role: 'crew', actor: SYS });
    const pty = f.last('crew-2');
    agents.handleEvent('crew-2', 'session-start');
    await until(() => pty.written.endsWith('\r'), 2000); // the first prompt
    agents.handleEvent('crew-2', 'prompt');
    agents.handleEvent('crew-2', 'stop');

    pty.written = '';
    const item = addInbox(store.state, { agentId: 'crew-2', from: 'captain', kind: 'message', text: 'message from captain: hi' })!;
    store.commit();
    await until(() => pty.written.includes('Call read_inbox'), 2000);
    expect(item.delivered).toBe(false);

    pty.written = ''; // no prompt hook: the line may have been lost, so it comes again
    await until(() => pty.written.includes('Call read_inbox'), 2000);
    agents.handleEvent('crew-2', 'prompt');
    expect(item.delivered).toBe(true);
    agents.handleEvent('crew-2', 'stop');

    pty.written = '';
    agents.write('crew-2', 'h'); // a human at the keyboard
    addInbox(store.state, { agentId: 'crew-2', from: 'crew-3', kind: 'message', text: 'message from crew-3: yo' });
    store.commit();
    await sleep(80);
    expect(pty.written).toBe('h');
    await until(() => pty.written.includes('Call read_inbox'), 2000);

    pty.written = '';
    await agents.type('crew-2', 'a\x1b[Ab\x03c\nd', true, { human: true }); // a human's own line is not held, but is sanitized
    expect(pty.written).toBe('abc d\r');
  });

  it('cleanMerged removes only stopped crew with no task and a merged branch, and forgets them', async () => {
    const f = ctlLauncher();
    const { agents, store, config } = setup(f.launcher);
    await agents.create({ role: 'captain', actor: SYS });
    for (let i = 0; i < 3; i++) await agents.create({ role: 'crew', actor: SYS }); // crew-2..4
    createTask(store.state, config, { title: 'Held', assignee: 'crew-4', actor: 'you' });
    await agents.stop('crew-2');
    await agents.stop('crew-4');
    const [crew2, crew3, crew4] = ['crew-2', 'crew-3', 'crew-4'].map((id) => store.state.agents.find((a) => a.id === id)!);

    const removed = await agents.cleanMerged();
    expect(removed.map((p) => p.split('/').pop())).toEqual(['crew-2']);
    expect(existsSync(crew2.worktree)).toBe(false);
    expect(existsSync(crew3.worktree)).toBe(true); // still running
    expect(existsSync(crew4.worktree)).toBe(true); // holds a task
    expect(store.state.agents.map((a) => a.id)).toEqual(['captain', 'crew-3', 'crew-4']);
  });
});
