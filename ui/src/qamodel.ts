// Pure QA gate helpers: the badge text, its tone and the weak rubric items.
import type { Task } from '../../src/types';

// TODO: import these from src/types.ts once T29 (vik) lands them there; until then the UI keeps its own copy of the contract.
/** Each rubric item is scored 1-5; the overall score is the lowest of them (1-5, never 0). Only 5/5 passes. */
export interface QaRubric { correct: number; tested: number; clean: number; scoped: number; safe: number }
export interface QaFinding { file: string; line?: number; problem: string; fix: string }
export interface QaVerdict { score: number; at: string; findings: QaFinding[]; rubric: QaRubric }
export interface QaRound { round: number; score: number; at: string }
export interface TaskQa {
  round: number; // 1, 2, 3...
  escalated?: boolean; // three failed rounds: the Captain and you decide
  last?: QaVerdict;
  history?: QaRound[]; // one entry per scored round, oldest first
}
/** A task as the QA gate leaves it: `qa` is absent until the qa station has scored it. */
export type QaTask = Task & { qa?: TaskQa };
export const qaOf = (task: Task): TaskQa | undefined => (task as QaTask).qa;

export const CHECKS: { key: keyof QaRubric; label: string }[] = [
  { key: 'correct', label: 'Correct' },
  { key: 'tested', label: 'Tested' },
  { key: 'clean', label: 'Clean' },
  { key: 'scoped', label: 'Scoped' },
  { key: 'safe', label: 'Safe' },
];

export type QaTone = 'pass' | 'fail' | 'escalated';

export function qaTone(task: Task): QaTone | null {
  const qa = qaOf(task);
  if (!qa) return null;
  if (qa.escalated) return 'escalated';
  return qa.last && qa.last.score >= 5 ? 'pass' : 'fail';
}

/** "QA 5/5", "QA 3/5 · round 2", "QA escalated · round 3"; null when the gate has not scored the task. */
export function qaLabel(task: Task): string | null {
  const qa = qaOf(task);
  if (!qa) return null;
  if (qa.escalated) return `QA escalated · round ${qa.round}`;
  if (!qa.last) return `QA round ${qa.round}`;
  return `QA ${qa.last.score}/5${qa.round > 1 || qa.last.score < 5 ? ` · round ${qa.round}` : ''}`;
}

/** Rubric items under 5/5, with their scores: ["Clean 3/5"]. */
export const failedChecks = (r: QaRubric): string[] => CHECKS.filter((c) => r[c.key] < 5).map((c) => `${c.label} ${r[c.key]}/5`);

/** "Round 1 3/5 · Round 2 4/5"; from `history` when the server sends it, else just the last verdict. Null before any score. */
export function qaHistory(task: Task): string | null {
  const qa = qaOf(task);
  if (!qa) return null;
  const rounds = qa.history?.length ? qa.history : qa.last ? [{ round: qa.round, score: qa.last.score }] : [];
  return rounds.length ? rounds.map((r) => `Round ${r.round} ${r.score}/5`).join(' · ') : null;
}
