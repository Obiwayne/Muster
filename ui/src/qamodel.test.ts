import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/types';
import { failedChecks, qaHistory, qaLabel, qaTone } from './qamodel';

const ok = { correct: true, tested: true, clean: true, scoped: true, safe: true };
const task = (qa?: Task['qa']) => ({ qa }) as Task;

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
    const t = task({ round: 2, last: { score: 4, at: 'x', findings: [], rubric: { ...ok, clean: false } } });
    expect(qaLabel(t)).toBe('QA 4/5 · round 2');
    expect(qaTone(t)).toBe('fail');
    expect(failedChecks(t.qa!.last!.rubric)).toEqual(['Clean']);
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
