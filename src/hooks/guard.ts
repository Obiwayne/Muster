// Pure PreToolUse decision logic for the muster hook. No I/O in decide() (paths are resolved through
// the injected env.realpath), so it can be unit tested.
//
// This is defence in depth and best effort: a shell is too expressive to police by parsing. The hard
// guarantees come from the git reference-transaction hook (core/refguard.ts: agents can't move the
// base branch or other agents' branches) and the server's token identities (orchestrator/auth.ts).
import { existsSync, realpathSync } from 'node:fs';
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
  agentId?: string; // MUSTER_AGENT
  worktree?: string; // MUSTER_WORKTREE
  repo?: string; // MUSTER_REPO (main checkout; .muster lives here)
  baseBranch?: string; // default "main"
  currentBranch?: string; // branch checked out in the hook's cwd, when known (for `git merge`)
  platform?: NodeJS.Platform; // default process.platform
  /** Folders no agent may read or touch (the human-token folder). */
  secretDirs?: string[];
  /** Maps an absolute path to its real path (junctions and symlinks resolved); see realNearest. */
  realpath?: (p: string) => string;
}

export type Decision = { allow: true } | { allow: false; reason: string };

const ALLOW: Decision = { allow: true };
const deny = (reason: string): Decision => ({ allow: false, reason });

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead']);
export const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/** Claude Code's question menu. decide() allows it; hook.ts sends the Captain's to the board and turns anyone else's away. */
export const ASK_TOOL = 'AskUserQuestion';
export const ASK_NOT_CAPTAIN = "Don't ask the user directly. Use ask_captain(question), or post a question note.";
export const askSentReason = (id: string): string =>
  `Muster sent your question to the user as note ${id} (Bulletin board and phone). Do not ask again and do not wait: carry on with other work or end your turn. The answer reaches your inbox as a reply on ${id}.`;

const GIT_WRITE = new Set([
  'add', 'am', 'apply', 'branch', 'checkout', 'cherry-pick', 'clean', 'commit', 'merge', 'mv', 'pull',
  'push', 'rebase', 'reset', 'restore', 'revert', 'rm', 'stash', 'switch', 'tag', 'worktree',
  'update-ref', 'symbolic-ref', 'config', 'fetch', 'replace', 'notes', 'gc', 'prune',
]);

// Things in a worktree an agent must not edit: git internals, Claude Code project config, Muster's own files.
const PROTECTED_IN_WORKTREE = new Set(['.git', '.claude', '.muster', '.mcp.json']);

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

function under(t: string, r: string): boolean {
  return t === r || t.startsWith(r.endsWith('/') ? r : r + '/');
}

export function isInside(target: string, root: string, base: string, win: boolean): boolean {
  return under(normalizePath(target, base, win), normalizePath(root, root, win));
}

/**
 * Real path of `p`: realpath of its nearest existing ancestor plus the rest. Catches a junction or
 * symlink inside the worktree that points elsewhere (the file itself may not exist yet).
 */
export function realNearest(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    if (existsSync(cur)) {
      try {
        return path.join(realpathSync.native(cur), ...rest.reverse());
      } catch {
        return path.resolve(p);
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    rest.push(path.basename(cur));
    cur = parent;
  }
}

/** Normalised real path (when env.realpath is set) of `p` resolved against `base`. */
function realNorm(p: string, base: string, env: GuardEnv): string {
  const win = isWin(env);
  const n = normalizePath(p, base, win);
  if (!env.realpath) return n;
  try {
    return normalizePath(env.realpath(n), '/', win);
  } catch {
    return n;
  }
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

/** Tokenise one simple command (quotes removed). Leading ( { and trailing ) } of subshells/groups are dropped. */
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
  while (out.length && /^[({]+/.test(out[0])) {
    out[0] = out[0].replace(/^[({]+/, '');
    if (!out[0]) out.shift();
  }
  while (out.length && /[)}]+$/.test(out[out.length - 1])) {
    out[out.length - 1] = out[out.length - 1].replace(/[)}]+$/, '');
    if (!out[out.length - 1]) out.pop();
  }
  return out;
}

interface GitCall {
  sub: string;
  args: string[];
  globals: string[]; // options between `git` and the subcommand
  dir?: string; // from -C
}

const ASSIGN = /^(?:\$env:)?[A-Za-z_][A-Za-z0-9_]*=/;

/** Parse a simple command as a git invocation, or null. Skips env assignments and git global options. */
export function parseGit(tokens: string[]): GitCall | null {
  let i = 0;
  while (i < tokens.length && ASSIGN.test(tokens[i])) i++;
  while (['sudo', 'command', 'exec', 'env', '&', 'time', 'nohup', '!'].includes(tokens[i])) i++;
  while (i < tokens.length && ASSIGN.test(tokens[i])) i++;
  const bin = tokens[i];
  if (!bin || !/(^|[\\/])git(\.exe)?$/i.test(bin)) return null;
  i++;
  let dir: string | undefined;
  const globals: string[] = [];
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const t = tokens[i];
    if (t === '-C') {
      dir = tokens[i + 1];
      i += 2;
    } else if (t === '-c' || t === '--git-dir' || t === '--work-tree' || t === '--namespace' || t === '--exec-path' || t === '--config-env') {
      globals.push(t, tokens[i + 1] ?? '');
      i += 2;
    } else {
      globals.push(t);
      i++;
    }
  }
  const sub = tokens[i];
  if (!sub) return null;
  return { sub, args: tokens.slice(i + 1), globals, dir };
}

/** Contents of $( ... ) and ` ... ` substitutions (one level, best effort). */
function substitutions(cmd: string): string[] {
  const out: string[] = [];
  for (const m of cmd.matchAll(/\$\(([^()]*)\)/g)) out.push(m[1]);
  for (const m of cmd.matchAll(/`([^`]*)`/g)) out.push(m[1]);
  return out;
}

const NESTED_SHELL = /^(?:.*[\\/])?(bash|sh|zsh|dash|ksh|fish|pwsh|powershell|cmd|wsl)(\.exe)?$/i;
const GIT_WORD = /(^|[^\w.-])git(\.exe)?([^\w-]|$)/i;

// ---- shell rules shared by every role ---------------------------------------

function slashLower(s: string): string {
  return s.replace(/\\/g, '/').toLowerCase();
}

// Cookie extraction, browser profiles and driving a browser directly: browsing goes through Muster's
// read-only browse tool (src/browser), whose profile also sits under the secrets base.
const BROWSER_TOOLING = /browser_cookie3|rookiepy|cookie_extract|opera-cookies\.py|opera\W{1,3}software|--remote-debugging|--user-data-dir|launchpersistentcontext|playwright/i;
const BROWSER_DENY = 'Browsing goes through the browse tool: agents may not read browser cookies or profiles, or drive a browser themselves.';

/** Rules that hold for any agent, whatever its role. */
function commonShell(command: string, env: GuardEnv): Decision {
  const lower = slashLower(command);
  for (const d of env.secretDirs ?? []) {
    const n = slashLower(d).replace(/\/+$/, '');
    if (n && lower.includes(n)) return deny("That folder holds the human's Muster token; agents may not touch it.");
  }
  if (/appdata\/local\/muster|localappdata[^\n]*muster|~\/\.muster\b|\$home\/\.muster\b/i.test(lower))
    return deny("That folder holds the human's Muster token; agents may not touch it.");
  if (/\.muster\/agents\b/.test(lower)) return deny("Other agents' Muster config is off limits.");
  if (BROWSER_TOOLING.test(lower)) return deny(BROWSER_DENY);
  if (/\bMUSTER_\w*\s*=|\bunset\b[^;&|\n]*\bMUSTER_|\benv\b[^;&|\n]*\s(-i|-u|--unset|--ignore-environment)\b|Remove-Item\b[^;&|\n]*env:|SetEnvironmentVariable/i.test(command))
    return deny('Agents may not change or clear their Muster environment.');
  if (/(^|[\s;&|(`$])(\$env:)?GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|CONFIG\w*|OBJECT_DIRECTORY)\s*=/i.test(command))
    return deny('Pointing git at another repository or config (GIT_DIR, GIT_WORK_TREE, GIT_CONFIG...) is not allowed.');
  if (/\bmklink\b|-ItemType\s+(Junction|SymbolicLink|HardLink)|\bln\s+(-\w*s|-\w*\s+-s)/i.test(command))
    return deny('Agents may not create links or junctions.');

  for (const inner of substitutions(command)) if (GIT_WORD.test(inner)) return deny('git inside a command substitution is not allowed; run it directly.');

  for (const seg of splitCommands(command)) {
    const tokens = tokenize(seg);
    let i = 0;
    while (i < tokens.length && (ASSIGN.test(tokens[i]) || ['&', 'env', 'exec', 'command', 'nohup', 'time'].includes(tokens[i]))) i++;
    const bin = tokens[i] ?? '';
    if (NESTED_SHELL.test(bin)) {
      const rest = tokens.slice(i + 1);
      if (rest.some((t) => /^-e(nc(odedcommand)?)?$/i.test(t))) return deny('Encoded PowerShell commands are not allowed.');
      if (rest.some((t) => /^(-c|-command|\/c|\/k|\/r|-lc|-ic)$/i.test(t)) && GIT_WORD.test(rest.join(' ')))
        return deny(`Run git directly, not through ${bin} -c: the guard checks git commands.`);
    }
    if (/^(eval|iex|Invoke-Expression)$/i.test(bin) && GIT_WORD.test(tokens.slice(i + 1).join(' ')))
      return deny('Run git directly, not through eval.');
    const git = parseGit(tokens);
    if (!git) continue;
    const { sub, args, globals } = git;
    if (globals.some((g) => /^--(git-dir|work-tree)(=|$)/.test(g))) return deny('git --git-dir/--work-tree is not allowed; work in your own checkout.');
    if (globals.some((g) => /hookspath/i.test(g)) || globals.includes('--config-env')) return deny('Overriding git hooks is not allowed.');
    if (sub === 'update-ref' || sub === 'symbolic-ref') return deny(`git ${sub} is not allowed; use normal commits on your own branch.`);
    if (sub === 'branch' && args.some((a) => a === '-f' || a === '--force' || /^-[a-zA-Z]*[fMC]/.test(a)))
      return deny('Forcing or overwriting branches (branch -f/-M/-C) is not allowed.');
    if (sub === 'config' && /hookspath|alias\./i.test(args.join(' '))) return deny('Changing git hooks or aliases is not allowed.');
    if (sub === 'push' && args.includes('--no-verify')) return deny('git push --no-verify is not allowed.');
  }
  return ALLOW;
}

// ---- decisions -------------------------------------------------------------

function toolPath(input: PreToolInput): string | undefined {
  const ti = input.tool_input ?? {};
  const p = ti.file_path ?? ti.notebook_path ?? ti.path;
  return typeof p === 'string' && p ? p : undefined;
}

/** Reads of the token folder or of other agents' config folders (their tokens are in mcp.json). */
function secretRead(target: string, base: string, env: GuardEnv): Decision {
  const win = isWin(env);
  const t = realNorm(target, base, env);
  for (const d of env.secretDirs ?? []) if (under(t, normalizePath(d, d, win))) return deny("That folder holds the human's Muster token; agents may not read it.");
  if (env.repo) {
    const agents = normalizePath(path.join(env.repo, '.muster', 'agents'), env.repo, win);
    const own = env.agentId ? `${agents}/${win ? env.agentId.toLowerCase() : env.agentId}` : undefined;
    if (under(t, agents) && !(own && under(t, own))) return deny("Other agents' Muster config is off limits.");
  }
  return ALLOW;
}

function crewEdit(target: string, cwd: string, env: GuardEnv): Decision {
  const wt = env.worktree!;
  const t = realNorm(target, cwd, env);
  const root = realNorm(wt, wt, env);
  if (!under(t, root)) return deny(`${target} is outside your worktree (${wt}). Only edit files inside your worktree; message the owning crew instead.`);
  const first = t.slice(root.length).replace(/^\/+/, '').split('/')[0];
  if (PROTECTED_IN_WORKTREE.has(first)) return deny(`${first} is Muster/Claude/git configuration; agents may not edit it.`);
  return ALLOW;
}

function crewShell(command: string, env: GuardEnv, cwd: string): Decision {
  const win = isWin(env);
  const base = env.baseBranch || 'main';
  const wt = env.worktree;
  let dir = cwd;
  for (const seg of splitCommands(command)) {
    const tokens = tokenize(seg);
    if (/^(cd|pushd|chdir|Set-Location|sl|Push-Location)$/i.test(tokens[0] ?? '')) {
      const to = tokens.slice(1).find((t) => !t.startsWith('-'));
      if (to && to !== '-' && !to.startsWith('~')) dir = normalizePath(to, dir, win);
      else if (to?.startsWith('~')) dir = '~';
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
    const gitDir = git.dir ? (dir === '~' ? '~' : normalizePath(git.dir, dir, win)) : dir;
    if (wt && GIT_WRITE.has(sub) && (gitDir === '~' || !isInside(gitDir, wt, gitDir, win)))
      return deny(`git ${sub} outside your worktree (${wt}) is not allowed. Work only in your worktree.`);
  }
  return ALLOW;
}

const CAPTAIN_GIT_DENY: Record<string, string> = {
  merge: 'The Captain never merges: call request_review and the human runs `muster merge`.',
  push: 'The Captain never pushes.',
  commit: "The Captain doesn't commit code: post_task or assign it to crew.",
  pull: 'The Captain never pulls into the base branch; the human does.',
  reset: 'The Captain never resets branches.',
  rebase: 'The Captain never rebases.',
  'cherry-pick': "The Captain doesn't commit code: post_task or assign it to crew.",
  am: "The Captain doesn't commit code: post_task or assign it to crew.",
  revert: "The Captain doesn't commit code: post_task or assign it to crew.",
  worktree: 'Muster owns the worktrees.',
};

function captainShell(command: string): Decision {
  for (const seg of splitCommands(command)) {
    const git = parseGit(tokenize(seg));
    if (!git) continue;
    const why = CAPTAIN_GIT_DENY[git.sub];
    if (why) return deny(why);
    if ((git.sub === 'checkout' && git.args.some((a) => /^-[a-zA-Z]*B/.test(a))) || (git.sub === 'switch' && git.args.some((a) => /^-[a-zA-Z]*C$|^--force-create$/.test(a))))
      return deny('The Captain never resets branches (checkout -B / switch -C).');
    if (git.sub === 'branch' && git.args.some((a) => /^-[a-zA-Z]*[dDmM]/.test(a) || a === '--delete' || a === '--move'))
      return deny('The Captain never deletes or renames branches.');
  }
  return ALLOW;
}

const SCOUT = 'scout researches and never changes code';
const BRANCH_LIST_FLAG = /^(-a|-r|-v|-vv|--all|--remotes|--verbose|--show-current|--contains|--no-contains|--merged|--no-merged|--format=.*|--sort=.*|--color.*|--no-color|--column.*)$/;
// Read-only forms of git subcommands that otherwise write: `git branch` (list), `git stash list`, `git config --get`…
const GIT_READ_FORMS: Record<string, (args: string[]) => boolean> = {
  branch: (a) => a.includes('--list') || a.includes('-l') || a.every((x) => BRANCH_LIST_FLAG.test(x)),
  tag: (a) => a.length === 0 || a.includes('-l') || a.includes('--list'),
  stash: (a) => a[0] === 'list' || a[0] === 'show',
  worktree: (a) => a[0] === 'list',
  config: (a) => a.some((x) => /^(--get(-all|-regexp)?|-l|--list)$/.test(x)),
  notes: (a) => a[0] === 'list' || a[0] === 'show',
};

/** The research agent only reads: every git subcommand that writes is refused; read forms (`git branch`, `git stash list`) pass. */
function researchShell(command: string): Decision {
  for (const seg of splitCommands(command)) {
    const git = parseGit(tokenize(seg));
    if (!git || !GIT_WRITE.has(git.sub) || GIT_READ_FORMS[git.sub]?.(git.args)) continue;
    return deny(`${SCOUT}: git ${git.sub} is not allowed. Read the code and post what you find with add_idea.`);
  }
  return ALLOW;
}

export function decide(input: PreToolInput, env: GuardEnv): Decision {
  const role = env.role;
  const tool = input.tool_name ?? '';
  if (role !== 'captain' && role !== 'crew' && role !== 'design' && role !== 'research' && role !== 'qa') return ALLOW;
  const cwd = input.cwd || env.worktree || process.cwd();

  if (READ_TOOLS.has(tool)) {
    const target = toolPath(input);
    return target ? secretRead(target, cwd, env) : ALLOW;
  }

  if (SHELL_TOOLS.has(tool)) {
    const command = String(input.tool_input?.command ?? '');
    const common = commonShell(command, env);
    if (!common.allow) return common;
    if (role === 'research') return researchShell(command);
    return role === 'captain' ? captainShell(command) : crewShell(command, env, cwd);
  }

  if (EDIT_TOOLS.has(tool)) {
    if (role === 'captain') return deny("The Captain doesn't write code: post_task or assign it to crew");
    if (role === 'qa') return deny('The QA agent reviews, it never edits code: put what to change in the findings of qa_verdict');
    if (role === 'research') return deny(`${SCOUT}: no file edits. Post what you found with add_idea.`);
    const target = toolPath(input);
    if (!target || !env.worktree) return ALLOW;
    return crewEdit(target, cwd, env);
  }
  return ALLOW;
}

/** The JSON Claude Code expects on stdout to deny a PreToolUse call. */
export function denyOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  });
}
