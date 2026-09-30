// Guard cases from the security review: each known bypass, plus the new Read/PowerShell/config rules.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decide, realNearest, tokenize, type GuardEnv, type PreToolInput } from './guard.js';

const REPO = 'F:\\Proj';
const WT = 'F:\\Proj\\.muster\\worktrees\\crew-2';
const SECRETS = 'C:\\Users\\me\\AppData\\Local\\muster';
const crew: GuardEnv = { role: 'crew', agentId: 'crew-2', worktree: WT, repo: REPO, baseBranch: 'main', platform: 'win32', secretDirs: [SECRETS] };
const captain: GuardEnv = { role: 'captain', agentId: 'captain', worktree: REPO, repo: REPO, baseBranch: 'main', platform: 'win32', secretDirs: [SECRETS] };

const sh = (command: string, cwd = WT, tool = 'Bash'): PreToolInput => ({ tool_name: tool, tool_input: { command }, cwd });
const denied = (command: string, env: GuardEnv = crew, tool = 'Bash') => !decide(sh(command, env === captain ? REPO : WT, tool), env).allow;
const edit = (file_path: string, tool = 'Edit'): PreToolInput => ({ tool_name: tool, tool_input: { file_path }, cwd: WT });
const read = (tool: string, input: Record<string, unknown>): PreToolInput => ({ tool_name: tool, tool_input: input, cwd: WT });

describe('reviewer bypasses (crew)', () => {
  it('subshell cd: (cd F:/x && git merge a)', () => {
    expect(denied('(cd F:/x && git merge a)')).toBe(true);
    expect(denied('( cd F:/Proj ; git commit -am x )')).toBe(true);
    expect(tokenize('(cd F:/x')).toEqual(['cd', 'F:/x']);
  });
  it('git --git-dir / --work-tree and GIT_DIR= / GIT_WORK_TREE=', () => {
    expect(denied('git --git-dir=F:/Proj/.git merge a')).toBe(true);
    expect(denied('git --git-dir F:/Proj/.git --work-tree F:/Proj merge a')).toBe(true);
    expect(denied('GIT_DIR=F:/Proj/.git git merge a')).toBe(true);
    expect(denied('GIT_WORK_TREE=F:/Proj git checkout main')).toBe(true);
    expect(denied('export GIT_DIR=F:/Proj/.git; git merge a')).toBe(true);
    expect(denied('$env:GIT_DIR="F:/Proj/.git"; git merge a', crew, 'PowerShell')).toBe(true);
  });
  it('symbolic-ref / update-ref / branch -f', () => {
    expect(denied('git symbolic-ref HEAD refs/heads/main && git commit -am x')).toBe(true);
    expect(denied('git update-ref refs/heads/main HEAD')).toBe(true);
    expect(denied('git branch -f main HEAD')).toBe(true);
    expect(denied('git branch --force crew-3/x HEAD')).toBe(true);
    expect(denied('git branch -M main')).toBe(true);
  });
  it('nested shells running git', () => {
    expect(denied('bash -c "git push origin main"')).toBe(true);
    expect(denied("sh -c 'cd .. && git merge x'")).toBe(true);
    expect(denied('powershell -c "git push"')).toBe(true);
    expect(denied('pwsh -Command "git merge x"')).toBe(true);
    expect(denied('cmd /c "git push"')).toBe(true);
    expect(denied('cmd.exe /c git merge x')).toBe(true);
    expect(denied('powershell -EncodedCommand ZwBpAHQAIABwAHUAcwBoAA==')).toBe(true);
    expect(denied('eval "git push"')).toBe(true);
    expect(denied('echo $(git update-ref refs/heads/main HEAD)')).toBe(true);
    expect(denied('bash -c "npm test"')).toBe(false);
  });
  it('hooks and config tampering', () => {
    expect(denied('git -c core.hooksPath=/dev/null commit -m x')).toBe(true);
    expect(denied('git config core.hooksPath /tmp/nohooks')).toBe(true);
    expect(denied('git config --unset core.hooksPath')).toBe(true);
    expect(denied('git config alias.ci "!git push"')).toBe(true);
    expect(denied('git push --no-verify', captain)).toBe(true);
  });
  it('clearing the agent identity the git hook relies on', () => {
    expect(denied('MUSTER_AGENT= git commit -am x')).toBe(true);
    expect(denied('env -u MUSTER_AGENT git commit -am x')).toBe(true);
    expect(denied('unset MUSTER_AGENT; git commit -am x')).toBe(true);
    expect(denied('env -i PATH=/usr/bin git commit -am x')).toBe(true);
    expect(denied('Remove-Item Env:MUSTER_AGENT; git commit -am x', crew, 'PowerShell')).toBe(true);
    expect(denied('$env:MUSTER_AGENT=""; git commit -am x', crew, 'PowerShell')).toBe(true);
    expect(denied('echo $MUSTER_AGENT')).toBe(false);
  });
  it('links and junctions', () => {
    expect(denied('mklink /J escape F:\\Proj')).toBe(true);
    expect(denied('New-Item -ItemType Junction -Path x -Target F:\\Proj', crew, 'PowerShell')).toBe(true);
    expect(denied('ln -s /f/Proj escape')).toBe(true);
  });
  it('the human token folder and other agents\' config', () => {
    expect(denied('type C:\\Users\\me\\AppData\\Local\\muster\\abc\\token')).toBe(true);
    expect(denied('cat "$LOCALAPPDATA/muster/abc/token"')).toBe(true);
    expect(denied('Get-Content $env:LOCALAPPDATA\\muster\\abc\\token', crew, 'PowerShell')).toBe(true);
    expect(denied('cat F:/Proj/.muster/agents/captain/mcp.json')).toBe(true);
  });
  it('still allows normal work', () => {
    expect(denied('git add -A && git commit -m "T3: add invite API"')).toBe(false);
    expect(denied('git reset --hard HEAD~1')).toBe(false); // own branch
    expect(denied('git log --oneline | head -5', crew, 'PowerShell')).toBe(false);
    expect(denied('npm test 2>&1 | tail -20')).toBe(false);
  });
});

describe('PowerShell tool gets the Bash rules', () => {
  it('denies push, base checkout and cd-outside writes', () => {
    expect(denied('git push', crew, 'PowerShell')).toBe(true);
    expect(denied('git checkout main', crew, 'PowerShell')).toBe(true);
    expect(denied('Set-Location F:\\Proj; git commit -am x', crew, 'PowerShell')).toBe(true);
    expect(denied('Set-Location -Path F:\\Proj; git add .', crew, 'PowerShell')).toBe(true);
    expect(denied('& git push', crew, 'PowerShell')).toBe(true);
  });
  it('applies the Captain rules too', () => {
    expect(denied('git merge crew-2/x', captain, 'PowerShell')).toBe(true);
  });
});

describe('Captain extra git rules', () => {
  it('denies pull, reset, rebase, cherry-pick, am, checkout -B', () => {
    for (const c of ['git pull . x', 'git pull', 'git reset --hard x', 'git rebase crew-2/x', 'git cherry-pick abc', 'git am < p.patch', 'git checkout -B main x', 'git switch -C main x', 'git revert HEAD', 'git branch -D crew-2/x'])
      expect(denied(c, captain), c).toBe(true);
  });
  it('allows reads', () => {
    expect(denied('git log --oneline -5 && git diff main...crew-2/x', captain)).toBe(false);
    expect(denied('git checkout -b scratch', captain)).toBe(false);
  });
});

describe('edits: protected files and junction escapes', () => {
  it('denies .git, .claude, .mcp.json and .muster inside the worktree', () => {
    for (const p of ['.claude\\settings.local.json', '.claude/settings.json', '.mcp.json', '.git', '.git/hooks/pre-commit', '.muster/state.json'])
      expect(decide(edit(p), crew).allow, p).toBe(false);
    expect(decide(edit('src/.claude-notes.md'), crew).allow).toBe(true);
    expect(decide(edit('src/app.ts'), crew).allow).toBe(true);
  });

  const tmp = mkdtempSync(join(tmpdir(), 'muster-junction-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  it('resolves a junction inside the worktree before the inside check', () => {
    const wt = join(tmp, 'wt');
    const outside = join(tmp, 'main-checkout');
    mkdirSync(join(wt, 'src'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(wt, 'escape'), 'junction');
    const env: GuardEnv = { role: 'crew', worktree: wt, realpath: realNearest };
    const input: PreToolInput = { tool_name: 'Write', tool_input: { file_path: join(wt, 'escape', 'new-dir', 'evil.ts') }, cwd: wt };
    expect(decide(input, { ...env, realpath: undefined }).allow).toBe(true); // the lexical check alone is fooled
    const d = decide(input, env);
    expect(d.allow).toBe(false);
    expect(!d.allow && d.reason).toMatch(/outside your worktree/);
    expect(decide({ ...input, tool_input: { file_path: join(wt, 'src', 'new', 'ok.ts') } }, env).allow).toBe(true);
  });
});

describe('reads of secrets', () => {
  it("denies the human token folder and other agents' config, for every role", () => {
    for (const env of [crew, captain]) {
      expect(decide(read('Read', { file_path: SECRETS + '\\0123abcd\\token' }), env).allow).toBe(false);
      expect(decide(read('Grep', { pattern: 'x', path: SECRETS }), env).allow).toBe(false);
      expect(decide(read('Glob', { pattern: '**', path: 'C:/Users/me/AppData/Local/muster' }), env).allow).toBe(false);
      expect(decide(read('Read', { file_path: 'F:\\Proj\\.muster\\agents\\crew-3\\mcp.json' }), env).allow).toBe(false);
    }
    expect(decide(read('Read', { file_path: 'F:\\Proj\\.muster\\agents\\crew-2\\prompt.md' }), crew).allow).toBe(true);
    expect(decide(read('Read', { file_path: 'F:\\Proj\\.muster\\server.json' }), crew).allow).toBe(true);
    expect(decide(read('Read', { file_path: 'src/app.ts' }), crew).allow).toBe(true);
  });
});
