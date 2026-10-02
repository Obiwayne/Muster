// Research: you start a run, the research agent "scout" reads public pages and posts ideas, and you approve,
// reject or ask the Captain about each one. An approved idea goes onto the roadmap through the Captain
// (addGoal with ideaId) without a second roadmap approval.
// Pure state mutations; the caller commits the store, starts/stops scout and toasts/notifies (see the API layer).
import type { IdeaEvidence, IdeaImpact, MusterState, ResearchIdea, ResearchRun, ResearchSources, ResearchState } from '../types.js';
import { addFeed, addInbox, captainOf, findAgent, HUMAN, isCaptain, nowIso, SYSTEM } from './board.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { nextId } from './store.js';
import { assertNotPaused } from './usage.js';

/** The research agent's id: there is only ever one. */
export const SCOUT_ID = 'scout';
export const MAX_IDEA_TITLE = 120;
export const MAX_SUMMARY = 1000;
export const MAX_QUOTE = 300;
export const MAX_EVIDENCE = 8;
export const MAX_THREAD_TEXT = 4000;
export const MAX_PLAN_ITEMS = 12;
const MAX_SOURCE_ITEMS = 20;
const MAX_SOURCE_TEXT = 200;
const MAX_FOCUS = 2000;
const IMPACTS: IdeaImpact[] = ['high', 'medium', 'low', 'business'];
const EFFORTS: ResearchIdea['effort'][] = ['S', 'M', 'L'];
const EVIDENCE_KINDS: IdeaEvidence['kind'][] = ['review', 'forum', 'competitor', 'app', 'web'];
const DEPTHS: ResearchRun['depth'][] = ['quick', 'thorough'];
/** How many ideas scout should aim for, per depth (also in its brief). */
export const IDEA_TARGET: Record<ResearchRun['depth'], string> = { quick: '3–8', thorough: '6–12' };

export interface RunInput {
  sources: unknown;
  focus?: unknown;
  depth: unknown;
}

export interface IdeaInput {
  title: unknown;
  summary: unknown;
  impact: unknown;
  effort: unknown;
  stageId?: unknown;
  overlapsGoalId?: unknown;
  evidence: unknown;
}

// ------------------------------------------------------------------ lookups

/** What GET /api/research returns: empty lists when there has never been a run. */
export function getResearch(state: MusterState): ResearchState {
  return state.research ?? { runs: [], ideas: [] };
}

/** state.research, created on the first write. */
function researchOf(state: MusterState): ResearchState {
  return (state.research ??= { runs: [], ideas: [] });
}

export function runningRun(state: MusterState): ResearchRun | undefined {
  return state.research?.runs.find((r) => r.status === 'running');
}

/** A run by id; "current" is the running one (finish_research doesn't need to know its id). */
export function requireRun(state: MusterState, id: string): ResearchRun {
  const key = String(id).trim().toUpperCase();
  const run = key === 'CURRENT' ? runningRun(state) : state.research?.runs.find((r) => r.id === key);
  if (!run) throw notFound(key === 'CURRENT' ? 'No research run is running' : `No research run "${id}"`);
  return run;
}

export function requireIdea(state: MusterState, id: string): ResearchIdea {
  const idea = state.research?.ideas.find((i) => i.id === String(id).trim().toUpperCase());
  if (!idea) throw notFound(`No idea "${id}"`);
  return idea;
}

export const isResearcher = (state: MusterState, actor: string) => findAgent(state, actor)?.role === 'research';

function requireHuman(actor: string, what: string): void {
  if (actor !== HUMAN) throw forbidden(`Only you can ${what}`);
}

function requireResearcher(state: MusterState, actor: string, what: string): void {
  if (!isResearcher(state, actor)) throw forbidden(`Only the research agent can ${what}`);
}

/** Inbox for the Captain (from "muster" when the Captain did it itself; addInbox drops items to their own sender). */
function tellCaptain(state: MusterState, from: string, text: string): void {
  const captain = captainOf(state);
  if (captain) addInbox(state, { agentId: captain.id, from: from === captain.id ? SYSTEM : from, kind: 'system', text });
}

// ------------------------------------------------------------------ validation

function text(v: unknown, what: string, max: number, required = true): string {
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`${what} is empty`);
    return '';
  }
  if (typeof v !== 'string') throw badRequest(`${what} must be text`);
  const t = v.trim();
  if (required && !t) throw badRequest(`${what} is empty`);
  if (t.length > max) throw badRequest(`${what} is longer than ${max} characters`);
  return t;
}

function stringList(v: unknown, what: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw badRequest(`${what} must be a list of names`);
  const items = [...new Set(v.map((x: string) => x.trim()).filter(Boolean))];
  if (items.length > MAX_SOURCE_ITEMS) throw badRequest(`${what}: at most ${MAX_SOURCE_ITEMS}`);
  for (const x of items) if (x.length > MAX_SOURCE_TEXT) throw badRequest(`${what}: "${x.slice(0, 40)}…" is longer than ${MAX_SOURCE_TEXT} characters`);
  return items;
}

function bool(v: unknown, what: string): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') throw badRequest(`${what} must be true or false`);
  return v;
}

export function checkSources(raw: unknown): ResearchSources {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('sources must be { competitors, reviews, forums, ownApp }');
  const s = raw as Record<string, unknown>;
  const sources: ResearchSources = {
    competitors: stringList(s.competitors, 'competitors'),
    reviews: bool(s.reviews, 'reviews'),
    forums: stringList(s.forums, 'forums'),
    ownApp: bool(s.ownApp, 'ownApp'),
  };
  if (!sources.competitors.length && !sources.reviews && !sources.forums.length && !sources.ownApp) {
    throw badRequest('Choose at least one source: similar apps, their reviews, forums or our own app');
  }
  return sources;
}

function checkEvidence(raw: unknown): IdeaEvidence[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_EVIDENCE) throw badRequest(`An idea needs 1–${MAX_EVIDENCE} evidence items`);
  return raw.map((e, i) => {
    const what = `Evidence ${i + 1}`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw badRequest(`${what} is not an object`);
    const kind = (e as IdeaEvidence).kind;
    if (!EVIDENCE_KINDS.includes(kind)) throw badRequest(`${what}: kind must be one of ${EVIDENCE_KINDS.join(', ')}`);
    const source = text((e as IdeaEvidence).source, `${what} source`, MAX_SOURCE_TEXT);
    const quote = text((e as IdeaEvidence).text, `${what} text`, MAX_QUOTE, false);
    const url = text((e as IdeaEvidence).url, `${what} url`, 2000, false);
    if (url && !/^https?:\/\/\S+$/i.test(url)) throw badRequest(`${what}: url must be an http(s) link`);
    const count = (e as IdeaEvidence).count;
    if (count !== undefined && count !== null && (!Number.isInteger(count) || count < 0)) throw badRequest(`${what}: count must be a whole number`);
    return { kind, source, ...(quote ? { text: quote } : {}), ...(url ? { url } : {}), ...(typeof count === 'number' ? { count } : {}) };
  });
}

/** An optional stage/goal id that must exist on the roadmap (400 otherwise: scout passes them, not a URL). */
function roadmapRef(state: MusterState, v: unknown, kind: 'stage' | 'goal'): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw badRequest(`${kind === 'stage' ? 'stageId' : 'overlapsGoalId'} must be an id like "${kind === 'stage' ? 'M2' : 'G3'}"`);
  const id = v.trim().toUpperCase();
  const list: { id: string }[] = (kind === 'stage' ? state.roadmap?.stages : state.roadmap?.goals) ?? [];
  if (!list.some((x) => x.id === id)) throw badRequest(`No ${kind} "${v}" on the roadmap${list.length ? ` (${kind}s: ${list.map((x) => x.id).join(', ')})` : ''}`);
  return id;
}

// ------------------------------------------------------------------ runs

const describeSources = (s: ResearchSources) =>
  [s.competitors.length ? s.competitors.join(', ') : '', s.reviews ? 'reviews' : '', s.forums.length ? s.forums.join(', ') : '', s.ownApp ? 'own app' : ''].filter(Boolean).join('; ');

/** POST /api/research/runs: you only, one run at a time, refused while paused. The caller then starts scout. */
export function startRun(state: MusterState, actor: string, input: RunInput): ResearchRun {
  requireHuman(actor, 'start research');
  assertNotPaused(state);
  const busy = runningRun(state);
  if (busy) throw conflict(`${busy.id} is still running; cancel it or wait for scout to finish`);
  const sources = checkSources(input?.sources);
  const depth = input?.depth as ResearchRun['depth'];
  if (!DEPTHS.includes(depth)) throw badRequest('depth must be "quick" or "thorough"');
  const focus = text(input?.focus, 'focus', MAX_FOCUS, false);
  const run: ResearchRun = {
    id: nextId(state, 'run'),
    status: 'running',
    sources,
    ...(focus ? { focus } : {}),
    depth,
    agentId: SCOUT_ID,
    startedAt: nowIso(),
    ideaIds: [],
  };
  researchOf(state).runs.push(run);
  addFeed(state, { kind: 'event', from: actor, text: `started research ${run.id} (${depth}: ${describeSources(sources)})${focus ? `: ${focus.slice(0, 120)}` : ''}` });
  return run;
}

/** POST /api/research/runs/:id/cancel: you only, a running run. The caller stops scout. */
export function cancelRun(state: MusterState, actor: string, id: string): ResearchRun {
  requireHuman(actor, 'cancel research');
  const run = requireRun(state, id);
  if (run.status !== 'running') throw conflict(`${run.id} is already ${run.status}`);
  run.status = 'cancelled';
  run.finishedAt = nowIso();
  addFeed(state, { kind: 'event', from: actor, text: `cancelled research ${run.id} (${run.ideaIds.length} idea${run.ideaIds.length === 1 ? '' : 's'} found)` });
  return run;
}

/** POST /api/research/runs/:id/finish (finish_research): the research agent only. The caller stops scout and toasts. */
export function finishRun(state: MusterState, actor: string, id: string, input: { summary: unknown; sourcesRead?: unknown }): ResearchRun {
  requireResearcher(state, actor, 'finish research');
  const run = requireRun(state, id);
  if (run.status !== 'running') throw conflict(`${run.id} is ${run.status}, not running`);
  const summary = text(input?.summary, 'summary', MAX_SUMMARY * 2);
  const read = input?.sourcesRead;
  if (read !== undefined && read !== null && (!Number.isInteger(read) || (read as number) < 0)) throw badRequest('sourcesRead must be a whole number');
  run.status = 'done';
  run.finishedAt = nowIso();
  run.summary = summary;
  if (typeof read === 'number') run.sourcesRead = read;
  addFeed(state, { kind: 'event', from: actor, text: `finished research ${run.id}: ${foundText(run)}` });
  return run;
}

/** "scout found 4 ideas" (toast and notification on finish). */
export const foundText = (run: ResearchRun) => `${run.agentId} found ${run.ideaIds.length} idea${run.ideaIds.length === 1 ? '' : 's'}`;

/** scout's process ended while its run was still going (crash, or it exited without finish_research). */
export function failRun(state: MusterState, reason: string): ResearchRun | undefined {
  const run = runningRun(state);
  if (!run) return undefined;
  run.status = 'failed';
  run.finishedAt = nowIso();
  addFeed(state, { kind: 'event', from: SYSTEM, text: `research ${run.id} failed: ${reason} (${run.ideaIds.length} idea${run.ideaIds.length === 1 ? '' : 's'} kept)` });
  return run;
}

// ------------------------------------------------------------------ brief

/** GET /api/research/brief: what scout works from — the running run, the product and roadmap, ideas already found, the rules. */
export function researchBrief(state: MusterState, repoRoot = state.repoRoot): string {
  const run = runningRun(state);
  if (!run) return 'No research run is running. Nothing to do: wait until you are given a run.';
  const s = run.sources;
  const out: string[] = [`Research run ${run.id} (${run.depth}).`];
  if (run.focus) out.push(`Focus from the user: ${run.focus}`);
  out.push('', 'Sources to cover:');
  if (s.competitors.length) out.push(`- Similar apps: ${s.competitors.join(', ')}. Read their public roadmaps, changelogs, pricing and help pages.`);
  if (s.reviews) out.push(`- Reviews: app-store and G2 reviews${s.competitors.length ? ' of those apps' : ' of apps like ours'}, low ratings first.`);
  if (s.forums.length) out.push(`- Forums: ${s.forums.join(', ')}. Threads where people describe the problem in their own words.`);
  if (s.ownApp) out.push(`- Our own app: read the code in ${repoRoot} and the roadmap for rough edges.`);

  const r = state.roadmap;
  out.push('', 'Product:');
  if (!r) out.push('No roadmap yet: work out what the product is from the README and the code. Leave stage and overlaps empty.');
  else {
    out.push(`${r.title}${r.summary ? ` — ${r.summary}` : ''}`, '', 'Roadmap (use these ids for stage and overlaps):');
    for (const st of r.stages) {
      const dates = st.start || st.due ? `, ${st.start ?? '?'} → ${st.due ?? '?'}` : '';
      out.push(`${st.id} ${st.title} (${st.status}${dates})`);
      for (const gid of st.goalIds) {
        const g = r.goals.find((x) => x.id === gid);
        if (g) out.push(`  ${g.id} ${g.title} (${g.status})`);
      }
    }
  }

  const ideas = state.research?.ideas ?? [];
  out.push('', 'Ideas already found (never post them again):');
  if (!ideas.length) out.push('none yet');
  for (const i of ideas.slice(-60)) out.push(`- ${i.id} ${i.title} (${i.status})`);

  out.push(
    '',
    'Rules:',
    '- Public pages only: never sign in, never post, comment, vote or fill in forms.',
    `- Quotes at most ${MAX_QUOTE} characters; name the source, link it, and give counts ("+37 similar", upvotes).`,
    '- Each idea is a user problem backed by evidence, not a feature wish. One add_idea per idea, 1–8 evidence items each.',
    '- Set stage to the stage it fits and overlaps to a goal it overlaps, when there is one.',
    `- Aim for ${IDEA_TARGET[run.depth]} ideas (${run.depth}).`,
    '- When you are done, call finish_research with a one-paragraph summary and how many sources you read.',
  );
  return out.join('\n');
}

// ------------------------------------------------------------------ ideas

/** POST /api/research/ideas (add_idea): the research agent only, while a run is running. */
export function addIdea(state: MusterState, actor: string, input: IdeaInput): ResearchIdea {
  requireResearcher(state, actor, 'add research ideas');
  const run = runningRun(state);
  if (!run) throw conflict('No research run is running; ideas can only be added during one');
  const title = text(input?.title, 'title', MAX_IDEA_TITLE);
  const summary = text(input?.summary, 'summary', MAX_SUMMARY);
  const impact = input?.impact as IdeaImpact;
  if (!IMPACTS.includes(impact)) throw badRequest(`impact must be one of ${IMPACTS.join(', ')}`);
  const effort = typeof input?.effort === 'string' ? (input.effort.trim().toUpperCase() as ResearchIdea['effort']) : undefined;
  if (!effort || !EFFORTS.includes(effort)) throw badRequest('effort must be S, M or L');
  const stageId = roadmapRef(state, input?.stageId, 'stage');
  const overlapsGoalId = roadmapRef(state, input?.overlapsGoalId, 'goal');
  const evidence = checkEvidence(input?.evidence);
  const research = researchOf(state);
  const same = research.ideas.find((i) => i.title.toLowerCase() === title.toLowerCase());
  if (same) throw conflict(`${same.id} "${same.title}" is already an idea; add new evidence to a different problem, or skip it`);
  const idea: ResearchIdea = {
    id: nextId(state, 'idea'),
    runId: run.id,
    title,
    summary,
    impact,
    effort,
    ...(stageId ? { stageId } : {}),
    ...(overlapsGoalId ? { overlapsGoalId } : {}),
    evidence,
    status: 'new',
    thread: [],
    createdAt: nowIso(),
  };
  research.ideas.push(idea);
  run.ideaIds.push(idea.id);
  addFeed(state, { kind: 'event', from: actor, text: `found idea ${idea.id} ${idea.title} (${impact} impact, effort ${effort})` });
  return idea;
}

/** POST /api/research/ideas/:id/ask: you ask the Captain about an idea; the answer comes back with advise_idea. */
export function askIdea(state: MusterState, actor: string, id: string, question: unknown): ResearchIdea {
  requireHuman(actor, 'ask about ideas');
  const idea = requireIdea(state, id);
  const body = text(question, 'text', MAX_THREAD_TEXT);
  idea.thread.push({ at: nowIso(), from: actor, text: body });
  addFeed(state, { kind: 'event', from: actor, text: `asked the Captain about ${idea.id} ${idea.title}` });
  tellCaptain(
    state,
    actor,
    `You asked about ${idea.id} ${idea.title}: ${body}. Read it with get_idea ${idea.id} and answer with advise_idea (include the roadmap changes you'd make on approval).`,
  );
  return idea;
}

/** POST /api/research/ideas/:id/advice (advise_idea): the Captain only. `plan` = the roadmap changes it would make on approval. */
export function adviseIdea(state: MusterState, actor: string, id: string, input: { text: unknown; plan?: unknown }): ResearchIdea {
  if (!isCaptain(state, actor)) throw forbidden('Only the Captain advises on ideas');
  const idea = requireIdea(state, id);
  const body = text(input?.text, 'text', MAX_THREAD_TEXT);
  let plan: string[] | undefined;
  if (input?.plan !== undefined && input.plan !== null) {
    if (!Array.isArray(input.plan) || input.plan.some((p) => typeof p !== 'string')) throw badRequest('plan must be a list of roadmap changes');
    plan = input.plan.map((p: string) => p.trim()).filter(Boolean);
    if (plan.length > MAX_PLAN_ITEMS) throw badRequest(`plan: at most ${MAX_PLAN_ITEMS} changes`);
    for (const p of plan) if (p.length > MAX_QUOTE) throw badRequest(`plan: "${p.slice(0, 40)}…" is longer than ${MAX_QUOTE} characters`);
  }
  idea.thread.push({ at: nowIso(), from: actor, text: body });
  if (plan?.length) idea.plan = plan;
  addFeed(state, { kind: 'event', from: actor, text: `advised on ${idea.id} ${idea.title}` });
  return idea;
}

/** POST /api/research/ideas/:id/approve: you only, from new. The Captain adds it to the roadmap (no second approval). */
export function approveIdea(state: MusterState, actor: string, id: string): ResearchIdea {
  requireHuman(actor, 'approve ideas');
  const idea = requireIdea(state, id);
  if (idea.status !== 'new') throw conflict(`${idea.id} is already ${idea.status}`);
  idea.status = 'approved';
  idea.decidedAt = nowIso();
  addFeed(state, { kind: 'event', from: actor, text: `approved idea ${idea.id} ${idea.title}` });
  const stage = idea.stageId ?? 'stage';
  tellCaptain(
    state,
    actor,
    `${idea.id} ${idea.title} approved. Add it to the roadmap now: add_goal(${stage}, …, idea: "${idea.id}") (or update_goal/link_tasks if it overlaps a goal${idea.overlapsGoalId ? ` — scout says ${idea.overlapsGoalId}` : ''}). That change is already approved — no second approval.`,
  );
  return idea;
}

/** POST /api/research/ideas/:id/reject: you only. An idea already on the roadmap (it has a goal) can't be rejected. */
export function rejectIdea(state: MusterState, actor: string, id: string, note?: unknown): ResearchIdea {
  requireHuman(actor, 'reject ideas');
  const idea = requireIdea(state, id);
  if (idea.status === 'rejected') throw conflict(`${idea.id} is already rejected`);
  if (idea.goalId) throw conflict(`${idea.id} is on the roadmap as ${idea.goalId}; change or cancel that goal instead`);
  const body = text(note, 'note', MAX_THREAD_TEXT, false);
  const wasApproved = idea.status === 'approved';
  idea.status = 'rejected';
  idea.decidedAt = nowIso();
  if (body) idea.thread.push({ at: idea.decidedAt, from: actor, text: body });
  addFeed(state, { kind: 'event', from: actor, text: `rejected idea ${idea.id} ${idea.title}${body ? `: ${body.slice(0, 120)}` : ''}` });
  if (wasApproved) tellCaptain(state, actor, `${idea.id} ${idea.title} was rejected after all${body ? `: ${body}` : ''}. Don't add it to the roadmap.`);
  return idea;
}

/** POST /api/research/ideas/:id/reopen: you only; a rejected (or approved but not yet added) idea goes back to new. */
export function reopenIdea(state: MusterState, actor: string, id: string): ResearchIdea {
  requireHuman(actor, 'reopen ideas');
  const idea = requireIdea(state, id);
  if (idea.status === 'new') throw conflict(`${idea.id} is already new`);
  if (idea.goalId) throw conflict(`${idea.id} is on the roadmap as ${idea.goalId}`);
  const wasApproved = idea.status === 'approved';
  idea.status = 'new';
  delete idea.decidedAt;
  addFeed(state, { kind: 'event', from: actor, text: `reopened idea ${idea.id} ${idea.title}` });
  if (wasApproved) tellCaptain(state, actor, `${idea.id} ${idea.title} is undecided again. Don't add it to the roadmap unless it is approved again.`);
  return idea;
}
