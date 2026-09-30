import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addWorktree, branchExists, cleanMergedWorktrees, commitsAhead, diff, mergeInto, mergeToBase, renameBranch, runTests, slug } from './git.js';
import { commitFile, gitSync, tempRepo } from './testutil.js';

let repo: string;
const wt = (id: string) => join(repo, '.muster', 'worktrees', id);

beforeAll(() => {
  repo = tempRepo();
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('git', () => {
  it('slugs task titles', () => {
    expect(slug('Share dialog: invite by e-mail!')).toBe('share-dialog-invite-by-e-mail');
    expect(slug('***')).toBe('task');
  });

  it('adds a worktree on a new branch and reuses it', async () => {
    expect(await addWorktree(repo, wt('crew-2'), 'crew-2/work', 'main')).toBe('crew-2/work');
    expect(existsSync(join(wt('crew-2'), 'README.md'))).toBe(true);
    expect(await addWorktree(repo, wt('crew-2'), 'crew-2/work', 'main')).toBe('crew-2/work');
    expect(await commitsAhead(repo, 'main', 'crew-2/work')).toBe(0);
  });

  it('renames a fresh branch after its task, avoiding taken names', async () => {
    gitSync(repo, 'branch', 'crew-2/share-dialog');
    const name = await renameBranch(wt('crew-2'), 'crew-2/work', 'crew-2/share-dialog');
    expect(name).toBe('crew-2/share-dialog-2');
    expect(gitSync(wt('crew-2'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(name);
    expect(await branchExists(repo, 'crew-2/work')).toBe(false);
  });

  it('diffs a branch against base', async () => {
    commitFile(wt('crew-2'), 'dialog.ts', 'export const x = 1;\n');
    const d = await diff(repo, 'main', 'crew-2/share-dialog-2');
    expect(d.stat).toMatch(/dialog\.ts/);
    expect(d.diff).toMatch(/\+export const x = 1;/);
    expect(await commitsAhead(repo, 'main', 'crew-2/share-dialog-2')).toBe(1);
  });

  it('merges a sender branch into a receiver worktree, aborting on conflict', async () => {
    await addWorktree(repo, wt('crew-3'), 'crew-3/work', 'main');
    const ok = await mergeInto(wt('crew-3'), 'crew-2/share-dialog-2');
    expect(ok.ok).toBe(true);
    expect(existsSync(join(wt('crew-3'), 'dialog.ts'))).toBe(true);

    commitFile(wt('crew-3'), 'dialog.ts', 'export const x = 3;\n');
    commitFile(wt('crew-2'), 'dialog.ts', 'export const x = 2;\n');
    const bad = await mergeInto(wt('crew-3'), 'crew-2/share-dialog-2');
    expect(bad).toMatchObject({ ok: false, conflicts: ['dialog.ts'] });
    expect(gitSync(wt('crew-3'), 'status', '--porcelain')).toBe('');
  });

  it('merges into base with --no-ff and refuses conflicts', async () => {
    const out = await mergeToBase(repo, 'main', 'crew-2/share-dialog-2', 'Merge crew-2/share-dialog-2 (T1 Share dialog)');
    expect(out).toBeTruthy();
    expect(gitSync(repo, 'log', '-1', '--format=%s')).toBe('Merge crew-2/share-dialog-2 (T1 Share dialog)');
    expect(gitSync(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);

    await expect(mergeToBase(repo, 'main', 'crew-3/work', 'Merge crew-3')).rejects.toMatchObject({ status: 409, message: /conflict in: dialog\.ts/ });
    expect(gitSync(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  });

  it('refuses to merge into a dirty main checkout', async () => {
    commitFile(repo, 'dirty.txt', 'a');
    gitSync(repo, 'rm', '-q', '--cached', 'dirty.txt');
    await expect(mergeToBase(repo, 'main', 'crew-3/work', 'm')).rejects.toMatchObject({ status: 409, message: /uncommitted changes/ });
    gitSync(repo, 'reset', '-q', '--hard');
  });

  it('removes only worktrees whose branch is merged', async () => {
    const removed = await cleanMergedWorktrees(repo, join(repo, '.muster', 'worktrees'), 'main');
    expect(removed.map((p) => p.split('/').pop())).toEqual(['crew-2']);
    expect(existsSync(wt('crew-2'))).toBe(false);
    expect(existsSync(wt('crew-3'))).toBe(true);
    expect(await branchExists(repo, 'crew-2/share-dialog-2')).toBe(false);
  });

  it('runs the test command and keeps the output tail', async () => {
    const r = await runTests(repo, 'node -e "for (let i = 0; i < 300; i++) console.log(\'line \' + i); process.exit(3)"', 30_000, 200);
    expect(r.exitCode).toBe(3);
    const lines = r.output.trim().split(/\r?\n/);
    expect(lines).toHaveLength(200);
    expect(lines.at(-1)).toBe('line 299');
  });
});
