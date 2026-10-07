import { describe, expect, it } from 'vitest';
import { captainPrompt, crewPrompt, designPrompt, mediaPrompt, qaPrompt, researchPrompt, type PromptContext } from './index.js';

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
    expect(p).toMatch(/never run `git merge\/push` yourself/i);
    expect(p).toMatch(/merge_task/);
    expect(p).toMatch(/Escalate only/i);
    expect(p).toMatch(/Crew-first answering/);
    expect(p).toMatch(/watchdog reports an idle agent/);
    expect(p).toContain('request_review');
    expect(p).toContain('get_diff');
    expect(p).toContain('run_tests');
    expect(p).toContain('read_inbox');
    expect(p).toContain('[muster]');
    expect(p).toContain('F:/Proj');
    expect(p).toContain('Proj');
  });
  it('sends multiple-choice decisions through the question menu', () => {
    expect(p).toMatch(/AskUserQuestion.*Bulletin board and the phone/);
    expect(p).toMatch(/recommended option first/);
    expect(p).toMatch(/carry on with other work or end your turn/);
  });
  it('puts the roadmap first and ties every task to a goal', () => {
    expect(p).toContain('## Roadmap');
    expect(p).toContain('`read_board()` and `roadmap()`');
    expect(p).toMatch(/draft one with `set_roadmap` before any build task/);
    expect(p).toMatch(/wait for the user's approval/);
    expect(p).toMatch(/Discovery and concept work may run first/);
    expect(p).toContain('Post every task with its goal');
    expect(p).toMatch(/when told a goal is done, break the next one into tasks/);
    expect(p).toMatch(/Tick exit criteria only with evidence.*then `complete_stage`/);
    expect(p).toMatch(/your changes apply straight away without asking/);
    expect(p).toMatch(/`add_goal` to the right stage/);
    expect(p).toMatch(/Rule: after every merged task, update the roadmap, then call `roadmap_status\(text, task\)`/);
    expect(p).toMatch(/The user reads this line to know where things are, so never skip it/);
    expect(p).toContain('`roadmap_status(text, task?)`');
    for (const t of ['set_roadmap(', 'update_stage', 'check_criterion(stage, n)', 'update_goal', 'post_task(title, description, goal']) expect(p).toContain(t);
  });
  it('lists the lines, marks the default and says humans approve', () => {
    const p = captainPrompt({ ...ctx, agentId: 'captain', worktree: ctx.repoRoot, branch: 'main', stations: [{ name: 'approval', role: 'human', guideline: 'You approve.' }], lines: [{ name: 'feature', label: 'Standard', stations: ['plan', 'build', 'review'] }, { name: 'new-app', label: 'Plan', stations: ['plan', 'approval', 'review'] }], defaultLine: 'feature' });
    expect(p).toContain('`feature` (Standard) — default: plan → build → review');
    expect(p).toContain('`new-app` (Plan): plan → approval → review');
    expect(p).toContain('line: "<name>"');
    expect(p).toContain('`bugfix` for defects');
    expect(p).toContain('docs/factory/<T#>-plan.md');
    expect(p).toContain('turn its task breakdown into the roadmap (`set_roadmap`)');
    expect(p).toContain('That task runs before the roadmap');
    expect(p).toContain('line: "new-app"');
    expect(p).toContain('package.json');
    expect(p).toContain('Settings → Project');
    expect(p).toContain('Never create the GitHub repo yourself');
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
    expect(p).toContain('Tasks belong to roadmap goals');
    expect(p).not.toContain('set_roadmap');
  });
  it('tells crew their work passes a QA gate that needs 5/5', () => {
    expect(p).toContain('Your work passes a QA gate that needs 5/5');
    expect(designPrompt(ctx)).not.toContain('QA gate');
  });
  it('is reasonably tight', () => expect(lines(p)).toBeLessThan(130));
  it('tells crew to ask for help instead of sitting idle', () => {
    expect(p).toMatch(/Never sit idle holding a task/);
    expect(p).toMatch(/post a `stuck` note right away/i);
    expect(p).toMatch(/message_crew/);
    expect(p).toMatch(/cut off or empty/);
    expect(p).toMatch(/`question` note/);
    expect(p).toMatch(/call `read_inbox\(\)` and `claim_task\(\)` again/);
    expect(p).toMatch(/post nothing/);
    expect(p).toMatch(/in your area/);
  });
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
    expect(p).toMatch(/Never sit idle holding a task/);
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
    for (const make of [captainPrompt, crewPrompt, designPrompt, researchPrompt, mediaPrompt]) {
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

describe('researchPrompt', () => {
  const p = researchPrompt({ ...ctx, agentId: 'scout', worktree: ctx.repoRoot, branch: 'main' });
  it('keeps scout read-only, never signing in itself, and no code changes', () => {
    expect(p).toContain('# Muster — you are the research agent (scout)');
    expect(p).toMatch(/Read-only, and never sign in yourself/);
    expect(p).toMatch(/Pages behind a login only through `browse`/);
    expect(p).toMatch(/Never touch cookies, browser profiles/);
    expect(p).toMatch(/read via public reader \(site blocked the research browser\)/);
    expect(p).toMatch(/Never change code/);
    expect(p).toContain('muster:web-research');
    expect(p).toMatch(/at most 300 characters/);
    expect(p).toContain('F:/Proj');
  });
  it('asks for evidence-backed user problems and walks the tools in order', () => {
    expect(p).toMatch(/user problem or opportunity backed by evidence/);
    expect(p).toMatch(/not a feature wish/);
    expect(p.indexOf('research_brief()')).toBeLessThan(p.indexOf('add_idea('));
    expect(p).toMatch(/Skip ideas the brief already lists/);
    expect(p).toContain('`finish_research`');
    expect(p).not.toContain('claim_task()');
  });
  it('is short', () => expect(lines(p)).toBeLessThan(90));
  it('carries the intel duties', () => {
    expect(p.indexOf('intel_brief()')).toBeLessThan(p.indexOf('record_intel(kind, item)'));
    expect(p).toMatch(/one claim per `record_intel` call/);
    expect(p).toMatch(/fact = you saw it on a primary source/);
    expect(p).toMatch(/prediction = your inference, with `prediction \{ signals, timeframe, wouldChange \}`/);
    expect(p).toMatch(/Count within the sample/);
    expect(p).toMatch(/never generalise from a few loud complaints/i);
    expect(p).toMatch(/partial public view/);
    expect(p).toMatch(/Engagement is attention, not sales/);
    expect(p).toMatch(/verified \(seen working\) vs claimed/);
    expect(p).toMatch(/right after each `add_idea`, write `intel_check`/);
    expect(p).toMatch(/`add_opportunity` linked to its capabilities, then `intel_check`/);
    expect(p).toMatch(/Official feeds are strong primary sources/);
    expect(p).toContain('`finish_intel_job`');
  });
  it('makes scout use browse in profile / opera mode and never in public mode', () => {
    expect(p).toContain('## Browse mode decides how you read pages');
    expect(p).toMatch(/profile or opera: you MUST use `browse`\*\* for every competitor product, feature and pricing page, and for pages that show more signed in: Reddit, LinkedIn, G2/);
    expect(p).toMatch(/Do not read those with curl or Jina Reader/);
    expect(p).toMatch(/curl \/ Jina Reader only\*\* for official feeds .* or as the fallback when `browse` reports `blocked`/);
    expect(p).toMatch(/public: never call `browse`/);
    expect(p).not.toMatch(/web-research skill's tools stay first/);
  });
});

describe('captainPrompt research ideas', () => {
  const p = captainPrompt({ ...ctx, agentId: 'captain', userName: 'Wayne' });
  it('answers questions with advise_idea and adds approved ideas without a second approval', () => {
    expect(p).toContain('## Research ideas');
    expect(p).toContain('"You asked about R7 …"');
    expect(p).toContain('`advise_idea(R7, text, plan)`');
    expect(p).toMatch(/honest cost/);
    expect(p).toContain('`add_goal(stage, title, description, idea: "R7")`');
    expect(p).toMatch(/No second approval/);
    expect(p).toContain('`list_ideas(status?)`');
  });
  it('handles competitive intelligence: gaps thread, effort, re-check alerts', () => {
    expect(p).toContain('## Competitive intelligence');
    expect(p).toContain('**"You asked about the gaps …"**');
    expect(p).toContain('`intel_reply(text)`');
    expect(p).toMatch(/honest `effort` 1–5/);
    expect(p).toContain('Leave the re-check out of `plan`: Muster shows it from the real watch.');
    expect(p).toContain('Approved ideas are re-checked **weekly**');
    expect(p).not.toMatch(/monthly/);
    expect(p).toContain('`add_goal(stage, …, idea: "R12")`');
    expect(p).toContain('**"Re-check of R7 … (G4): …"**');
    expect(p).toContain('`intel_suggest(IX5, text)`');
    expect(p).toContain('`request_intel_check(idea)`');
  });
  it('states the real re-check cadence from config instead of letting the Captain guess', () => {
    const daily = captainPrompt({ ...ctx, agentId: 'captain', intelRecheck: 'daily' });
    expect(daily).toContain('Approved ideas are re-checked **daily**');
    expect(daily).toMatch(/say daily, never another cadence/);
    expect(daily).not.toMatch(/re-checked \*\*weekly/);
    const off = captainPrompt({ ...ctx, agentId: 'captain', intelRecheck: 'off' });
    expect(off).toContain('Re-checks are **off** in Settings');
  });
});

describe('reactions guidance', () => {
  it('captain, crew and design learn react and what each emoji means; research does not', () => {
    for (const make of [captainPrompt, crewPrompt, designPrompt]) {
      const p = make(ctx);
      expect(p).toContain('react(message, emoji)');
      expect(p).toMatch(/👍 once you've read it and no reply is needed/);
      expect(p).toMatch(/👀 when you're looking into it/);
      expect(p).toMatch(/✅ when what it asked is done or the note is resolved/);
      expect(p).toMatch(/❓ instead of guessing/);
      expect(p).toMatch(/Don't react to your own messages/);
      expect(p).toMatch(/never replaces an answer/);
    }
    const r = researchPrompt({ ...ctx, agentId: 'scout' });
    expect(r).not.toContain('react(');
    expect(r).not.toContain('👍');
  });
});

describe('qaPrompt', () => {
  const qa = qaPrompt({ ...ctx, agentId: 'qa', branch: '', worktree: 'F:/Proj/.muster/worktrees/qa' });
  it('is review-only and strict', () => {
    expect(qa).toContain('the QA agent (qa)');
    expect(qa).toContain('F:/Proj/.muster/worktrees/qa');
    expect(qa).toMatch(/never edit code/);
    expect(qa).toMatch(/only 5\/5 passes/i);
    expect(qa).toMatch(/overall score is the lowest/);
    expect(qa).toContain('git diff main...HEAD');
    expect(qa).toContain('npm test');
  });
  it('names the verdict tool, its rubric items and the finding shape', () => {
    expect(qa).toContain('qa_verdict(task, rubric, findings, summary)');
    for (const k of ['correct', 'tested', 'clean', 'scoped', 'safe']) expect(qa).toContain(k);
    expect(qa).toContain('{ file, line?, problem, fix }');
  });
  it('says three failed rounds go to the Captain and the user, and not to bend scores', () => {
    expect(qa).toMatch(/never pass work to end the loop/i);
    expect(qa).toMatch(/Captain and the user decide/);
  });
  it('does not offer the builder tools or Vellum', () => {
    expect(qa).not.toContain('handoff(');
    expect(qa).not.toContain('report_done');
    expect(qa).not.toMatch(/Vellum/);
  });
  it('is tight', () => expect(lines(qa)).toBeLessThan(80));
});

describe('mediaPrompt', () => {
  it('makes herald a read-only writer that sources every claim and never posts', () => {
    const p = mediaPrompt({ ...ctx, agentId: 'herald' });
    expect(p).toContain('you are herald, the media agent (herald)');
    expect(p).toContain('`media_brief()` — **call first.**');
    expect(p).toMatch(/Never post, publish, send, push or sign in anywhere/);
    expect(p).toMatch(/Plain text only/);
    expect(p).toContain('`sources: []`');
  });
  it('tells the Captain to suggest media for features users will notice', () => {
    expect(captainPrompt(ctx)).toContain('call `suggest_media(task, title, why)` once for it');
  });
});
