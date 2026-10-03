import { describe, expect, it } from 'vitest';
import { decide, denyOutput, normalizePath, splitCommands, tokenize, type GuardEnv, type PreToolInput } from './guard.js';

const WT = 'F:\\Proj\\.muster\\worktrees\\crew-2';
const crew: GuardEnv = { role: 'crew', worktree: WT, baseBranch: 'main', platform: 'win32' };
const captain: GuardEnv = { role: 'captain', worktree: 'F:\\Proj', baseBranch: 'main', platform: 'win32' };

const edit = (file_path: string, cwd = WT, tool = 'Edit'): PreToolInput => ({
  hook_event_name: 'PreToolUse',
  tool_name: tool,
  tool_input: tool === 'NotebookEdit' ? { notebook_path: file_path } : { file_path },
  cwd,
});
const bash = (command: string, cwd = WT): PreToolInput => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });

describe('crew file edits (Windows)', () => {
  it('allows absolute paths inside the worktree', () => {
    expect(decide(edit('F:\\Proj\\.muster\\worktrees\\crew-2\\src\\a.ts'), crew).allow).toBe(true);
  });
  it('allows relative paths resolved against cwd', () => {
    expect(decide(edit('src/a.ts'), crew).allow).toBe(true);
    expect(decide(edit('a.ts', WT + '\\src'), crew).allow).toBe(true);
  });
  it('ignores drive-letter and path case, and slash style', () => {
    expect(decide(edit('f:/proj/.MUSTER/worktrees/CREW-2/src/a.ts'), crew).allow).toBe(true);
    expect(decide(edit('/f/Proj/.muster/worktrees/crew-2/x.ts'), crew).allow).toBe(true);
  });
  it('denies paths outside the worktree', () => {
    const d = decide(edit('F:\\Proj\\src\\a.ts'), crew);
    expect(d.allow).toBe(false);
    expect(!d.allow && d.reason).toMatch(/outside your worktree/);
  });
  it('denies .. traversal out of the worktree', () => {
    expect(decide(edit('..\\crew-3\\src\\a.ts'), crew).allow).toBe(false);
    expect(decide(edit('src/../../crew-3/a.ts'), crew).allow).toBe(false);
    expect(decide(edit('F:\\Proj\\.muster\\worktrees\\crew-2\\..\\..\\..\\secret.txt'), crew).allow).toBe(false);
  });
  it('denies sibling folders that share a prefix', () => {
    expect(decide(edit('F:\\Proj\\.muster\\worktrees\\crew-22\\a.ts'), crew).allow).toBe(false);
  });
  it('covers Write, MultiEdit and NotebookEdit', () => {
    for (const tool of ['Write', 'MultiEdit', 'NotebookEdit']) expect(decide(edit('C:\\other\\x.ipynb', WT, tool), crew).allow).toBe(false);
  });
  it('allows other tools', () => {
    expect(decide({ tool_name: 'Read', tool_input: { file_path: 'C:\\x' }, cwd: WT }, crew).allow).toBe(true);
  });
});

describe('crew file edits (posix)', () => {
  const env: GuardEnv = { role: 'design', worktree: '/repo/.muster/worktrees/design', platform: 'linux' };
  it('is case sensitive and resolves ..', () => {
    expect(decide(edit('src/a.css', '/repo/.muster/worktrees/design'), env).allow).toBe(true);
    expect(decide(edit('/repo/.muster/worktrees/Design/a.css', '/repo'), env).allow).toBe(false);
    expect(decide(edit('../../../src/a.css', '/repo/.muster/worktrees/design'), env).allow).toBe(false);
  });
});

describe('crew bash deny-list', () => {
  const denied = (c: string, env: GuardEnv = crew) => !decide(bash(c), env).allow;
  it('denies git push in any form', () => {
    expect(denied('git push')).toBe(true);
    expect(denied('git push origin crew-2/x')).toBe(true);
    expect(denied('npm test && git push -u origin HEAD')).toBe(true);
    expect(denied('git -C . push')).toBe(true);
  });
  it('denies checking out / switching to the base branch', () => {
    expect(denied('git checkout main')).toBe(true);
    expect(denied('git switch main')).toBe(true);
    expect(denied('git checkout -f main')).toBe(true);
    expect(denied('git checkout develop', { ...crew, baseBranch: 'develop' })).toBe(true);
  });
  it('allows restoring a file from main and other checkouts', () => {
    expect(denied('git checkout main -- src/a.ts')).toBe(false);
    expect(denied('git checkout -b crew-2/new')).toBe(false);
  });
  it('denies git worktree and branch -D', () => {
    expect(denied('git worktree add ../x')).toBe(true);
    expect(denied('git branch -D crew-3/x')).toBe(true);
    expect(denied('git branch --delete --force x')).toBe(true);
    expect(denied('git branch -a')).toBe(false);
  });
  it('denies merge only while on the base branch', () => {
    expect(denied('git merge crew-3/x', { ...crew, currentBranch: 'main' })).toBe(true);
    expect(denied('git merge crew-3/x', { ...crew, currentBranch: 'crew-2/x' })).toBe(false);
  });
  it('denies cd outside the worktree followed by git writes', () => {
    expect(denied('cd F:\\Proj && git commit -am x')).toBe(true);
    expect(denied('cd ../.. ; git add .')).toBe(true);
    expect(denied('git -C F:/Proj commit -m x')).toBe(true);
    expect(denied('cd ../.. && git status')).toBe(false);
    expect(denied('cd src && git add . && git commit -m "T3: x"')).toBe(false);
  });
  it('allows normal work', () => {
    expect(denied('npm test 2>&1 | tail -20')).toBe(false);
    expect(denied('git add -A && git commit -m "T3: add invite API; tests"')).toBe(false);
    expect(denied('echo "git push" > notes.txt')).toBe(false);
  });
});

describe('captain rules', () => {
  it('denies every edit tool, even inside the repo', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      const d = decide(edit('F:\\Proj\\src\\a.ts', 'F:\\Proj', tool), captain);
      expect(d.allow).toBe(false);
      expect(!d.allow && d.reason).toMatch(/doesn't write code/);
    }
  });
  it('denies git merge/push/commit but allows reads', () => {
    expect(decide(bash('git merge crew-2/x', 'F:\\Proj'), captain).allow).toBe(false);
    expect(decide(bash('git push', 'F:\\Proj'), captain).allow).toBe(false);
    expect(decide(bash('git commit -m x', 'F:\\Proj'), captain).allow).toBe(false);
    expect(decide(bash('git log --oneline -5 && git diff main...crew-2/x', 'F:\\Proj'), captain).allow).toBe(true);
  });
});

describe('research (scout) rules', () => {
  const scout: GuardEnv = { role: 'research', agentId: 'scout', repo: 'F:\\Proj', baseBranch: 'main', platform: 'win32' };
  const at = (c: string) => decide(bash(c, 'F:\\Proj'), scout);
  it('denies every edit tool with the scout message', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      const d = decide(edit('F:\\Proj\\notes.md', 'F:\\Proj', tool), scout);
      expect(d.allow).toBe(false);
      expect(!d.allow && d.reason).toMatch(/scout researches and never changes code/);
    }
  });
  it('denies git writes like the Captain, and more', () => {
    for (const c of ['git commit -m x', 'git push', 'git merge x', 'git add .', 'git checkout -b x', 'git switch main', 'git stash', 'git restore a.ts', 'git branch new', 'git branch -D x', 'git tag v1', 'git reset --hard', 'git log && git commit -am x']) {
      const d = at(c);
      expect(d.allow, c).toBe(false);
      expect(!d.allow && d.reason).toMatch(/^scout researches and never changes code: git /);
    }
  });
  it('allows reading the code and git history', () => {
    for (const c of ['git log --oneline -20', 'git diff main', 'git show HEAD', 'git status', 'git branch', 'git branch -a', 'git branch --show-current', 'git stash list', 'git tag -l', 'git config --get user.name', 'git worktree list', 'git grep TODO', 'ls src'])
      expect(at(c).allow, c).toBe(true);
    expect(decide({ tool_name: 'Read', tool_input: { file_path: 'F:\\Proj\\src\\a.ts' }, cwd: 'F:\\Proj' }, scout).allow).toBe(true);
  });
  it('keeps the rules shared by every role', () => {
    expect(at('MUSTER_ROLE=captain node x.js').allow).toBe(false);
    expect(decide({ tool_name: 'Read', tool_input: { file_path: 'F:\\Proj\\.muster\\agents\\captain\\mcp.json' }, cwd: 'F:\\Proj' }, scout).allow).toBe(false);
  });
});

describe('browser and cookie tooling (every role)', () => {
  const SECRETS = 'C:\\Users\\me\\AppData\\Local\\muster';
  const envs: GuardEnv[] = [
    { ...crew, secretDirs: [SECRETS] },
    { ...captain, secretDirs: [SECRETS] },
    { role: 'research', agentId: 'scout', repo: 'F:\\Proj', baseBranch: 'main', platform: 'win32', secretDirs: [SECRETS] },
    { role: 'design', agentId: 'design', worktree: WT, baseBranch: 'main', platform: 'win32', secretDirs: [SECRETS] },
  ];
  const denied = [
    'python -c "import browser_cookie3; print(browser_cookie3.chrome())"',
    '"$AGENT_REACH_PYTHON" -m rookiepy',
    'agent-reach cookie_extract --browser opera',
    'python scripts/opera-cookies.py reddit.com',
    'type "%APPDATA%\\Opera Software\\Opera Stable\\Local State"',
    'cat ~/AppData/Roaming/Opera\\ Software/Opera\\ Stable/Default/Network/Cookies',
    '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222',
    'chrome.exe --user-data-dir=C:\\tmp\\p https://reddit.com',
    'node -e "require(\'playwright-core\').chromium.launchPersistentContext(\'x\')"',
    'npx playwright open https://reddit.com',
    'dir C:\\Users\\me\\AppData\\Local\\muster\\research-browser\\profile',
  ];
  it('denies cookie extraction, profiles and driving a browser', () => {
    for (const env of envs)
      for (const c of denied) {
        const d = decide(bash(c, env.worktree ?? 'F:\\Proj'), env);
        expect(d.allow, `${env.role}: ${c}`).toBe(false);
      }
    const d = decide(bash('python -c "import browser_cookie3"', WT), envs[0]);
    expect(!d.allow && d.reason).toMatch(/browse tool/);
  });
  it('denies reading the research profile with the read tools', () => {
    for (const env of envs)
      expect(decide({ tool_name: 'Read', tool_input: { file_path: `${SECRETS}\\research-browser\\profile\\Default\\Cookies` }, cwd: 'F:\\Proj' }, env).allow).toBe(false);
  });
  it('still allows ordinary research and builds', () => {
    for (const c of ['npm test', 'curl -s "https://r.jina.ai/https://padlet.com/premium"', 'git log --oneline -5'])
      expect(decide(bash(c, WT), envs[0]).allow, c).toBe(true);
  });
});

describe('non-muster sessions and helpers', () => {
  it('allows everything without a role', () => {
    expect(decide(bash('git push'), {}).allow).toBe(true);
    expect(decide(edit('C:\\x'), { worktree: WT }).allow).toBe(true);
  });
  it('builds the deny JSON Claude Code expects', () => {
    expect(JSON.parse(denyOutput('no'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' },
    });
  });
  it('parses shell commands', () => {
    expect(splitCommands('a && b || c; d | e\nf')).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(splitCommands('echo "a && b"; c')).toEqual(['echo "a && b"', 'c']);
    expect(tokenize(`git commit -m "hello world" 'x y'`)).toEqual(['git', 'commit', '-m', 'hello world', 'x y']);
    expect(normalizePath('..\\B', 'C:\\a\\x', true)).toBe('c:/a/b');
  });
});
