// Everything needed to launch `claude` for an agent: executable path, config files and argv.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { captainPrompt, crewPrompt, designPrompt, type PromptContext } from '../prompts/index.js';
import type { Agent, MusterConfig, Role } from '../types.js';
import { MUSTER_HOME, posix, type MusterPaths } from './paths.js';

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

/** node-pty spawns executables only; a .cmd/.bat shim has to go through cmd.exe. */
export function spawnCommand(claudePath: string, args: string[]): { file: string; args: string[] } {
  return /\.(cmd|bat)$/i.test(claudePath) ? { file: 'cmd.exe', args: ['/d', '/s', '/c', claudePath, ...args] } : { file: claudePath, args };
}

export function modelFor(role: Role, config: MusterConfig): string {
  return role === 'captain' ? config.captainModel : role === 'design' ? config.designModel : config.crewModel;
}

export interface LaunchContext {
  url: string;
  token: string;
  repoRoot: string;
  config: MusterConfig;
}

export function agentEnv(agent: Agent, ctx: LaunchContext): Record<string, string> {
  return {
    MUSTER_URL: ctx.url,
    MUSTER_TOKEN: ctx.token,
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
  };
  return agent.role === 'captain' ? captainPrompt(p) : agent.role === 'design' ? designPrompt(p) : crewPrompt(p);
}

function vellumServer(config: MusterConfig): MusterConfig['vellum'] {
  if (config.vellum) return config.vellum;
  return existsSync(DEFAULT_VELLUM_ENTRY) ? { command: posix(process.execPath), args: [DEFAULT_VELLUM_ENTRY] } : undefined;
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

export function settingsConfig(config: MusterConfig): object {
  const node = `"${posix(process.execPath)}"`;
  const hook = (event: string) => [{ type: 'command', command: `${node} "${posix(MUSTER_HOME)}/dist/hooks/hook.js" ${event}` }];
  return {
    permissions: { allow: config.allowedTools },
    statusLine: { type: 'command', command: `${node} "${posix(MUSTER_HOME)}/dist/usage/statusline.js"` },
    hooks: {
      PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: hook('pre-tool') }],
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
  writeFileSync(files.settings, JSON.stringify(settingsConfig(ctx.config), null, 2));
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
    ...(opts.inlinePrompt !== undefined ? ['--append-system-prompt', opts.inlinePrompt] : ['--append-system-prompt-file', files.prompt]),
    '--name', `muster ${agent.id}`,
  ];
}
