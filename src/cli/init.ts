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

  const gi = join(root, '.gitignore');
  const existing = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  const ignored = existing.split(/\r?\n/).some((l) => /^\/?\.muster\/?\s*$/.test(l.trim()));
  if (!ignored) {
    const sep = existing && !existing.endsWith('\n') ? (existing.includes('\r\n') ? '\r\n' : '\n') : '';
    writeFileSync(gi, existing + sep + '.muster/\n');
    created.push(existing ? '.gitignore (added .muster/)' : '.gitignore');
  }
  return { root, created };
}
