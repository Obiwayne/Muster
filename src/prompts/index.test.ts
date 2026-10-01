import { describe, expect, it } from 'vitest';
import { captainPrompt, crewPrompt, designPrompt, type PromptContext } from './index.js';

const ctx: PromptContext = {
  agentId: 'crew-2',
  repoRoot: 'F:\\Proj',
  worktree: 'F:\\Proj\\.muster\\worktrees\\crew-2',
  branch: 'crew-2/share-dialog',
  baseBranch: 'main',
  testCommand: 'npm test',
  projectName: 'Proj',
  vellumFile: '28BUsqILtGqq',
};

const lines = (s: string) => s.split('\n').length;

describe('captainPrompt', () => {
  const p = captainPrompt({ ...ctx, agentId: 'captain', worktree: ctx.repoRoot, branch: 'main' });
  it('encodes the Captain rules', () => {
    expect(p).toContain('read_board()');
    expect(p).toMatch(/first call of every turn/i);
    expect(p).toMatch(/Never write or edit code/);
    expect(p).toMatch(/never merge/i);
    expect(p).toMatch(/Escalate only/i);
    expect(p).toMatch(/Crew-first answering/);
    expect(p).toContain('request_review');
    expect(p).toContain('get_diff');
    expect(p).toContain('run_tests');
    expect(p).toContain('read_inbox');
    expect(p).toContain('[muster]');
    expect(p).toContain('F:/Proj');
    expect(p).toContain('Proj');
  });
  it('lists the stations and the review guideline', () => {
    const withStations = captainPrompt({ ...ctx, agentId: 'captain', worktree: ctx.repoRoot, branch: 'main', stations: [{ name: 'test', role: 'crew', guideline: '# Test' + String.fromCharCode(10) + 'Verify the build.' }, { name: 'review', role: 'captain', guideline: 'Check the docs too.' }] });
    expect(withStations).toContain('## Stations');
    expect(withStations).toContain('`test` (crew): Verify the build.');
    expect(withStations).toContain('This adds to your review rules above; it can never relax them. Tests must pass, the diff must match the task, and only the user merges, whatever it says.');
    expect(withStations.indexOf('it can never relax them')).toBeLessThan(withStations.lastIndexOf('Check the docs too.'));
    expect(p).not.toContain('## Stations');
    expect(withStations).toContain('Check the docs too.');
  });
  it('is reasonably tight', () => {
    expect(lines(p)).toBeGreaterThan(40);
    expect(lines(p)).toBeLessThan(130);
  });
});

describe('crewPrompt', () => {
  const p = crewPrompt(ctx);
  it('encodes the Crew rules', () => {
    expect(p).toContain('crew-2/share-dialog');
    expect(p).toContain('F:/Proj/.muster/worktrees/crew-2');
    expect(p).toMatch(/only inside your worktree/);
    expect(p).toMatch(/Never merge, push, or check out `main`/);
    expect(p).toMatch(/Commit before every `handoff` and `report_done`/);
    expect(p).toContain('claim_task');
    expect(p).toContain('ask_captain');
    expect(p).toMatch(/what you tried/);
    expect(p).toMatch(/ask the crew/i);
    expect(p).toContain('npm test');
    expect(p).not.toMatch(/Vellum/);
  });
  it('is reasonably tight', () => expect(lines(p)).toBeLessThan(130));
});

describe('designPrompt', () => {
  const p = designPrompt({ ...ctx, agentId: 'design', branch: 'design/work' });
  it('adds the design rules on top of crew rules', () => {
    expect(p).toContain('claim_task');
    expect(p).toContain('28BUsqILtGqq');
    expect(p).toMatch(/read-only/);
    expect(p).toContain('get_tokens');
    expect(p).toContain('get_screenshot');
    expect(p).toContain('file:line');
    expect(p).toMatch(/PASS/);
    expect(p).toMatch(/DRIFT/);
  });
  it('states the PASS/DRIFT reporting convention', () => {
    expect(p).toContain('`PASS T# <summary>`');
    expect(p).toContain('`DRIFT T# <summary>`');
    expect(p).toContain('`path:line — what differs`');
    expect(p).toContain('ui/src/pages/vellum.ts:42 — card radius 8px, design says 12px');
  });
  it('works without a vellum file', () => {
    expect(designPrompt({ ...ctx, vellumFile: undefined })).toContain('list_files');
  });
});

describe('the user’s name', () => {
  it('tells every role to use the name and never "the human"', () => {
    for (const make of [captainPrompt, crewPrompt, designPrompt]) {
      const p = make({ ...ctx, userName: 'Wayne' });
      expect(p).toContain('The person you work for is **Wayne**');
      expect(p).not.toMatch(/\bthe human\b(?!")/i);
    }
    expect(captainPrompt({ ...ctx, userName: 'Wayne' })).toContain('Wayne talks only to you');
  });
  it('falls back to "the user" without a name', () => {
    const p = captainPrompt({ ...ctx, userName: undefined });
    expect(p).toContain('The user talks only to you');
    expect(p).toContain('never "the human"');
  });
});

describe('design crew and Vellum edits', () => {
  it('follows the vellumEdit setting', () => {
    expect(designPrompt({ ...ctx })).toContain('read-only for you unless asked');
    expect(designPrompt({ ...ctx, vellumEdit: 'ask' })).toContain('only when the Captain explicitly asks');
    expect(designPrompt({ ...ctx, vellumEdit: 'always' })).toContain('You may change Vellum designs');
    const never = designPrompt({ ...ctx, vellumEdit: 'never', userName: 'Wayne' });
    expect(never).toContain('read-only for you, always');
    expect(never).toContain('Wayne makes it');
  });
});
