// Pure PreToolUse decision logic for the muster hook. No I/O here, so it can be unit tested.
import path from 'node:path';

export interface PreToolInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  session_id?: string;
}

export interface GuardEnv {
  role?: string; // MUSTER_ROLE; missing/unknown = not a muster agent, allow everything
  worktree?: string; // MUSTER_WORKTREE
  baseBranch?: string; // default "main"
  currentBranch?: string; // branch checked out in the hook's cwd, when known (for `git merge`)
  platform?: NodeJS.Platform; // default process.platform
}

export type Decision = { allow: true } | { allow: false; reason: string };

const ALLOW: Decision = { allow: true };
const deny = (reason: string): Decision => ({ allow: false, reason });

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const GIT_WRITE = new Set([
  'add', 'am', 'apply', 'branch', 'checkout', 'cherry-pick', 'clean', 'commit', 'merge', 'mv', 'pull',
  'push', 'rebase', 'reset', 'restore', 'revert', 'rm', 'stash', 'switch', 'tag', 'worktree',
]);

// ---- paths ----------------------------------------------------------------

function isWin(env: GuardEnv): boolean {
  return (env.platform ?? process.platform) === 'win32';
}

/** Resolve `p` against `base` and normalise it for comparison (forward slashes; lower case on Windows). */
export function normalizePath(p: string, base: string, win: boolean): string {
  if (win) {
    // Git Bash / MSYS style "/f/Muster/x" -> "f:/Muster/x"
    const fix = (s: string) => s.replace(/^\/([a-zA-Z])(\/|$)/, '$1:/');
    const resolved = path.win32.resolve(fix(base), fix(p));
    return resolved.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }
  return path.posix.resolve(base, p).replace(/\/+$/, '') || '/';
}

export function isInside(target: string, root: string, base: string, win: boolean): boolean {
  const t = normalizePath(target, base, win);
  const r = normalizePath(root, root, win);
  return t === r || t.startsWith(r.endsWith('/') ? r : r + '/');
}

// ---- shell parsing (best effort) --------------------------------------------

/** Split a shell command line into simple commands on ;, &&, ||, |, & and newlines (quote aware). */
export function splitCommands(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < cmd.length) {
        cur += c + cmd[++i];
        continue;
      }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '&' && (cmd[i - 1] === '>' || cmd[i - 1] === '<' || cmd[i + 1] === '>')) {
      cur += c; // redirection like 2>&1 or &>file
      continue;
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      if ((c === '|' || c === '&') && cmd[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Tokenise one simple command (quotes removed). */
export function tokenize(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}

interface GitCall {
  sub: string;
  args: string[];
  dir?: string; // from -C
}

/** Parse a simple command as a git invocation, or null. Skips env assignments and git global options. */
export function parseGit(tokens: string[]): GitCall | null {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (tokens[i] === 'sudo' || tokens[i] === 'command' || tokens[i] === 'exec') i++;
  const bin = tokens[i];
  if (!bin || !/(^|[\\/])git(\.exe)?$/i.test(bin)) return null;
  i++;
  let dir: string | undefined;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const t = tokens[i];
    if (t === '-C') {
      dir = tokens[i + 1];
      i += 2;
    } else if (t === '-c' || t === '--git-dir' || t === '--work-tree' || t === '--namespace') {
      i += 2;
    } else i++;
  }
  const sub = tokens[i];
  if (!sub) return null;
  return { sub, args: tokens.slice(i + 1), dir };
}

// ---- decisions -------------------------------------------------------------

function editTarget(input: PreToolInput): string | undefined {
  const ti = input.tool_input ?? {};
  const p = ti.file_path ?? ti.notebook_path ?? ti.path;
  return typeof p === 'string' && p ? p : undefined;
}

function crewBash(command: string, env: GuardEnv, cwd: string): Decision {
  const win = isWin(env);
  const base = env.baseBranch || 'main';
  const wt = env.worktree;
  let dir = cwd;
  for (const seg of splitCommands(command)) {
    const tokens = tokenize(seg);
    if (tokens[0] === 'cd' || tokens[0] === 'pushd' || tokens[0] === 'Set-Location') {
      const to = tokens[1];
      if (to && to !== '-' && !to.startsWith('~')) dir = normalizePath(to, dir, win);
      continue;
    }
    const git = parseGit(tokens);
    if (!git) continue;
    const { sub, args } = git;
    const positional = args.filter((a) => !a.startsWith('-'));
    if (sub === 'push') return deny('Crew never push. Commit on your branch, then handoff or report_done; the human merges.');
    if (sub === 'worktree') return deny('Crew must not manage worktrees; Muster owns them.');
    if (sub === 'branch' && args.some((a) => a === '-D' || (a === '--delete' && args.includes('--force')) || /^-[a-zA-Z]*D/.test(a)))
      return deny('Crew must not force-delete branches.');
    if ((sub === 'checkout' || sub === 'switch') && !args.includes('--') && positional[0] === base)
      return deny(`Crew never check out ${base}. Stay on your own branch in your worktree.`);
    if (sub === 'merge' && env.currentBranch && env.currentBranch === base)
      return deny(`Crew never merge into ${base}; only the human merges after review.`);
    const gitDir = git.dir ? normalizePath(git.dir, dir, win) : dir;
    if (wt && GIT_WRITE.has(sub) && !isInside(gitDir, wt, gitDir, win))
      return deny(`git ${sub} outside your worktree (${wt}) is not allowed. Work only in your worktree.`);
  }
  return ALLOW;
}

function captainBash(command: string): Decision {
  for (const seg of splitCommands(command)) {
    const git = parseGit(tokenize(seg));
    if (!git) continue;
    if (git.sub === 'merge') return deny('The Captain never merges: call request_review and the human runs `muster merge`.');
    if (git.sub === 'push') return deny('The Captain never pushes.');
    if (git.sub === 'commit') return deny("The Captain doesn't commit code: post_task or assign it to crew.");
  }
  return ALLOW;
}

export function decide(input: PreToolInput, env: GuardEnv): Decision {
  const role = env.role;
  const tool = input.tool_name ?? '';
  if (role !== 'captain' && role !== 'crew' && role !== 'design') return ALLOW;

  if (role === 'captain') {
    if (EDIT_TOOLS.has(tool)) return deny("The Captain doesn't write code: post_task or assign it to crew");
    if (tool === 'Bash') return captainBash(String(input.tool_input?.command ?? ''));
    return ALLOW;
  }

  // crew / design
  const cwd = input.cwd || env.worktree || process.cwd();
  if (EDIT_TOOLS.has(tool)) {
    const target = editTarget(input);
    if (!target || !env.worktree) return ALLOW;
    if (!isInside(target, env.worktree, cwd, isWin(env)))
      return deny(`${target} is outside your worktree (${env.worktree}). Only edit files inside your worktree; message the owning crew instead.`);
    return ALLOW;
  }
  if (tool === 'Bash') return crewBash(String(input.tool_input?.command ?? ''), env, cwd);
  return ALLOW;
}

/** The JSON Claude Code expects on stdout to deny a PreToolUse call. */
export function denyOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  });
}
