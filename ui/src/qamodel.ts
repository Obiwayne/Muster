// Pure QA gate helpers: the badge text, its tone and the failed rubric checks.
import type { QaRubric, Task } from '../../src/types';

export const CHECKS: { key: keyof QaRubric; label: string }[] = [
  { key: 'correct', label: 'Correct' },
  { key: 'tested', label: 'Tested' },
  { key: 'clean', label: 'Clean' },
  { key: 'scoped', label: 'Scoped' },
  { key: 'safe', label: 'Safe' },
];

export type QaTone = 'pass' | 'fail' | 'escalated';

export function qaTone(task: Task): QaTone | null {
  const qa = task.qa;
  if (!qa) return null;
  if (qa.escalated) return 'escalated';
  return qa.last && qa.last.score >= 5 ? 'pass' : 'fail';
}

/** "QA 5/5", "QA 3/5 · round 2", "QA escalated · round 3"; null when the gate has not scored the task. */
export function qaLabel(task: Task): string | null {
  const qa = task.qa;
  if (!qa) return null;
  if (qa.escalated) return `QA escalated · round ${qa.round}`;
  if (!qa.last) return `QA round ${qa.round}`;
  return `QA ${qa.last.score}/5${qa.round > 1 || qa.last.score < 5 ? ` · round ${qa.round}` : ''}`;
}

export const failedChecks = (r: QaRubric): string[] => CHECKS.filter((c) => !r[c.key]).map((c) => c.label);
