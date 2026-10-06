import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type MusterState, type Task } from '../types.js';
import { inboxFor } from './board.js';
import { escalationText, findingsMarkdown, parseVerdict, recordQaVerdict, type VerdictInput } from './qaverdict.js';
import { emptyState } from './store.js';
import { claimTask, createTask, doneTask, requestReview, sendBack } from './tasks.js';
import { makeAgent } from './testutil.js';

const config = { ...DEFAULT_CONFIG, defaultStations: ['build'] };
const rubric = (n: number) => ({ correct: n, tested: n, clean: n, scoped: n, safe: n });
const verdict = (score: number, extra: Partial<VerdictInput> = {}): VerdictInput =>
  parseVerdict({
    score,
    rubric: { ...rubric(5), correct: score },
    findings: score < 5 ? [{ file: 'src/a.ts', line: 3, problem: 'null deref', fix: 'guard it' }] : [],
    summary: 'looked it over',
    ...extra,
  });

let s: MusterState;
let t: Task;

/** Builder crew-2 hands the task to qa and the QA agent claims it. */
function toQa(): void {
  if (t.status === 'in_progress' && t.assignee === 'crew-2') doneTask(s, t.id, 'crew-2', 'built');
  expect(claimTask(s, 'qa')?.id).toBe(t.id);
}

beforeEach(() => {
  s = emptyState('/repo');
  s.agents.push(makeAgent('captain', 'captain'), makeAgent('crew-2', 'crew'), makeAgent('qa', 'qa'));
  t = createTask(s, config, { title: 'Share dialog', actor: 'captain' });
  claimTask(s, 'crew-2');
  toQa();
});

describe('parseVerdict', () => {
  it('needs score = lowest rubric score, and a finding below 5', () => {
    const ok = { score: 4, rubric: { ...rubric(5), tested: 4 }, findings: [{ file: 'a.ts', problem: 'p', fix: 'f' }], summary: 's' };
    expect(parseVerdict(ok).score).toBe(4);
    expect(() => parseVerdict({ ...ok, score: 5 })).toThrow(/must equal the lowest rubric score \(4\)/);
    expect(() => parseVerdict({ ...ok, findings: [] })).toThrow(/needs at least one finding/);
    expect(() => parseVerdict({ ...ok, score: 6 })).toThrow(/must equal the lowest rubric score/);
    expect(parseVerdict({ ...ok, score: undefined }).score).toBe(4); // derived
    expect(() => parseVerdict({ score: 5, rubric: rubric(5), findings: [{ file: 'a.ts', problem: 'p', fix: 'f' }], summary: 's' })).toThrow(/5\/5 has no findings/);
    expect(() => parseVerdict({ rubric: { ...rubric(5), clean: 6 }, summary: 's' })).toThrow(/rubric\.clean/);
    expect(() => parseVerdict({ ...ok, rubric: { ...ok.rubric, safe: undefined } })).toThrow(/rubric\.safe/);
    expect(() => parseVerdict({ ...ok, findings: [{ file: 'a.ts', problem: 'p' }] })).toThrow(/findings\[0\]\.fix/);
    expect(() => parseVerdict({ ...ok, summary: ' ' })).toThrow(/summary is required/);
    expect(parseVerdict({ score: 5, rubric: rubric(5), summary: 'clean' }).findings).toEqual([]);
  });
});

describe('recordQaVerdict', () => {
  it('only the QA agent holding the task at qa can give one', () => {
    expect(() => recordQaVerdict(s, t.id, 'crew-2', verdict(5))).toThrow(/Only the QA agent/);
    expect(() => recordQaVerdict(s, t.id, 'captain', verdict(5))).toThrow(/Only the QA agent/);
    s.agents.push(makeAgent('qa-2', 'qa'));
    expect(() => recordQaVerdict(s, t.id, 'qa-2', verdict(5))).toThrow(/doesn't hold/);
  });

  it('5 goes to review, with the verdict recorded', () => {
    const r = recordQaVerdict(s, t.id, 'qa', verdict(5));
    expect(r.outcome).toBe('passed');
    expect(t).toMatchObject({ status: 'review', assignee: 'captain', qa: { round: 1, last: { score: 5 }, history: [{ round: 1, score: 5 }] } });
    expect(inboxFor(s, 'captain').some((i) => i.kind === 'review' && i.taskId === t.id)).toBe(true);
  });

  it('1-4 goes back to the builder with a findings checklist and round 1', () => {
    const r = recordQaVerdict(s, t.id, 'qa', verdict(3));
    expect(r).toMatchObject({ outcome: 'sent_back', round: 1 });
    expect(t).toMatchObject({ status: 'in_progress', assignee: 'crew-2', stationIndex: 0, qa: { round: 1, last: { score: 3 } } });
    const msg = inboxFor(s, 'crew-2').at(-1)!.text;
    expect(msg).toContain('QA round 1/3: score 3/5 - fix these:');
    expect(msg).toContain('- [ ] src/a.ts:3: null deref -> guard it');
    // handing off again returns it to qa
    doneTask(s, t.id, 'crew-2', 'fixed');
    expect(t).toMatchObject({ status: 'ready', stationIndex: 1 });
    expect(claimTask(s, 'qa')?.id).toBe(t.id);
  });

  it('with the builder gone the task becomes ready for the station role', () => {
    s.agents.find((a) => a.id === 'crew-2')!.status = 'stopped';
    recordQaVerdict(s, t.id, 'qa', verdict(2));
    expect(t).toMatchObject({ status: 'ready', assignee: undefined, stationIndex: 0 });
  });

  it('3 failures escalate: parked with the Captain, no review without a send_back, which resets the rounds', () => {
    recordQaVerdict(s, t.id, 'qa', verdict(2));
    doneTask(s, t.id, 'crew-2', 'again');
    claimTask(s, 'qa');
    recordQaVerdict(s, t.id, 'qa', verdict(3));
    doneTask(s, t.id, 'crew-2', 'again');
    claimTask(s, 'qa');
    const r = recordQaVerdict(s, t.id, 'qa', verdict(4));
    expect(r.outcome).toBe('escalated');
    expect(t).toMatchObject({ status: 'review', assignee: 'captain', qa: { round: 3, escalated: true } });
    expect(t.qa!.history.map((h) => h.score)).toEqual([2, 3, 4]);
    expect(() => requestReview(s, t.id, 'captain', 'ship it')).toThrow(/failed QA 3 times/);
    sendBack(s, t.id, 'captain', 'try the other approach');
    expect(t.qa).toMatchObject({ round: 0, escalated: undefined });
    expect(t).toMatchObject({ status: 'in_progress', assignee: 'crew-2' });
  });
});

describe('texts', () => {
  it('findings.md lists rubric and findings; the escalation text carries every report', () => {
    const md = findingsMarkdown(t, 2, verdict(3));
    expect(md).toContain('# QA round 2 of 3: 3/5');
    expect(md).toContain('- correct: 3/5');
    expect(md).toContain('- [ ] src/a.ts:3: null deref');
    expect(escalationText(t, ['one', 'two', 'three'])).toMatch(/failed QA 3 times[\s\S]*one[\s\S]*two[\s\S]*three/);
  });
});
