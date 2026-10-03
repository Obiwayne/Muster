import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type IntelCapability, type IntelStore, type MusterState } from '../types.js';
import {
  addCompetitor,
  cancelJob,
  checkClaim,
  emptyIntel,
  enqueueJob,
  failJob,
  finishJob,
  IntelFile,
  intelBrief,
  intelReport,
  intelSummary,
  markChangesSeen,
  nextAt,
  patchCompetitor,
  recordIntel,
  removeCompetitor,
  requestJob,
  startNextJob,
  tickWatches,
  today,
} from './intel.js';
import { estimateIntelJob, estimateResearch } from './intelestimate.js';
import { recomputeVerdicts } from './intelcheck.js';
import { startRun } from './research.js';
import { emptyState } from './store.js';
import { makeAgent } from './testutil.js';

const config = DEFAULT_CONFIG;
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
const src = (over: Record<string, unknown> = {}) => ({ kind: 'site', title: 'Padlet pricing', url: 'https://padlet.com/pricing', ...over });
const claim = (over: Record<string, unknown> = {}) => ({ label: 'fact', confidence: 'high', sources: [src()], asOf: '2026-10-01', ...over });
const addPadlet = () => addCompetitor(store, 'you', { name: 'Padlet', url: 'https://padlet.com' }, config);

beforeEach(() => {
  s = emptyState('/repo');
  s.agents.push(makeAgent('captain', 'captain'), makeAgent('scout', 'research', { branch: 'main', worktree: '/repo' }));
  store = emptyIntel('wall');
});

describe('claims (the rule)', () => {
  it('accepts a sourced fact and fills seenAt with today', () => {
    const c = checkClaim(claim(), 'x');
    expect(c.sources[0].seenAt).toBe(today());
    expect(c).toMatchObject({ label: 'fact', confidence: 'high', asOf: '2026-10-01' });
  });

  it('400 names the field', () => {
    expect(status(() => checkClaim(claim({ sources: [] }), 'theme'))).toEqual([400, 'theme.sources: at least one source is required']);
    expect(status(() => checkClaim(claim({ sources: [src({ url: undefined })] }), 'x'))[1]).toBe('x.sources[0].url is required');
    expect(status(() => checkClaim(claim({ sources: [{ kind: 'own_app', title: 'Our code' }] }), 'x'))[0]).toBe(200); // own_app needs no url
    expect(status(() => checkClaim(claim({ asOf: '2026-02-30' }), 'x'))).toEqual([400, 'x.asOf must be a date YYYY-MM-DD']);
    expect(status(() => checkClaim(claim({ sources: [src({ publishedAt: '1 Oct' })] }), 'x'))[1]).toBe('x.sources[0].publishedAt must be a date YYYY-MM-DD');
    expect(status(() => checkClaim(claim({ label: 'rumour' }), 'x'))[1]).toMatch(/^x\.label must be one of/);
    expect(status(() => checkClaim(claim(), 'insight', { implication: true }))).toEqual([400, 'insight.implication is required']);
    expect(status(() => checkClaim(claim({ sources: Array(13).fill(src()) }), 'x'))[1]).toBe('x.sources: at most 12');
  });

  it('a prediction needs signals, timeframe and what would change it', () => {
    expect(status(() => checkClaim(claim({ label: 'prediction' }), 'plan'))[1]).toMatch(/^plan\.prediction is required/);
    const p = { signals: ['3 job ads for moderation engineers'], timeframe: 'Q1 2027', wouldChange: 'They drop it from the roadmap' };
    expect(status(() => checkClaim(claim({ label: 'prediction', prediction: { ...p, signals: [] } }), 'plan'))[1]).toBe('plan.prediction.signals needs at least 1 item');
    expect(status(() => checkClaim(claim({ label: 'prediction', prediction: { ...p, timeframe: '' } }), 'plan'))[1]).toBe('plan.prediction.timeframe is required');
    expect(status(() => checkClaim(claim({ label: 'prediction', prediction: { ...p, wouldChange: undefined } }), 'plan'))[1]).toBe('plan.prediction.wouldChange is required');
    expect(checkClaim(claim({ label: 'prediction', prediction: p }), 'plan').prediction).toEqual(p);
    expect(status(() => checkClaim(claim({ prediction: p }), 'x'))[1]).toBe('x.prediction is only for label "prediction"');
  });
});

describe('competitors', () => {
  it('us exists from the start; add assigns a slug and colour, refuses duplicates and "us"', () => {
    expect(store.competitors).toMatchObject([{ id: 'us', name: 'wall', isUs: true, colour: 0, url: '' }]);
    expect(status(() => addCompetitor(store, 'captain', { name: 'Padlet', url: 'https://padlet.com' }, config))[0]).toBe(403);
    const c = addPadlet();
    expect(c).toMatchObject({ id: 'padlet', colour: 1, watch: 'off', browse: 'profile', areas: expect.arrayContaining(['features', 'reviews']) });
    expect(status(() => addCompetitor(store, 'you', { name: 'Padlet', url: 'https://other.example' }, config))[0]).toBe(409);
    expect(status(() => addCompetitor(store, 'you', { name: 'Pad', url: 'https://www.padlet.com/' }, config))[0]).toBe(409);
    expect(status(() => addCompetitor(store, 'you', { id: 'us', name: 'X', url: 'https://x.example' }, config))[0]).toBe(400);
    expect(addCompetitor(store, 'you', { name: 'Wakelet', url: 'https://wakelet.com', watch: 'weekly' }, config).colour).toBe(2);
    expect(store.watches).toMatchObject([{ id: 'W1', subject: { kind: 'competitor', competitorId: 'wakelet' }, cadence: 'weekly', active: true }]);
  });

  it('patch re-plans the watch; remove keeps findings, stops the watch, refuses us', () => {
    addPadlet();
    patchCompetitor(store, 'you', 'padlet', { watch: 'daily' });
    expect(store.watches[0]).toMatchObject({ cadence: 'daily', active: true });
    expect(status(() => removeCompetitor(store, 'you', 'us'))[0]).toBe(400);
    removeCompetitor(store, 'you', 'padlet');
    expect(store.competitors.find((c) => c.id === 'padlet')).toMatchObject({ removed: true, watch: 'off' });
    expect(store.watches[0].active).toBe(false);
    expect(addPadlet()).toMatchObject({ id: 'padlet', colour: 1 }); // comes back with its colour
    expect(store.competitors.find((c) => c.id === 'padlet')!.removed).toBeUndefined();
  });
});

describe('record_intel', () => {
  beforeEach(() => {
    addPadlet();
    startNextJob(store, s); // nothing queued yet
    requestJob(store, s, 'you', { kind: 'competitor', competitorIds: ['padlet'] }, config);
    startNextJob(store, s);
  });

  it('only scout, only while a job or run runs', () => {
    expect(status(() => recordIntel(store, s, 'captain', 'theme', {}))[0]).toBe(403);
    cancelJob(store, s, 'you', 'IJ1');
    expect(status(() => recordIntel(store, s, 'scout', 'finding', {}))[0]).toBe(409);
  });

  it('capabilities upsert by name (case-insensitive) and merge cells; verdicts are computed', () => {
    const us = { status: 'none', ...claim({ sources: [{ kind: 'own_app', title: 'Our code' }] }) };
    const cap = recordIntel(store, s, 'scout', 'capability', { name: 'Approve posts before live', group: 'Moderation', cells: { us, padlet: { status: 'yes', ...claim() } } }) as IntelCapability;
    expect(cap.id).toBe('F1');
    recomputeVerdicts(store, s);
    expect(cap).toMatchObject({ verdict: 'gap', verdictVs: ['padlet'] });
    const again = recordIntel(store, s, 'scout', 'capability', { name: 'approve POSTS before live', cells: { padlet: { status: 'paid', note: 'Pro only', ...claim() } } }) as IntelCapability;
    expect(again).toBe(cap);
    expect(store.capabilities).toHaveLength(1);
    expect(cap.cells.padlet).toMatchObject({ status: 'paid', note: 'Pro only' });
    expect(cap.cells.us.status).toBe('none');
    expect(status(() => recordIntel(store, s, 'scout', 'capability', { name: 'X', cells: { wakelet: { status: 'yes', ...claim() } } }))[1]).toMatch(/^cells\.wakelet: no competitor "wakelet"/);
    expect(status(() => recordIntel(store, s, 'scout', 'capability', { name: 'Y', cells: { us: { status: 'planned', ...claim() } } }))[1]).toBe('cells.us.stageId is required when we have it planned');
    expect(status(() => recordIntel(store, s, 'scout', 'capability', { name: 'Y', cells: { padlet: { status: 'planned', ...claim() } } }))[1]).toBe('cells.padlet.planNote is required');
  });

  it('themes are opinions, upsert by title, cap quotes', () => {
    const q = (t: string) => ({ text: t, source: src({ kind: 'app_store', title: 'App Store · Padlet · 2★' }) });
    const theme = { title: 'Kids post before I can check', mentions: 91, sampleSize: 412, independentSources: 40, byCompetitor: { padlet: 91 }, severity: 'severe', trend: 'rising', quotes: [q('No approval queue')], confidence: 'high', sources: [src()] };
    const t = recordIntel(store, s, 'scout', 'theme', theme) as { id: string; label: string };
    expect(t).toMatchObject({ id: 'TH1', label: 'opinion' });
    recordIntel(store, s, 'scout', 'theme', { ...theme, title: 'KIDS POST BEFORE I CAN CHECK', mentions: 95 });
    expect(store.themes).toHaveLength(1);
    expect(store.themes[0].mentions).toBe(95);
    expect(status(() => recordIntel(store, s, 'scout', 'theme', { ...theme, label: 'fact' }))[1]).toBe('theme.label must be "opinion" here');
    expect(status(() => recordIntel(store, s, 'scout', 'theme', { ...theme, quotes: [q('x'.repeat(301))] }))[1]).toBe('quotes[0].text is longer than 300 characters');
    expect(status(() => recordIntel(store, s, 'scout', 'theme', { ...theme, quotes: Array(7).fill(q('a')) }))[1]).toBe('quotes: at most 6 per theme');
    // Live run: scout sent themes before the sample; the error has to say what to do.
    const { sampleSize: _omit, ...noSize } = theme;
    expect(status(() => recordIntel(store, s, 'scout', 'theme', { ...noSize, title: 'Laggy' }))).toEqual([400, 'Missing sampleSize: send it, or record the sample (kind sample) first; themes default to its total']);
  });

  it('plans: commitment is a fact, prediction needs its prediction block; upsert by title', () => {
    const plan = { competitorId: 'padlet', title: 'Approval queue', kind: 'commitment', status: 'planned', confidence: 'high', sources: [src()], capabilityIds: [] };
    expect(recordIntel(store, s, 'scout', 'plan', plan)).toMatchObject({ id: 'PL1', label: 'fact' });
    expect(status(() => recordIntel(store, s, 'scout', 'plan', { ...plan, title: 'AI', kind: 'prediction' }))[1]).toMatch(/^plan\.prediction is required/);
    expect(status(() => recordIntel(store, s, 'scout', 'plan', { ...plan, label: 'prediction' }))[1]).toBe('plan.label must be "fact" here');
    recordIntel(store, s, 'scout', 'plan', { ...plan, title: 'approval QUEUE', status: 'in_progress' });
    expect(store.plans).toHaveLength(1);
    expect(store.plans[0].status).toBe('in_progress');
  });

  it('findings: team/org are partial; ai needs aiStatus; insights and changes need an implication', () => {
    expect(recordIntel(store, s, 'scout', 'finding', { area: 'team', title: '42 staff on LinkedIn', ...claim() })).toMatchObject({ id: 'IF1', partial: true });
    expect(status(() => recordIntel(store, s, 'scout', 'finding', { area: 'ai', title: 'AI', ...claim() }))[1]).toMatch(/^aiStatus must be one of/);
    expect(status(() => recordIntel(store, s, 'scout', 'insight', { kind: 'match', title: 'T', detail: 'D', ...claim() }))[1]).toBe('insight.implication is required');
    const ch = recordIntel(store, s, 'scout', 'change', { competitorId: 'padlet', area: 'pricing', title: 'Pro to £8/mo', planImpact: 'respond', implication: 'Our price gap widens', ...claim() });
    expect(ch).toMatchObject({ id: 'IX1', seen: false, jobId: 'IJ1', at: today() });
    expect(intelSummary(store, s).alerts).toBe(1);
    expect(markChangesSeen(store, 'you')).toBe(1);
    expect(intelSummary(store, s).alerts).toBe(0);
  });

  it('a known id updates, an unknown id is 404; ids are never reused after a reload', () => {
    recordIntel(store, s, 'scout', 'finding', { area: 'pricing', title: 'Pro £8', ...claim() });
    recordIntel(store, s, 'scout', 'finding', { id: 'IF1', area: 'pricing', title: 'Pro £8/mo', ...claim() });
    expect(store.findings).toMatchObject([{ id: 'IF1', title: 'Pro £8/mo' }]);
    expect(status(() => recordIntel(store, s, 'scout', 'finding', { id: 'IF9', area: 'pricing', title: 'x', ...claim() }))[0]).toBe(404);
    const dir = mkdtempSync(join(tmpdir(), 'muster-intel-'));
    try {
      const file = join(dir, 'intel.json');
      const hacked = { ...store, nextIds: { ...store.nextIds, finding: 1 } }; // hand-edited counter
      writeFileSync(file, JSON.stringify(hacked));
      const reloaded = new IntelFile(file, 'wall').store;
      expect(reloaded.nextIds.finding).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scenarios need assumptions; positioning points are 0..1', () => {
    expect(status(() => recordIntel(store, s, 'scout', 'scenario', { name: '30 teachers', assumptions: [], costs: {}, ...claim() }))[1]).toBe('assumptions needs at least 1 item');
    expect(recordIntel(store, s, 'scout', 'scenario', { name: '30 teachers', assumptions: ['1 school, 12 months'], costs: { padlet: { amount: 2000, currency: 'GBP', period: 'year' } }, ...claim() })).toMatchObject({ id: 'PS1' });
    const pos = { title: 'Price vs safety', x: { label: 'Price', min: 'free', max: '£££' }, y: { label: 'Safety', min: 'low', max: 'high' }, points: [{ competitorId: 'padlet', x: 1.2, y: 0.5 }], assumptions: ['list prices'], ...claim() };
    expect(status(() => recordIntel(store, s, 'scout', 'positioning', pos))[1]).toBe('points[0].x must be a number from 0 to 1');
  });
});

describe('jobs', () => {
  beforeEach(() => addPadlet());

  it('one at a time, oldest first; dedupe per subject', () => {
    const a = requestJob(store, s, 'you', { kind: 'competitor', competitorIds: ['padlet'] }, config);
    expect(requestJob(store, s, 'captain', { kind: 'competitor', competitorIds: ['padlet'] }, config)).toBe(a);
    const sweep = requestJob(store, s, 'captain', { kind: 'sweep' }, config);
    expect(status(() => requestJob(store, s, 'scout', { kind: 'sweep' }, config))[0]).toBe(403);
    expect(startNextJob(store, s)).toBe(a);
    expect(startNextJob(store, s)).toBeUndefined();
    finishJob(store, s, 'scout', { summary: 'Read 12 pages', sourcesRead: 12 });
    expect(a).toMatchObject({ status: 'done', sourcesRead: 12 });
    expect(store.competitors.find((c) => c.id === 'padlet')!.lastSweptAt).toBeDefined();
    expect(startNextJob(store, s)).toBe(sweep);
  });

  it('queued while a research run runs and while paused', () => {
    startRun(s, 'you', { sources: { competitors: ['Padlet'], reviews: false, forums: [], ownApp: false }, depth: 'quick' });
    requestJob(store, s, 'you', { kind: 'sweep' }, config);
    expect(startNextJob(store, s)).toBeUndefined();
    s.research!.runs[0].status = 'done';
    s.usage.paused = true;
    expect(startNextJob(store, s)).toBeUndefined();
    s.usage.paused = false;
    expect(startNextJob(store, s)!.status).toBe('running');
    expect(status(() => startRun(s, 'you', { sources: { competitors: ['x'], reviews: false, forums: [], ownApp: false }, depth: 'quick' }, 'profile', store))).toEqual([409, 'scout is busy with IJ1 (sweep); start research when it is done, or cancel it on the Intel page']);
  });

  it('cancel queued or running; scout exit fails the job and keeps its findings', () => {
    const a = requestJob(store, s, 'you', { kind: 'sweep' }, config);
    expect(cancelJob(store, s, 'you', a.id)).toMatchObject({ wasRunning: false, job: { status: 'cancelled' } });
    expect(status(() => cancelJob(store, s, 'you', a.id))[0]).toBe(409);
    const b = requestJob(store, s, 'you', { kind: 'sweep' }, config);
    startNextJob(store, s);
    expect(cancelJob(store, s, 'captain', b.id).wasRunning).toBe(true);
    const c = requestJob(store, s, 'you', { kind: 'sweep' }, config);
    startNextJob(store, s);
    recordIntel(store, s, 'scout', 'finding', { area: 'pricing', title: 'Pro £8', ...claim() });
    expect(failJob(store, 'scout exited (code 1)')).toBe(c);
    expect(c).toMatchObject({ status: 'failed', error: 'scout exited (code 1)' });
    expect(store.findings).toHaveLength(1);
  });

  it('a competitor job is for one competitor; no competitors → 409', () => {
    expect(status(() => requestJob(store, s, 'you', { kind: 'competitor', competitorIds: [] }, config))[0]).toBe(409);
    removeCompetitor(store, 'you', 'padlet');
    expect(status(() => requestJob(store, s, 'you', { kind: 'sweep' }, config))[0]).toBe(409);
  });
});

describe('watches', () => {
  it('nextAt per cadence', () => {
    const t = Date.parse('2026-10-01T00:00:00Z');
    expect(nextAt('daily', t)).toBe('2026-10-02T00:00:00.000Z');
    expect(nextAt('weekly', t)).toBe('2026-10-08T00:00:00.000Z');
    expect(nextAt('monthly', t)).toBe('2026-10-31T00:00:00.000Z');
  });

  it('the tick queues each due watch once and moves it on', () => {
    addCompetitor(store, 'you', { name: 'Padlet', url: 'https://padlet.com', watch: 'weekly' }, config);
    const w = store.watches[0];
    const now = Date.parse(w.nextAt) + 1000;
    const [job] = tickWatches(store, s, config, now);
    expect(job).toMatchObject({ kind: 'watch', competitorIds: ['padlet'], by: 'schedule', watchId: w.id });
    expect(w.nextAt).toBe(nextAt('weekly', now));
    expect(tickWatches(store, s, config, now)).toEqual([]); // not due again
    w.nextAt = new Date(now - 1).toISOString();
    expect(tickWatches(store, s, config, now)).toEqual([job]); // due again, but the queued job is reused
    expect(store.jobs).toHaveLength(1);
  });
});

describe('summary, brief, report, estimates', () => {
  it('summary counts; brief describes the running job; report lists every claim', () => {
    addPadlet();
    expect(intelBrief(store, s, config)).toBe('No intel job is running. Nothing to do: wait until you are given one.');
    requestJob(store, s, 'you', { kind: 'competitor', competitorIds: ['padlet'] }, config);
    startNextJob(store, s);
    recordIntel(store, s, 'scout', 'capability', { name: 'Approve posts', cells: { us: { status: 'yes', ...claim() }, padlet: { status: 'none', ...claim() } } });
    recomputeVerdicts(store, s);
    const sum = intelSummary(store, s);
    expect(sum).toMatchObject({ competitors: 1, edges: 1, gaps: 0, sources: 1, queuedJobs: 0, runningJob: { id: 'IJ1', kind: 'competitor', label: 'Researching Padlet' } });
    const brief = intelBrief(store, s, config);
    expect(brief).toContain('Intel job IJ1 (competitor, quick): Researching Padlet.');
    expect(brief).toContain('- capabilities: F1 Approve posts');
    expect(brief).toContain('150 of 150 browse calls left');
    expect(brief).toContain('finish_intel_job');
    // Live run: scout left every us cell empty, so all its rows read as gaps.
    expect(brief).toContain('- Capabilities: fill the us cell too, from our own app');
    expect(brief).toMatch(/no roadmap yet; read the README and code for what it does\./);
    const report = intelReport(store, s);
    expect(report).toContain('### F1 Approve posts — edge vs Padlet');
    expect(report).toContain('[fact · high · as of 2026-10-01] Sources: Padlet pricing (https://padlet.com/pricing)');
  });

  it('a corrupt file is set aside and an empty store used', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muster-intel-'));
    try {
      const file = join(dir, 'intel.json');
      writeFileSync(file, '{ nope');
      const logs: string[] = [];
      const f = new IntelFile(file, 'wall', { log: (m) => logs.push(m) });
      expect(f.store.competitors.map((c) => c.id)).toEqual(['us']);
      expect(logs[0]).toMatch(/could not be read/);
      expect(readdirSync(dir).some((n) => n.startsWith('intel.json.corrupt-'))).toBe(true);
      let rev = 0;
      f.on('change', (r) => (rev = r));
      f.commit();
      expect(rev).toBe(1);
      expect(JSON.parse(readFileSync(file, 'utf8')).rev).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('research estimates include the intel checks when competitors are tracked', () => {
    expect(estimateResearch('quick', 0)).toMatchObject({ checks: 0, usagePct: 3, minutes: 10 });
    const withChecks = estimateResearch('quick', 2);
    expect(withChecks.checks).toBe(5);
    expect(withChecks.usagePct).toBeGreaterThan(3);
    expect(withChecks.text).toMatch(/incl\. 5 intel checks/);
    expect(estimateIntelJob('sweep', 'quick', 3).checks).toBe(6);
    expect(estimateIntelJob('check', 'quick', 1).checks).toBe(1);
  });
});

it('enqueueJob keeps check jobs per idea apart', () => {
  const base = { competitorIds: ['padlet'], areas: [], browse: 'profile' as const, depth: 'quick' as const, by: 'you' };
  const a = enqueueJob(store, { ...base, kind: 'check', ideaId: 'R1' });
  expect(enqueueJob(store, { ...base, kind: 'recheck', ideaId: 'R1' })).toBe(a);
  expect(enqueueJob(store, { ...base, kind: 'check', ideaId: 'R2' })).not.toBe(a);
});
