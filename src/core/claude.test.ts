import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../types.js';
import { stripAnsi } from '../orchestrator/terminal.js';
import { launchArgs, ptyEnv, resolveClaudePath, spawnCommand, trustPromptKeys, writeAgentFiles } from './claude.js';
import { musterPaths } from './paths.js';
import { makeAgent } from './testutil.js';

// Raw ConPTY output of claude 2.1's first-run trust dialog (colours trimmed).
const TRUST_SCREEN =
  '\x1b[?25l\x1b[2J\x1b[m\x1b[H\x1b]0;claude\x07\x1b[?25h\r\n' +
  '\x1b[1m\x1b[3;2HAccessing\x1b[1Cworkspace:\x1b[m\x1b[7;2HQuick\x1b[1Csafety\x1b[1Ccheck:\x1b[1CIs\x1b[1Cthis\x1b[1Ca\x1b[1Cproject\x1b[1Cyou\x1b[1Ccreated\x1b[1Cor\x1b[1Cone\x1b[1Cyou\x1b[1Ctrust?' +
  '\x1b[10;2HClaude\x1b[1CCode\x27ll\x1b[1Cbe\x1b[1Cable\x1b[1Cto\x1b[1Cread,\x1b[1Cedit,\x1b[1Cand\x1b[1Cexecute\x1b[1Cfiles\x1b[1Chere.' +
  '\x1b[14;2H❯\x1b[1CNo,\x1b[1Cexit\x1b[m\x1b[15;4HYes,\x1b[1CI\x1b[1Ctrust\x1b[1Cthis\x1b[1Cfolder\x1b[17;2HEnter\x1b[1Cto\x1b[1Cconfirm\x1b[1C·\x1b[1CEsc\x1b[1Cto\x1b[1Ccancel';

describe('trust prompt', () => {
  it('moves to "Yes" when "No, exit" is pre-selected', () => {
    const screen = stripAnsi(TRUST_SCREEN);
    expect(screen).toContain('Yes, I trust this folder');
    expect(trustPromptKeys(screen)).toBe('\x1b[B\r');
  });

  it('just presses Enter when "Yes" is already selected, and waits for a complete dialog', () => {
    expect(trustPromptKeys('Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit\nEnter to confirm')).toBe('\r');
    expect(trustPromptKeys('Do you trust the files in this folder?\n❯ 1. Yes, proceed')).toBeUndefined();
    expect(trustPromptKeys('Welcome back!\nEnter to confirm')).toBeUndefined();
  });
});

describe('claude launch', () => {
  it('reads the real exe out of the npm claude.cmd shim', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muster-claude-'));
    const exe = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    mkdirSync(join(exe, '..'), { recursive: true });
    writeFileSync(exe, '');
    writeFileSync(join(dir, 'claude.cmd'), '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n');
    expect(resolveClaudePath({}, 'win32', dir)).toBe(exe);
    expect(resolveClaudePath({ claudePath: 'C:/x/claude.exe' }, 'win32', dir)).toBe('C:/x/claude.exe');
    expect(resolveClaudePath({}, 'linux', dir)).toBe('claude');
  });

  it('drops parent-session and stale Muster vars from the PTY env', () => {
    const agent = makeAgent('crew-2', 'crew');
    const ctx = { url: 'http://127.0.0.1:1', token: 't', repoRoot: '/repo', config: DEFAULT_CONFIG };
    const env = ptyEnv(agent, ctx, { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_USE_BEDROCK: '1', MUSTER_AGENT: 'captain' });
    expect(env).toMatchObject({ PATH: '/bin', CLAUDE_CODE_USE_BEDROCK: '1', MUSTER_AGENT: 'crew-2', MUSTER_WORKTREE: '/tmp/crew-2' });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
  });

  it('runs .cmd shims through cmd.exe', () => {
    expect(spawnCommand('C:/npm/claude.cmd', ['--x']).file).toBe('cmd.exe');
    expect(spawnCommand('C:/bin/claude.exe', ['--x'])).toEqual({ file: 'C:/bin/claude.exe', args: ['--x'] });
  });

  it('writes forward-slash commands and the agent env into its config files', () => {
    const root = mkdtempSync(join(tmpdir(), 'muster-files-'));
    const paths = musterPaths(root);
    const agent = makeAgent('crew-2', 'crew', { worktree: join(root, '.muster', 'worktrees', 'crew-2') });
    const files = writeAgentFiles(paths, agent, { url: 'http://127.0.0.1:47800', token: 'abc', repoRoot: root, config: { ...DEFAULT_CONFIG, projectName: 'demo' } });

    const mcp = JSON.parse(readFileSync(files.mcp, 'utf8'));
    expect(mcp.mcpServers.muster.args[0]).toMatch(/^[^\\]+\/dist\/mcp\/index\.js$/);
    expect(mcp.mcpServers.muster.env).toMatchObject({ MUSTER_AGENT: 'crew-2', MUSTER_ROLE: 'crew', MUSTER_TOKEN: 'abc', MUSTER_BASE_BRANCH: 'main' });
    expect(mcp.mcpServers.vellum).toBeUndefined();

    const settings = JSON.parse(readFileSync(files.settings, 'utf8'));
    expect(settings.permissions.allow).toEqual(DEFAULT_CONFIG.allowedTools);
    const hook = settings.hooks.PreToolUse[0].hooks[0].command as string;
    expect(hook).toMatch(/^"[^\\]+" "[^\\]+\/dist\/hooks\/hook\.js" pre-tool$/);
    expect(settings.statusLine.command).toMatch(/dist\/usage\/statusline\.js"$/);
    expect(readFileSync(files.prompt, 'utf8')).toMatch(/crew-2/);

    expect(launchArgs(agent, DEFAULT_CONFIG, files, { resume: false })).toEqual([
      '--session-id', 's-crew-2', '--model', 'sonnet', '--permission-mode', 'auto',
      '--mcp-config', files.mcp, '--settings', files.settings, '--append-system-prompt-file', files.prompt, '--name', 'muster crew-2',
    ]);
    const resumed = launchArgs(agent, DEFAULT_CONFIG, files, { resume: true, inlinePrompt: 'be nice' });
    expect(resumed.slice(0, 2)).toEqual(['--resume', 's-crew-2']);
    expect(resumed).toContain('--append-system-prompt');
    expect(resumed).not.toContain('--append-system-prompt-file');
  });
});
