// Roadmap: stages ("M1"…) → goals ("G1"…) → tasks. The Captain drafts it, you approve it, and the
// orchestrator counts progress from the tasks and tells the Captain when goals finish.
// Pure state mutations; the caller commits the store (and toasts/notifies, see the API layer).
import type { ExitCriterion, GoalStatus, MusterState, Note, Roadmap, RoadmapGoal, ResearchIdea, RoadmapHealth, RoadmapProgress, RoadmapStage, StageStatus } from '../types.js';
import { addFeed, addInbox, captainOf, closeNoteIfOpen, HUMAN, isCaptain, nowIso, postNote, SYSTEM } from './board.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { nextId } from './store.js';

export const MAX_STAGES = 12;
export const MAX_GOALS_PER_STAGE = 12;
export const MAX_TITLE = 120;
const STAGE_STATUSES: StageStatus[] = ['planned', 'active', 'done'];
const GOAL_STATUSES: GoalStatus[] = ['planned', 'active', 'done', 'cancelled'];

export interface GoalInput {
  id?: string;
  title: string;
  description?: string;
  start?: string | null;
  due?: string | null;
}

export interface StageInput {
  id?: string;
  title: string;
  description?: string;
  start?: string | null;
  due?: string | null;
  exitCriteria?: (string | ExitCriterion)[];
  goals?: GoalInput[];
}

export interface RoadmapInput {
  title: string;
  summary?: string;
  launchDate?: string | null;
  stages: StageInput[];
}

export interface StagePatch {
  title?: string;
  description?: string;
  start?: string | null;
  due?: string | null;
  status?: StageStatus;
}

export interface GoalPatch {
  title?: string;
  description?: string;
  start?: string | null;
  due?: string | null;
  status?: GoalStatus;
}

/** What a write did to the approval note, so the API can toast (and notify when a note was opened). */
export interface RoadmapChange {
  roadmap: Roadmap;
  note?: Note; // the approval note opened or updated by this write
  noteOpened?: boolean; // true: a new note (toast + notification); false: the open one was updated
}

// ------------------------------------------------------------------ dates

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since the epoch for a YYYY-MM-DD date (undefined when it isn't one). */
function dayNumber(d: string): number | undefined {
  const m = DATE_RE.exec(d);
  if (!m) return undefined;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const back = new Date(t);
  if (back.getUTCFullYear() !== +m[1] || back.getUTCMonth() !== +m[2] - 1 || back.getUTCDate() !== +m[3]) return undefined;
  return t / 86_400_000;
}

/** Today (or `d`) as YYYY-MM-DD in local time: the day you see on your calendar. */
export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** undefined/null/"" → unset; otherwise a real YYYY-MM-DD date or 400. */
function checkDate(v: unknown, what: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || dayNumber(v.trim()) === undefined) throw badRequest(`${what} must be a date as YYYY-MM-DD`);
  return v.trim();
}

function checkRange(start: string | undefined, due: string | undefined, what: string): void {
  if (start && due && start > due) throw badRequest(`${what}: start ${start} is after due ${due}`);
}

function checkTitle(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v.trim()) throw badRequest(`${what} is empty`);
  const t = v.trim();
  if (t.length > MAX_TITLE) throw badRequest(`${what} is longer than ${MAX_TITLE} characters`);
  return t;
}

function checkText(v: unknown, what: string): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw badRequest(`${what} must be text`);
  return v.trim();
}

// ------------------------------------------------------------------ lookups

function requireCaptainOrYou(state: MusterState, actor: string, what: string): void {
  if (actor !== HUMAN && !isCaptain(state, actor)) throw forbidden(`Only the Captain or you can ${what}`);
}

export function requireRoadmap(state: MusterState): Roadmap {
  if (!state.roadmap) throw notFound('There is no roadmap yet');
  return state.roadmap;
}

export function requireStage(state: MusterState, id: string): RoadmapStage {
  const s = requireRoadmap(state).stages.find((x) => x.id === String(id).trim().toUpperCase());
  if (!s) throw notFound(`No stage "${id}"`);
  return s;
}

export function requireGoal(state: MusterState, id: string): RoadmapGoal {
  const g = state.roadmap?.goals.find((x) => x.id === String(id).trim().toUpperCase());
  if (!g) throw notFound(`No goal "${id}"`);
  return g;
}

const goalsOf = (r: Roadmap, stage: RoadmapStage): RoadmapGoal[] => stage.goalIds.map((id) => r.goals.find((g) => g.id === id)).filter((g): g is RoadmapGoal => !!g);
const stageOf = (r: Roadmap, goal: RoadmapGoal): RoadmapStage | undefined => r.stages.find((s) => s.id === goal.stageId);
const finished = (g: RoadmapGoal) => g.status === 'done' || g.status === 'cancelled';

/** Stage/goal ids in order with their dates and the launch date: a change here is a replan that needs your approval. */
function planKey(r: Roadmap): string {
  return JSON.stringify([r.launchDate ?? null, r.stages.map((s) => [s.id, s.start ?? null, s.due ?? null, goalsOf(r, s).map((g) => [g.id, g.start ?? null, g.due ?? null])])]);
}

/** Inbox for the Captain; from "muster" when the Captain did it itself (addInbox drops items to their own sender). */
function tellCaptain(state: MusterState, from: string, text: string): void {
  const captain = captainOf(state);
  if (captain) addInbox(state, { agentId: captain.id, from: from === captain.id ? SYSTEM : from, kind: 'system', text });
}

const startText = (stage: RoadmapStage, goal: RoadmapGoal | undefined) =>
  goal
    ? `Start ${stage.id} ${stage.title}: break ${goal.id} ${goal.title} into tasks (post_task with goal: ${goal.id}).`
    : `Start ${stage.id} ${stage.title}: it has no goals left to work; add one with add_goal.`;

// ------------------------------------------------------------------ approval note

function approvalText(r: Roadmap, actor: string): string {
  const goals = r.stages.reduce((n, s) => n + s.goalIds.length, 0);
  const counts = `${r.stages.length} stage${r.stages.length === 1 ? '' : 's'}, ${goals} goal${goals === 1 ? '' : 's'}${r.launchDate ? `, launch ${r.launchDate}` : ''}`;
  return `Roadmap ready for your approval: ${r.title}, revision ${r.revision + 1} (${counts}), drafted by ${actor}. Approve it or send it back from the Roadmap page.`;
}

/** Opens the approval note for a draft, or updates the open one (re-saving a draft never opens a second note). */
function requestApproval(state: MusterState, actor: string): { note: Note; noteOpened: boolean } {
  const r = state.roadmap!;
  const text = approvalText(r, actor);
  const open = r.noteId ? state.notes.find((n) => n.id === r.noteId && n.open) : undefined;
  if (open) {
    open.text = text;
    return { note: open, noteOpened: false };
  }
  // Posted by the orchestrator with no taskId, so nothing treats it as a task's approval (Approve/Reject on the board).
  const note = postNote(state, { actor: SYSTEM, type: 'approval', to: HUMAN, text, topic: 'roadmap' });
  r.noteId = note.id;
  return { note, noteOpened: true };
}

/** After an edit through the stage/goal routes: a replan turns an approved roadmap back into a draft (and asks you again). */
function afterEdit(state: MusterState, before: string, actor: string): RoadmapChange {
  const r = state.roadmap!;
  r.updatedAt = nowIso();
  if (planKey(r) === before) return { roadmap: r };
  if (r.status === 'approved') {
    r.status = 'draft';
    addFeed(state, { kind: 'event', from: actor, text: `changed the approved roadmap; revision ${r.revision + 1} waits for your approval` });
  }
  return { roadmap: r, ...requestApproval(state, actor) };
}

// ------------------------------------------------------------------ set / approve / reject

function buildCriteria(raw: unknown, old: ExitCriterion[], what: string, actor: string, at: string): ExitCriterion[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest(`${what}: exitCriteria must be a list`);
  return raw.map((e, i) => {
    const text = typeof e === 'string' ? e.trim() : e && typeof e === 'object' && typeof e.text === 'string' ? e.text.trim() : '';
    if (!text) throw badRequest(`${what}: exit criterion ${i + 1} is empty`);
    const prev = old.find((c) => c.text === text);
    const done = e && typeof e === 'object' && typeof e.done === 'boolean' ? e.done : (prev?.done ?? false);
    if (!done) return { text, done };
    return prev?.done ? { ...prev, text } : { text, done, doneAt: at, by: actor };
  });
}

/**
 * PUT /api/roadmap, set_roadmap: replaces the plan. Entries with a known id keep id, status and timestamps;
 * the rest get fresh ids. Dropping a goal that still has tasks is refused (409). A new roadmap, any save of a
 * draft, or a replan of an approved one (stages/goals added, removed or moved, dates changed) waits for your approval.
 */
export function setRoadmap(state: MusterState, input: RoadmapInput, actor: string): RoadmapChange {
  requireCaptainOrYou(state, actor, 'write the roadmap');
  if (!input || typeof input !== 'object') throw badRequest('Missing roadmap');
  const title = checkTitle(input.title, 'Roadmap title');
  const summary = checkText(input.summary, 'summary');
  const launchDate = checkDate(input.launchDate, 'launchDate');
  if (!Array.isArray(input.stages) || input.stages.length < 1 || input.stages.length > MAX_STAGES) throw badRequest(`A roadmap has 1–${MAX_STAGES} stages`);
  const prev = state.roadmap;
  const known = (list: { id: string }[] | undefined, id: unknown) => (typeof id === 'string' && list?.some((x) => x.id === id.trim().toUpperCase()) ? id.trim().toUpperCase() : undefined);
  const seen = new Set<string>();
  const once = (id: string | undefined) => {
    if (!id) return id;
    if (seen.has(id)) throw badRequest(`${id} appears twice`);
    seen.add(id);
    return id;
  };

  // Check everything before anything changes, so a 400/409 leaves the roadmap (and nextIds) as they were.
  const checked = input.stages.map((s, i) => {
    if (!s || typeof s !== 'object') throw badRequest(`Stage ${i + 1} is not an object`);
    const what = `Stage ${i + 1}`;
    const start = checkDate(s.start, `${what} start`);
    const due = checkDate(s.due, `${what} due`);
    checkRange(start, due, what);
    if (s.exitCriteria !== undefined && s.exitCriteria !== null && !Array.isArray(s.exitCriteria)) throw badRequest(`${what}: exitCriteria must be a list`);
    const goals = s.goals ?? [];
    if (!Array.isArray(goals)) throw badRequest(`${what}: goals must be a list`);
    if (goals.length > MAX_GOALS_PER_STAGE) throw badRequest(`${what} has ${goals.length} goals; at most ${MAX_GOALS_PER_STAGE}`);
    return {
      id: once(known(prev?.stages, s.id)),
      title: checkTitle(s.title, `${what} title`),
      description: checkText(s.description, `${what} description`),
      start,
      due,
      exitCriteria: s.exitCriteria,
      goals: goals.map((g, j) => {
        if (!g || typeof g !== 'object') throw badRequest(`${what} goal ${j + 1} is not an object`);
        const gw = `${what} goal ${j + 1}`;
        const gs = checkDate(g.start, `${gw} start`);
        const gd = checkDate(g.due, `${gw} due`);
        checkRange(gs, gd, gw);
        return { id: once(known(prev?.goals, g.id)), title: checkTitle(g.title, `${gw} title`), description: checkText(g.description, `${gw} description`), start: gs, due: gd };
      }),
    };
  });
  const kept = new Set(checked.flatMap((s) => s.goals.map((g) => g.id)).filter(Boolean));
  const dropped = (prev?.goals ?? [])
    .filter((g) => !kept.has(g.id))
    .map((g) => ({ g, tasks: state.tasks.filter((t) => t.goalId === g.id && t.status !== 'cancelled').map((t) => t.id) }))
    .filter((d) => d.tasks.length);
  if (dropped.length) {
    throw conflict(`Can't drop ${dropped.map((d) => `${d.g.id} ${d.g.title} (${d.tasks.join(', ')})`).join('; ')}: ${dropped.length === 1 ? 'it has' : 'they have'} tasks. Keep ${dropped.length === 1 ? 'the goal' : 'those goals'}, or cancel the tasks first.`);
  }

  const at = nowIso();
  const goals: RoadmapGoal[] = [];
  const stages: RoadmapStage[] = checked.map((s) => {
    const old = s.id ? prev!.stages.find((x) => x.id === s.id) : undefined;
    const id = s.id ?? nextId(state, 'stage');
    const goalIds = s.goals.map((g) => {
      const og = g.id ? prev!.goals.find((x) => x.id === g.id) : undefined;
      const goal: RoadmapGoal = {
        id: g.id ?? nextId(state, 'goal'),
        stageId: id,
        title: g.title,
        description: g.description,
        status: og?.status ?? 'planned',
        ...(g.start ? { start: g.start } : {}),
        ...(g.due ? { due: g.due } : {}),
        ...(og?.activatedAt ? { activatedAt: og.activatedAt } : {}),
        ...(og?.completedAt ? { completedAt: og.completedAt } : {}),
      };
      goals.push(goal);
      return goal.id;
    });
    return {
      id,
      title: s.title,
      description: s.description,
      ...(s.start ? { start: s.start } : {}),
      ...(s.due ? { due: s.due } : {}),
      status: old?.status ?? 'planned',
      exitCriteria: buildCriteria(s.exitCriteria, old?.exitCriteria ?? [], `Stage ${id}`, actor, at),
      goalIds,
      ...(old?.completedAt ? { completedAt: old.completedAt } : {}),
    };
  });

  const before = prev ? planKey(prev) : undefined;
  const roadmap: Roadmap = {
    title,
    summary,
    ...(launchDate ? { launchDate } : {}),
    status: prev?.status ?? 'draft',
    revision: prev?.revision ?? 0,
    ...(prev?.approvedAt ? { approvedAt: prev.approvedAt } : {}),
    ...(prev?.noteId ? { noteId: prev.noteId } : {}),
    stages,
    goals,
    createdBy: prev?.createdBy ?? actor,
    updatedAt: at,
  };
  state.roadmap = roadmap;
  addFeed(state, { kind: 'event', from: actor, text: `${prev ? 'updated' : 'drafted'} the roadmap: ${title} (${stages.length} stages, ${goals.length} goals)` });
  if (roadmap.status === 'approved' && planKey(roadmap) !== before) roadmap.status = 'draft';
  if (roadmap.status !== 'draft') return { roadmap };
  return { roadmap, ...requestApproval(state, actor) };
}

/** Makes the first stage that isn't done the active one, with an active goal (the first planned one when none is active). */
function startCurrent(state: MusterState): { stage?: RoadmapStage; goal?: RoadmapGoal; changed: boolean } {
  const r = state.roadmap!;
  const stage = r.stages.find((s) => s.status !== 'done');
  if (!stage) return { changed: false };
  let changed = false;
  if (stage.status !== 'active') {
    stage.status = 'active';
    changed = true;
  }
  const goals = goalsOf(r, stage);
  let goal = goals.find((g) => g.status === 'active');
  if (!goal) {
    goal = goals.find((g) => g.status === 'planned');
    if (goal) {
      activateGoal(goal);
      changed = true;
    }
  }
  return { stage, goal, changed };
}

export function activateGoal(goal: RoadmapGoal): void {
  goal.status = 'active';
  goal.activatedAt ??= nowIso();
  delete goal.completedAt;
}

function closeApprovalNote(state: MusterState, r: Roadmap): Note | undefined {
  const note = r.noteId ? state.notes.find((n) => n.id === r.noteId) : undefined;
  if (note) closeNoteIfOpen(note);
  delete r.noteId;
  return note;
}

/** POST /api/roadmap/approve: only you, only a draft. Starts the first stage and goal and tells the Captain. */
export function approveRoadmap(state: MusterState, actor: string): Roadmap {
  if (actor !== HUMAN) throw forbidden('Only you can approve the roadmap');
  const r = requireRoadmap(state);
  if (r.status !== 'draft') throw conflict(`The roadmap is already approved (revision ${r.revision})`);
  const at = nowIso();
  r.status = 'approved';
  r.revision += 1;
  r.approvedAt = at;
  r.updatedAt = at;
  closeApprovalNote(state, r);
  const { stage, goal, changed } = startCurrent(state);
  addFeed(state, { kind: 'event', from: actor, text: `approved the roadmap ${r.title} (revision ${r.revision})` });
  const text = !stage
    ? `Roadmap revision ${r.revision} approved. Every stage is done.`
    : r.revision === 1 || changed
      ? `Roadmap approved. ${startText(stage, goal)}`
      : `Roadmap revision ${r.revision} approved. Carry on with ${stage.id} ${stage.title}${goal ? `, goal ${goal.id} ${goal.title} (post_task with goal: ${goal.id})` : ''}.`;
  tellCaptain(state, actor, text);
  const loose = unlinkedTasks(state);
  if (loose.length)
    tellCaptain(state, actor, `${loose.length} task${loose.length === 1 ? ' is' : 's are'} not on the roadmap yet (${loose.slice(0, 12).join(', ')}${loose.length > 12 ? '…' : ''}). Link done and running work to the goals it delivers with link_tasks so progress is right, and tick any exit criteria it already meets.`);
  return r;
}

/** POST /api/roadmap/reject: only you, a note is required. Replies on and closes the approval note; it stays a draft. */
export function rejectRoadmap(state: MusterState, actor: string, note: string): Roadmap {
  if (actor !== HUMAN) throw forbidden('Only you can send the roadmap back');
  const text = typeof note === 'string' ? note.trim() : '';
  if (!text) throw badRequest('Say what needs to change: a note is required');
  const r = requireRoadmap(state);
  if (r.status !== 'draft') throw conflict('The roadmap is approved; there is no draft to send back');
  const at = nowIso();
  const n = r.noteId ? state.notes.find((x) => x.id === r.noteId) : undefined;
  if (n) {
    n.replies.push({ at, from: actor, text });
    addFeed(state, { kind: 'reply', from: actor, noteId: n.id, text });
  }
  closeApprovalNote(state, r);
  r.updatedAt = at;
  addFeed(state, { kind: 'event', from: actor, text: `sent the roadmap back: ${text}` });
  tellCaptain(state, actor, `The user sent the roadmap back: ${text}. Revise it with set_roadmap; it goes back to them for approval.`);
  return r;
}

// ------------------------------------------------------------------ stages

/** PATCH /api/roadmap/stages/:id. Status "done" goes through completeStage (criteria must be ticked). */
export function patchStage(state: MusterState, id: string, patch: StagePatch, actor: string): RoadmapChange & { stage: RoadmapStage } {
  requireCaptainOrYou(state, actor, 'change the roadmap');
  const r = requireRoadmap(state);
  const stage = requireStage(state, id);
  const p = patch ?? {};
  const title = p.title !== undefined ? checkTitle(p.title, `${stage.id} title`) : stage.title;
  const description = p.description !== undefined ? checkText(p.description, `${stage.id} description`) : stage.description;
  const start = 'start' in p ? checkDate(p.start, `${stage.id} start`) : stage.start;
  const due = 'due' in p ? checkDate(p.due, `${stage.id} due`) : stage.due;
  checkRange(start, due, stage.id);
  if (p.status !== undefined && !STAGE_STATUSES.includes(p.status)) throw badRequest(`status must be one of ${STAGE_STATUSES.join(', ')}`);
  const before = planKey(r);
  if (p.status === 'done' && stage.status !== 'done') completeStage(state, stage.id, actor);
  else if (p.status && p.status !== stage.status) {
    stage.status = p.status;
    delete stage.completedAt;
    addFeed(state, { kind: 'event', from: actor, text: `set ${stage.id} ${stage.title} to ${p.status}` });
  }
  stage.title = title;
  stage.description = description;
  if (start) stage.start = start;
  else delete stage.start;
  if (due) stage.due = due;
  else delete stage.due;
  return { ...afterEdit(state, before, actor), stage };
}

/** Ticks (or unticks) one exit criterion; `index` is 0-based. Not a replan. */
export function tickCriterion(state: MusterState, stageId: string, index: number, done: boolean, actor: string): RoadmapStage {
  requireCaptainOrYou(state, actor, 'tick exit criteria');
  const r = requireRoadmap(state);
  const stage = requireStage(state, stageId);
  if (!Number.isInteger(index) || index < 0) throw badRequest('index must be a whole number from 0');
  if (typeof done !== 'boolean') throw badRequest('done must be true or false');
  const c = stage.exitCriteria[index];
  if (!c) throw notFound(`${stage.id} has no exit criterion ${index} (it has ${stage.exitCriteria.length}, counted from 0)`);
  if (c.done !== done) {
    if (done) Object.assign(c, { done, doneAt: nowIso(), by: actor });
    else {
      c.done = false;
      delete c.doneAt;
      delete c.by;
    }
    r.updatedAt = nowIso();
    addFeed(state, { kind: 'event', from: actor, text: `${done ? 'ticked' : 'unticked'} ${stage.id} exit criterion ${index + 1}: ${c.text}` });
  }
  return stage;
}

/**
 * Completes a stage: all exit criteria ticked (409 otherwise), or `force` (you only). The next stage becomes
 * active with its first goal, and the Captain is told what to start.
 */
export function completeStage(state: MusterState, stageId: string, actor: string, force = false): { stage: RoadmapStage; next?: RoadmapStage; goal?: RoadmapGoal } {
  requireCaptainOrYou(state, actor, 'complete stages');
  if (force && actor !== HUMAN) throw forbidden('Only you can complete a stage with unticked exit criteria');
  const r = requireRoadmap(state);
  const stage = requireStage(state, stageId);
  if (stage.status === 'done') throw conflict(`${stage.id} is already done`);
  const open = stage.exitCriteria.map((c, i) => ({ c, i })).filter((x) => !x.c.done);
  if (open.length && !force) {
    throw conflict(`${stage.id} has ${open.length} unticked exit criteri${open.length === 1 ? 'on' : 'a'}: ${open.map((x) => `${x.i + 1}. ${x.c.text}`).join('; ')}. Tick them (check_criterion) once there is evidence, then complete the stage.`);
  }
  const at = nowIso();
  stage.status = 'done';
  stage.completedAt = at;
  r.updatedAt = at;
  addFeed(state, { kind: 'event', from: actor, text: `completed ${stage.id} ${stage.title}${open.length ? ` (forced, ${open.length} criteria unticked)` : ''}` });
  const { stage: next, goal } = startCurrent(state);
  tellCaptain(state, actor, `${stage.id} ${stage.title} is complete. ${next ? startText(next, goal) : 'Every stage of the roadmap is done.'}`);
  return { stage, next, goal };
}

// ------------------------------------------------------------------ goals

/**
 * POST /api/roadmap/goals: a new planned goal at the end of the stage. Counts as a replan, except for the goal
 * of an approved research idea (`ideaId`): approving the idea was the approval, so an approved roadmap stays approved.
 */
export function addGoal(state: MusterState, input: GoalInput & { stageId: string; ideaId?: string | null }, actor: string): RoadmapChange & { goal: RoadmapGoal } {
  requireCaptainOrYou(state, actor, 'change the roadmap');
  const r = requireRoadmap(state);
  if (!input || typeof input.stageId !== 'string') throw badRequest('Missing stageId');
  const stage = requireStage(state, input.stageId);
  const title = checkTitle(input.title, 'Goal title');
  const description = checkText(input.description, 'description');
  const start = checkDate(input.start, 'start');
  const due = checkDate(input.due, 'due');
  checkRange(start, due, 'Goal');
  if (stage.goalIds.length >= MAX_GOALS_PER_STAGE) throw badRequest(`${stage.id} already has ${MAX_GOALS_PER_STAGE} goals`);
  const idea = input.ideaId === undefined || input.ideaId === null || input.ideaId === '' ? undefined : ideaForGoal(state, input.ideaId);
  const before = planKey(r);
  const goal: RoadmapGoal = { id: nextId(state, 'goal'), stageId: stage.id, title, description, status: 'planned', ...(start ? { start } : {}), ...(due ? { due } : {}) };
  r.goals.push(goal);
  stage.goalIds.push(goal.id);
  addFeed(state, { kind: 'event', from: actor, text: `added goal ${goal.id} ${goal.title} to ${stage.id} ${stage.title}` });
  if (idea) {
    idea.goalId = goal.id;
    addFeed(state, { kind: 'event', from: actor, text: `added ${goal.id} for idea ${idea.id}` });
    if (r.status === 'approved') {
      r.updatedAt = nowIso();
      return { roadmap: r, goal };
    }
  }
  return { ...afterEdit(state, before, actor), goal };
}

/** The idea a new goal is for: 404 unknown, 409 unless approved and still without a goal. */
function ideaForGoal(state: MusterState, ideaId: unknown): ResearchIdea {
  if (typeof ideaId !== 'string' || !ideaId.trim()) throw badRequest('ideaId must be an idea id like "R7"');
  const id = ideaId.trim().toUpperCase();
  const idea = state.research?.ideas.find((i) => i.id === id);
  if (!idea) throw notFound(`No idea "${ideaId}"`);
  if (idea.status !== 'approved') throw conflict(`${idea.id} ${idea.title} is ${idea.status === 'new' ? 'not approved yet' : 'rejected'}; only an approved idea goes onto the roadmap`);
  if (idea.goalId) throw conflict(`${idea.id} ${idea.title} is already on the roadmap as ${idea.goalId}`);
  return idea;
}

/** PATCH /api/roadmap/goals/:id. Done/cancelled by hand moves the stage on the same way a finished goal does. */
export function patchGoal(state: MusterState, id: string, patch: GoalPatch, actor: string): RoadmapChange & { goal: RoadmapGoal } {
  requireCaptainOrYou(state, actor, 'change the roadmap');
  const r = requireRoadmap(state);
  const goal = requireGoal(state, id);
  const p = patch ?? {};
  const title = p.title !== undefined ? checkTitle(p.title, `${goal.id} title`) : goal.title;
  const description = p.description !== undefined ? checkText(p.description, `${goal.id} description`) : goal.description;
  const start = 'start' in p ? checkDate(p.start, `${goal.id} start`) : goal.start;
  const due = 'due' in p ? checkDate(p.due, `${goal.id} due`) : goal.due;
  checkRange(start, due, goal.id);
  if (p.status !== undefined && !GOAL_STATUSES.includes(p.status)) throw badRequest(`status must be one of ${GOAL_STATUSES.join(', ')}`);
  const before = planKey(r);
  goal.title = title;
  goal.description = description;
  if (start) goal.start = start;
  else delete goal.start;
  if (due) goal.due = due;
  else delete goal.due;
  if (p.status && p.status !== goal.status) {
    if (p.status === 'active') activateGoal(goal);
    else if (p.status === 'planned') {
      goal.status = 'planned';
      delete goal.completedAt;
    } else {
      goal.status = p.status;
      goal.completedAt = nowIso();
      goalFinished(state, goal, actor);
    }
    if (p.status === 'active' || p.status === 'planned') addFeed(state, { kind: 'event', from: actor, text: `set ${goal.id} ${goal.title} to ${p.status}` });
  }
  return { ...afterEdit(state, before, actor), goal };
}

/** The goal a new task is posted to: 404 unknown, 409 cancelled. Call `activateGoal` once the task exists if it's planned. */
export function goalForTask(state: MusterState, goalId: unknown): RoadmapGoal {
  if (typeof goalId !== 'string' || !goalId.trim()) throw badRequest('goalId must be a goal id like "G3"');
  const goal = requireGoal(state, goalId);
  if (goal.status === 'cancelled') throw conflict(`${goal.id} ${goal.title} is cancelled; post the task to another goal`);
  return goal;
}

/**
 * POST /api/roadmap/goals/:id/tasks: put existing tasks on a goal (or take them off with `unlink`), e.g. work that
 * merged before the roadmap existed. Captain or you. A planned goal that gets an unmerged task becomes active;
 * a goal whose linked tasks are all merged finishes on the next advance. Not a replan: no approval needed.
 */
export function linkTasks(state: MusterState, goalId: string, taskIds: unknown, actor: string, unlink = false): { goal: RoadmapGoal; linked: string[] } {
  requireCaptainOrYou(state, actor, 'link tasks to roadmap goals');
  const goal = requireGoal(state, goalId);
  if (!unlink && goal.status === 'cancelled') throw conflict(`${goal.id} ${goal.title} is cancelled`);
  if (!Array.isArray(taskIds) || !taskIds.length || taskIds.some((t) => typeof t !== 'string')) throw badRequest('taskIds must be a list of task ids like ["T3", "T4"]');
  const tasks = taskIds.map((raw) => {
    const id = String(raw).trim().toUpperCase();
    const t = state.tasks.find((x) => x.id === id);
    if (!t) throw notFound(`No task "${raw}"`);
    return t;
  });
  for (const t of tasks) {
    if (unlink) {
      if (t.goalId === goal.id) delete t.goalId;
    } else t.goalId = goal.id;
  }
  if (!unlink && goal.status === 'planned' && tasks.some((t) => t.status !== 'merged' && t.status !== 'cancelled')) activateGoal(goal);
  const ids = tasks.map((t) => t.id);
  addFeed(state, { kind: 'event', from: actor, text: `${unlink ? 'took' : 'put'} ${ids.join(', ')} ${unlink ? 'off' : 'on'} ${goal.id} ${goal.title}` });
  state.roadmap!.updatedAt = nowIso();
  finishLinkedGoals(state);
  advanceRoadmap(state);
  return { goal, linked: ids };
}

/** A goal (any status but cancelled/done) whose linked tasks are all merged is finished: linked old work counts. */
function finishLinkedGoals(state: MusterState): void {
  for (const g of state.roadmap?.goals ?? []) {
    if (g.status !== 'planned') continue;
    const tasks = state.tasks.filter((t) => t.goalId === g.id && t.status !== 'cancelled');
    if (tasks.length && tasks.every((t) => t.status === 'merged')) activateGoal(g); // advanceRoadmap then marks it done
  }
}

/** Live tasks with no goal while the roadmap is approved: the Captain should put them on it. */
export function unlinkedTasks(state: MusterState): string[] {
  if (state.roadmap?.status !== 'approved') return [];
  return state.tasks.filter((t) => !t.goalId && t.status !== 'cancelled').map((t) => t.id);
}

/** Called when a task merges: if it has no goal on an approved roadmap, ask the Captain to place it. */
export function remindUnlinked(state: MusterState, taskId: string): void {
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t || t.goalId || state.roadmap?.status !== 'approved') return;
  tellCaptain(state, SYSTEM, `${t.id} ${t.title} merged without a roadmap goal. Put it on the goal it delivers (link_tasks), and update the roadmap if it changes the plan.`);
}

/** Feed event, next planned goal of the stage → active, and the Captain hears what to do next. */
function goalFinished(state: MusterState, goal: RoadmapGoal, from: string): void {
  const r = state.roadmap!;
  const stage = stageOf(r, goal);
  addFeed(state, { kind: 'event', from, text: `${goal.id} ${goal.title} ${goal.status === 'cancelled' ? 'cancelled' : 'done'}` });
  if (!stage || stage.status !== 'active') return;
  const goals = goalsOf(r, stage);
  const next = goals.find((g) => g.status === 'planned');
  if (next) activateGoal(next);
  tellCaptain(state, from, `${goal.id} ${goal.status === 'cancelled' ? 'cancelled' : 'done'}.${next ? ` Next: ${next.id} ${next.title} — break it into tasks.` : ''}`);
  if (goals.every(finished)) tellCaptain(state, from, `All goals of ${stage.id} are done. Check its exit criteria (check_criterion) and complete_stage.`);
}

/**
 * Run after any task change: an active goal whose tasks (≥1, not cancelled) are all merged becomes done.
 * Returns the goals it finished.
 */
export function advanceRoadmap(state: MusterState): RoadmapGoal[] {
  const r = state.roadmap;
  if (!r) return [];
  const done: RoadmapGoal[] = [];
  for (const g of r.goals) {
    if (g.status !== 'active') continue;
    const tasks = state.tasks.filter((t) => t.goalId === g.id && t.status !== 'cancelled');
    if (!tasks.length || !tasks.every((t) => t.status === 'merged')) continue;
    g.status = 'done';
    g.completedAt = nowIso();
    done.push(g);
  }
  for (const g of done) goalFinished(state, g, SYSTEM);
  if (done.length) r.updatedAt = nowIso();
  return done;
}

// ------------------------------------------------------------------ progress

const pct = (done: number, total: number) => (total ? Math.round((done / total) * 100) : 0);
const HEALTH_RANK: Record<RoadmapHealth, number> = { late: 4, at_risk: 3, on_track: 2, not_started: 1, done: 0 };

function stageHealth(stage: RoadmapStage, percent: number, today: number): RoadmapHealth {
  if (stage.status === 'done') return 'done';
  const start = stage.start ? dayNumber(stage.start) : undefined;
  const due = stage.due ? dayNumber(stage.due) : undefined;
  if (stage.status === 'planned' && (start === undefined || start > today)) return 'not_started';
  if (due !== undefined && today > due) return 'late';
  let expected = 0;
  if (start !== undefined && due !== undefined) expected = due > start ? Math.min(1, Math.max(0, (today - start) / (due - start))) : today >= start ? 1 : 0;
  return percent / 100 < expected - 0.15 ? 'at_risk' : 'on_track';
}

/**
 * Progress counted from the tasks (never stored). Task counts leave out cancelled tasks and the tasks of
 * cancelled goals; done = merged. `today` is YYYY-MM-DD (see localDate).
 */
export function computeProgress(state: MusterState, today: string): RoadmapProgress | null {
  const r = state.roadmap;
  if (!r) return null;
  const now = dayNumber(today);
  if (now === undefined) throw badRequest(`today must be YYYY-MM-DD, not "${today}"`);
  const goals: RoadmapProgress['goals'] = {};
  for (const g of r.goals) {
    const tasks = state.tasks.filter((t) => t.goalId === g.id && t.status !== 'cancelled');
    const done = tasks.filter((t) => t.status === 'merged').length;
    const agents = [...new Set(tasks.filter((t) => t.status !== 'merged' && t.assignee).map((t) => t.assignee!))];
    const percent = tasks.length ? pct(done, tasks.length) : g.status === 'done' ? 100 : 0;
    goals[g.id] = { done, total: tasks.length, percent, agents };
  }
  const stages: RoadmapProgress['stages'] = {};
  let allDone = 0;
  let allTotal = 0;
  let weighted = 0;
  let weights = 0;
  for (const s of r.stages) {
    let done = 0;
    let total = 0;
    const live = goalsOf(r, s).filter((g) => g.status !== 'cancelled');
    for (const g of live) {
      done += goals[g.id].done;
      total += goals[g.id].total;
    }
    allDone += done;
    allTotal += total;
    const criteriaDone = s.exitCriteria.filter((c) => c.done).length;
    const criteriaTotal = s.exitCriteria.length;
    // Work done before the roadmap (or never linked to a goal) still shows: fall back to criteria, then goals.
    let basis: 'done' | 'tasks' | 'criteria' | 'goals';
    let percent: number;
    if (s.status === 'done') [basis, percent] = ['done', 100];
    else if (total) [basis, percent] = ['tasks', pct(done, total)];
    else if (criteriaTotal) [basis, percent] = ['criteria', pct(criteriaDone, criteriaTotal)];
    else [basis, percent] = ['goals', live.length ? Math.round(live.reduce((a, g) => a + goals[g.id].percent, 0) / live.length) : 0];
    stages[s.id] = { done, total, percent, health: stageHealth(s, percent, now), criteriaDone, criteriaTotal, basis };
    const w = Math.max(1, live.length);
    weighted += percent * w;
    weights += w;
  }
  const unlinked = state.tasks.filter((t) => !t.goalId && t.status !== 'cancelled').length;
  const open = r.stages.filter((s) => s.status !== 'done').map((s) => stages[s.id].health);
  const health: RoadmapHealth = open.length ? open.reduce((a, b) => (HEALTH_RANK[b] > HEALTH_RANK[a] ? b : a)) : 'done';
  const current = r.stages.find((s) => s.status !== 'done');
  const currentGoal = current ? goalsOf(r, current).find((g) => g.status === 'active') : undefined;
  const launch = r.launchDate ? dayNumber(r.launchDate) : undefined;
  return {
    overall: { done: allDone, total: allTotal, percent: weights ? Math.round(weighted / weights) : 0, unlinked },
    health,
    ...(launch !== undefined ? { daysToLaunch: launch - now } : {}),
    ...(current ? { currentStageId: current.id } : {}),
    ...(currentGoal ? { currentGoalId: currentGoal.id } : {}),
    stages,
    goals,
  };
}
