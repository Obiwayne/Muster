// `muster init`: set up .muster/ in the repo and ignore it in git. Idempotent.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, gitMainRoot } from './context.js';

export interface InitResult {
  root: string;
  created: string[]; // things created or changed (empty = already set up)
}

function gitOk(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function initMuster(cwd: string): InitResult {
  const root = gitMainRoot(cwd);
  if (!root) throw new CliError('Not a git repository. Run `git init` in your project first (Muster works on one git repo).');
  if (gitOk(root, ['rev-parse', '--verify', '--quiet', 'HEAD']) === null) {
    throw new CliError('This repo has no commits yet. Make a first commit (worktrees branch from it), then run muster again.');
  }
  const created: string[] = [];
  const dir = join(root, '.muster');
  for (const sub of ['', 'logs', 'agents', 'worktrees']) {
    const p = join(dir, sub);
    if (!existsSync(p)) {
      mkdirSync(p, { recursive: true });
      created.push(sub ? `.muster/${sub}/` : '.muster/');
    }
  }

  const config = join(dir, 'config.json');
  if (!existsSync(config)) {
    // Only what differs from DEFAULT_CONFIG; everything else stays default.
    const cfg: Record<string, unknown> = {};
    const branch = gitOk(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (branch && branch !== 'main') cfg.baseBranch = branch;
    writeFileSync(config, JSON.stringify(cfg, null, 2) + '\n');
    created.push('.muster/config.json');
  }

  // Ignore .muster/ through .git/info/exclude rather than .gitignore: editing a tracked file would
  // leave the main checkout dirty, and `muster merge` needs a clean tree.
  if (!isIgnored(root, '.gitignore')) {
    const commonDir = gitOk(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']) ?? join(root, '.git');
    const exclude = join(commonDir, 'info', 'exclude');
    mkdirSync(join(commonDir, 'info'), { recursive: true });
    const existing = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (!isIgnoredIn(existing)) {
      const sep = existing && !existing.endsWith('\n') ? '\n' : '';
      writeFileSync(exclude, existing + sep + '.muster/\n');
      created.push('.git/info/exclude (added .muster/)');
    }
  }
  return { root, created };
}

function isIgnoredIn(text: string): boolean {
  return text.split(/\r?\n/).some((l) => /^\/?\.muster\/?\s*$/.test(l.trim()));
}

function isIgnored(root: string, file: string): boolean {
  const p = join(root, file);
  return existsSync(p) && isIgnoredIn(readFileSync(p, 'utf8'));
}
