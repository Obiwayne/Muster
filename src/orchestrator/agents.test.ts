import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../types.js';
import { ensureDirs, musterPaths } from '../core/paths.js';
import { Store } from '../core/store.js';
import { tempRepo } from '../core/testutil.js';
import { AgentManager } from './agents.js';
import { nodePtyLauncher, type PtyLauncher } from './terminal.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function setup(launcher: PtyLauncher, timings = {}) {
  const repo = tempRepo();
  const paths = musterPaths(repo);
  ensureDirs(paths);
  const store = new Store(paths);
  const config = { ...DEFAULT_CONFIG, claudePath: 'claude.exe' };
  const agents = new AgentManager({ store, paths, config: () => config, server: () => ({ url: 'http://127.0.0.1:1', token: 't' }), launcher, claudePath: () => 'claude.exe', timings });
  cleanups.push(() => {
    agents.dispose();
    rmSync(repo, { recursive: true, force: true });
  });
  return { store, agents };
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
