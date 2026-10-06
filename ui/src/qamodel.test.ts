import { describe, expect, it } from 'vitest';
import { failedChecks, qaHistory, qaLabel, qaTone, type QaTask } from './qamodel';

const ok = { correct: 5, tested: 5, clean: 5, scoped: 5, safe: 5 };
const task = (qa?: QaTask['qa']) => ({ qa }) as QaTask;

describe('qa badge', () => {
  it('has nothing to show before QA has run', () => {
    expect(qaLabel(task())).toBeNull();
    expect(qaTone(task())).toBeNull();
  });
  it('passes only on 5/5', () => {
    const t = task({ round: 1, last: { score: 5, at: 'x', findings: [], rubric: ok } });
    expect(qaLabel(t)).toBe('QA 5/5');
    expect(qaTone(t)).toBe('pass');
  });
  it('names the round after a send-back', () => {
    const t = task({ round: 2, last: { score: 4, at: 'x', findings: [], rubric: { ...ok, clean: 3, tested: 4 } } });
    expect(qaLabel(t)).toBe('QA 4/5 · round 2');
    expect(qaTone(t)).toBe('fail');
    expect(failedChecks(t.qa!.last!.rubric)).toEqual(['Tested 4/5', 'Clean 3/5']);
  });
  it('shows an escalated task as escalated whatever its score', () => {
    const t = task({ round: 3, escalated: true, last: { score: 3, at: 'x', findings: [], rubric: ok } });
    expect(qaLabel(t)).toBe('QA escalated · round 3');
    expect(qaTone(t)).toBe('escalated');
  });
  it('lists the rounds from history, else falls back to the last verdict', () => {
    const last = { score: 4, at: 'x', findings: [], rubric: ok };
    expect(qaHistory(task())).toBeNull();
    expect(qaHistory(task({ round: 2, last }))).toBe('Round 2 4/5');
    expect(qaHistory(task({ round: 2, last, history: [{ round: 1, score: 3, at: 'x' }, { round: 2, score: 4, at: 'x' }] }))).toBe('Round 1 3/5 · Round 2 4/5');
  });
});
