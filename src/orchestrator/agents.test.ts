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
});
