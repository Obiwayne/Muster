// Task board: creation, dependencies, claiming, stations, review and send-back.
// Pure state mutations; git side effects (branch merges/renames) live in the API layer.
import { STATION_ROLE, type Agent, type MusterConfig, type MusterState, type Note, type Role, type Task, type TaskBranchInput, type TaskEvent } from '../types.js';
import { addFeed, addInbox, captainOf, closeNoteIfOpen, findAgent, HUMAN, idNum, isCaptain, nowIso, postNote, replyNote, requireActor, requireAgent, SYSTEM } from './board.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { activateGoal, advanceRoadmap, remindUnlinked, goalForTask } from './roadmap.js';
import { nextId } from './store.js';
import { assertNotPaused } from './usage.js';

/** Which role works a station: `roles` (from the station files) first, then the built-in defaults; unknown stations are crew. */
export const stationRole = (station: string, roles: Record<string, Role> = {}): Role => (station === 'review' ? 'captain' : (roles[station] ?? STATION_ROLE[station] ?? 'crew'));

export function currentStation(task: Task): string {
  return task.stations[task.stationIndex] ?? 'review';
}

export function requireTask(state: MusterState, id: string): Task {
  const t = state.tasks.find((x) => x.id === String(id).toUpperCase());
  if (!t) throw notFound(`No task "${id}"`);
  return t;
}

function event(task: Task, agentId: string, kind: TaskEvent['kind'], text?: string): void {
  const at = nowIso();
  task.history.push({ at, agentId, kind, ...(text ? { text } : {}) });
  task.updatedAt = at;
}

const OPEN_STATUSES = new Set(['blocked', 'ready']);

function depsMet(state: MusterState, task: Task): boolean {
  return task.dependsOn.every((d) => {
    const dep = state.tasks.find((x) => x.id === d);
    return !dep || dep.status === 'ready_for_merge' || dep.status === 'merged';
  });
}

/** blocked ⇄ ready/in_progress depending on whether every dependency reached ready_for_merge or merged. */
export function recomputeReadiness(state: MusterState): void {
  for (const t of state.tasks) {
    if (!OPEN_STATUSES.has(t.status)) continue;
    t.status = !depsMet(state, t) ? 'blocked' : t.assignee ? 'in_progress' : 'ready';
  }
}

function requireCaptainOrYou(state: MusterState, actor: string, what: string): void {
  if (actor !== HUMAN && !isCaptain(state, actor)) throw forbidden(`Only the Captain or you can ${what}`);
}

/** The task an agent is actively holding (in progress, or assigned and waiting on dependencies). */
export function heldTask(state: MusterState, agent: Agent): Task | undefined {
  if (!agent.taskId) return undefined;
  const t = state.tasks.find((x) => x.id === agent.taskId);
  return t && t.assignee === agent.id && (t.status === 'in_progress' || t.status === 'blocked' || t.status === 'ready') ? t : undefined;
}

/** One task per agent: refuses when the agent holds a different task that isn't done or in review. */
export function assertCanTake(state: MusterState, agent: Agent, task?: Task): void {
  if (agent.role === 'research') throw conflict(`${agent.id} is the research agent; it never takes tasks`);
  const held = heldTask(state, agent);
  if (held && held.id !== task?.id) {
    throw conflict(`${agent.id} already holds ${held.id} ${held.title} (${held.status}); it has to hand it off or report it done before taking ${task?.id ?? 'another task'}`);
  }
}

/** The branch a finishing station hands on: its name and head commit (already checked to contain the task's inputs). */
export interface StationBranch {
  branch: string;
  sha: string;
}

export interface TaskInput {
  title: string;
  description?: string;
  dependsOn?: string[];
  stations?: string[];
  line?: string; // the line the stations came from, recorded on the task
  assignee?: string;
  goalId?: string; // roadmap goal the task delivers (404 unknown; a planned goal becomes active)
  actor: string;
}

export function createTask(state: MusterState, config: MusterConfig, input: TaskInput, roles?: Record<string, Role>): Task {
  const actor = requireActor(state, input.actor);
  if (!input.title?.trim()) throw badRequest('Task title is empty');
  const dependsOn = (input.dependsOn ?? []).map((d) => requireTask(state, d).id);
  const goal = input.goalId ? goalForTask(state, input.goalId) : undefined;
  // Everything that can refuse happens before the task exists, so a 409 leaves nothing half-created.
  if (input.assignee) {
    requireCaptainOrYou(state, actor, 'assign tasks');
    assertNotPaused(state);
    assertCanTake(state, requireAgent(state, input.assignee));
  }
  const stations = (input.stations?.length ? input.stations : config.defaultStations).map((s) => s.trim().toLowerCase()).filter((s) => s && s !== 'review');
  const at = nowIso();
  const task: Task = {
    id: nextId(state, 'task'),
    title: input.title.trim(),
    description: input.description?.trim() ?? '',
    dependsOn,
    ...(input.line ? { line: input.line } : {}),
    ...(goal ? { goalId: goal.id } : {}),
    stations: [...stations, 'review'],
    stationIndex: 0,
    status: 'ready',
    createdBy: actor,
    createdAt: at,
    updatedAt: at,
    history: [],
  };
  event(task, actor, 'created');
  state.tasks.push(task);
  addFeed(state, { kind: 'event', from: actor, taskId: task.id, text: `posted ${task.id} ${task.title}${goal ? ` (goal ${goal.id})` : ''}` });
  if (goal?.status === 'planned') activateGoal(goal);
  if (stationRole(currentStation(task), roles) === 'human') awaitApproval(state, task, actor, 'the task starts at an approval station');
  else if (input.assignee) assignTask(state, task.id, input.assignee, actor);
  recomputeReadiness(state);
  return task;
}

/**
 * Gives the task to an agent at its current station. The branch is settled afterwards by
 * AgentManager.syncTaskBranch (a fresh branch per task, with the previous station's work merged in).
 */
function takeTask(state: MusterState, task: Task, agent: Agent): void {
  task.assignee = agent.id;
  task.status = depsMet(state, task) ? 'in_progress' : 'blocked';
  task.reviewedSha = undefined;
  agent.taskId = task.id;
}

/** Stuck notes the orchestrator posts for an agent when merging a task's inputs into its branch conflicts. */
export const MERGE_CONFLICT = 'Merge conflict:';

/** The station branch was checked to contain every input, so the conflicts reported for the task are resolved. */
function closeMergeConflicts(state: MusterState, task: Task): void {
  for (const n of state.notes) if (n.type === 'stuck' && n.taskId === task.id && n.text.startsWith(MERGE_CONFLICT)) closeNoteIfOpen(n);
}

/** Undoes a take whose branch setup failed: the task goes back on the board. */
export function untake(state: MusterState, task: Task, agent: Agent, reason: string): void {
  if (task.assignee === agent.id) task.assignee = undefined;
  if (agent.taskId === task.id) agent.taskId = undefined;
  if (task.status === 'in_progress' || task.status === 'blocked') task.status = 'ready';
  event(task, 'muster', 'note', `not given to ${agent.id}: ${reason}`);
  recomputeReadiness(state);
}

function release(state: MusterState, task: Task): void {
  const holder = task.assignee ? findAgent(state, task.assignee) : undefined;
  if (holder?.taskId === task.id) holder.taskId = undefined;
}

/** The task claim_task would give this agent (no changes made). */
export function nextClaimable(state: MusterState, agent: Agent, roles?: Record<string, Role>): Task | undefined {
  return state.tasks
    .filter((t) => !t.assignee && (t.status === 'ready' || (t.status === 'blocked' && depsMet(state, t))) && stationRole(currentStation(t), roles) === agent.role)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || idNum(a.id) - idNum(b.id))[0];
}

export function claimTask(state: MusterState, actor: string, roles?: Record<string, Role>): Task | null {
  const agent = requireAgent(state, actor);
  assertNotPaused(state);
  assertCanTake(state, agent);
  recomputeReadiness(state);
  const task = nextClaimable(state, agent, roles);
  if (!task) return null;
  takeTask(state, task, agent);
  event(task, agent.id, 'claimed');
  addFeed(state, { kind: 'event', from: agent.id, taskId: task.id, text: `claimed ${task.id} ${task.title} (${currentStation(task)})` });
  return task;
}

export function assignTask(state: MusterState, taskId: string, agentId: string, actor: string): Task {
  requireCaptainOrYou(state, actor, 'assign tasks');
  assertNotPaused(state);
  const task = requireTask(state, taskId);
  const agent = requireAgent(state, agentId);
  if (task.status === 'merged' || task.status === 'cancelled') throw conflict(`${task.id} is ${task.status}`);
  assertCanTake(state, agent, task);
  if (task.assignee && task.assignee !== agent.id) release(state, task);
  takeTask(state, task, agent);
  event(task, agent.id, 'assigned', `by ${actor}`);
  addInbox(state, { agentId: agent.id, from: actor, kind: 'assignment', taskId: task.id, text: `${actor} assigned you ${task.id} ${task.title}` });
  addFeed(state, { kind: 'event', from: actor, to: agent.id, taskId: task.id, text: `assigned ${task.id} ${task.title} to ${agent.id}` });
  return task;
}

function requireHolder(state: MusterState, task: Task, actor: string): void {
  if (task.assignee !== actor && actor !== HUMAN && !isCaptain(state, actor)) {
    throw forbidden(`${task.id} is held by ${task.assignee ?? 'nobody'}, not ${actor}`);
  }
}

/** Moves the task to its review station, held by the Captain. */
function toReview(state: MusterState, task: Task, from: string, text: string): void {
  release(state, task);
  const captain = captainOf(state);
  task.stationIndex = task.stations.length - 1;
  task.status = 'review';
  task.assignee = captain?.id;
  if (captain) addInbox(state, { agentId: captain.id, from, kind: 'review', taskId: task.id, text });
}

/** Tell free agents of the station's role, so the task doesn't wait for the Captain to route it. */
function announceReady(state: MusterState, task: Task, actor: string, roles?: Record<string, Role>): void {
  const station = currentStation(task);
  const role = stationRole(station, roles);
  let told = 0;
  for (const a of state.agents) {
    if (a.id === actor || a.role !== role || a.status === 'stopped' || a.taskId) continue;
    addInbox(state, { agentId: a.id, from: actor, kind: 'handoff', taskId: task.id, text: `${task.id} ${task.title} is ready at the ${station} station: call claim_task` });
    told++;
  }
  // Nobody free to pick it up (e.g. the only crew agent just handed it on): the Captain decides who takes it.
  const captain = captainOf(state);
  if (!told && captain && captain.id !== actor) {
    addInbox(state, {
      agentId: captain.id,
      from: actor,
      kind: 'handoff',
      taskId: task.id,
      text: `${task.id} ${task.title} is ready at the ${station} station and no free ${role === 'design' ? 'design crew' : role} agent was told. assign it (${actor} may take it if nobody else can), or spawn_crew if the crew limit allows.`,
    });
  }
}

const closeApprovals = (state: MusterState, task: Task): void => {
  for (const n of state.notes) if (n.type === 'approval' && n.taskId === task.id) closeNoteIfOpen(n);
};

/** The task reached a 'human' station: nobody holds or claims it; an open approval note waits for you (Approve / Reject). */
function awaitApproval(state: MusterState, task: Task, actor: string, noteText: string): Note {
  release(state, task);
  task.assignee = undefined;
  task.status = 'awaiting_approval';
  closeApprovals(state, task);
  const station = currentStation(task);
  const note = postNote(state, { actor, type: 'approval', taskId: task.id, to: HUMAN, text: `${task.id} ${task.title} waits for your approval at the ${station} station: ${noteText}` });
  addFeed(state, { kind: 'event', from: actor, to: HUMAN, taskId: task.id, text: `${task.id} waits for your approval (${station})` });
  return note;
}

/** The task's open approval note (what the board shows Approve / Reject on). */
export const approvalNote = (state: MusterState, task: Task): Note | undefined =>
  [...state.notes].reverse().find((n) => n.type === 'approval' && n.taskId === task.id && n.open);

function requireAwaitingApproval(state: MusterState, taskId: string, actor: string, what: string): Task {
  if (actor !== HUMAN) throw forbidden(`Only you can ${what}`);
  const task = requireTask(state, taskId);
  if (task.status !== 'awaiting_approval') throw conflict(`${task.id} is ${task.status}, not awaiting approval`);
  return task;
}

/** Puts the task at its (new) current station: the human's approval, a free agent of the role, or the Captain's review. */
function arrive(state: MusterState, task: Task, actor: string, text: string, roles?: Record<string, Role>): void {
  const station = currentStation(task);
  if (station === 'review') toReview(state, task, actor, `${actor} approved ${task.id} ${task.title}: ${text}`);
  else if (stationRole(station, roles) === 'human') awaitApproval(state, task, actor, text);
  else {
    release(state, task);
    task.assignee = undefined;
    task.status = 'ready';
    announceReady(state, task, actor, roles);
  }
}

/** You approve the task at a 'human' station; it moves on to the next station (or the Captain's review). Only you. */
export function approveTask(state: MusterState, taskId: string, actor: string, note: string, roles?: Record<string, Role>): Task {
  const task = requireAwaitingApproval(state, taskId, actor, 'approve');
  const text = note?.trim() || 'Approved';
  closeApprovals(state, task);
  task.stationIndex = Math.min(task.stationIndex + 1, task.stations.length - 1);
  const station = currentStation(task);
  event(task, actor, 'handoff', `approved, to ${station === 'review' ? 'review' : 'any ' + stationRole(station, roles)}: ${text}`);
  addFeed(state, { kind: 'event', from: actor, taskId: task.id, text: `approved ${task.id} ${task.title}: ${text}` });
  const captain = captainOf(state);
  if (captain && station !== 'review') addInbox(state, { agentId: captain.id, from: actor, kind: 'system', taskId: task.id, text: `${actor} approved ${task.id} ${task.title}: ${text}` });
  arrive(state, task, actor, text, roles);
  recomputeReadiness(state);
  return task;
}

/** Who last handed the task into its current station, if that agent can still take it back. */
export function rejectTarget(state: MusterState, task: Task, roles?: Record<string, Role>): Agent | undefined {
  const prev = task.stations[task.stationIndex - 1];
  if (!prev || prev === 'review' || stationRole(prev, roles) === 'human') return undefined;
  const last = [...task.history].reverse().find((e) => e.kind === 'handoff' && e.agentId !== HUMAN && e.agentId !== SYSTEM);
  const a = last && findAgent(state, last.agentId);
  if (!a || a.status === 'stopped' || a.role !== stationRole(prev, roles) || heldTask(state, a)) return undefined;
  return a;
}

/** You reject the task at a 'human' station: it goes back to the previous station and that station's last holder (else any agent of its role). */
export function rejectTask(state: MusterState, taskId: string, actor: string, note: string, roles?: Record<string, Role>): Task {
  const task = requireAwaitingApproval(state, taskId, actor, 'reject');
  const text = note?.trim();
  if (!text) throw badRequest('Say what needs to change: a reject note is required');
  if (task.stationIndex < 1) throw conflict(`${task.id} has no earlier station to go back to`);
  const approval = approvalNote(state, task);
  const holder = rejectTarget(state, task, roles);
  if (approval) replyNote(state, approval.id, actor, text, true);
  closeApprovals(state, task);
  task.stationIndex -= 1;
  const station = currentStation(task);
  event(task, actor, 'note', `rejected, back to ${station}: ${text}`);
  addFeed(state, { kind: 'event', from: actor, to: holder?.id, taskId: task.id, text: `rejected ${task.id} ${task.title}, back to ${station}: ${text}` });
  const captain = captainOf(state);
  if (captain && captain.id !== holder?.id) addInbox(state, { agentId: captain.id, from: actor, kind: 'system', taskId: task.id, text: `${actor} rejected ${task.id} ${task.title}, back to ${station}: ${text}` });
  if (holder) {
    takeTask(state, task, holder);
    addInbox(state, { agentId: holder.id, from: actor, kind: 'handoff', taskId: task.id, text: `${actor} rejected ${task.id} ${task.title} and sent it back to you (${station}): ${text}` });
  } else arrive(state, task, actor, text, roles);
  recomputeReadiness(state);
  return task;
}

export interface HandoffResult {
  task: Task;
  /** Branch that carried the work before the handoff; the receiver's worktree should merge it. */
  fromBranch?: string;
  receiver?: Agent;
}

/**
 * Moves the task to its next station. `from` is the finishing station's branch (checked by the caller
 * to contain the task's inputs); it becomes the task branch and an input every later branch must contain.
 */
export function handoffTask(state: MusterState, taskId: string, actor: string, to: string | undefined, note: string, from?: StationBranch, roles?: Record<string, Role>): HandoffResult {
  requireActor(state, actor);
  const task = requireTask(state, taskId);
  requireHolder(state, task, actor);
  if (task.status !== 'in_progress') throw conflict(`${task.id} is ${task.status}, not in progress`);
  const receiver = to ? requireAgent(state, to) : undefined;
  if (receiver) assertCanTake(state, receiver, task);
  if (from) {
    task.branch = from.branch;
    addInput(task, { branch: from.branch, sha: from.sha, kind: 'station' });
    closeMergeConflicts(state, task);
  }
  const fromBranch = task.branch;
  task.stationIndex = Math.min(task.stationIndex + 1, task.stations.length - 1);
  const station = currentStation(task);
  const noteText = note?.trim() || '(no note)';
  event(task, actor, 'handoff', `to ${station === 'review' ? 'review' : (receiver?.id ?? 'any ' + stationRole(station, roles))}: ${noteText}`);

  if (station === 'review') {
    toReview(state, task, actor, `${actor} handed ${task.id} ${task.title} to review: ${noteText}`);
    addFeed(state, { kind: 'event', from: actor, to: task.assignee, taskId: task.id, text: `handed ${task.id} to review: ${noteText}` });
    return { task, fromBranch };
  }

  release(state, task);
  task.assignee = undefined;
  if (stationRole(station, roles) === 'human') {
    awaitApproval(state, task, actor, noteText);
    return { task, fromBranch };
  }
  if (receiver) {
    takeTask(state, task, receiver);
    addInbox(state, { agentId: receiver.id, from: actor, kind: 'handoff', taskId: task.id, text: `${actor} handed you ${task.id} ${task.title} (${station}): ${noteText}` });
  } else {
    task.status = 'ready';
    announceReady(state, task, actor, roles);
  }
  addFeed(state, { kind: 'event', from: actor, to: receiver?.id, taskId: task.id, text: `handed ${task.id} to ${receiver?.id ?? 'the ' + station + ' station'}: ${noteText}` });
  return { task, fromBranch, receiver };
}

export function doneTask(state: MusterState, taskId: string, actor: string, summary: string, from?: StationBranch, roles?: Record<string, Role>): Task {
  requireActor(state, actor);
  const task = requireTask(state, taskId);
  requireHolder(state, task, actor);
  if (task.status !== 'in_progress') throw conflict(`${task.id} is ${task.status}, not in progress`);
  const text = summary?.trim() || 'Done';
  // "Done" finishes this station, not the whole line: with stations still to go (e.g. test, design),
  // the task goes on to the next one rather than jumping straight to the Captain.
  if (task.stations[task.stationIndex + 1] !== 'review' && task.stationIndex < task.stations.length - 1) {
    postNote(state, { actor, type: 'done', taskId: task.id, text: `${task.id} ${task.title} (${currentStation(task)}): ${text}` });
    return handoffTask(state, taskId, actor, undefined, text, from, roles).task;
  }
  if (from) {
    task.branch = from.branch;
    closeMergeConflicts(state, task);
  }
  event(task, actor, 'done', text);
  postNote(state, { actor, type: 'done', taskId: task.id, text: `${task.id} ${task.title}: ${text}` });
  toReview(state, task, actor, `${actor} finished ${task.id} ${task.title}: ${text}`);
  return task;
}

/** Statuses from which the Captain may flag a task; ready_for_merge again = re-review after new commits. */
const REVIEWABLE = new Set(['review', 'in_progress', 'ready_for_merge']);

/** `reviewed` = the task branch and its head commit now; the human's merge merges exactly that commit. */
export function requestReview(state: MusterState, taskId: string, actor: string, summary: string, reviewed?: StationBranch, opts: { requireEvidence?: boolean } = {}): { task: Task; note: Note } {
  if (!isCaptain(state, actor)) throw forbidden('Only the Captain can request review');
  const task = requireTask(state, taskId);
  if (!REVIEWABLE.has(task.status)) throw conflict(`${task.id} is ${task.status}; only work in review or in progress can be flagged ready for merge`);
  if (opts.requireEvidence && !task.evidence?.length) {
    throw conflict(`${task.id} has no evidence yet. Send it back so its last station attaches proof with add_evidence (screenshots, test output, numbers), or test it yourself and call add_evidence(task: "${task.id}", files, summary) before request_review.`);
  }
  release(state, task);
  for (const n of state.notes) if (n.type === 'review' && n.taskId === task.id) closeNoteIfOpen(n);
  task.stationIndex = task.stations.length - 1;
  task.status = 'ready_for_merge';
  if (reviewed) {
    task.branch = reviewed.branch;
    closeMergeConflicts(state, task);
  }
  task.reviewedSha = reviewed?.sha;
  task.mergeApproval = undefined;
  event(task, actor, 'review_requested', summary);
  const note = postNote(state, {
    actor,
    type: 'review',
    taskId: task.id,
    to: HUMAN,
    text: `Ready for review: ${task.id} ${task.title}${task.branch ? ` (${task.branch})` : ''}. ${summary?.trim() ?? ''}`.trim(),
  });
  // The reviewed commit is what gets merged: tell whoever owns the branch to leave it alone now.
  for (const a of state.agents) {
    if (a.role === 'captain' || a.branch !== task.branch) continue;
    addInbox(state, { agentId: a.id, from: actor, kind: 'system', taskId: task.id, text: `${task.id} is flagged ready for merge at ${reviewed?.sha?.slice(0, 8) ?? 'its current commit'}. Don't commit to ${task.branch} any more; if it needs a change, ask the Captain to send it back.` });
  }
  recomputeReadiness(state);
  return { task, note };
}

/**
 * The branch moved after the Captain's review, so the reviewed commit is no longer what's on it.
 * Back to the Captain's review station (instead of leaving the human to chase it); returns who moved it.
 */
export function reviewAgain(state: MusterState, task: Task, head: string): string {
  const mover = state.agents.find((a) => a.branch === task.branch && a.role !== 'captain')?.id ?? 'someone';
  for (const n of state.notes) if (n.type === 'review' && n.taskId === task.id) closeNoteIfOpen(n);
  const text = `${task.id} ${task.title}: ${mover} committed to ${task.branch} after your review (now ${head.slice(0, 8)}, you reviewed ${task.reviewedSha?.slice(0, 8) ?? '?'}). Review the branch again: get_diff, run_tests, then request_review or send_back.`;
  task.reviewedSha = undefined;
  task.mergeApproval = undefined;
  toReview(state, task, SYSTEM, text);
  event(task, SYSTEM, 'note', `re-review: ${task.branch} moved to ${head.slice(0, 8)} after review`);
  addFeed(state, { kind: 'event', from: SYSTEM, taskId: task.id, text: `sent ${task.id} back to the Captain for re-review: ${mover} committed after the review` });
  return mover;
}

/**
 * You looked at the Captain's review and are happy: the Captain may now merge exactly the reviewed
 * commit with merge_task (and push it). A later review or send-back drops the approval.
 */
export function approveMerge(state: MusterState, taskId: string, actor: string): Task {
  if (actor !== HUMAN) throw forbidden('Only you can approve a merge');
  const task = requireTask(state, taskId);
  if (task.status !== 'ready_for_merge') throw conflict(`${task.id} is ${task.status}, not ready for merge (the Captain has not flagged it)`);
  if (task.mergeApproval) return task;
  task.mergeApproval = { at: nowIso(), ...(task.reviewedSha ? { sha: task.reviewedSha } : {}) };
  event(task, actor, 'note', 'approved for merge');
  const captain = captainOf(state);
  if (captain) {
    addInbox(state, { agentId: captain.id, from: HUMAN, kind: 'review', taskId: task.id, text: `The user reviewed ${task.id} ${task.title} and is happy with it. Merge it now with merge_task(task: "${task.id}"); it merges the commit you reviewed and pushes it to GitHub. If it fails, fix the cause (send_back for a conflict) or tell the user what failed.` });
  }
  addFeed(state, { kind: 'event', from: actor, to: captain?.id, taskId: task.id, text: `approved ${task.id} ${task.title} for merge` });
  return task;
}

/** The agent that first took the task at its build station. */
export function builderOf(state: MusterState, task: Task): Agent | undefined {
  for (const e of task.history) {
    if (e.kind !== 'claimed' && e.kind !== 'assigned') continue;
    const a = findAgent(state, e.agentId);
    if (a && a.role !== 'captain') return a;
  }
  return undefined;
}

/** Drops a task that is no longer wanted: it leaves the board and nobody can claim it. Captain or you. */
export function cancelTask(state: MusterState, taskId: string, actor: string, reason: string): Task {
  requireCaptainOrYou(state, actor, 'cancel tasks');
  const task = requireTask(state, taskId);
  if (task.status === 'merged' || task.status === 'cancelled') throw conflict(`${task.id} is already ${task.status}`);
  const holder = task.assignee;
  release(state, task);
  task.assignee = undefined;
  task.status = 'cancelled';
  const why = reason?.trim() || 'no longer needed';
  event(task, actor, 'cancelled', why);
  for (const n of state.notes) if (n.taskId === task.id) closeNoteIfOpen(n);
  if (holder && holder !== actor && !isCaptain(state, holder)) {
    addInbox(state, { agentId: holder, from: actor, kind: 'system', taskId: task.id, text: `${actor} cancelled ${task.id} ${task.title}: ${why}. Stop work on it and call claim_task.` });
  }
  addFeed(state, { kind: 'event', from: actor, taskId: task.id, text: `cancelled ${task.id} ${task.title}: ${why}` });
  recomputeReadiness(state);
  advanceRoadmap(state); // the goal's other tasks may all be merged now
  return task;
}

export function sendBack(state: MusterState, taskId: string, actor: string, note: string): Task {
  requireCaptainOrYou(state, actor, 'send work back');
  const task = requireTask(state, taskId);
  if (task.status === 'merged' || task.status === 'cancelled') throw conflict(`${task.id} is ${task.status}`);
  const text = note?.trim() || 'Needs more work';
  const builder = builderOf(state, task);
  if (builder) assertCanTake(state, builder, task);
  release(state, task);
  task.reviewedSha = undefined;
  task.mergeApproval = undefined;
  task.stationIndex = Math.max(0, task.stations.indexOf('build'));
  for (const n of state.notes) if ((n.type === 'review' || n.type === 'approval') && n.taskId === task.id) closeNoteIfOpen(n);
  event(task, actor, 'note', `sent back: ${text}`);

  if (builder) {
    takeTask(state, task, builder);
    addInbox(state, { agentId: builder.id, from: actor, kind: 'handoff', taskId: task.id, text: `${actor} sent ${task.id} ${task.title} back to you: ${text}` });
  } else {
    task.assignee = undefined;
    task.status = 'ready';
  }
  addFeed(state, { kind: 'event', from: actor, to: builder?.id, taskId: task.id, text: `sent ${task.id} back: ${text}` });
  return task;
}

/** Records a commit the task branch must contain (one entry per branch and kind; the latest commit wins). */
export function addInput(task: Task, input: TaskBranchInput): void {
  const inputs = (task.inputs ??= []);
  const i = inputs.findIndex((x) => x.branch === input.branch && x.kind === input.kind);
  if (i >= 0) inputs[i] = input;
  else inputs.push(input);
}

export function markMerged(state: MusterState, task: Task, actor: string): void {
  task.status = 'merged';
  task.assignee = undefined;
  event(task, actor, 'merged');
  for (const n of state.notes) if (n.type === 'review' && n.taskId === task.id) closeNoteIfOpen(n);
  addFeed(state, { kind: 'event', from: actor, taskId: task.id, text: `merged ${task.id} ${task.title}${task.branch ? ` (${task.branch})` : ''}` });
  recomputeReadiness(state);
  advanceRoadmap(state);
  remindUnlinked(state, task.id);
}

/** True when the agent's latest task action was finishing or handing on, and it holds nothing now. */
export function hasReportedDone(state: MusterState, agent: Agent): boolean {
  if (agent.taskId) return false;
  let last: TaskEvent | undefined;
  for (const t of state.tasks) for (const e of t.history) if (e.agentId === agent.id && (!last || e.at >= last.at)) last = e;
  return last?.kind === 'done' || last?.kind === 'handoff';
}
