// Everything needed to launch `claude` for an agent: executable path, config files and argv.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { defaultLineName, listLines } from './lines.js';
import { listStations } from './stations.js';
import { captainPrompt, crewPrompt, designPrompt, type PromptContext } from '../prompts/index.js';
import type { Agent, MusterConfig, Role } from '../types.js';
import { MUSTER_HOME, musterPaths, PLUGIN_DIR, posix, type MusterPaths } from './paths.js';
import { deriveAgentToken } from './tokens.js';

const DEFAULT_VELLUM_ENTRY = 'F:/Vellum/mcp/dist/index.js';

function onPath(name: string, pathEnv: string): string | undefined {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir.replace(/^"|"$/g, ''), name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/**
 * config.claudePath, else on Windows the real claude.exe behind the npm `claude.cmd` shim
 * (node-pty cannot run .cmd files directly), else claude.exe on PATH, else "claude".
 */
export function resolveClaudePath(config: Pick<MusterConfig, 'claudePath'>, platform = process.platform, pathEnv = process.env.PATH ?? ''): string {
  if (config.claudePath) return config.claudePath;
  if (platform !== 'win32') return 'claude';
  const shim = onPath('claude.cmd', pathEnv);
  if (shim) {
    const m = /"%dp0%\\?([^"]+?\.exe)"/i.exec(readFileSync(shim, 'utf8'));
    const exe = join(dirname(shim), m ? m[1] : 'node_modules/@anthropic-ai/claude-code/bin/claude.exe');
    if (existsSync(exe)) return exe;
  }
  return onPath('claude.exe', pathEnv) ?? shim ?? 'claude';
}

/** What an npm .cmd shim runs: its exe, or node + a script. undefined when the shim can't be read. */
export function shimTarget(shim: string): { exe: string } | { script: string } | undefined {
  let text: string;
  try {
    text = readFileSync(shim, 'utf8');
  } catch {
    return undefined;
  }
  const exe = /"%~?dp0%?\\?([^"]+?\.exe)"/i.exec(text);
  if (exe && !/(^|[\\/])node\.exe$/i.test(exe[1]) && existsSync(join(dirname(shim), exe[1]))) return { exe: join(dirname(shim), exe[1]) };
  const script = /"%~?dp0%?\\?([^"]+?\.(?:c|m)?js)"/i.exec(text);
  if (script && existsSync(join(dirname(shim), script[1]))) return { script: join(dirname(shim), script[1]) };
  return undefined;
}

/** Quote one argument for cmd.exe (inside `/s /c "..."`). */
function cmdQuote(a: string): string {
  if (/["%^&|<>!\r\n]/.test(a)) throw new Error(`Cannot pass ${JSON.stringify(a.slice(0, 40))} through cmd.exe safely`);
  return a === '' || /[\s,;=()]/.test(a) ? `"${a}"` : a;
}

/**
 * node-pty spawns executables only. A .cmd/.bat shim is resolved to what it runs (claude.exe, or node +
 * cli.js) when possible; otherwise it goes through `cmd.exe /d /s /c "<command line>"`. The whole command
 * line is passed as one pre-quoted string (see ptyArgs), and the role prompt is never passed inline through
 * cmd (only --append-system-prompt-file), since cmd would interpret its text.
 */
export function spawnCommand(claudePath: string, args: string[]): { file: string; args: string[] } {
  if (!/\.(cmd|bat)$/i.test(claudePath)) return { file: claudePath, args };
  const target = shimTarget(claudePath);
  if (target && 'exe' in target) return { file: target.exe, args };
  if (target) return { file: process.execPath, args: [target.script, ...args] };
  const safe: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--append-system-prompt') {
      i++; // dropped: prompt text must not go through cmd.exe
      continue;
    }
    safe.push(args[i]);
  }
  return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${[claudePath, ...safe].map(cmdQuote).join(' ')}"`] };
}

/** The args to hand node-pty: a cmd.exe `/s /c` line goes as one raw command-line string (node-pty would re-escape its quotes). */
export function ptyArgs(file: string, args: string[]): string[] | string {
  if (/(^|[\\/])cmd(\.exe)?$/i.test(file) && args.length === 4 && args[0] === '/d' && args[1] === '/s' && args[2] === '/c') return args.join(' ');
  return args;
}

export function modelFor(role: Role, config: MusterConfig): string {
  return role === 'captain' ? config.captainModel : role === 'design' ? config.designModel : config.crewModel;
}

export interface LaunchContext {
  url: string;
  /** The orchestrator's agent secret: each agent gets deriveAgentToken(token, id), never this value. */
  token: string;
  repoRoot: string;
  config: MusterConfig;
}

export function agentEnv(agent: Agent, ctx: LaunchContext): Record<string, string> {
  return {
    MUSTER_URL: ctx.url,
    MUSTER_TOKEN: deriveAgentToken(ctx.token, agent.id),
    MUSTER_AGENT: agent.id,
    MUSTER_ROLE: agent.role,
    MUSTER_WORKTREE: agent.worktree,
    MUSTER_REPO: ctx.repoRoot,
    MUSTER_BASE_BRANCH: ctx.config.baseBranch,
  };
}

// Markers a parent Claude Code session puts in its children's env. Inherited by an agent they
// would make it a "child session" (e.g. transcript saving off, which breaks --resume).
const PARENT_SESSION_ENV = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(ENTRYPOINT|CHILD_SESSION|SESSION_ID|SESSION_ATTENDED|EXECPATH|MESSAGING_SOCKET|MESSAGING_TOKEN))$/;

/** The full PTY environment: the orchestrator's own env minus Muster and parent-session vars, plus the agent's identity. */
export function ptyEnv(agent: Agent, ctx: LaunchContext, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !k.startsWith('MUSTER_') && !PARENT_SESSION_ENV.test(k)) env[k] = v;
  return { ...env, ...agentEnv(agent, ctx), FORCE_COLOR: '1' };
}

export function rolePrompt(agent: Agent, ctx: LaunchContext): string {
  const p: PromptContext = {
    agentId: agent.id,
    repoRoot: ctx.repoRoot,
    worktree: agent.worktree,
    branch: agent.branch,
    baseBranch: ctx.config.baseBranch,
    testCommand: ctx.config.testCommand,
    projectName: ctx.config.projectName ?? '',
    vellumFile: ctx.config.vellumFile?.trim() || undefined,
    vellumEdit: ctx.config.vellumEdit ?? 'ask',
    requireEvidence: ctx.config.requireEvidence !== false,
    userName: ctx.config.userName,
    stations: agent.role === 'captain' ? listStations(musterPaths(ctx.repoRoot), ctx.config) : undefined,
    lines: agent.role === 'captain' ? listLines(ctx.config) : undefined,
    defaultLine: defaultLineName(ctx.config),
  };
  return agent.role === 'captain' ? captainPrompt(p) : agent.role === 'design' ? designPrompt(p) : crewPrompt(p);
}

export function vellumServer(config: MusterConfig, defaultEntry = DEFAULT_VELLUM_ENTRY): MusterConfig['vellum'] {
  if (config.vellum) return config.vellum;
  return existsSync(defaultEntry) ? { command: posix(process.execPath), args: [defaultEntry] } : undefined;
}

export function mcpConfig(agent: Agent, ctx: LaunchContext): object {
  const env = agentEnv(agent, ctx);
  const servers: Record<string, unknown> = {
    muster: { command: posix(process.execPath), args: [`${posix(MUSTER_HOME)}/dist/mcp/index.js`], env },
  };
  const vellum = agent.role === 'design' ? vellumServer(ctx.config) : undefined;
  if (vellum) servers.vellum = vellum;
  return { mcpServers: servers };
}

/** Tools the guard hook checks (hooks/guard.ts). PowerShell is Claude Code's Windows shell tool. */
export const PRE_TOOL_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|Read|Grep|Glob';

/** Vellum MCP tools that change a design. Denied to the design crew when config.vellumEdit is 'never'. */
export const VELLUM_EDIT_TOOLS = [
  'create_artboard', 'create_file', 'create_page', 'create_tokens', 'delete_nodes', 'duplicate_nodes', 'move_nodes',
  'rename_nodes', 'rename_pages', 'set_text_content', 'set_theme_mode', 'set_tokens', 'update_styles', 'write_html',
  'reply_to_comment_thread', 'set_comment_thread_status',
].map((t) => `mcp__vellum__${t}`);

export function settingsConfig(config: MusterConfig, role?: Agent['role']): object {
  const node = `"${posix(process.execPath)}"`;
  const hook = (event: string) => [{ type: 'command', command: `${node} "${posix(MUSTER_HOME)}/dist/hooks/hook.js" ${event}` }];
  const deny = role === 'design' && config.vellumEdit === 'never' ? VELLUM_EDIT_TOOLS : [];
  return {
    // A user-level "disableAllHooks": true (e.g. to mute sound hooks) would also switch off these hooks and the
    // status line, leaving agents stuck on "starting", never resumable and unguarded. --settings outranks it.
    disableAllHooks: false,
    permissions: { allow: config.allowedTools, ...(deny.length ? { deny } : {}) },
    statusLine: { type: 'command', command: `${node} "${posix(MUSTER_HOME)}/dist/usage/statusline.js"` },
    hooks: {
      PreToolUse: [{ matcher: PRE_TOOL_MATCHER, hooks: hook('pre-tool') }],
      UserPromptSubmit: [{ hooks: hook('prompt') }],
      Stop: [{ hooks: hook('stop') }],
      Notification: [{ hooks: hook('notification') }],
      SessionStart: [{ hooks: hook('session-start') }],
    },
  };
}

export interface AgentFiles {
  mcp: string;
  settings: string;
  prompt: string;
}

export function writeAgentFiles(paths: MusterPaths, agent: Agent, ctx: LaunchContext): AgentFiles {
  const dir = paths.agentDir(agent.id);
  mkdirSync(dir, { recursive: true });
  const files = { mcp: join(dir, 'mcp.json'), settings: join(dir, 'settings.json'), prompt: join(dir, 'prompt.md') };
  writeFileSync(files.mcp, JSON.stringify(mcpConfig(agent, ctx), null, 2));
  writeFileSync(files.settings, JSON.stringify(settingsConfig(ctx.config, agent.role), null, 2));
  writeFileSync(files.prompt, rolePrompt(agent, ctx));
  return files;
}

const TRUST_PROMPT = /trust this folder|do you trust|trust the files/i;
const ARROW_DOWN = '\x1b[B';
const ARROW_UP = '\x1b[A';

/**
 * Keys that accept claude's first-run folder-trust dialog, given the plain-text screen,
 * or undefined while no complete dialog is showing. Newer builds pre-select "No, exit",
 * so the keys move the cursor to the "Yes" option before pressing Enter.
 */
export function trustPromptKeys(screen: string): string | undefined {
  if (!TRUST_PROMPT.test(screen) || !/enter to confirm/i.test(screen)) return undefined;
  const options = screen
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(?:[❯>]\s*)?(?:\d+\.\s*)?(?:yes|no)\b/i.test(l));
  const target = options.findIndex((l) => /^(?:[❯>]\s*)?(?:\d+\.\s*)?yes\b/i.test(l));
  if (target < 0) return undefined;
  const selected = Math.max(0, options.findIndex((l) => /^[❯>]/.test(l)));
  const move = target > selected ? ARROW_DOWN.repeat(target - selected) : ARROW_UP.repeat(selected - target);
  return move + '\r';
}

export interface LaunchOptions {
  retried?: boolean; // already retried once after a launch error (no loops)
  resume: boolean;
  /** Pass the prompt text inline instead of --append-system-prompt-file. */
  inlinePrompt?: string;
}

export function launchArgs(agent: Agent, config: MusterConfig, files: AgentFiles, opts: LaunchOptions): string[] {
  return [
    ...(opts.resume ? ['--resume', agent.sessionId] : ['--session-id', agent.sessionId]),
    '--model', agent.model,
    '--permission-mode', config.permissionMode,
    '--mcp-config', files.mcp,
    '--settings', files.settings,
    // Only user settings files (plus --settings above): a project's .claude/settings(.local).json in the
    // worktree can't loosen the agent's permissions or drop its hooks.
    '--setting-sources', 'user',
    // Muster's skills (evidence, before/after, code structure, unslop) as muster:<name>, for agents only.
    ...(existsSync(PLUGIN_DIR) ? ['--plugin-dir', PLUGIN_DIR] : []),
    ...(opts.inlinePrompt !== undefined ? ['--append-system-prompt', opts.inlinePrompt] : ['--append-system-prompt-file', files.prompt]),
    '--name', `muster ${agent.id}`,
  ];
}
