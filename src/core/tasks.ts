// Task board: creation, dependencies, claiming, stations, review and send-back.
// Pure state mutations; git side effects (branch merges/renames) live in the API layer.
import { STATION_ROLE, type Agent, type MusterConfig, type MusterState, type Note, type Role, type Task, type TaskEvent } from '../types.js';
import { addFeed, addInbox, captainOf, closeNoteIfOpen, findAgent, HUMAN, idNum, isCaptain, nowIso, postNote, requireActor, requireAgent } from './board.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { nextId } from './store.js';
import { assertNotPaused } from './usage.js';

export const stationRole = (station: string): Role => STATION_ROLE[station] ?? 'crew';

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

export interface TaskInput {
  title: string;
  description?: string;
  dependsOn?: string[];
  stations?: string[];
  assignee?: string;
  actor: string;
}

export function createTask(state: MusterState, config: MusterConfig, input: TaskInput): Task {
  const actor = requireActor(state, input.actor);
  if (!input.title?.trim()) throw badRequest('Task title is empty');
  const dependsOn = (input.dependsOn ?? []).map((d) => requireTask(state, d).id);
  const stations = (input.stations?.length ? input.stations : config.defaultStations).map((s) => s.trim().toLowerCase()).filter((s) => s && s !== 'review');
  const at = nowIso();
  const task: Task = {
    id: nextId(state, 'task'),
    title: input.title.trim(),
    description: input.description?.trim() ?? '',
    dependsOn,
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
  addFeed(state, { kind: 'event', from: actor, taskId: task.id, text: `posted ${task.id} ${task.title}` });
  if (input.assignee) assignTask(state, task.id, input.assignee, actor);
  recomputeReadiness(state);
  return task;
}

/** Gives the task to an agent at its current station. */
function takeTask(state: MusterState, task: Task, agent: Agent): void {
  task.assignee = agent.id;
  task.branch ??= agent.branch;
  task.status = depsMet(state, task) ? 'in_progress' : 'blocked';
  agent.taskId = task.id;
}

function release(state: MusterState, task: Task): void {
  const holder = task.assignee ? findAgent(state, task.assignee) : undefined;
  if (holder?.taskId === task.id) holder.taskId = undefined;
}

export function claimTask(state: MusterState, actor: string): Task | null {
  const agent = requireAgent(state, actor);
  assertNotPaused(state);
  recomputeReadiness(state);
  const task = state.tasks
    .filter((t) => t.status === 'ready' && stationRole(currentStation(t)) === agent.role)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || idNum(a.id) - idNum(b.id))[0];
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

export interface HandoffResult {
  task: Task;
  /** Branch that carried the work before the handoff; the receiver's worktree should merge it. */
  fromBranch?: string;
  receiver?: Agent;
}

export function handoffTask(state: MusterState, taskId: string, actor: string, to: string | undefined, note: string): HandoffResult {
  requireActor(state, actor);
  const task = requireTask(state, taskId);
  requireHolder(state, task, actor);
  if (task.status !== 'in_progress') throw conflict(`${task.id} is ${task.status}, not in progress`);
  const fromBranch = task.branch;
  const receiver = to ? requireAgent(state, to) : undefined;
  task.stationIndex = Math.min(task.stationIndex + 1, task.stations.length - 1);
  const station = currentStation(task);
  const noteText = note?.trim() || '(no note)';
  event(task, actor, 'handoff', `to ${station === 'review' ? 'review' : (receiver?.id ?? 'any ' + stationRole(station))}: ${noteText}`);

  if (station === 'review') {
    toReview(state, task, actor, `${actor} handed ${task.id} ${task.title} to review: ${noteText}`);
    addFeed(state, { kind: 'event', from: actor, to: task.assignee, taskId: task.id, text: `handed ${task.id} to review: ${noteText}` });
    return { task, fromBranch };
  }

  release(state, task);
  task.assignee = undefined;
  if (receiver) {
    takeTask(state, task, receiver);
    addInbox(state, { agentId: receiver.id, from: actor, kind: 'handoff', taskId: task.id, text: `${actor} handed you ${task.id} ${task.title} (${station}): ${noteText}` });
  } else {
    task.status = 'ready';
  }
  addFeed(state, { kind: 'event', from: actor, to: receiver?.id, taskId: task.id, text: `handed ${task.id} to ${receiver?.id ?? 'the ' + station + ' station'}: ${noteText}` });
  return { task, fromBranch, receiver };
}

export function doneTask(state: MusterState, taskId: string, actor: string, summary: string): Task {
  requireActor(state, actor);
  const task = requireTask(state, taskId);
  requireHolder(state, task, actor);
  if (task.status !== 'in_progress') throw conflict(`${task.id} is ${task.status}, not in progress`);
  const text = summary?.trim() || 'Done';
  event(task, actor, 'done', text);
  postNote(state, { actor, type: 'done', taskId: task.id, text: `${task.id} ${task.title}: ${text}` });
  toReview(state, task, actor, `${actor} finished ${task.id} ${task.title}: ${text}`);
  return task;
}

export function requestReview(state: MusterState, taskId: string, actor: string, summary: string): { task: Task; note: Note } {
  if (!isCaptain(state, actor)) throw forbidden('Only the Captain can request review');
  const task = requireTask(state, taskId);
  if (task.status === 'merged' || task.status === 'cancelled') throw conflict(`${task.id} is ${task.status}`);
  release(state, task);
  task.stationIndex = task.stations.length - 1;
  task.status = 'ready_for_merge';
  event(task, actor, 'review_requested', summary);
  const note = postNote(state, {
    actor,
    type: 'review',
    taskId: task.id,
    to: HUMAN,
    text: `Ready for review: ${task.id} ${task.title}${task.branch ? ` (${task.branch})` : ''}. ${summary?.trim() ?? ''}`.trim(),
  });
  recomputeReadiness(state);
  return { task, note };
}

/** The agent that first took the task at its build station. */
function builderOf(state: MusterState, task: Task): Agent | undefined {
  for (const e of task.history) {
    if (e.kind !== 'claimed' && e.kind !== 'assigned') continue;
    const a = findAgent(state, e.agentId);
    if (a && a.role !== 'captain') return a;
  }
  return undefined;
}

export function sendBack(state: MusterState, taskId: string, actor: string, note: string): Task {
  requireCaptainOrYou(state, actor, 'send work back');
  const task = requireTask(state, taskId);
  if (task.status === 'merged' || task.status === 'cancelled') throw conflict(`${task.id} is ${task.status}`);
  const text = note?.trim() || 'Needs more work';
  release(state, task);
  task.stationIndex = Math.max(0, task.stations.indexOf('build'));
  for (const n of state.notes) if (n.type === 'review' && n.taskId === task.id) closeNoteIfOpen(n);
  event(task, actor, 'note', `sent back: ${text}`);

  const builder = builderOf(state, task);
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

export function markMerged(state: MusterState, task: Task, actor: string): void {
  task.status = 'merged';
  task.assignee = undefined;
  event(task, actor, 'merged');
  for (const n of state.notes) if (n.type === 'review' && n.taskId === task.id) closeNoteIfOpen(n);
  addFeed(state, { kind: 'event', from: actor, taskId: task.id, text: `merged ${task.id} ${task.title}${task.branch ? ` (${task.branch})` : ''}` });
  recomputeReadiness(state);
}

/** True when the agent's latest task action was finishing or handing on, and it holds nothing now. */
export function hasReportedDone(state: MusterState, agent: Agent): boolean {
  if (agent.taskId) return false;
  let last: TaskEvent | undefined;
  for (const t of state.tasks) for (const e of t.history) if (e.agentId === agent.id && (!last || e.at >= last.at)) last = e;
  return last?.kind === 'done' || last?.kind === 'handoff';
}
