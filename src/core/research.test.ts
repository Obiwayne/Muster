import { beforeEach, describe, expect, it } from 'vitest';
import type { IdeaEvidence, MusterState } from '../types.js';
import { inboxFor } from './board.js';
import { addIdea, adviseIdea, approveIdea, askIdea, cancelRun, failRun, finishRun, getResearch, reopenIdea, rejectIdea, researchBrief, startRun, type IdeaInput } from './research.js';
import { addGoal, approveRoadmap, setRoadmap } from './roadmap.js';
import { emptyState, migrate } from './store.js';
import { makeAgent } from './testutil.js';

let s: MusterState;
const sources = { competitors: ['Padlet', 'Wakelet'], reviews: true, forums: ['r/Teachers'], ownApp: false };
const ev: IdeaEvidence[] = [{ kind: 'review', source: 'App Store review · Padlet · 2★', text: 'No way to approve posts first', url: 'https://example.com/r/1', count: 37 }];
const idea = (over: Partial<IdeaInput> = {}): IdeaInput => ({ title: 'Moderation queue', summary: 'Teachers need to approve posts before students see them.', impact: 'high', effort: 'M', evidence: ev, ...over });
const captainInbox = () => inboxFor(s, 'captain').map((i) => i.text);
const status = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { status?: number }).status;
  }
  return 200;
};

beforeEach(() => {
  s = emptyState('/repo');
  s.agents.push(makeAgent('captain', 'captain'), makeAgent('crew-2', 'crew'), makeAgent('scout', 'research', { branch: 'main', worktree: '/repo' }));
  setRoadmap(s, { title: 'wall v1', summary: 'A wall for classes.', stages: [{ title: 'Basics', goals: [{ title: 'Posting' }] }, { title: 'Safety', goals: [{ title: 'Reports' }] }] }, 'captain');
  approveRoadmap(s, 'you');
});

describe('research runs', () => {
  it('starts one run at a time, only for you, with at least one source', () => {
    expect(getResearch(emptyState('/x'))).toEqual({ runs: [], ideas: [] });
    expect(status(() => startRun(s, 'captain', { sources, depth: 'quick' }))).toBe(403);
    expect(status(() => startRun(s, 'you', { sources: { competitors: [], reviews: false, forums: [], ownApp: false }, depth: 'quick' }))).toBe(400);
    expect(status(() => startRun(s, 'you', { sources, depth: 'deep' }))).toBe(400);
    const run = startRun(s, 'you', { sources, depth: 'thorough', focus: ' moderation ' });
    expect(run).toMatchObject({ id: 'RR1', status: 'running', agentId: 'scout', depth: 'thorough', focus: 'moderation', ideaIds: [] });
    expect(s.feed.at(-1)!.text).toMatch(/^started research RR1 \(thorough: Padlet, Wakelet; reviews; r\/Teachers\)/);
    expect(status(() => startRun(s, 'you', { sources, depth: 'quick' }))).toBe(409);
  });

  it('is refused while paused', () => {
    s.usage.paused = true;
    expect(status(() => startRun(s, 'you', { sources, depth: 'quick' }))).toBe(409);
  });

  it('cancels (you) and finishes (research agent only), and fails when scout dies', () => {
    const run = startRun(s, 'you', { sources, depth: 'quick' });
    expect(status(() => finishRun(s, 'captain', run.id, { summary: 'x' }))).toBe(403);
    expect(status(() => finishRun(s, 'scout', run.id, { summary: '' }))).toBe(400);
    addIdea(s, 'scout', idea());
    const done = finishRun(s, 'scout', 'current', { summary: 'Read 12 pages.', sourcesRead: 12 });
    expect(done).toMatchObject({ status: 'done', summary: 'Read 12 pages.', sourcesRead: 12 });
    expect(done.finishedAt).toBeTruthy();
    expect(status(() => cancelRun(s, 'you', run.id))).toBe(409);
    const second = startRun(s, 'you', { sources, depth: 'quick' });
    expect(status(() => cancelRun(s, 'scout', second.id))).toBe(403);
    expect(cancelRun(s, 'you', second.id).status).toBe('cancelled');
    const third = startRun(s, 'you', { sources, depth: 'quick' });
    expect(failRun(s, 'scout exited')?.id).toBe(third.id);
    expect(third.status).toBe('failed');
    expect(failRun(s, 'again')).toBeUndefined();
  });
});

describe('research ideas', () => {
  beforeEach(() => {
    startRun(s, 'you', { sources, depth: 'quick' });
  });

  it('only the research agent adds them, during a run, with valid fields', () => {
    expect(status(() => addIdea(s, 'crew-2', idea()))).toBe(403);
    expect(status(() => addIdea(s, 'scout', idea({ impact: 'huge' })))).toBe(400);
    expect(status(() => addIdea(s, 'scout', idea({ effort: 'XL' })))).toBe(400);
    expect(status(() => addIdea(s, 'scout', idea({ evidence: [] })))).toBe(400);
    expect(status(() => addIdea(s, 'scout', idea({ evidence: Array(9).fill(ev[0]) })))).toBe(400);
    expect(status(() => addIdea(s, 'scout', idea({ evidence: [{ ...ev[0], text: 'x'.repeat(301) }] })))).toBe(400);
    expect(status(() => addIdea(s, 'scout', idea({ evidence: [{ ...ev[0], url: 'javascript:alert(1)' }] })))).toBe(400);
    expect(status(() => addIdea(s, 'scout', idea({ stageId: 'M9' })))).toBe(400);
    expect(status(() => addIdea(s, 'scout', idea({ overlapsGoalId: 'G9' })))).toBe(400);
    const i = addIdea(s, 'scout', idea({ stageId: 'm2', overlapsGoalId: 'g2', effort: 'm' }));
    expect(i).toMatchObject({ id: 'R1', runId: 'RR1', status: 'new', stageId: 'M2', overlapsGoalId: 'G2', effort: 'M', thread: [] });
    expect(s.research!.runs[0].ideaIds).toEqual(['R1']);
    expect(status(() => addIdea(s, 'scout', idea({ title: 'moderation QUEUE' })))).toBe(409);
    cancelRun(s, 'you', 'RR1');
    expect(status(() => addIdea(s, 'scout', idea({ title: 'Other' })))).toBe(409);
  });

  it('brief lists the run, the roadmap ids, ideas found and the rules', () => {
    addIdea(s, 'scout', idea());
    const text = researchBrief(s);
    expect(text).toContain('Research run RR1 (quick).');
    expect(text).toContain('Padlet, Wakelet');
    expect(text).toContain('M1 Basics (active)');
    expect(text).toContain('  G2 Reports (planned)');
    expect(text).toContain('- R1 Moderation queue (new)');
    expect(text).toContain('Aim for 3–8 ideas');
    expect(text).toMatch(/Public pages only/);
    cancelRun(s, 'you', 'RR1');
    expect(researchBrief(s)).toMatch(/^No research run is running/);
  });

  it('ask goes to the Captain; the Captain advises with a plan', () => {
    const i = addIdea(s, 'scout', idea());
    expect(status(() => askIdea(s, 'captain', i.id, 'q'))).toBe(403);
    askIdea(s, 'you', 'r1', 'Is it worth it?');
    expect(captainInbox().at(-1)).toBe(
      "You asked about R1 Moderation queue: Is it worth it?. Read it with get_idea R1 and answer with advise_idea (include the roadmap changes you'd make on approval).",
    );
    expect(status(() => adviseIdea(s, 'crew-2', i.id, { text: 'x' }))).toBe(403);
    expect(status(() => adviseIdea(s, 'captain', i.id, { text: 'x', plan: 'no' }))).toBe(400);
    adviseIdea(s, 'captain', i.id, { text: 'Yes, small.', plan: ['+ Add goal Moderation queue to M2'] });
    expect(i.thread.map((m) => m.from)).toEqual(['you', 'captain']);
    expect(i.plan).toEqual(['+ Add goal Moderation queue to M2']);
  });

  it('approve tells the Captain; the goal it adds keeps the roadmap approved', () => {
    const i = addIdea(s, 'scout', idea({ stageId: 'M2' }));
    expect(status(() => addGoal(s, { stageId: 'M2', title: 'Moderation queue', ideaId: i.id }, 'captain'))).toBe(409); // not approved yet
    expect(status(() => approveIdea(s, 'captain', i.id))).toBe(403);
    approveIdea(s, 'you', i.id);
    expect(i).toMatchObject({ status: 'approved' });
    expect(captainInbox().at(-1)).toMatch(/^R1 Moderation queue approved\. Add it to the roadmap now: add_goal\(M2, …, idea: "R1"\).*no second approval\.$/);
    expect(status(() => approveIdea(s, 'you', i.id))).toBe(409);
    expect(status(() => addGoal(s, { stageId: 'M2', title: 'x', ideaId: 'R9' }, 'captain'))).toBe(404);
    const { goal, roadmap } = addGoal(s, { stageId: 'M2', title: 'Moderation queue', ideaId: 'r1' }, 'captain');
    expect(i.goalId).toBe(goal.id);
    expect(roadmap.status).toBe('approved');
    expect(s.feed.some((f) => f.text === `added ${goal.id} for idea R1`)).toBe(true);
    expect(status(() => addGoal(s, { stageId: 'M2', title: 'Again', ideaId: 'R1' }, 'captain'))).toBe(409);
    expect(status(() => rejectIdea(s, 'you', i.id))).toBe(409);
    expect(status(() => reopenIdea(s, 'you', i.id))).toBe(409);
    // A plain new goal is still a replan.
    expect(addGoal(s, { stageId: 'M2', title: 'Plain' }, 'captain').roadmap.status).toBe('draft');
  });

  it('reject with a note, and reopen', () => {
    const i = addIdea(s, 'scout', idea());
    expect(status(() => rejectIdea(s, 'captain', i.id))).toBe(403);
    rejectIdea(s, 'you', i.id, 'Not for us');
    expect(i).toMatchObject({ status: 'rejected' });
    expect(i.thread.at(-1)).toMatchObject({ from: 'you', text: 'Not for us' });
    expect(status(() => rejectIdea(s, 'you', i.id))).toBe(409);
    reopenIdea(s, 'you', i.id);
    expect(i.status).toBe('new');
    expect(i.decidedAt).toBeUndefined();
    expect(status(() => reopenIdea(s, 'you', i.id))).toBe(409);
    approveIdea(s, 'you', i.id);
    rejectIdea(s, 'you', i.id);
    expect(captainInbox().at(-1)).toMatch(/rejected after all/);
  });
});

describe('research state migration', () => {
  it('keeps run and idea ids unique and fills partial research', () => {
    const m = migrate({ research: { runs: [{ id: 'RR4' }], ideas: [{ id: 'R12' }] } as never, nextIds: { idea: 2 } as never }, '/repo');
    expect(m.nextIds).toMatchObject({ run: 5, idea: 13 });
    expect(migrate({}, '/repo').research).toBeUndefined();
    expect(migrate({ research: { runs: [] } as never }, '/repo').research).toEqual({ runs: [], ideas: [] });
  });
});
