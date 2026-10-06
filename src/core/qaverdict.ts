// The QA agent's verdict on a task at the qa station: validation, the pass / send-back / escalate decision, and the
// texts that go to the builder, the evidence store and the escalation note. Pure state changes; the API layer does the git side.
import type { Agent, MusterState, QaFinding, QaRubric, QaVerdict, Role, Task } from '../types.js';
import { addFeed, addInbox, captainOf, closeNoteIfOpen, findAgent, HUMAN, SYSTEM } from './board.js';
import { badRequest, conflict, forbidden } from './errors.js';
import { QA_STATION } from './qa.js';
import { announceReady, currentStation, doneTask, event, heldTask, release, requireTask, stationRole, takeTask, toReview, type StationBranch } from './tasks.js';

export const MAX_QA_ROUNDS = 3;
const MAX_FINDINGS = 50;
const MAX_TEXT = 4000;
const RUBRIC_KEYS = ['correct', 'tested', 'clean', 'scoped', 'safe'] as const;

export interface VerdictInput {
  score: QaVerdict['score'];
  rubric: QaRubric;
  findings: QaFinding[];
  summary: string;
}

export type QaOutcome = 'passed' | 'sent_back' | 'escalated';

const isScore = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5;
const text = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw badRequest(`${what} is required`);
  if (v.length > MAX_TEXT) throw badRequest(`${what} is longer than ${MAX_TEXT} characters`);
  return v.trim();
};

/** Shape-checks a qa_verdict body; names the field on a 400. The score must be the lowest rubric score; below 5 needs a finding. */
export function parseVerdict(body: { score?: unknown; rubric?: unknown; findings?: unknown; summary?: unknown }): VerdictInput {
  if (!isScore(body.score)) throw badRequest('score must be a whole number from 1 to 5');
  const r = body.rubric as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== 'object') throw badRequest(`rubric is required: ${RUBRIC_KEYS.join(', ')} (each 1-5)`);
  const rubric = {} as QaRubric;
  for (const k of RUBRIC_KEYS) {
    if (!isScore(r[k])) throw badRequest(`rubric.${k} must be a whole number from 1 to 5`);
    rubric[k] = r[k] as number;
  }
  const min = Math.min(...RUBRIC_KEYS.map((k) => rubric[k]));
  if (body.score !== min) throw badRequest(`score ${body.score} must equal the lowest rubric score (${min})`);
  const raw = body.findings === undefined ? [] : body.findings;
  if (!Array.isArray(raw)) throw badRequest('findings must be a list');
  if (raw.length > MAX_FINDINGS) throw badRequest(`At most ${MAX_FINDINGS} findings; keep the ones that matter`);
  const findings = raw.map((f: Record<string, unknown>, i): QaFinding => {
    if (!f || typeof f !== 'object') throw badRequest(`findings[${i}] must be an object`);
    if (f.line !== undefined && (typeof f.line !== 'number' || !Number.isInteger(f.line) || f.line < 1)) throw badRequest(`findings[${i}].line must be a positive whole number`);
    return { file: text(f.file, `findings[${i}].file`), ...(f.line !== undefined ? { line: f.line as number } : {}), problem: text(f.problem, `findings[${i}].problem`), fix: text(f.fix, `findings[${i}].fix`) };
  });
  if (body.score < 5 && !findings.length) throw badRequest('A score below 5 needs at least one finding (file, problem, fix)');
  return { score: body.score as QaVerdict['score'], rubric, findings, summary: text(body.summary, 'summary') };
}

/** Only the QA agent holding the task at the qa station may give a verdict. */
export function assertQaHolder(state: MusterState, task: Task, actor: string): Agent {
  const agent = findAgent(state, actor);
  if (!agent || agent.role !== 'qa') throw forbidden('Only the QA agent gives a QA verdict');
  if (currentStation(task) !== QA_STATION || task.status !== 'in_progress' || task.assignee !== agent.id) {
    throw conflict(`${agent.id} doesn't hold ${task.id} at the qa station (it is ${task.status} at ${currentStation(task)}, held by ${task.assignee ?? 'nobody'})`);
  }
  return agent;
}

const where = (f: QaFinding) => `${f.file}${f.line ? `:${f.line}` : ''}`;

/** findings.md, saved as evidence. */
export function findingsMarkdown(task: Pick<Task, 'id' | 'title'>, round: number, v: VerdictInput): string {
  const lines = [`# QA round ${round} of ${MAX_QA_ROUNDS}: ${v.score}/5`, '', `${task.id} ${task.title}`, '', v.summary, '', '## Rubric', ...RUBRIC_KEYS.map((k) => `- ${k}: ${v.rubric[k]}/5`), ''];
  if (v.findings.length) lines.push('## Findings', ...v.findings.map((f) => `- [ ] ${where(f)}: ${f.problem}\n  Fix: ${f.fix}`), '');
  return lines.join('\n');
}

const checklist = (findings: QaFinding[]) => findings.map((f) => `- [ ] ${where(f)}: ${f.problem} -> ${f.fix}`).join('\n');

/** The station before qa that an agent works (a human approval station can't take it back), and its last holder if free. */
function builderStation(state: MusterState, task: Task, roles?: Record<string, Role>): { index: number; holder?: Agent } {
  let index = task.stations.indexOf(QA_STATION) - 1;
  while (index > 0 && stationRole(task.stations[index], roles) === 'human') index--;
  index = Math.max(0, index);
  const role = stationRole(task.stations[index], roles);
  const last = [...task.history].reverse().find((e) => e.kind === 'handoff' && e.agentId !== HUMAN && e.agentId !== SYSTEM && findAgent(state, e.agentId)?.role === role);
  const holder = last && findAgent(state, last.agentId);
  return { index, holder: holder && holder.status !== 'stopped' && !heldTask(state, holder) ? holder : undefined };
}

export interface QaResult {
  task: Task;
  outcome: QaOutcome;
  round: number;
  builder?: Agent;
}

/**
 * Records the verdict on task.qa and moves the task: 5/5 on to review; 1-4 back to the builder with the findings
 * (rounds 1 and 2), or parked with the Captain, escalated, after the third failed round.
 */
export function recordQaVerdict(state: MusterState, taskId: string, actor: string, v: VerdictInput, opts: { from?: StationBranch; roles?: Record<string, Role> } = {}): QaResult {
  const task = requireTask(state, taskId);
  assertQaHolder(state, task, actor);
  const at = new Date().toISOString();
  const round = (task.qa?.round ?? 0) + 1;
  task.qa = {
    round,
    last: { score: v.score, at, findings: v.findings, rubric: v.rubric },
    history: [...(task.qa?.history ?? []), { round, score: v.score, at }],
  };
  const head = `QA round ${round}/${MAX_QA_ROUNDS}: score ${v.score}/5`;

  if (v.score === 5) {
    doneTask(state, task.id, actor, `${head}. ${v.summary}`, opts.from, opts.roles);
    return { task, outcome: 'passed', round };
  }

  if (round >= MAX_QA_ROUNDS) {
    task.qa.escalated = true;
    event(task, actor, 'note', `${head}: failed QA ${MAX_QA_ROUNDS} times, parked with the Captain`);
    toReview(state, task, actor, `${task.id} ${task.title} failed QA ${MAX_QA_ROUNDS} times (last ${v.score}/5). Read the reports in its evidence, then send_back with guidance (this resets the QA rounds) or cancel_task.`);
    addFeed(state, { kind: 'event', from: actor, taskId: task.id, text: `${task.id} failed QA ${MAX_QA_ROUNDS} times (${v.score}/5): escalated` });
    return { task, outcome: 'escalated', round };
  }

  const { index, holder } = builderStation(state, task, opts.roles);
  const station = task.stations[index];
  release(state, task);
  task.stationIndex = index;
  task.reviewedSha = undefined;
  task.mergeApproval = undefined;
  event(task, actor, 'note', `${head}, back to ${station}`);
  const body = `${head} - fix these:\n${checklist(v.findings)}\n\n${v.summary}\nHand it off again when they are done: it returns to QA.`;
  if (holder) {
    takeTask(state, task, holder);
    addInbox(state, { agentId: holder.id, from: actor, kind: 'handoff', taskId: task.id, text: `${task.id} ${task.title} came back from QA (${station}). ${body}` });
  } else {
    task.assignee = undefined;
    task.status = 'ready';
    announceReady(state, task, actor, opts.roles);
  }
  const captain = captainOf(state);
  if (captain && captain.id !== holder?.id) addInbox(state, { agentId: captain.id, from: actor, kind: 'system', taskId: task.id, text: `${head} on ${task.id} ${task.title}: sent back to ${holder?.id ?? 'any ' + stationRole(station, opts.roles)}.` });
  addFeed(state, { kind: 'event', from: actor, to: holder?.id, taskId: task.id, text: `${head} on ${task.id}: back to ${station}` });
  for (const n of state.notes) if (n.type === 'review' && n.taskId === task.id) closeNoteIfOpen(n);
  return { task, outcome: 'sent_back', round, builder: holder };
}

/** The escalation note: every round's report (findings.md of each qa evidence entry, oldest first). */
export function escalationText(task: Task, reports: string[]): string {
  return `${task.id} ${task.title} failed QA ${MAX_QA_ROUNDS} times and is parked with the Captain. send_back with guidance (resets the QA rounds) or cancel_task.\n\n${reports.join('\n\n---\n\n')}`;
}
