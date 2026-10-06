import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../types.js';
import { stripAnsi } from '../orchestrator/terminal.js';
import { launchArgs, ptyArgs, ptyEnv, researchEnv, resolveClaudePath, rolePrompt, settingsConfig, spawnCommand, trustPromptKeys, VELLUM_EDIT_TOOLS, writeAgentFiles } from './claude.js';
import { musterPaths, PLUGIN_DIR } from './paths.js';
import { deriveAgentToken } from './tokens.js';
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
    expect(env).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: '1', MUSTER_AGENT: 'crew-2', MUSTER_WORKTREE: '/tmp/crew-2' });
    expect(env.PATH.split(/[;:]/)[0]).toBe('/bin'); // the research tools, when installed, only ever go after it
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
    expect(mcp.mcpServers.muster.env).toMatchObject({ MUSTER_AGENT: 'crew-2', MUSTER_ROLE: 'crew', MUSTER_TOKEN: deriveAgentToken('abc', 'crew-2'), MUSTER_BASE_BRANCH: 'main' });
    expect(JSON.stringify(mcp)).not.toContain('"abc"'); // the secret itself never reaches an agent
    expect(mcp.mcpServers.vellum).toBeUndefined();

    const settings = JSON.parse(readFileSync(files.settings, 'utf8'));
    expect(settings.permissions.allow).toEqual(DEFAULT_CONFIG.allowedTools);
    expect(settings.hooks.PreToolUse[0].matcher.split('|')).toEqual(expect.arrayContaining(['Bash', 'PowerShell', 'Edit', 'Write', 'Read']));
    const hook = settings.hooks.PreToolUse[0].hooks[0].command as string;
    expect(hook).toMatch(/^"[^\\]+" "[^\\]+\/dist\/hooks\/hook\.js" pre-tool$/);
    expect(settings.statusLine.command).toMatch(/dist\/usage\/statusline\.js"$/);
    expect(settings.disableAllHooks).toBe(false); // a user-level disableAllHooks must not switch Muster's hooks off
    expect(readFileSync(files.prompt, 'utf8')).toMatch(/crew-2/);

    expect(launchArgs(agent, DEFAULT_CONFIG, files, { resume: false })).toEqual([
      '--session-id', 's-crew-2', '--model', 'sonnet', '--permission-mode', 'auto',
      '--mcp-config', files.mcp, '--settings', files.settings, '--setting-sources', 'user', '--plugin-dir', PLUGIN_DIR, '--append-system-prompt-file', files.prompt, '--name', 'muster crew-2',
    ]);
    const resumed = launchArgs(agent, DEFAULT_CONFIG, files, { resume: true, inlinePrompt: 'be nice' });
    expect(resumed.slice(0, 2)).toEqual(['--resume', 's-crew-2']);
    expect(resumed).toContain('--append-system-prompt');
    expect(resumed).not.toContain('--append-system-prompt-file');
  });
});

describe('spawning through a .cmd shim', () => {
  it('runs the exe or node script behind an npm shim directly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muster shim '));
    const exe = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    mkdirSync(join(exe, '..'), { recursive: true });
    writeFileSync(exe, '');
    writeFileSync(join(dir, 'claude.cmd'), '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n');
    expect(spawnCommand(join(dir, 'claude.cmd'), ['--x'])).toEqual({ file: exe, args: ['--x'] });

    const cli = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    writeFileSync(cli, '');
    writeFileSync(join(dir, 'old.cmd'), '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n)\r\n');
    expect(spawnCommand(join(dir, 'old.cmd'), ['--x'])).toEqual({ file: process.execPath, args: [cli, '--x'] });
  });

  it('quotes the whole cmd line for /s /c and never passes the prompt inline', () => {
    const cmd = spawnCommand('C:/Program Files/My Tools/claude.cmd', ['--settings', 'C:/a b/settings.json', '--append-system-prompt', 'rm -rf & calc', '--name', 'muster crew-2']);
    expect(cmd.file).toBe('cmd.exe');
    expect(cmd.args).toEqual(['/d', '/s', '/c', '""C:/Program Files/My Tools/claude.cmd" --settings "C:/a b/settings.json" --name "muster crew-2""']);
    expect(ptyArgs(cmd.file, cmd.args)).toBe('/d /s /c ""C:/Program Files/My Tools/claude.cmd" --settings "C:/a b/settings.json" --name "muster crew-2""');
    expect(ptyArgs('C:/bin/claude.exe', ['--x'])).toEqual(['--x']);
    expect(() => spawnCommand('C:/x/claude.cmd', ['--name', 'a%PATH%'])).toThrow(/cmd\.exe/);
  });
});

describe('rolePrompt vellumFile', () => {
  const ctx = (vellumFile?: string) => ({ url: 'http://x', token: 't', repoRoot: 'F:/r', config: { ...DEFAULT_CONFIG, projectName: 'demo', vellumFile } });
  const design = makeAgent('design', 'design', { worktree: 'F:/r/.muster/worktrees/design' });
  it('names the configured Vellum file in the design crew prompt only', () => {
    expect(rolePrompt(design, ctx(' 28BUsqILtGqq '))).toContain('`28BUsqILtGqq`');
    expect(rolePrompt(design, ctx())).toContain('list_files');
    expect(rolePrompt(design, ctx('  '))).toContain('list_files');
    expect(rolePrompt(makeAgent('crew-2', 'crew', { worktree: 'F:/r/w' }), ctx('28BUsqILtGqq'))).not.toContain('28BUsqILtGqq');
  });
});

describe('rolePrompt qa', () => {
  const c = { url: 'http://x', token: 't', repoRoot: 'F:/r', config: { ...DEFAULT_CONFIG, projectName: 'demo' } };
  it('gives the QA agent its own review-only prompt, not the crew one', () => {
    const p = rolePrompt(makeAgent('qa', 'qa', { worktree: 'F:/r/.muster/worktrees/qa' }), c);
    expect(p).toContain('the QA agent (qa)');
    expect(p).toContain('qa_verdict');
    expect(p).not.toContain('report_done');
  });
});

describe('Vellum edit permissions', () => {
  it('denies Vellum editing tools only to the design crew, only when vellumEdit is never', () => {
    const base = { ...DEFAULT_CONFIG };
    const deny = (role: 'captain' | 'crew' | 'design', vellumEdit: 'ask' | 'always' | 'never') =>
      (settingsConfig({ ...base, vellumEdit }, role) as { permissions: { deny?: string[] } }).permissions.deny;
    expect(deny('design', 'never')).toEqual(VELLUM_EDIT_TOOLS);
    expect(deny('design', 'never')).toContain('mcp__vellum__write_html');
    expect(deny('design', 'never')).not.toContain('mcp__vellum__get_screenshot');
    expect(deny('design', 'ask')).toBeUndefined();
    expect(deny('design', 'always')).toBeUndefined();
    expect(deny('crew', 'never')).toBeUndefined();
  });

describe('research tools', () => {
  it('appends the Agent Reach venv to PATH (never ahead of a project python) only when it is installed', () => {
    const venv = mkdtempSync(join(tmpdir(), 'muster-venv-'));
    expect(researchEnv({ Path: '/opt/python' }, venv)).toEqual({});
    const bin = join(venv, process.platform === 'win32' ? 'Scripts' : 'bin');
    const py = join(bin, process.platform === 'win32' ? 'python.exe' : 'python');
    mkdirSync(bin, { recursive: true });
    writeFileSync(py, '');
    const sep = process.platform === 'win32' ? ';' : ':';
    expect(researchEnv({ Path: '/opt/python' }, venv)).toEqual({ Path: `/opt/python${sep}${bin}`, AGENT_REACH_PYTHON: py });
    expect(researchEnv({ Path: `/opt/python${sep}${bin}` }, venv)).toEqual({ AGENT_REACH_PYTHON: py }); // already there
  });
});

});
