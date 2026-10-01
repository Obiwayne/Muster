// `--create`: turn any folder into a repo Muster can work in (git init, .gitignore, first commit). Never nests a repo.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export const DEFAULT_GITIGNORE = 'node_modules\ndist\n.env\n.muster/\n';
export const WARN_FILES = 5000;
export const WARN_BYTES = 200 * 1024 * 1024;

const run = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).trim();
const tryRun = (cwd: string, args: string[]): string | null => {
  try {
    return run(cwd, args);
  } catch {
    return null;
  }
};

export type FolderState = 'ready' | 'no-commits' | 'not-a-repo';

export interface FolderInspection {
  state: FolderState;
  /** The folder that would be (or is) the repo root: the repo top for a subfolder, else the folder itself. */
  root: string;
  /** Files Muster would commit (not counting ignored ones); 0 when ready. */
  files: number;
  bytes: number;
  large: boolean;
}

const toplevel = (dir: string): string | null => {
  const top = tryRun(dir, ['rev-parse', '--show-toplevel']);
  return top ? resolve(top) : null;
};
const hasCommit = (root: string) => tryRun(root, ['rev-parse', '--verify', '--quiet', 'HEAD']) !== null;

export function inspectFolder(dir: string): FolderInspection {
  dir = resolve(dir);
  const top = toplevel(dir);
  if (top && hasCommit(top)) return { state: 'ready', root: top, files: 0, bytes: 0, large: false };
  const root = top ?? dir;
  const state: FolderState = top ? 'no-commits' : 'not-a-repo';
  let list: string[];
  if (top) {
    list = run(root, ['ls-files', '-z', '--others', '--cached', '--exclude-standard']).split('\0').filter(Boolean);
  } else {
    // Ask git against a throwaway git dir so an existing .gitignore (or the defaults we'd write) is honoured.
    const tmp = mkdtempSync(join(tmpdir(), 'muster-inspect-'));
    try {
      const gd = join(tmp, 'g');
      run(tmp, ['init', '-q', '--bare', gd]);
      const ex = join(tmp, 'exclude');
      writeFileSync(ex, existsSync(join(root, '.gitignore')) ? '' : DEFAULT_GITIGNORE);
      list = run(root, ['--git-dir', gd, '--work-tree', root, '-c', `core.excludesFile=${ex}`, 'ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  let bytes = 0;
  for (const f of list) {
    try {
      bytes += statSync(join(root, f)).size;
    } catch {
      /* vanished */
    }
  }
  return { state, root, files: list.length, bytes, large: list.length > WARN_FILES || bytes > WARN_BYTES };
}

const gitConfigured = (cwd: string, key: string) => !!tryRun(cwd, ['config', key]);

/** Make `dir` a repo with a first commit if it isn't one. Returns what it did (empty = nothing to do). */
export function prepareRepo(dir: string): { root: string; did: string[] } {
  dir = resolve(dir);
  const top = toplevel(dir);
  if (top && hasCommit(top)) return { root: top, did: [] };
  const root = top ?? dir;
  const did: string[] = [];
  if (!top) {
    run(root, ['init', '-q', '-b', 'main']);
    did.push('git init');
  }
  if (!readdirSync(root).some((f) => f !== '.git' && f !== '.muster')) {
    writeFileSync(join(root, 'README.md'), `# ${basename(root)}\n`);
    did.push('README.md');
  }
  if (!existsSync(join(root, '.gitignore'))) {
    writeFileSync(join(root, '.gitignore'), DEFAULT_GITIGNORE);
    did.push('.gitignore');
  }
  run(root, ['add', '-A']);
  // The person's git identity; a placeholder for this one commit only (never global config).
  const fallback = gitConfigured(root, 'user.name') && gitConfigured(root, 'user.email') ? [] : ['-c', 'user.name=Muster', '-c', 'user.email=muster@localhost'];
  run(root, [...fallback, 'commit', '-q', '--allow-empty', '-m', 'Initial commit (set up by Muster)']);
  did.push('first commit');
  return { root, did };
}
