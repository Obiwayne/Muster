// The git reference-transaction guard, against real git: a repo with crew worktrees and a bundled ref-hook.js.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hooksDir, installRefGuard, parseRefUpdates, REF_GUARD_MARK, refViolation } from './refguard.js';
import { gitSync, tempRepo } from './testutil.js';

let home: string; // stands in for MUSTER_HOME: holds dist/hooks/ref-hook.js
let repo: string;
const wt = (id: string) => join(repo, '.muster', 'worktrees', id);

// A clean env: no Muster identity inherited from whoever runs the tests.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MUSTER_') && !k.startsWith('GIT_'))) as Record<string, string>;
const agentEnv = (id: string) => ({ ...baseEnv, MUSTER_AGENT: id, MUSTER_REPO: repo });

function git(cwd: string, env: Record<string, string>, ...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}
const head = (ref: string) => gitSync(repo, 'rev-parse', ref);
const write = (dir: string, file: string, text: string) => writeFileSync(join(dir, file), text);

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'muster-home-'));
  buildSync({
    entryPoints: [fileURLToPath(new URL('../hooks/ref-hook.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: join(home, 'dist', 'hooks', 'ref-hook.js'),
    logLevel: 'silent',
  });
  repo = tempRepo();
  mkdirSync(join(repo, '.muster', 'worktrees'), { recursive: true });
  writeFileSync(
    join(repo, '.muster', 'state.json'),
    JSON.stringify({ agents: [{ id: 'captain' }, { id: 'crew-2' }, { id: 'crew-3' }] }),
  );
  for (const id of ['crew-2', 'crew-3']) gitSync(repo, 'worktree', 'add', '-q', '-b', `${id}/work`, wt(id), 'main');
  gitSync(repo, 'branch', 'crew-3/spare'); // not checked out anywhere, so only the hook stops a forced update
  gitSync(repo, 'config', 'receive.denyCurrentBranch', 'ignore'); // so git itself doesn't refuse `push . HEAD:main` first
  const r = installRefGuard(repo, { node: process.execPath, musterHome: home });
  expect(r.action).toBe('installed');
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('reference-transaction guard (real git)', () => {
  it('installs idempotently into the shared hooks folder', () => {
    const file = join(hooksDir(repo), 'reference-transaction');
    expect(readFileSync(file, 'utf8')).toContain(REF_GUARD_MARK);
    expect(hooksDir(repo)).toBe(resolve(repo, '.git', 'hooks'));
    // Worktrees share it.
    expect(resolve(wt('crew-2'), gitSync(wt('crew-2'), 'rev-parse', '--path-format=absolute', '--git-path', 'hooks'))).toBe(hooksDir(repo));
    expect(installRefGuard(repo, { node: process.execPath, musterHome: home }).action).toBe('current');
  });

  it('lets crew commit on their own branch', () => {
    write(wt('crew-2'), 'a.txt', 'a');
    expect(git(wt('crew-2'), agentEnv('crew-2'), 'add', 'a.txt').ok).toBe(true);
    const c = git(wt('crew-2'), agentEnv('crew-2'), 'commit', '-q', '-m', 'own work');
    expect(c).toMatchObject({ ok: true });
    expect(head('crew-2/work')).not.toBe(head('main'));
  });

  it('refuses crew updates to main however they are made', () => {
    const main = head('main');
    const env = agentEnv('crew-2');
    const d = wt('crew-2');

    const upd = git(d, env, 'update-ref', 'refs/heads/main', 'HEAD');
    expect(upd.ok).toBe(false);
    expect(upd.out).toMatch(/crew-2 may not update main/);

    const push = git(d, env, 'push', '.', 'HEAD:main');
    expect(push.ok).toBe(false);
    expect(push.out).toMatch(/crew-2 may not update main/);
    expect(git(d, env, 'branch', '-f', 'main', 'HEAD').ok).toBe(false); // (git also refuses: main is checked out)

    // symbolic-ref HEAD refs/heads/main && git commit -am x
    expect(git(d, env, 'symbolic-ref', 'HEAD', 'refs/heads/main').ok).toBe(true); // HEAD itself is per-worktree
    write(d, 'README.md', 'sneaky\n');
    const commit = git(d, env, 'commit', '-q', '-am', 'x');
    expect(commit.ok).toBe(false);
    expect(commit.out).toMatch(/crew-2 may not update main/);
    gitSync(d, 'symbolic-ref', 'HEAD', 'refs/heads/crew-2/work');
    gitSync(d, 'checkout', '--', 'README.md');

    expect(head('main')).toBe(main);
  });

  it("refuses updates to another agent's branches", () => {
    const env = agentEnv('crew-2');
    const theirs = head('crew-3/work');
    const r = git(wt('crew-2'), env, 'update-ref', 'refs/heads/crew-3/work', 'HEAD');
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/belongs to crew-3/);
    const force = git(wt('crew-2'), env, 'branch', '-f', 'crew-3/spare', 'HEAD');
    expect(force.ok).toBe(false);
    expect(force.out).toMatch(/belongs to crew-3/);
    const del = git(wt('crew-2'), env, 'branch', '-D', 'crew-3/spare');
    expect(del.out).toMatch(/belongs to crew-3/);
    expect(gitSync(repo, 'branch', '--list', 'crew-3/spare')).toContain('crew-3/spare');
    expect(git(wt('crew-2'), env, 'push', '.', 'HEAD:refs/heads/crew-3/new').ok).toBe(false);
    expect(head('crew-3/work')).toBe(theirs);
    // A branch of its own namespace is fine.
    expect(git(wt('crew-2'), env, 'branch', 'crew-2/extra').ok).toBe(true);
  });

  it('refuses the Captain moving main (commit, reset)', () => {
    const main = head('main');
    const env = agentEnv('captain');
    write(repo, 'README.md', 'captain edit\n');
    expect(git(repo, env, 'commit', '-q', '-am', 'captain').ok).toBe(false);
    gitSync(repo, 'checkout', '--', 'README.md');
    const reset = git(repo, env, 'reset', '--hard', 'crew-2/work');
    expect(reset.out).toMatch(/captain may not update main/);
    expect(head('main')).toBe(main);
    gitSync(repo, 'reset', '-q', '--hard', 'main'); // reset rewrote the files before its ref update was refused
  });

  it('leaves humans, the orchestrator and other repositories alone', () => {
    write(repo, 'human.txt', 'h');
    gitSync(repo, 'add', 'human.txt');
    expect(git(repo, baseEnv, 'commit', '-q', '-m', 'human commit').ok).toBe(true);
    expect(git(repo, baseEnv, 'update-ref', 'refs/heads/crew-3/work', 'main').ok).toBe(true);
    // An agent running git against some other repo (MUSTER_REPO differs): not our business.
    expect(git(repo, { ...agentEnv('crew-2'), MUSTER_REPO: join(tmpdir(), 'elsewhere') }, 'update-ref', 'refs/heads/main', 'HEAD~1').ok).toBe(true);
    gitSync(repo, 'reset', '-q', '--hard', 'HEAD@{1}');
  });

  it('chains a hook that was there before', () => {
    const other = tempRepo();
    try {
      const dir = hooksDir(other);
      mkdirSync(dir, { recursive: true });
      const marker = join(other, 'chained.log').replace(/\\/g, '/');
      writeFileSync(join(dir, 'reference-transaction'), `#!/bin/sh\ncat >> '${marker}'\necho "$1" >> '${marker}'\n`);
      const r = installRefGuard(other, { node: process.execPath, musterHome: home });
      expect(r).toMatchObject({ action: 'updated', chained: join(dir, 'reference-transaction.pre-muster') });
      gitSync(other, 'branch', 'feature');
      const log = readFileSync(marker, 'utf8');
      expect(log).toContain('refs/heads/feature');
      expect(log).toContain('committed');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('respects core.hooksPath and keeps an in-repo hooks folder out of git status', () => {
    const other = tempRepo();
    try {
      gitSync(other, 'config', 'core.hooksPath', join(other, '.githooks').replace(/\\/g, '/'));
      const r = installRefGuard(other, { node: process.execPath, musterHome: home });
      expect(r.file).toBe(join(other, '.githooks', 'reference-transaction'));
      expect(existsSync(r.file)).toBe(true);
      expect(gitSync(other, 'status', '--porcelain')).toBe('');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('ref decision', () => {
  const z = '0'.repeat(40);
  const a = 'a'.repeat(40);
  it('parses stdin and decides', () => {
    const ups = parseRefUpdates(`${z} ${a} refs/heads/crew-2/x\n${a} ${a} refs/heads/main\n`);
    expect(ups).toHaveLength(2);
    const o = { agent: 'crew-2', baseBranch: 'main', agents: ['captain', 'crew-2', 'crew-22'] };
    expect(refViolation(ups, o)).toBeUndefined(); // own branch; main only verified
    expect(refViolation(parseRefUpdates(`${a} ${z} refs/heads/main`), o)).toMatch(/may not update main/);
    expect(refViolation(parseRefUpdates(`${z} ${z} refs/heads/crew-22/x`), o)).toMatch(/crew-22/); // delete without an old value
    expect(refViolation(parseRefUpdates(`${z} ${a} refs/heads/crew-22/x`), o)).toMatch(/crew-22/);
    expect(refViolation(parseRefUpdates(`${z} ${a} refs/heads/feature/x`), o)).toBeUndefined();
    expect(refViolation(parseRefUpdates(`${z} ${a} refs/tags/v1`), o)).toBeUndefined();
  });
});

