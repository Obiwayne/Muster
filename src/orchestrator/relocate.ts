// A project folder that was renamed or moved: state.json and the agent files still name the old absolute paths.
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { git, normalise } from '../core/git.js';
import type { MusterPaths } from '../core/paths.js';
import type { Store } from '../core/store.js';

/** `p` rewritten from under `from` to under `to`, or null when it is not under `from`. */
export function rebase(p: string, from: string, to: string): string | null {
  const a = normalise(p);
  const b = normalise(from);
  if (a !== b && !a.startsWith(b + '/')) return null;
  return resolve(to, ...p.slice(from.length).split('/').flatMap((x) => x.split(sep)).filter(Boolean));
}

/**
 * If state.json was written for another folder, points repoRoot and every agent worktree under it at the
 * current root. Returns how many agents moved, or null when nothing changed. Touches only state, never the disk.
 */
export function relocateState(store: Store, paths: MusterPaths, log: (msg: string) => void): number | null {
  const from = store.movedFrom;
  if (!from || normalise(from) === normalise(paths.root)) return null;
  let moved = 0;
  for (const a of store.state.agents) {
    const next = rebase(a.worktree, from, paths.root);
    if (next && next !== a.worktree) {
      a.worktree = next;
      moved++;
    }
  }
  store.state.repoRoot = paths.root;
  store.movedFrom = undefined;
  store.commit();
  log(`project folder moved from ${from} to ${paths.root}; rewrote ${moved} agent worktree path${moved === 1 ? '' : 's'}`);
  return moved;
}

/** `git worktree repair` for every crew worktree that exists (idempotent; fixes a folder moved by hand). */
export async function repairWorktrees(store: Store, paths: MusterPaths, log: (msg: string) => void): Promise<void> {
  const dirs = store.state.agents.filter((a) => a.role !== 'captain' && existsSync(a.worktree)).map((a) => a.worktree);
  if (!dirs.length) return;
  const r = await git(paths.root, ['worktree', 'repair', ...dirs], true);
  if (r.code !== 0) log(`git worktree repair failed: ${r.stderr.trim() || r.stdout.trim()}`);
}
