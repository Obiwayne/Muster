import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type CapabilityCell, type CapabilityStatus, type IntelCapability, type IntelCheck, type IntelStore, type MusterState, type ResearchIdea } from '../types.js';
import { inboxFor } from './board.js';
import { addCompetitor, emptyIntel, finishJob, recordIntel, startNextJob, tickWatches } from './intel.js';
import { capabilityVerdict, checkGate, checkVerdict, recheckAlert, recomputeVerdicts, requestCheck, syncIntel, writeCheck } from './intelcheck.js';
import { addIdea, addOpportunity, adviseIdea, approveIdea, rejectIdea, startRun } from './research.js';
import { addGoal, approveRoadmap, patchGoal, setRoadmap } from './roadmap.js';
import { emptyState } from './store.js';
import { makeAgent } from './testutil.js';

const config = DEFAULT_CONFIG;
const DAY = 86_400_000;
let s: MusterState;
let store: IntelStore;
const status = (fn: () => unknown): [number, string] => {
  try {
    fn();
  } catch (e) {
    return [(e as { status?: number }).status ?? 500, (e as Error).message];
  }
  return [200, ''];
};
const src = { kind: 'site', title: 'Padlet help', url: 'https://padlet.com/help' };
const claim = { label: 'fact' as const, confidence: 'high' as const, sources: [{ ...src, seenAt: '2026-10-01' }] as CapabilityCell['sources'], asOf: '2026-10-01' };
const c = (status: CapabilityStatus, extra: Partial<CapabilityCell> = {}): CapabilityCell => ({ ...claim, status, ...extra });
const cap = (cells: Record<string, CapabilityCell>, extra: Partial<IntelCapability> = {}): IntelCapability => ({ id: 'F1', name: 'x', cells, verdict: 'parity', verdictVs: [], updatedAt: '', ...extra });
const row = (area: string, extra: Record<string, unknown> = {}) => ({ area, finding: 'Padlet partial', signal: 'supports', label: 'fact', confidence: 'high', sources: [src], ...extra });
const ev = [{ kind: 'review', source: 'App Store · Padlet · 2★', text: 'No approval queue', url: 'https://example.com/r/1' }];
const captainInbox = () => inboxFor(s, 'captain').map((i) => i.text);

beforeEach(() => {
  s = emptyState('/repo');
  s.agents.push(makeAgent('captain', 'captain'), makeAgent('scout', 'research', { branch: 'main', worktree: '/repo' }));
  setRoadmap(s, { title: 'wall v1', summary: 'A wall.', stages: [{ title: 'Basics', goals: [{ title: 'Posting' }] }, { title: 'Safety', goals: [{ title: 'Reports' }] }] }, 'captain');
  approveRoadmap(s, 'you');
  store = emptyIntel('wall');
});

describe('capabilityVerdict (the contract table)', () => {
  const ids = ['padlet', 'wakelet'];
  it('us yes → edge vs those without yes, else parity', () => {
    expect(capabilityVerdict(cap({ us: c('yes'), padlet: c('yes'), wakelet: c('partial') }), ids)).toEqual({ verdict: 'edge', verdictVs: ['wakelet'] });
    expect(capabilityVerdict(cap({ us: c('yes'), padlet: c('yes'), wakelet: c('yes') }), ids)).toEqual({ verdict: 'parity', verdictVs: [] });
  });
  it('us not yes and anyone yes/paid → gap vs them, closing at our stage when planned', () => {
    expect(capabilityVerdict(cap({ us: c('none'), padlet: c('paid'), wakelet: c('none') }), ids)).toEqual({ verdict: 'gap', verdictVs: ['padlet'] });
    expect(capabilityVerdict(cap({ us: c('planned', { stageId: 'M2' }), padlet: c('yes') }), ids)).toEqual({ verdict: 'gap', verdictVs: ['padlet'], verdictStage: 'M2' });
    expect(capabilityVerdict(cap({ us: c('partial'), padlet: c('yes') }), ids).verdict).toBe('gap');
  });
  it('us planned and nobody yes/paid → edge at our stage', () => {
    expect(capabilityVerdict(cap({ us: c('planned', { stageId: 'M3' }), padlet: c('partial') }), ids)).toEqual({ verdict: 'edge', verdictVs: ['padlet', 'wakelet'], verdictStage: 'M3' });
  });
  it('nobody has it → open; only partials → parity', () => {
    expect(capabilityVerdict(cap({ us: c('missing'), padlet: c('none'), wakelet: c('planned', { planNote: 'Q1' }) }), ids)).toEqual({ verdict: 'open', verdictVs: [] });
    expect(capabilityVerdict(cap({ us: c('none'), padlet: c('partial') }), ids).verdict).toBe('parity');
    expect(capabilityVerdict(cap({ us: c('partial'), padlet: c('partial') }), ids).verdict).toBe('parity');
  });
  it('a linked goal overrides the us cell: open goal → planned at its stage, done goal → yes', () => {
    const r = s.roadmap!;
    const row = cap({ us: c('none'), padlet: c('yes') }, { goalId: 'G2' });
    expect(capabilityVerdict(row, ids, r)).toEqual({ verdict: 'gap', verdictVs: ['padlet'], verdictStage: 'M2' });
    r.goals[1].status = 'done';
    expect(capabilityVerdict(row, ids, r)).toEqual({ verdict: 'edge', verdictVs: ['wakelet'] });
    r.goals[1].status = 'cancelled';
    expect(capabilityVerdict(row, ids, r).verdict).toBe('gap');
  });
});

describe('checkVerdict', () => {
  beforeEach(() => {
    store.competitors.push({ id: 'padlet', name: 'Padlet', url: 'https://padlet.com', colour: 1, sources: [], areas: [], watch: 'off', browse: 'profile', addedAt: '' });
    store.capabilities.push(cap({ us: c('yes'), padlet: c('none') }, { id: 'F1' }), cap({ us: c('none'), padlet: c('none') }, { id: 'F2' }), cap({ us: c('none'), padlet: c('yes') }, { id: 'F3' }));
    recomputeVerdicts(store, s);
  });
  const plan = (extra: Record<string, unknown>) => store.plans.push({ id: 'PL1', competitorId: 'padlet', title: 'Approval', kind: 'commitment', capabilityIds: ['F1'], ...claim, ...extra } as never);

  it('gap if any row is a gap, open if all are open, edge otherwise, scout verdict without rows', () => {
    expect(checkVerdict({ capabilityIds: ['F1', 'F3'], verdict: 'edge' }, store)).toBe('gap');
    expect(checkVerdict({ capabilityIds: ['F2'], verdict: 'gap' }, store)).toBe('open');
    expect(checkVerdict({ capabilityIds: ['F1', 'F2'], verdict: 'gap' }, store)).toBe('edge');
    expect(checkVerdict({ capabilityIds: [], verdict: 'unclear' }, store)).toBe('unclear');
  });
  it('edge_at_risk from a live commitment', () => {
    plan({ status: 'in_progress' });
    expect(checkVerdict({ capabilityIds: ['F1'], verdict: 'unclear' }, store)).toBe('edge_at_risk');
    store.plans[0].status = 'dropped';
    expect(checkVerdict({ capabilityIds: ['F1'], verdict: 'unclear' }, store)).toBe('edge');
  });
  it('edge_at_risk from a medium-confidence prediction, not a low one', () => {
    plan({ kind: 'prediction', label: 'prediction', confidence: 'medium' });
    expect(checkVerdict({ capabilityIds: ['F1'], verdict: 'unclear' }, store)).toBe('edge_at_risk');
    store.plans[0].confidence = 'low';
    expect(checkVerdict({ capabilityIds: ['F1'], verdict: 'unclear' }, store)).toBe('edge');
  });
});

describe('the approval gate', () => {
  let idea: ResearchIdea;
  beforeEach(() => {
    startRun(s, 'you', { sources: { competitors: [], reviews: true, forums: [], ownApp: false }, depth: 'quick' });
    idea = addIdea(s, 'scout', { title: 'Moderation queue', summary: 'Approve first.', impact: 'high', effort: 'M', evidence: ev });
  });
  const intel = (now?: number) => ({ store, config, now });

  it('no competitors tracked → a skipped check is created and approval goes ahead (with a watch)', () => {
    const r = approveIdea(s, 'you', idea.id, intel());
    expect(r.status).toBe('approved');
    const check = store.checks.find((x) => x.id === r.checkId)!;
    expect(check).toMatchObject({ status: 'skipped', skippedReason: 'no competitors tracked' });
    expect(store.watches).toMatchObject([{ id: r.watchId, subject: { kind: 'idea', ideaId: idea.id }, cadence: 'weekly', active: true }]);
    expect(captainInbox().at(-1)).toMatch(/That change is already approved — no second approval\. Intel check IC1: skipped \(no competitors tracked\) — it is attached to the goal automatically\.$/);
  });

  it('409 without a check, while it runs, when it is stale; passes when done and fresh', () => {
    addCompetitor(store, 'you', { name: 'Padlet', url: 'https://padlet.com' }, config);
    expect(status(() => approveIdea(s, 'you', idea.id, intel()))).toEqual([409, 'R1 Moderation queue needs an intel check before you approve it. Run intel check (POST /api/intel/checks { ideaId: "R1" }), then approve when it is done.']);
    const check = requestCheck(store, s, 'you', idea.id, config);
    expect(check).toMatchObject({ status: 'queued', ideaId: 'R1' });
    expect(requestCheck(store, s, 'captain', idea.id, config)).toBe(check);
    expect(status(() => requestCheck(store, s, 'scout', idea.id, config))[0]).toBe(403);
    expect(status(() => approveIdea(s, 'you', idea.id, intel()))[1]).toBe('The intel check IC1 of R1 Moderation queue is still queued; approve once it is done.');
    s.research!.runs[0].status = 'done';
    const job = startNextJob(store, s)!;
    expect(job).toMatchObject({ kind: 'check', ideaId: 'R1', checkId: 'IC1' });
    expect(check.status).toBe('running');
    expect(status(() => approveIdea(s, 'you', idea.id, intel()))[0]).toBe(409);
    writeCheck(store, s, 'scout', 'R1', { rows: [row('features')], verdictText: 'Build it now.', confidence: 'medium', watchFor: 'Padlet ships approval' });
    finishJob(store, s, 'scout', { summary: 'done' });
    expect(check).toMatchObject({ status: 'done', revision: 1, sourceCount: 1, verdict: 'unclear' });
    expect(status(() => approveIdea(s, 'you', idea.id, intel(Date.now() + 15 * DAY)))[1]).toMatch(/^The intel check IC1 of R1 Moderation queue is 15 days old \(older than 14\)/);
    expect(checkGate(store, idea, config)).toBe(check);
    const r = approveIdea(s, 'you', idea.id, intel());
    expect(store.watches.find((w) => w.id === r.watchId)).toMatchObject({ alertOn: 'alert if Padlet ships approval' });
    expect(captainInbox().at(-1)).toMatch(/Intel check IC1: unclear \(medium, 1 source\) — it is attached to the goal automatically\.$/);
  });

  it('a failed check asks for a new one', () => {
    addCompetitor(store, 'you', { name: 'Padlet', url: 'https://padlet.com' }, config);
    requestCheck(store, s, 'you', idea.id, config);
    s.research!.runs[0].status = 'done';
    startNextJob(store, s);
    finishJob(store, s, 'scout', { summary: 'gave up' }); // without writing the check
    expect(status(() => approveIdea(s, 'you', idea.id, intel()))[1]).toMatch(/^The intel check IC1 of R1 Moderation queue failed/);
  });
});

describe('intel_check writes and re-checks', () => {
  let idea: ResearchIdea;
  let check: IntelCheck;
  beforeEach(() => {
    addCompetitor(store, 'you', { name: 'Padlet', url: 'https://padlet.com' }, config);
    startRun(s, 'you', { sources: { competitors: ['Padlet'], reviews: true, forums: [], ownApp: false }, depth: 'quick' });
    recordIntel(store, s, 'scout', 'capability', { name: 'Approve posts', cells: { us: { status: 'yes', ...claim }, padlet: { status: 'none', ...claim } } });
    recomputeVerdicts(store, s);
    idea = addIdea(s, 'scout', { title: 'Moderation queue', summary: 'Approve first.', impact: 'high', effort: 'M', evidence: ev });
    check = writeCheck(store, s, 'scout', idea.id, { rows: [row('features'), row('plans', { finding: 'Nothing announced', signal: 'neutral' })], verdictText: 'Our edge; keep it.', confidence: 'high', capabilityIds: ['F1'], watchFor: 'Padlet announces approval' }).check;
    s.research!.runs[0].status = 'done';
    approveIdea(s, 'you', idea.id, { store, config });
    addGoal(s, { stageId: 'M2', title: 'Moderation queue', ideaId: idea.id }, 'captain');
    syncIntel(store, s);
  });

  it('a run-time check: computed verdict, linked to the idea and, once added, its goal', () => {
    expect(check).toMatchObject({ id: 'IC1', revision: 1, status: 'done', verdict: 'edge', capabilityIds: ['F1'], goalId: 'G3' });
    expect(s.roadmap!.goals.find((g) => g.id === 'G3')!.intelCheckId).toBe('IC1');
    expect(s.roadmap!.status).toBe('approved');
    expect(status(() => writeCheck(store, s, 'scout', idea.id, { rows: [row('features')], verdictText: 'x', confidence: 'high' }))[0]).toBe(409); // nothing running
  });

  it('the rows are validated', () => {
    startRun(s, 'you', { sources: { competitors: ['Padlet'], reviews: true, forums: [], ownApp: false }, depth: 'quick' });
    expect(status(() => writeCheck(store, s, 'scout', idea.id, { rows: [], verdictText: 'x', confidence: 'high' }))[1]).toBe('rows: at least one row (one per area you covered)');
    expect(status(() => writeCheck(store, s, 'scout', idea.id, { rows: [row('features'), row('features')], verdictText: 'x', confidence: 'high' }))[1]).toMatch(/appears twice/);
    expect(status(() => writeCheck(store, s, 'scout', idea.id, { rows: [row('features', { sources: [] })], verdictText: 'x', confidence: 'high' }))[1]).toBe('rows[0].sources: at least one source is required');
    expect(status(() => writeCheck(store, s, 'scout', idea.id, { rows: [row('features')], verdictText: '', confidence: 'high' }))[1]).toBe('verdictText is required');
  });

  it('a re-check that changes the verdict raises a change, a note to you and a Captain line', () => {
    const watch = store.watches.find((w) => w.id === idea.watchId)!;
    const [job] = tickWatches(store, s, config, Date.parse(watch.nextAt) + 1);
    expect(job).toMatchObject({ kind: 'recheck', ideaId: 'R1', checkId: 'IC1', watchId: watch.id });
    expect(startNextJob(store, s)).toBe(job);
    recordIntel(store, s, 'scout', 'plan', { competitorId: 'padlet', title: 'Post approval', kind: 'commitment', status: 'in_progress', capabilityIds: ['F1'], ...claim });
    const notesBefore = s.notes.length;
    const r = writeCheck(store, s, 'scout', idea.id, { rows: [row('features'), row('plans', { finding: 'Padlet building approval', signal: 'threat' })], verdictText: 'Ship before Padlet does.', confidence: 'high', capabilityIds: ['F1'] });
    expect(r.check).toMatchObject({ revision: 2, verdict: 'edge_at_risk', history: [{ revision: 1, verdict: 'edge', confidence: 'high', changedAreas: [] }] });
    expect(r.check.rows.map((x) => !!x.changed)).toEqual([false, true]);
    expect(r.alert!.change).toMatchObject({ id: 'IX1', planImpact: 'respond', competitorId: 'padlet', area: 'roadmap', ideaId: 'R1', goalId: 'G3', seen: false, implication: 'Ship before Padlet does.' });
    expect(r.alert!.notifyText).toBe('Intel: R1 Moderation queue verdict edge → edge at risk');
    expect(s.notes.length).toBe(notesBefore + 1);
    expect(r.alert!.note).toMatchObject({ type: 'system', topic: 'intel', to: 'you', open: true });
    expect(captainInbox().at(-1)).toBe('Re-check of R1 Moderation queue (G3): verdict edge → edge at risk; plans: Padlet building approval (threat). Does the plan need to respond? Suggest it with intel_suggest(IX1, text).');
    expect(watch.lastAt).toBe(r.check.doneAt);
  });

  it('a re-check without changes only moves the watch', () => {
    const watch = store.watches.find((w) => w.id === idea.watchId)!;
    tickWatches(store, s, config, Date.parse(watch.nextAt) + 1);
    startNextJob(store, s);
    const notes = s.notes.length;
    const inbox = captainInbox().length;
    const r = writeCheck(store, s, 'scout', idea.id, { rows: [row('features'), row('plans', { finding: 'Nothing announced', signal: 'neutral' })], verdictText: 'Still our edge.', confidence: 'high', capabilityIds: ['F1'] });
    expect(r.alert).toBeUndefined();
    expect(r.check.revision).toBe(2);
    expect(store.changes).toEqual([]);
    expect(s.notes.length).toBe(notes);
    expect(captainInbox().length).toBe(inbox);
    expect(watch.lastAt).toBe(r.check.doneAt);
  });

  it('recheckAlert: a changed against/threat row alone is enough; neutral changes are not', () => {
    const rows = [{ ...row('complaints'), changed: true, signal: 'against' }] as IntelCheck['rows'];
    expect(recheckAlert({ verdict: 'gap', confidence: 'high' }, { verdict: 'gap', confidence: 'high', rows })).toBe('complaints: Padlet partial (against)');
    rows[0].signal = 'neutral';
    expect(recheckAlert({ verdict: 'gap', confidence: 'high' }, { verdict: 'gap', confidence: 'high', rows })).toBeUndefined();
    expect(recheckAlert({ verdict: 'gap', confidence: 'high' }, { verdict: 'gap', confidence: 'low', rows })).toBe('confidence high → low');
  });

  it('a cancelled goal stops the watch; the goal moves the capability verdict', () => {
    store.capabilities[0].ideaId = idea.id;
    store.capabilities[0].cells.us.status = 'none';
    store.capabilities[0].cells.padlet.status = 'yes';
    syncIntel(store, s);
    expect(store.capabilities[0]).toMatchObject({ goalId: 'G3', verdict: 'gap', verdictStage: 'M2' });
    patchGoal(s, 'G3', { status: 'cancelled' }, 'captain');
    expect(syncIntel(store, s)).toBe(true);
    expect(store.watches.find((w) => w.id === idea.watchId)!.active).toBe(false);
    expect(store.capabilities[0].verdictStage).toBeUndefined();
  });
});

describe('watches stop on reject; opportunities', () => {
  it('rejecting an approved idea stops its watch', () => {
    startRun(s, 'you', { sources: { competitors: [], reviews: true, forums: [], ownApp: false }, depth: 'quick' });
    const idea = addIdea(s, 'scout', { title: 'Export', summary: 'PDF export.', impact: 'low', effort: 'S', evidence: ev });
    approveIdea(s, 'you', idea.id, { store, config });
    expect(store.watches[0].active).toBe(true);
    rejectIdea(s, 'you', idea.id, 'later');
    syncIntel(store, s);
    expect(store.watches[0].active).toBe(false);
  });

  it('add_opportunity makes an intel idea linked to its capabilities; advise_idea effort sets the score', () => {
    addCompetitor(store, 'you', { name: 'Padlet', url: 'https://padlet.com' }, config);
    store.jobs.push({ id: 'IJ1', kind: 'competitor', status: 'queued', competitorIds: ['padlet'], areas: [], browse: 'profile', depth: 'quick', by: 'you', queuedAt: '', pagesBrowsed: 0 });
    store.nextIds.job = 2;
    startNextJob(store, s);
    recordIntel(store, s, 'scout', 'capability', { name: 'Approve posts', cells: { us: { status: 'none', ...claim }, padlet: { status: 'yes', ...claim } } });
    const opportunity = {
      kind: 'gap', capabilityIds: ['F1'], problem: 'Kids post before teachers check', alternatives: 'Delete afterwards', proposal: 'Approval queue', value: 'Safer walls',
      effortNote: 'Medium · ~5 tasks', priority: 'now', validation: 'Pilot with 3 teachers', valueScore: 5, effortScore: 3, claim: { ...claim, implication: 'Table stakes for schools' },
    };
    expect(status(() => addOpportunity(s, store, 'scout', { title: 'Approval queue', summary: 's', impact: 'high', effort: 'M', evidence: ev, opportunity: { ...opportunity, valueScore: 6 } }))[1]).toBe('opportunity.valueScore must be a whole number from 1 to 5');
    expect(status(() => addOpportunity(s, store, 'scout', { title: 'Approval queue', summary: 's', impact: 'high', effort: 'M', evidence: ev, opportunity: { ...opportunity, claim } }))[1]).toBe('opportunity.claim.implication is required');
    const idea = addOpportunity(s, store, 'scout', { title: 'Approval queue', summary: 's', impact: 'high', effort: 'M', evidence: ev, opportunity });
    expect(idea).toMatchObject({ id: 'R1', origin: 'intel', runId: 'IJ1', status: 'new', opportunity: { kind: 'gap', valueScore: 5 } });
    expect(store.capabilities[0].ideaId).toBe('R1');
    adviseIdea(s, 'captain', 'R1', { text: 'About a week.', effort: 4 });
    expect(idea.opportunity!.effortScore).toBe(4);
    expect(status(() => adviseIdea(s, 'captain', 'R1', { text: 'x', effort: 9 }))[0]).toBe(400);
  });
});
