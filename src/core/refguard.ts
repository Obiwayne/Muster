// Git-level enforcement: a `reference-transaction` hook in the repo's shared hooks folder refuses ref
// updates made by Muster agents (MUSTER_AGENT set) to the base branch or to other agents' branches.
// It is what actually holds when the PreToolUse guard is bypassed (`bash -c`, env tricks, scripts):
// every ref write (commit, merge, reset, update-ref, branch -f, `push .`) goes through a transaction.
// The orchestrator's own git calls (merge, worktree setup, handoff merges) run without MUSTER_AGENT.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { posix } from './paths.js';

export const REF_GUARD_MARK = 'muster-ref-guard';
export const REF_GUARD_VERSION = 1;
export const HOOK_NAME = 'reference-transaction';
export const CHAINED_SUFFIX = '.pre-muster';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** The hooks folder git uses for this repo: core.hooksPath when set, else <common-dir>/hooks. */
export function hooksDir(repoRoot: string): string {
  return resolve(repoRoot, git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']));
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function refGuardScript(o: { node: string; musterHome: string; repoRoot: string; chained: string }): string {
  return [
    '#!/bin/sh',
    `# ${REF_GUARD_MARK} v${REF_GUARD_VERSION}: installed by Muster. Refuses ref updates by Muster agents`,
    '# (MUSTER_AGENT set) to the base branch or to other agents\' branches; a no-op for everyone else.',
    `# Any hook that was here before runs afterwards: ${HOOK_NAME}${CHAINED_SUFFIX}. Muster reinstalls this on start.`,
    'input=$(cat)',
    'if [ -n "$MUSTER_AGENT" ] && [ "$1" = prepared ]; then',
    `  printf '%s\\n' "$input" | ${shq(posix(o.node))} ${shq(`${posix(o.musterHome)}/dist/hooks/ref-hook.js`)} "$1" ${shq(posix(o.repoRoot))} || exit 1`,
    'fi',
    `chained=${shq(posix(o.chained))}`,
    'if [ -f "$chained" ]; then',
    '  if [ -n "$input" ]; then printf \'%s\\n\' "$input"; fi | "$chained" "$@" || exit $?',
    'fi',
    'exit 0',
    '',
  ].join('\n');
}

export interface InstallResult {
  action: 'installed' | 'updated' | 'current';
  file: string;
  chained?: string;
  warning?: string;
}

/** Installs or upgrades the hook (idempotent). A foreign hook already there is kept and chained. */
export function installRefGuard(repoRoot: string, o: { node: string; musterHome: string }): InstallResult {
  const root = resolve(repoRoot);
  const dir = hooksDir(root);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, HOOK_NAME);
  const chained = file + CHAINED_SUFFIX;
  const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  if (current !== undefined && !current.includes(REF_GUARD_MARK)) {
    if (existsSync(chained)) throw new Error(`${file} is not Muster's and ${chained} already exists; merge them by hand`);
    renameSync(file, chained);
  }
  const script = refGuardScript({ node: o.node, musterHome: o.musterHome, repoRoot: root, chained });
  const result: InstallResult = { action: current === undefined ? 'installed' : current === script ? 'current' : 'updated', file };
  if (existsSync(chained)) result.chained = chained;
  if (result.action !== 'current') writeFileSync(file, script, { mode: 0o755 });

  // A hooks folder inside the checkout (core.hooksPath=.githooks): keep our file out of `git status`.
  const rel = relative(root, dir);
  if (rel && !rel.startsWith('..') && !/^[a-zA-Z]:/.test(rel)) {
    const exclude = resolve(root, git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']));
    const line = posix(join(rel, HOOK_NAME));
    const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (!text.split(/\r?\n/).includes(line)) {
      mkdirSync(resolve(exclude, '..'), { recursive: true });
      appendFileSync(exclude, (text && !text.endsWith('\n') ? '\n' : '') + line + '\n');
    }
    // A relative hooksPath resolves per worktree, so crew worktrees would not see this copy.
    let hooksPath = '';
    try {
      hooksPath = git(root, ['config', '--get', 'core.hooksPath']);
    } catch {
      /* unset */
    }
    if (hooksPath && !/^([a-zA-Z]:)?[\\/]/.test(hooksPath))
      result.warning = `core.hooksPath "${hooksPath}" is relative; crew worktrees resolve it in their own checkout, where this hook is missing`;
  }
  return result;
}

// ---- the decision (used by dist/hooks/ref-hook.js) -------------------------

export interface RefUpdate {
  oldValue: string;
  newValue: string;
  ref: string;
}

export function parseRefUpdates(stdin: string): RefUpdate[] {
  const out: RefUpdate[] = [];
  for (const line of stdin.split(/\r?\n/)) {
    const m = /^(\S+) (\S+) (.+)$/.exec(line.trim());
    if (m) out.push({ oldValue: m[1], newValue: m[2], ref: m[3] });
  }
  return out;
}

/** Why `agent` may not make these ref updates, or undefined when it may. */
export function refViolation(updates: RefUpdate[], o: { agent: string; baseBranch: string; agents: string[] }): string | undefined {
  const others = o.agents.filter((a) => a && a !== o.agent);
  for (const u of updates) {
    // old == new is a verify, not a change, unless both are zero: a delete that didn't state the old value.
    if (u.oldValue === u.newValue && !/^0+$/.test(u.newValue)) continue;
    if (u.ref === `refs/heads/${o.baseBranch}`) return `Muster: ${o.agent} may not update ${o.baseBranch}; only the human merges (muster merge).`;
    const other = others.find((a) => u.ref === `refs/heads/${a}` || u.ref.startsWith(`refs/heads/${a}/`));
    if (other) return `Muster: ${o.agent} may not update ${u.ref}, which belongs to ${other}. Message ${other} instead.`;
  }
  return undefined;
}

/** Agent ids known for a repo: state.json agents plus worktree folders. */
export function knownAgents(repoRoot: string): string[] {
  const ids = new Set<string>(['captain']);
  try {
    const state = JSON.parse(readFileSync(join(repoRoot, '.muster', 'state.json'), 'utf8')) as { agents?: { id?: unknown }[] };
    for (const a of state.agents ?? []) if (typeof a.id === 'string') ids.add(a.id);
  } catch {
    /* no state yet */
  }
  try {
    for (const d of readdirSync(join(repoRoot, '.muster', 'worktrees'))) ids.add(d);
  } catch {
    /* none */
  }
  return [...ids];
}

export function configuredBaseBranch(repoRoot: string): string {
  try {
    const cfg = JSON.parse(readFileSync(join(repoRoot, '.muster', 'config.json'), 'utf8'));
    if (typeof cfg.baseBranch === 'string' && cfg.baseBranch) return cfg.baseBranch;
  } catch {
    /* default */
  }
  return 'main';
}
