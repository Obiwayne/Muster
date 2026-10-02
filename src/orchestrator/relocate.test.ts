// A project folder renamed (or moved) while Muster was stopped: stored paths follow it.
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HUMAN } from '../core/board.js';
import { gitSync, tempRepo } from '../core/testutil.js';
import { rebase } from './relocate.js';
import { startOrchestrator } from './server.js';
import type { PtyLauncher, PtyProcess } from './terminal.js';

class FakePty implements PtyProcess {
  pid = 7000;
  onData() {}
  private exitCbs: ((e: { exitCode: number }) => void)[] = [];
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

const fwd = (p: string) => p.split(sep).join('/');
const cleanup: string[] = [];
afterAll(() => cleanup.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('rebase', () => {
  it('moves paths under the old root, case-insensitively where the OS is, and ignores others', () => {
    expect(fwd(rebase('/a/old/.muster/worktrees/crew-2', '/a/old', '/a/new')!).endsWith('/new/.muster/worktrees/crew-2')).toBe(true);
    expect(rebase('/a/older/x', '/a/old', '/a/new')).toBeNull();
    expect(rebase('/elsewhere/x', '/a/old', '/a/new')).toBeNull();
  });
});

describe('renamed project folder', () => {
  it('rewrites state paths, repairs the worktree, regenerates agent files and creates nothing at the old path', async () => {
    process.env.MUSTER_NO_NOTIFY = '1';
    const parent = mkdtempSync(join(tmpdir(), 'muster-reloc-'));
    cleanup.push(parent);
    const oldRoot = tempRepo();
    cleanup.push(oldRoot);
    const ui = mkdtempSync(join(tmpdir(), 'muster-ui-'));
    cleanup.push(ui);
    writeFileSync(join(ui, 'index.html'), '<html></html>');
    const start = (repoRoot: string) => startOrchestrator({ repoRoot, port: 0, launcher, uiDir: ui, autoStart: false, log: () => {} });

    const a = await start(oldRoot);
    const crew = await a.agents.create({ role: 'crew', actor: HUMAN });
    const oldWt = crew.worktree;
    expect(existsSync(oldWt)).toBe(true);
    await a.agents.stopAll();
    await a.shutdown();

    const newRoot = join(parent, 'renamed');
    // Windows briefly keeps the folder busy after the last handle closes; the desktop's rename step retries too.
    for (let i = 0; ; i++) {
      try {
        renameSync(oldRoot, newRoot);
        break;
      } catch (e) {
        if (i >= 20) throw e;
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    const logs: string[] = [];
    const b = await startOrchestrator({ repoRoot: newRoot, port: 0, launcher, uiDir: ui, autoStart: false, log: (m) => logs.push(m) });
    try {
      const agent = b.store.state.agents.find((x) => x.id === crew.id)!;
      expect(b.store.state.repoRoot).toBe(newRoot);
      expect(fwd(agent.worktree)).toBe(fwd(join(newRoot, '.muster', 'worktrees', crew.id)));
      expect(b.store.state.agents.find((x) => x.role === 'captain' || x.id === 'captain')?.worktree ?? newRoot).toBe(newRoot);
      expect(gitSync(agent.worktree, 'status', '--porcelain')).toBe('');
      expect(gitSync(newRoot, 'worktree', 'list')).toContain('worktrees');
      const mcp = readFileSync(join(newRoot, '.muster', 'agents', crew.id, 'mcp.json'), 'utf8');
      const oldFwd = fwd(oldRoot);
      for (const f of ['mcp.json', 'settings.json', 'prompt.md']) {
        const text = fwd(readFileSync(join(newRoot, '.muster', 'agents', crew.id, f), 'utf8').split(sep + sep).join('/'));
        expect(text.includes(oldFwd), f).toBe(false);
      }
      expect(mcp.length).toBeGreaterThan(0);
      expect(logs.join('\n')).toMatch(/project folder moved/);
      expect(existsSync(oldRoot)).toBe(false);
      expect(existsSync(oldWt)).toBe(false);
    } finally {
      await b.shutdown();
    }
  });
});
