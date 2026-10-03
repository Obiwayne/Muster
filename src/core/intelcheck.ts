// Verdicts (Gap / Edge / Open), the shared intel check every idea passes before approval, and the re-check alert.
// Pure functions over IntelStore + MusterState; the API layer commits, notifies and toasts.
// See docs/ARCHITECTURE.md § "Competitive intelligence" → Verdicts, Intel check.
import {
  INTEL_CHECK_AREAS,
  type CapabilityStatus,
  type CapabilityVerdict,
  type IntelArea,
  type IntelCapability,
  type IntelChange,
  type IntelCheck,
  type IntelCheckArea,
  type IntelCheckRow,
  type IntelConfidence,
  type IntelStore,
  type IntelVerdict,
  type IntelWatch,
  type MusterConfig,
  type MusterState,
  type Note,
  type ResearchIdea,
  type Roadmap,
} from '../types.js';
import { addInbox, captainOf, HUMAN, isCaptain, nowIso, postNote, SYSTEM } from './board.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import {
  checkClaim,
  CONFIDENCES,
  createIdeaWatch,
  enqueueJob,
  nextIntelId,
  oneOf,
  requireResearcher,
  runningJob,
  stopWatch,
  text,
  trackedIds,
  US,
} from './intel.js';

const DAY_MS = 86_400_000;
export const NO_COMPETITORS = 'no competitors tracked';
const VERDICTS: IntelVerdict[] = ['gap', 'edge', 'edge_at_risk', 'open', 'parity', 'unclear'];
const SIGNALS: IntelCheckRow['signal'][] = ['supports', 'against', 'neutral', 'threat'];
/** Which IntelArea a check row speaks for (change log entries need one). */
const CHECK_AREA_TO_INTEL: Record<IntelCheckArea, IntelArea> = { features: 'features', complaints: 'reviews', social: 'marketing', plans: 'roadmap', pricing: 'pricing', audience: 'audience', ai: 'ai' };

/** "edge_at_risk" → "edge at risk" (notes, inbox lines, the dashboard chip). */
export const verdictWords = (v: IntelVerdict | CapabilityVerdict) => v.replace(/_/g, ' ');

// ------------------------------------------------------------------ capability verdicts

/** Our cell, with a linked goal overriding it: an open goal → planned at its stage, a done goal → yes. */
export function usStatus(cap: IntelCapability, roadmap?: Roadmap | null): { status: CapabilityStatus; stageId?: string } {
  const goal = cap.goalId ? roadmap?.goals.find((g) => g.id === cap.goalId) : undefined;
  if (goal && goal.status === 'done') return { status: 'yes' };
  if (goal && goal.status !== 'cancelled') return { status: 'planned', stageId: goal.stageId };
  const cell = cap.cells[US];
  return { status: cell?.status ?? 'none', ...(cell?.stageId ? { stageId: cell.stageId } : {}) };
}

/**
 * One feature-matrix row's verdict against the tracked competitors (pure; the contract's table):
 * us yes → edge vs everyone without yes (parity when nobody lacks it); us not yes and anyone yes/paid → gap vs them
 * (closing at our stage when planned); us planned and nobody yes/paid → edge at our stage; nobody has it → open;
 * otherwise (only partials) → parity.
 */
export function capabilityVerdict(cap: IntelCapability, competitorIds: string[], roadmap?: Roadmap | null): Pick<IntelCapability, 'verdict' | 'verdictVs' | 'verdictStage'> {
  const us = usStatus(cap, roadmap);
  const them = competitorIds.map((id) => ({ id, status: cap.cells[id]?.status ?? ('none' as CapabilityStatus) }));
  if (us.status === 'yes') {
    const vs = them.filter((t) => t.status !== 'yes').map((t) => t.id);
    return vs.length ? { verdict: 'edge', verdictVs: vs } : { verdict: 'parity', verdictVs: [] };
  }
  const having = them.filter((t) => t.status === 'yes' || t.status === 'paid').map((t) => t.id);
  if (having.length) return { verdict: 'gap', verdictVs: having, ...(us.status === 'planned' && us.stageId ? { verdictStage: us.stageId } : {}) };
  if (us.status === 'planned') return { verdict: 'edge', verdictVs: them.map((t) => t.id), ...(us.stageId ? { verdictStage: us.stageId } : {}) };
  const nobody = (s: CapabilityStatus) => s === 'none' || s === 'missing';
  if (nobody(us.status) && them.every((t) => nobody(t.status) || t.status === 'planned')) return { verdict: 'open', verdictVs: [] };
  return { verdict: 'parity', verdictVs: [] };
}

/** Recomputes every capability's verdict (after a capability write or a roadmap change). True when any changed. */
export function recomputeVerdicts(store: IntelStore, state: MusterState): boolean {
  const ids = trackedIds(store);
  let changed = false;
  for (const cap of store.capabilities) {
    // An idea raised for this row that is now on the roadmap: the row follows its goal.
    if (!cap.goalId && cap.ideaId) {
      const goalId = state.research?.ideas.find((i) => i.id === cap.ideaId)?.goalId;
      if (goalId) {
        cap.goalId = goalId;
        changed = true;
      }
    }
    const v = capabilityVerdict(cap, ids, state.roadmap);
    if (cap.verdict === v.verdict && cap.verdictVs.join() === v.verdictVs.join() && cap.verdictStage === v.verdictStage) continue;
    cap.verdict = v.verdict;
    cap.verdictVs = v.verdictVs;
    if (v.verdictStage) cap.verdictStage = v.verdictStage;
    else delete cap.verdictStage;
    changed = true;
  }
  return changed;
}

/** Plans that put an edge on these rows at risk: a live commitment, or a prediction of medium or high confidence. */
export function threats(store: IntelStore, capabilityIds: string[]) {
  return store.plans.filter(
    (p) =>
      p.capabilityIds.some((id) => capabilityIds.includes(id)) &&
      p.status !== 'shipped' &&
      p.status !== 'dropped' &&
      (p.kind === 'commitment' || p.confidence !== 'low'),
  );
}

/**
 * The verdict of a check: with capabilityIds, gap if any linked row is a gap, open if all are open, else edge
 * (edge_at_risk when a plan threatens those rows) when any row is an edge, else parity. Without capabilityIds,
 * scout's verdict stands (`unclear` allowed).
 */
export function checkVerdict(check: Pick<IntelCheck, 'capabilityIds' | 'verdict'>, store: IntelStore): IntelVerdict {
  const caps = check.capabilityIds.map((id) => store.capabilities.find((c) => c.id === id)).filter((c): c is IntelCapability => !!c);
  if (!caps.length) return check.verdict;
  if (caps.some((c) => c.verdict === 'gap')) return 'gap';
  if (caps.every((c) => c.verdict === 'open')) return 'open';
  if (caps.some((c) => c.verdict === 'edge')) return threats(store, check.capabilityIds).length ? 'edge_at_risk' : 'edge';
  return 'parity';
}

// ------------------------------------------------------------------ checks

export function requireIdea(state: MusterState, id: string): ResearchIdea {
  const idea = state.research?.ideas.find((i) => i.id === String(id).trim().toUpperCase());
  if (!idea) throw notFound(`No idea "${id}"`);
  return idea;
}

export const checkOf = (store: IntelStore, idea: ResearchIdea) => (idea.checkId ? store.checks.find((c) => c.id === idea.checkId) : undefined);

function newCheck(store: IntelStore, idea: ResearchIdea, status: IntelCheck['status']): IntelCheck {
  const check: IntelCheck = {
    id: nextIntelId(store, 'check'),
    ideaId: idea.id,
    revision: 1,
    status,
    rows: [],
    verdict: 'unclear',
    verdictText: '',
    confidence: 'low',
    sourceCount: 0,
    capabilityIds: [...(idea.opportunity?.capabilityIds ?? [])],
    createdAt: nowIso(),
    history: [],
    ...(idea.goalId ? { goalId: idea.goalId } : {}),
  };
  store.checks.push(check);
  idea.checkId = check.id;
  return check;
}

/** No competitors tracked: the idea's check is `skipped` at once (approval may go ahead). */
export function skipCheck(store: IntelStore, idea: ResearchIdea): IntelCheck {
  const check = checkOf(store, idea) ?? newCheck(store, idea, 'skipped');
  check.status = 'skipped';
  check.skippedReason = NO_COMPETITORS;
  check.doneAt = nowIso();
  return check;
}

/** A done or skipped check younger than config.intel.checkMaxAgeDays. */
export function isFresh(check: IntelCheck | undefined, config: Pick<MusterConfig, 'intel'>, now = Date.now()): boolean {
  if (!check || (check.status !== 'done' && check.status !== 'skipped')) return false;
  const at = Date.parse(check.doneAt ?? check.createdAt);
  return now - at < config.intel.checkMaxAgeDays * DAY_MS;
}

/**
 * The approval gate: the idea's check must be done or skipped and fresh. With no competitors tracked a skipped check
 * is created on the spot. Otherwise 409 says what to do.
 */
export function checkGate(store: IntelStore, idea: ResearchIdea, config: Pick<MusterConfig, 'intel'>, now = Date.now()): IntelCheck {
  const check = checkOf(store, idea);
  if (isFresh(check, config, now)) return check!;
  if (!trackedIds(store).length && check?.status !== 'queued' && check?.status !== 'running') return skipCheck(store, idea);
  const ref = `${idea.id} ${idea.title}`;
  if (!check) throw conflict(`${ref} needs an intel check before you approve it. Run intel check (POST /api/intel/checks { ideaId: "${idea.id}" }), then approve when it is done.`);
  if (check.status === 'queued' || check.status === 'running') throw conflict(`The intel check ${check.id} of ${ref} is still ${check.status}; approve once it is done.`);
  if (check.status === 'failed') throw conflict(`The intel check ${check.id} of ${ref} failed${check.skippedReason ? ` (${check.skippedReason})` : ''}. Run intel check again, then approve.`);
  const days = Math.floor((now - Date.parse(check.doneAt ?? check.createdAt)) / DAY_MS);
  throw conflict(`The intel check ${check.id} of ${ref} is ${days} days old (older than ${config.intel.checkMaxAgeDays}). Run a fresh intel check, then approve.`);
}

/** POST /api/intel/checks: you or the Captain queue a check job for an idea (or get the queued/running one). */
export function requestCheck(store: IntelStore, state: MusterState, actor: string, ideaId: unknown, config: Pick<MusterConfig, 'researchBrowser'>): IntelCheck {
  if (actor !== HUMAN && !isCaptain(state, actor)) throw forbidden('Only you or the Captain can request an intel check');
  const idea = requireIdea(state, text(ideaId, 'ideaId', 20));
  let check = checkOf(store, idea);
  if (check && (check.status === 'queued' || check.status === 'running')) return check;
  const ids = trackedIds(store);
  if (!ids.length) return skipCheck(store, idea);
  check ??= newCheck(store, idea, 'queued');
  check.status = 'queued';
  delete check.skippedReason;
  const job = enqueueJob(store, {
    kind: 'check',
    competitorIds: ids,
    areas: ['features', 'reviews', 'roadmap', 'pricing', 'audience', 'marketing', 'ai'],
    browse: config.researchBrowser.mode,
    depth: 'quick',
    by: actor,
    ideaId: idea.id,
    checkId: check.id,
  });
  job.checkId ??= check.id;
  check.jobId = job.id;
  return check;
}

export interface CheckInput {
  rows: unknown;
  verdict?: unknown;
  verdictText: unknown;
  confidence: unknown;
  capabilityIds?: unknown;
  watchFor?: unknown;
}

function checkRows(raw: unknown): IntelCheckRow[] {
  if (!Array.isArray(raw) || raw.length < 1) throw badRequest('rows: at least one row (one per area you covered)');
  if (raw.length > INTEL_CHECK_AREAS.length) throw badRequest(`rows: at most ${INTEL_CHECK_AREAS.length}, one per area`);
  const seen = new Set<string>();
  return raw.map((r, i) => {
    const what = `rows[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw badRequest(`${what} must be an object`);
    const o = r as Record<string, unknown>;
    const area = oneOf(o.area, INTEL_CHECK_AREAS, `${what}.area`);
    if (seen.has(area)) throw badRequest(`${what}.area: "${area}" appears twice; one row per area`);
    seen.add(area);
    return { ...checkClaim(o, what), area, finding: text(o.finding, `${what}.finding`, 300), signal: oneOf(o.signal, SIGNALS, `${what}.signal`) };
  });
}

const rowKey = (r: IntelCheckRow) => [r.finding, r.signal, r.label, r.confidence].join('|');

export interface WriteResult {
  check: IntelCheck;
  /** Set on a re-check of an approved idea whose verdict, confidence or a threat/against row changed. */
  alert?: { change: IntelChange; note: Note; notifyText: string };
}

/**
 * POST /api/intel/checks/:ideaId (intel_check): the research agent writes the idea's check, during an intel job or a
 * research run. A check written before becomes revision n+1: the old one goes to `history`, differing rows get `changed`.
 */
export function writeCheck(store: IntelStore, state: MusterState, actor: string, ideaId: string, input: CheckInput): WriteResult {
  requireResearcher(state, actor, 'write intel checks');
  const job = runningJob(store);
  const run = state.research?.runs.find((r) => r.status === 'running');
  if (!job && !run) throw conflict('Nothing is running: write intel checks during an intel job or a research run');
  const idea = requireIdea(state, ideaId);
  const rows = checkRows(input?.rows);
  const verdictText = text(input?.verdictText, 'verdictText', 1000);
  const confidence = oneOf(input?.confidence, CONFIDENCES, 'confidence') as IntelConfidence;
  let capabilityIds: string[] | undefined;
  if (input?.capabilityIds !== undefined && input.capabilityIds !== null) {
    if (!Array.isArray(input.capabilityIds)) throw badRequest('capabilityIds must be a list of capability ids (F3)');
    capabilityIds = [...new Set(input.capabilityIds.map((x, i) => {
      const id = text(x, `capabilityIds[${i}]`, 20).toUpperCase();
      if (!store.capabilities.some((c) => c.id === id)) throw badRequest(`capabilityIds[${i}]: no capability "${x}"`);
      return id;
    }))];
  }
  const scoutVerdict = input?.verdict === undefined || input.verdict === null ? 'unclear' : oneOf(input.verdict, VERDICTS, 'verdict');
  const watchFor = text(input?.watchFor, 'watchFor', 300, false);

  let check = checkOf(store, idea);
  const prev = check?.doneAt && check.status !== 'skipped' ? { verdict: check.verdict, confidence: check.confidence, rows: check.rows, revision: check.revision, doneAt: check.doneAt } : undefined;
  if (!check) check = newCheck(store, idea, 'running');
  if (prev) {
    check.history.push({ revision: prev.revision, verdict: prev.verdict, confidence: prev.confidence, doneAt: prev.doneAt, changedAreas: prev.rows.filter((r) => r.changed).map((r) => r.area) });
    check.revision = prev.revision + 1;
    for (const r of rows) {
      const old = prev.rows.find((x) => x.area === r.area);
      if (!old || rowKey(old) !== rowKey(r)) r.changed = true;
    }
  }
  check.rows = rows;
  check.verdictText = verdictText;
  check.confidence = confidence;
  if (capabilityIds) check.capabilityIds = capabilityIds;
  else if (!check.capabilityIds.length && idea.opportunity?.capabilityIds.length) check.capabilityIds = [...idea.opportunity.capabilityIds];
  check.verdict = check.capabilityIds.length ? checkVerdict({ capabilityIds: check.capabilityIds, verdict: scoutVerdict }, store) : scoutVerdict;
  if (watchFor) check.watchFor = watchFor;
  check.sourceCount = new Set(rows.flatMap((r) => r.sources.map((s) => s.url ?? `${s.kind}:${s.title}`))).size;
  check.status = 'done';
  delete check.skippedReason;
  check.doneAt = nowIso();
  if (job) check.jobId = job.id;
  if (idea.goalId) check.goalId = idea.goalId;
  idea.checkId = check.id;

  const watch = idea.watchId ? store.watches.find((w) => w.id === idea.watchId) : undefined;
  if (watch && job?.kind === 'recheck') watch.lastAt = check.doneAt;
  if (!prev || idea.status !== 'approved') return { check };
  const what = recheckAlert(prev, check);
  if (!what) return { check };
  return { check, alert: raiseRecheckAlert(store, state, idea, check, prev.verdict, what) };
}

/**
 * Decides whether a re-check needs you: the verdict or confidence changed, or a row that changed is a threat or
 * against. Returns what changed (one line), or undefined when only the watch's lastAt should move.
 */
export function recheckAlert(prev: { verdict: IntelVerdict; confidence: IntelConfidence }, next: Pick<IntelCheck, 'verdict' | 'confidence' | 'rows'>): string | undefined {
  const parts: string[] = [];
  if (prev.verdict !== next.verdict) parts.push(`verdict ${verdictWords(prev.verdict)} → ${verdictWords(next.verdict)}`);
  if (prev.confidence !== next.confidence) parts.push(`confidence ${prev.confidence} → ${next.confidence}`);
  const moved = next.rows.filter((r) => r.changed && (r.signal === 'threat' || r.signal === 'against'));
  for (const r of moved) parts.push(`${r.area}: ${r.finding} (${r.signal})`);
  return parts.length ? parts.join('; ') : undefined;
}

/** The re-check alert's side effects: a 'respond' change, an open intel note to you, and a Captain inbox line. */
function raiseRecheckAlert(store: IntelStore, state: MusterState, idea: ResearchIdea, check: IntelCheck, before: IntelVerdict, what: string): NonNullable<WriteResult['alert']> {
  const changedRows = check.rows.filter((r) => r.changed);
  const basis = changedRows.find((r) => r.signal === 'threat' || r.signal === 'against') ?? changedRows[0] ?? check.rows[0];
  const sources = [...(changedRows.length ? changedRows : check.rows).flatMap((r) => r.sources)].slice(0, 12);
  const threat = threats(store, check.capabilityIds)[0];
  const vsCap = check.capabilityIds.map((id) => store.capabilities.find((c) => c.id === id)).find((c) => c?.verdictVs.length);
  const competitorId = threat?.competitorId ?? vsCap?.verdictVs[0] ?? trackedIds(store)[0] ?? US;
  const change: IntelChange = {
    id: nextIntelId(store, 'change'),
    label: basis.label,
    confidence: check.confidence,
    sources,
    asOf: check.doneAt!.slice(0, 10),
    implication: check.verdictText,
    ...(basis.label === 'prediction' && basis.prediction ? { prediction: basis.prediction } : {}),
    at: check.doneAt!.slice(0, 10),
    competitorId,
    area: CHECK_AREA_TO_INTEL[basis.area],
    title: `Re-check of ${idea.id} ${idea.title}: ${what}`.slice(0, 200),
    planImpact: 'respond',
    ideaId: idea.id,
    ...(idea.goalId ? { goalId: idea.goalId } : {}),
    seen: false,
    ...(check.jobId ? { jobId: check.jobId } : {}),
  };
  store.changes.push(change);
  const verdictMove = before !== check.verdict ? `verdict ${verdictWords(before)} → ${verdictWords(check.verdict)}` : what;
  const notifyText = `Intel: ${idea.id} ${idea.title} ${verdictMove}`;
  const note = postNote(state, { actor: SYSTEM, type: 'system', to: HUMAN, topic: 'intel', text: `${notifyText}. ${what === verdictMove ? '' : `${what}. `}${check.verdictText} (${change.id}; the Captain is asked whether the plan needs to respond.)` });
  note.open = true;
  const captain = captainOf(state);
  if (captain) {
    addInbox(state, {
      agentId: captain.id,
      from: SYSTEM,
      kind: 'system',
      text: `Re-check of ${idea.id} ${idea.title}${idea.goalId ? ` (${idea.goalId})` : ''}: ${what}. Does the plan need to respond? Suggest it with intel_suggest(${change.id}, text).`,
    });
  }
  return { change, note, notifyText };
}

// ------------------------------------------------------------------ approval and upkeep

/** After an idea is approved: its re-check watch (config.intel.recheck; off = none) and the Captain's extra line. */
export function onApproved(store: IntelStore, idea: ResearchIdea, check: IntelCheck, config: Pick<MusterConfig, 'intel'>): { watch?: IntelWatch; line: string } {
  const watch = createIdeaWatch(store, idea.id, config.intel.recheck, check.watchFor ? `alert if ${check.watchFor}` : undefined);
  if (watch) idea.watchId = watch.id;
  const what = check.status === 'skipped' ? `skipped (${check.skippedReason ?? NO_COMPETITORS})` : `${verdictWords(check.verdict)} (${check.confidence}, ${check.sourceCount} source${check.sourceCount === 1 ? '' : 's'})`;
  return { watch, line: `Intel check ${check.id}: ${what} — it is attached to the goal automatically.` };
}

/** Re-check plan lines for the Captain rail and advice: "Re-check weekly; alert if <watchFor>". */
export function recheckLine(check: IntelCheck | undefined, config: Pick<MusterConfig, 'intel'>): string | undefined {
  if (config.intel.recheck === 'off') return undefined;
  return `Re-check ${config.intel.recheck}${check?.watchFor ? `; alert if ${check.watchFor}` : ''}`;
}

/**
 * Keeps the intel store in step with state (run after every state change): checks learn their idea's goal, watches of
 * ideas that are no longer approved or whose goal was cancelled stop, and verdicts follow the roadmap. True when the
 * store changed.
 */
export function syncIntel(store: IntelStore, state: MusterState): boolean {
  let changed = false;
  const ideas = new Map((state.research?.ideas ?? []).map((i) => [i.id, i]));
  for (const c of store.checks) {
    const goalId = ideas.get(c.ideaId)?.goalId;
    if (goalId && c.goalId !== goalId) {
      c.goalId = goalId;
      changed = true;
    }
  }
  for (const w of store.watches) {
    if (!w.active || w.subject.kind !== 'idea') continue;
    const idea = ideas.get(w.subject.ideaId);
    const goal = idea?.goalId ? state.roadmap?.goals.find((g) => g.id === idea.goalId) : undefined;
    if (!idea || idea.status !== 'approved' || goal?.status === 'cancelled') {
      stopWatch(store, w.id);
      changed = true;
    }
  }
  return recomputeVerdicts(store, state) || changed;
}
