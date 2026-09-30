// Git operations: worktrees, branches, diffs, tests and merges. Always execFile, never a shell string.
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { conflict } from './errors.js';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function git(cwd: string, args: string[], allowFail = false): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const exit = (err as { code?: unknown } | null)?.code;
      const code = !err ? 0 : typeof exit === 'number' ? exit : 1;
      const result = { code, stdout: String(stdout), stderr: String(stderr) };
      if (code !== 0 && !allowFail) reject(new Error(`git ${args.join(' ')} failed: ${(stderr || stdout || String(err)).trim()}`));
      else resolvePromise(result);
    });
  });
}

const out = async (cwd: string, args: string[]) => (await git(cwd, args)).stdout.trim();

export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'task'
  );
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], true)).code === 0;
}

export async function currentBranch(cwd: string): Promise<string> {
  return out(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

/** The commit a ref (branch, tag or sha) points at, or undefined when it doesn't resolve. */
export async function revParse(cwd: string, ref: string): Promise<string | undefined> {
  if (!ref || ref.startsWith('-')) return undefined;
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], true);
  return r.code === 0 ? r.stdout.trim() || undefined : undefined;
}

/** True when `ancestor` is reachable from `descendant` (a commit contains itself). */
export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], true)).code === 0;
}

/** Tracked files with uncommitted changes in `worktree` (empty = clean). Untracked files are ignored. */
export async function uncommittedChanges(worktree: string): Promise<string[]> {
  // not out(): trimming would eat the leading space of the first ' M file' line
  return (await git(worktree, ['status', '--porcelain', '--untracked-files=no'])).stdout.split(/\r?\n/).filter(Boolean);
}

/** A branch name not taken yet: `name`, else `name-2`, `name-3`... */
export async function freeBranchName(cwd: string, name: string): Promise<string> {
  let candidate = name;
  for (let i = 2; await branchExists(cwd, candidate); i++) candidate = `${name}-${i}`;
  return candidate;
}

/** Switches `worktree` to a new branch started from `base`. Returns the (possibly suffixed) name. */
export async function createBranch(worktree: string, name: string, base: string): Promise<string> {
  const branch = await freeBranchName(worktree, name);
  await git(worktree, ['switch', '-c', branch, base]);
  return branch;
}

/** Fast-forwards the checked-out branch to `base` when possible; returns whether it moved or was already there. */
export async function fastForward(worktree: string, base: string): Promise<boolean> {
  return (await git(worktree, ['merge', '--ff-only', '--quiet', base], true)).code === 0;
}

/** Paths git reports as worktrees of this repo, normalised for comparison. */
async function worktreePaths(repoRoot: string): Promise<Map<string, string | undefined>> {
  const text = await out(repoRoot, ['worktree', 'list', '--porcelain']);
  const map = new Map<string, string | undefined>();
  let path: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      path = normalise(line.slice(9));
      map.set(path, undefined);
    } else if (line.startsWith('branch ') && path) {
      map.set(path, line.slice(7).replace(/^refs\/heads\//, ''));
    }
  }
  return map;
}

export const normalise = (p: string) => resolve(p).replace(/\\/g, '/').toLowerCase();

/** Creates (or reuses) a worktree at `path` on `branch`, branching from `base` when the branch is new. Returns the branch checked out. */
export async function addWorktree(repoRoot: string, path: string, branch: string, base: string): Promise<string> {
  const known = await worktreePaths(repoRoot);
  if (known.has(normalise(path)) && existsSync(path)) return known.get(normalise(path)) ?? (await currentBranch(path));
  await git(repoRoot, ['worktree', 'prune'], true);
  if (await branchExists(repoRoot, branch)) await git(repoRoot, ['worktree', 'add', path, branch]);
  else await git(repoRoot, ['worktree', 'add', '-b', branch, path, base]);
  return branch;
}

export async function commitsAhead(cwd: string, base: string, branch: string): Promise<number> {
  const r = await git(cwd, ['rev-list', '--count', `${base}..${branch}`], true);
  return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
}

/** Renames the branch checked out in `worktree`; picks a free name by suffixing -2, -3... */
export async function renameBranch(worktree: string, from: string, to: string): Promise<string> {
  const name = await freeBranchName(worktree, to);
  await git(worktree, ['branch', '-m', from, name]);
  return name;
}

export async function diff(repoRoot: string, base: string, branch: string): Promise<{ stat: string; diff: string }> {
  const range = `${base}...${branch}`;
  const [stat, full] = await Promise.all([out(repoRoot, ['diff', '--stat', range]), git(repoRoot, ['diff', range])]);
  return { stat, diff: full.stdout };
}

/**
 * Merges `ref` (a branch or commit) into whatever `worktree` has checked out.
 * Aborts and reports conflicts instead of leaving a half merge.
 */
export async function mergeInto(worktree: string, ref: string, message?: string): Promise<{ ok: boolean; conflicts: string[]; output: string }> {
  const r = await git(worktree, ['merge', '--no-edit', ...(message ? ['-m', message] : []), ref], true);
  if (r.code === 0) return { ok: true, conflicts: [], output: r.stdout.trim() };
  const conflicts = (await git(worktree, ['diff', '--name-only', '--diff-filter=U'], true)).stdout.split(/\r?\n/).filter(Boolean);
  await git(worktree, ['merge', '--abort'], true);
  return { ok: false, conflicts, output: (r.stdout + r.stderr).trim() };
}

/**
 * `git merge --no-ff` of `ref` (a branch, or the exact commit that was reviewed) into `base` in the main checkout.
 * Throws 409 on a dirty tree or conflicts.
 */
export async function mergeToBase(repoRoot: string, base: string, ref: string, message: string): Promise<string> {
  const dirty = await out(repoRoot, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) throw conflict(`The main checkout has uncommitted changes:\n${dirty}`);
  if (!(await revParse(repoRoot, ref))) throw conflict(`${/^[0-9a-f]{40}$/.test(ref) ? 'Commit' : 'Branch'} ${ref} does not exist`);
  await git(repoRoot, ['checkout', base]);
  const r = await git(repoRoot, ['merge', '--no-ff', ref, '-m', message], true);
  if (r.code === 0) return (r.stdout + r.stderr).trim();
  const conflicts = (await git(repoRoot, ['diff', '--name-only', '--diff-filter=U'], true)).stdout.split(/\r?\n/).filter(Boolean);
  await git(repoRoot, ['merge', '--abort'], true);
  throw conflict(conflicts.length ? `Merge conflict in: ${conflicts.join(', ')}` : `Merge failed: ${(r.stderr || r.stdout).trim()}`);
}

export async function isMerged(repoRoot: string, branch: string, base: string): Promise<boolean> {
  return (await git(repoRoot, ['merge-base', '--is-ancestor', branch, base], true)).code === 0;
}

/** Worktree paths of the agents recorded in `.muster/state.json` (the folder above `worktreesDir`). */
function registeredWorktrees(worktreesDir: string): Set<string> {
  try {
    const state = JSON.parse(readFileSync(join(dirname(worktreesDir), 'state.json'), 'utf8')) as { agents?: { worktree?: string }[] };
    return new Set((state.agents ?? []).flatMap((a) => (a.worktree ? [normalise(a.worktree)] : [])));
  } catch {
    return new Set();
  }
}

export interface CleanOptions {
  /**
   * Decides per worktree whether it may go. Default: only worktrees no registered agent uses
   * (agents are read from .muster/state.json), so a clean never pulls a folder from under a live agent.
   */
  mayRemove?: (path: string, branch: string) => boolean;
}

/** Removes worktrees under `worktreesDir` whose branch is merged into base, then deletes the branch. Returns removed paths. */
export async function cleanMergedWorktrees(repoRoot: string, worktreesDir: string, base: string, opts: CleanOptions = {}): Promise<string[]> {
  const prefix = normalise(worktreesDir) + '/';
  const registered = opts.mayRemove ? undefined : registeredWorktrees(worktreesDir);
  const mayRemove = opts.mayRemove ?? ((path: string) => !registered!.has(normalise(path)));
  const removed: string[] = [];
  for (const [path, branch] of await worktreePaths(repoRoot)) {
    if (!path.startsWith(prefix) || !branch || !mayRemove(path, branch) || !(await isMerged(repoRoot, branch, base))) continue;
    const r = await git(repoRoot, ['worktree', 'remove', path], true);
    if (r.code !== 0) continue;
    await git(repoRoot, ['branch', '-d', branch], true);
    removed.push(path);
  }
  return removed;
}

export async function removeWorktree(repoRoot: string, path: string): Promise<void> {
  await git(repoRoot, ['worktree', 'remove', '--force', path], true);
}

export interface TestRun {
  command: string;
  exitCode: number;
  output: string;
}

/** Runs the configured test command (a shell string by design) in `cwd`, keeping the last `tailLines` lines. */
export function runTests(cwd: string, command: string, timeoutMs = 10 * 60_000, tailLines = 200): Promise<TestRun> {
  return new Promise((done) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString();
      if (buf.length > 2_000_000) buf = buf.slice(-1_000_000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    const finish = (exitCode: number) => {
      clearTimeout(timer);
      const tail = buf.trimEnd().split(/\r?\n/).slice(-tailLines).join('\n');
      done({ command, exitCode, output: timedOut ? `${tail}\n[muster] timed out after ${Math.round(timeoutMs / 1000)} s` : tail });
    };
    child.on('error', (e) => {
      buf += String(e);
      finish(127);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
  else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
