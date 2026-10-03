// Competitive intelligence over HTTP: scout's API alone fills the store, the approval gate, watches and re-checks,
// the dispatcher's scout lifecycle and the `intel` WS event.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { IntelCheck, IntelJob, IntelStore, IntelSummary, MusterConfig, MusterEvent, MusterState, Note, ResearchIdea, RoadmapGoal } from '../types.js';
import { tempRepo } from '../core/testutil.js';
import { startOrchestrator, type Orchestrator } from './server.js';
import type { PtyLauncher, PtyProcess } from './terminal.js';

const typed: string[] = [];
class FakePty implements PtyProcess {
  static nextPid = 9000;
  static last?: FakePty;
  pid = FakePty.nextPid++;
  private exitCbs: ((e: { exitCode: number }) => void)[] = [];
  constructor() {
    FakePty.last = this;
  }
  onData() {}
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCbs.push(cb);
  }
  write(data: string) {
    typed.push(data);
  }
  resize() {}
  kill() {
    setImmediate(() => this.crash());
  }
  crash() {
    this.exitCbs.splice(0).forEach((cb) => cb({ exitCode: 1 }));
  }
}
const scoutPtys: FakePty[] = [];
const launcher: PtyLauncher = (_file, args) => {
  const p = new FakePty();
  if (args.join(' ').includes('scout')) scoutPtys.push(p);
  return p;
};

let repo: string;
let orch: Orchestrator;
const events: MusterEvent[] = [];
let ws: WebSocket;

async function call<T = any>(actor: string, method: string, path: string, body: Record<string, unknown> = {}): Promise<{ status: number; data: T; text: string; type: string }> {
  const token = actor === 'you' ? orch.token : orch.agentToken(actor);
  const res = await fetch(orch.url + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-muster-token': token },
    body: method === 'GET' ? undefined : JSON.stringify({ actor, ...body }),
  });
  const text = await res.text();
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, data: type.includes('json') && text ? JSON.parse(text) : (null as T), text, type };
}
async function ok<T = any>(actor: string, method: string, path: string, body?: Record<string, unknown>): Promise<T> {
  const r = await call<T>(actor, method, path, body);
  if (r.status !== 200) throw new Error(`${actor} ${method} ${path} → ${r.status} ${r.text}`);
  return r.data;
}
const state = () => orch.store.state as MusterState;
const intel = () => orch.intel.store as IntelStore;
const scout = () => state().agents.find((a) => a.id === 'scout');
const captainInbox = () => state().inbox.filter((i) => i.agentId === 'captain').map((i) => i.text);
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const src = { kind: 'site', title: 'Padlet features', url: 'https://padlet.com/features' };
const claim = { label: 'fact', confidence: 'high', sources: [src], asOf: '2026-10-01' };
const ownCode = { label: 'fact', confidence: 'high', sources: [{ kind: 'own_app', title: 'Our code: src/moderation' }], asOf: '2026-10-01' };
const ev = [{ kind: 'competitor', source: 'Padlet help', text: 'No approval for free walls', url: 'https://padlet.com/help/1' }];
const opportunity = (over: Record<string, unknown> = {}) => ({
  kind: 'edge', capabilityIds: ['F1'], problem: 'Teachers fear unvetted posts', alternatives: 'Delete afterwards', proposal: 'Keep the approval queue first-class', value: 'Safe walls',
  effortNote: 'Small · polish', priority: 'next', validation: 'Ask 3 teachers', valueScore: 4, effortScore: 2, claim: { ...claim, implication: 'Our clearest edge for schools' }, ...over,
});
const row = (area: string, over: Record<string, unknown> = {}) => ({ area, finding: 'Padlet has none', signal: 'supports', ...claim, ...over });

beforeAll(async () => {
  process.env.MUSTER_NO_NOTIFY = '1';
  repo = tempRepo();
  const ui = mkdtempSync(join(tmpdir(), 'muster-ui-'));
  writeFileSync(join(ui, 'index.html'), '<html></html>');
  mkdirSync(join(repo, '.muster'), { recursive: true });
  writeFileSync(join(repo, '.muster', 'config.json'), JSON.stringify({ lines: { feature: { label: 'Feature', stations: ['build'] } }, claudePath: 'C:/fake/claude.exe', maxCrew: 1, projectName: 'wall' }));
  orch = await startOrchestrator({
    repoRoot: repo,
    port: 0,
    launcher,
    uiDir: ui,
    log: () => {},
    timings: { enterDelayMs: 1, firstPromptDelayMs: 1, nudgeDebounceMs: 10, scoutStopDelayMs: 20, stopConfirmMs: 200 },
  });
  ws = new WebSocket(`${orch.url.replace('http', 'ws')}/ws/events?token=${orch.token}`);
  ws.on('message', (m) => events.push(JSON.parse(String(m))));
  await new Promise((r) => ws.once('open', r));
  await ok('captain', 'PUT', '/api/roadmap', { title: 'wall v1', summary: 'A class wall', stages: [{ title: 'Basics', exitCriteria: [], goals: [{ title: 'Posting' }] }, { title: 'Safety', exitCriteria: [], goals: [{ title: 'Reports' }] }] });
  await ok('you', 'POST', '/api/roadmap/approve');
});

afterAll(async () => {
  ws?.close();
  await orch?.shutdown();
  rmSync(repo, { recursive: true, force: true });
});

describe('intel API', () => {
  it('starts with us; settings deep-merge and are validated', async () => {
    const store = await ok<IntelStore>('captain', 'GET', '/api/intel');
    expect(store.competitors).toMatchObject([{ id: 'us', name: 'wall', isUs: true }]);
    expect(await ok<IntelSummary>('you', 'GET', '/api/intel/summary')).toMatchObject({ competitors: 0, gaps: 0, alerts: 0, queuedJobs: 0 });
    expect((await call('you', 'PATCH', '/api/config', { intel: { checkMaxAgeDays: 0 } })).status).toBe(400);
    expect((await call('you', 'PATCH', '/api/config', { researchBrowser: { operaAllow: ['not a domain'] } })).status).toBe(400);
    expect((await call('you', 'PATCH', '/api/config', { researchBrowser: { mode: 'sneaky' } })).status).toBe(400);
    const c = await ok<MusterConfig>('you', 'PATCH', '/api/config', { researchBrowser: { operaAllow: ['Reddit.com'] }, intel: { recheck: 'weekly' } });
    expect(c.researchBrowser).toEqual({ mode: 'profile', channel: 'chrome', operaAllow: ['reddit.com'], minDelayMs: 3000, maxPagesPerJob: 150, visibleSites: [] });
    expect((await call('you', 'PATCH', '/api/config', { researchBrowser: { visibleSites: ['reddit'] } })).status).toBe(400);
    const v = await ok<MusterConfig>('you', 'PATCH', '/api/config', { researchBrowser: { visibleSites: ['Reddit.com', 'reddit.com'] } });
    expect(v.researchBrowser).toMatchObject({ operaAllow: ['reddit.com'], visibleSites: ['reddit.com'] });
    expect((await ok<MusterConfig>('you', 'PATCH', '/api/config', { researchBrowser: { visibleSites: null } })).researchBrowser.visibleSites).toEqual([]);
    expect(c.intel).toEqual({ recheck: 'weekly', checkMaxAgeDays: 14 });
    expect((await call('captain', 'PATCH', '/api/config', { intel: { recheck: 'off' } })).status).toBe(403);
  });

  it('you add a competitor and start research: the job starts scout with the intel prompt', async () => {
    expect((await call('captain', 'POST', '/api/intel/competitors', { name: 'Padlet', url: 'https://padlet.com' })).status).toBe(403);
    const r = await ok<{ competitor: { id: string }; job: IntelJob }>('you', 'POST', '/api/intel/competitors', { name: 'Padlet', url: 'https://padlet.com', areas: ['features', 'roadmap'], watch: 'weekly', start: true });
    expect(r.competitor.id).toBe('padlet');
    expect(r.job).toMatchObject({ id: 'IJ1', kind: 'competitor', competitorIds: ['padlet'], areas: ['features', 'roadmap'] });
    expect((await call('you', 'POST', '/api/intel/competitors', { name: 'Padlet', url: 'https://padlet.com' })).status).toBe(409);
    await until(() => orch.agents.isRunning('scout'));
    expect(intel().jobs[0].status).toBe('running');
    expect(scout()).toMatchObject({ role: 'research', worktree: repo });
    await ok('scout', 'POST', '/api/agents/scout/event', { event: 'session-start' });
    await until(() => typed.includes('[muster] You are scout (research). Intel job IJ1 (competitor). Call intel_brief and start.'));
    const research = await call('you', 'POST', '/api/research/runs', { sources: { competitors: ['Padlet'], reviews: false, forums: [], ownApp: false }, depth: 'quick' });
    expect(research.status).toBe(409);
    expect(research.data.error).toMatch(/^scout is busy with IJ1/);
  });

  it('brief for scout or you; scout records findings that GET /api/intel returns; the intel event fires', async () => {
    expect((await call('captain', 'GET', '/api/intel/brief')).status).toBe(403);
    expect((await ok<{ text: string }>('scout', 'GET', '/api/intel/brief')).text).toContain('Intel job IJ1 (competitor, quick): Researching Padlet.');
    expect((await call('captain', 'POST', '/api/intel/record', { kind: 'finding', item: {} })).status).toBe(403);
    const bad = await call('scout', 'POST', '/api/intel/record', { kind: 'capability', item: { name: 'Approve posts', cells: { padlet: { status: 'none', ...claim, sources: [] } } } });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toBe('cells.padlet.sources: at least one source is required');
    const before = events.filter((e) => e.type === 'intel').length;
    const cap = await ok('scout', 'POST', '/api/intel/record', { kind: 'capability', item: { name: 'Approve posts before live', cells: { us: { status: 'yes', ...ownCode }, padlet: { status: 'none', ...claim } } } });
    expect(cap).toMatchObject({ id: 'F1', verdict: 'edge', verdictVs: ['padlet'] });
    await ok('scout', 'POST', '/api/intel/record', { kind: 'theme', item: { title: 'Kids post first', mentions: 40, sampleSize: 400, independentSources: 30, byCompetitor: { padlet: 40 }, severity: 'high', trend: 'rising', confidence: 'medium', sources: [src], quotes: [] } });
    await ok('scout', 'POST', '/api/intel/record', { kind: 'change', item: { competitorId: 'padlet', area: 'pricing', title: 'Pro to £8/mo', planImpact: 'respond', implication: 'Price gap widens', ...claim } });
    const store = await ok<IntelStore>('you', 'GET', '/api/intel');
    expect(store.capabilities.map((c) => c.name)).toEqual(['Approve posts before live']);
    expect(store.themes[0]).toMatchObject({ id: 'TH1', label: 'opinion' });
    expect(store.changes[0]).toMatchObject({ id: 'IX1', jobId: 'IJ1', seen: false });
    await until(() => events.filter((e) => e.type === 'intel').length > before);
    const ev = events.filter((e) => e.type === 'intel').at(-1) as Extract<MusterEvent, { type: 'intel' }>;
    expect(ev.rev).toBe(intel().rev);
    expect(ev.summary).toMatchObject({ competitors: 1, edges: 1, alerts: 1, runningJob: { id: 'IJ1' } });
    // per-job progress for the research-in-progress overlay, carried by the summary
    expect(intel().jobs[0].progress).toMatchObject({ claims: 3, areas: { features: 1, reviews: 1, pricing: 1 }, current: 'pricing', latest: { text: 'Pro to £8/mo', label: 'fact' } });
    const sum = await ok<IntelSummary>('you', 'GET', '/api/intel/summary');
    expect(sum.runningJob).toMatchObject({ id: 'IJ1', names: ['Padlet'], areas: ['features', 'roadmap'], pages: 0, progress: { claims: 3, current: 'pricing' } });
  });

  it('scout raises an opportunity and checks it; finishing the last job stops scout', async () => {
    const idea = await ok<ResearchIdea>('scout', 'POST', '/api/intel/opportunities', { title: 'Approval queue as our edge', summary: 'Keep it.', impact: 'high', effort: 'S', evidence: ev, opportunity: opportunity() });
    expect(idea).toMatchObject({ id: 'R1', origin: 'intel', runId: 'IJ1', status: 'new' });
    expect(intel().capabilities[0].ideaId).toBe('R1');
    const check = await ok<IntelCheck>('scout', 'POST', '/api/intel/checks/R1', { rows: [row('features')], verdictText: 'Protect it.', confidence: 'high', capabilityIds: ['F1'], watchFor: 'Padlet ships approval' });
    expect(check).toMatchObject({ id: 'IC1', status: 'done', verdict: 'edge', revision: 1 });
    expect((await call('you', 'POST', '/api/intel/finish', { summary: 'x' })).status).toBe(403);
    const job = await ok<IntelJob>('scout', 'POST', '/api/intel/finish', { summary: 'Read 14 pages.', sourcesRead: 14 });
    expect(job).toMatchObject({ status: 'done', sourcesRead: 14 });
    expect(intel().competitors.find((c) => c.id === 'padlet')!.lastSweptAt).toBeDefined();
    // "research is ready" note for you: Needs you, from scout, with the counts the board shows
    const note = state().notes.find((n) => n.intel?.jobId === 'IJ1')!;
    expect(note).toMatchObject({ type: 'system', topic: 'intel', from: 'scout', to: 'you', open: true });
    expect(note.text).toMatch(/^Padlet research is ready\nRead 14 sources in \d+s\. 4 claims across 4 areas\.$/);
    expect(note.intel).toMatchObject({ outcome: 'ready', kind: 'competitor', names: ['Padlet'], sources: 14, claims: 4, areas: 4, edges: 1, gaps: 0, ideas: 1 });
    await until(() => scout()!.status === 'stopped');
    expect((await call('scout', 'POST', '/api/intel/record', { kind: 'finding', item: { area: 'pricing', title: 'late', ...claim } })).status).toBe(409);
  });

  it('approve needs a fresh check: 409 without one; Run intel check queues a job; done → approved with a watch', async () => {
    // An idea without a check: raised in a second job.
    await ok('captain', 'POST', '/api/intel/jobs', { kind: 'sweep' });
    await until(() => orch.agents.isRunning('scout'));
    const r2 = await ok<ResearchIdea>('scout', 'POST', '/api/intel/opportunities', { title: 'Approval queue for paid walls', summary: 'Edge.', impact: 'medium', effort: 'S', evidence: ev, opportunity: opportunity() });
    await ok('scout', 'POST', '/api/intel/finish', { summary: 'Swept.' });
    const refused = await call('you', 'POST', `/api/research/ideas/${r2.id}/approve`);
    expect(refused.status).toBe(409);
    expect(refused.data.error).toMatch(/^Run the intel check first: /);
    expect((await call('scout', 'POST', '/api/intel/checks', { ideaId: r2.id })).status).toBe(403);
    const queued = await ok<IntelCheck>('captain', 'POST', '/api/intel/checks', { ideaId: r2.id });
    expect(queued).toMatchObject({ id: 'IC2', status: 'queued', ideaId: 'R2' });
    await until(() => intel().checks.find((c) => c.id === 'IC2')!.status === 'running');
    expect((await call('you', 'POST', `/api/research/ideas/${r2.id}/approve`)).data.error).toBe('The intel check IC2 of R2 Approval queue for paid walls is still running; approve once it is done.');
    await until(() => orch.agents.isRunning('scout'));
    await ok('scout', 'POST', `/api/intel/checks/${r2.id}`, { rows: [row('features'), row('plans', { finding: 'Nothing announced', signal: 'neutral' })], verdictText: 'Our edge holds.', confidence: 'high', capabilityIds: ['F1'], watchFor: 'Padlet announces approval' });
    await ok('scout', 'POST', '/api/intel/finish', { summary: 'Checked.' });
    const checkJob = intel().jobs.find((j) => j.kind === 'check' && j.ideaId === r2.id)!;
    expect(checkJob.status).toBe('done');
    expect(state().notes.some((n) => n.intel?.jobId === checkJob.id)).toBe(false); // check-only jobs post no ready note
    const approved = await ok<ResearchIdea>('you', 'POST', `/api/research/ideas/${r2.id}/approve`);
    expect(approved).toMatchObject({ status: 'approved', checkId: 'IC2', watchId: expect.stringMatching(/^W\d+$/) });
    expect(intel().watches.find((w) => w.id === approved.watchId)).toMatchObject({ subject: { kind: 'idea', ideaId: 'R2' }, cadence: 'weekly', alertOn: 'alert if Padlet announces approval', active: true });
    expect(captainInbox().at(-1)).toMatch(/approved\. Add it to the roadmap now: .* Intel check IC2: edge \(high, 1 source\) — it is attached to the goal automatically\.$/);
  });

  it('add_goal for the idea carries intelCheckId and keeps the roadmap approved', async () => {
    const r = await ok<{ goal: RoadmapGoal; roadmap: { status: string } }>('captain', 'POST', '/api/roadmap/goals', { stageId: 'M2', title: 'Approval for paid walls', ideaId: 'R2' });
    expect(r.goal.intelCheckId).toBe('IC2');
    expect(r.roadmap.status).toBe('approved');
    await until(() => intel().checks.find((c) => c.id === 'IC2')!.goalId === r.goal.id);
  });

  it('a due watch re-checks; a changed verdict raises a change, a note to you and a Captain line', async () => {
    const watch = intel().watches.find((w) => w.subject.kind === 'idea')!;
    watch.nextAt = new Date(Date.now() - 1000).toISOString();
    const [job] = orch.intel.tick();
    expect(job).toMatchObject({ kind: 'recheck', ideaId: 'R2', checkId: 'IC2', by: 'schedule' });
    expect(orch.intel.tick()).toEqual([]); // queued once
    await until(() => orch.agents.isRunning('scout') && intel().jobs.find((j) => j.id === job.id)!.status === 'running');
    await ok('scout', 'POST', '/api/intel/record', { kind: 'plan', item: { competitorId: 'padlet', title: 'Post approval for all walls', kind: 'commitment', status: 'in_progress', capabilityIds: ['F1'], ...claim } });
    const check = await ok<IntelCheck>('scout', 'POST', '/api/intel/checks/R2', { rows: [row('features'), row('plans', { finding: 'Padlet building approval', signal: 'threat' })], verdictText: 'Ship polish before Padlet.', confidence: 'high', capabilityIds: ['F1'] });
    expect(check).toMatchObject({ revision: 2, verdict: 'edge_at_risk', goalId: 'G3' });
    const change = intel().changes.at(-1)!;
    expect(change).toMatchObject({ planImpact: 'respond', ideaId: 'R2', goalId: 'G3', seen: false });
    const notes = await ok<Note[]>('you', 'GET', '/api/notes?needsYou=1');
    expect(notes.find((n) => n.topic === 'intel' && !n.intel)).toMatchObject({ type: 'system', open: true, text: expect.stringMatching(/^Intel: R2 Approval queue for paid walls verdict edge → edge at risk\./) });
    expect(captainInbox().at(-1)).toBe(`Re-check of R2 Approval queue for paid walls (G3): verdict edge → edge at risk; plans: Padlet building approval (threat). Does the plan need to respond? Suggest it with intel_suggest(${change.id}, text).`);
    await ok('scout', 'POST', '/api/intel/finish', { summary: 'Re-checked.' });
    expect(watch.lastAt).toBeDefined();
    expect((await call('you', 'POST', `/api/intel/changes/${change.id}/suggest`, { text: 'x' })).status).toBe(403);
    expect(await ok('captain', 'POST', `/api/intel/changes/${change.id}/suggest`, { text: 'Pull approval polish into M2.' })).toMatchObject({ suggestion: 'Pull approval polish into M2.' });
    expect((await ok<IntelSummary>('you', 'GET', '/api/intel/summary')).alerts).toBe(2);
    expect(await ok('you', 'POST', '/api/intel/changes/seen')).toEqual({ ok: true, marked: 2 });
  });

  it('scout exiting mid-job fails the job (findings kept); cancel stops a running job', async () => {
    const job = await ok<IntelJob>('you', 'POST', '/api/intel/jobs', { kind: 'competitor', competitorIds: ['padlet'] });
    await until(() => orch.agents.isRunning('scout') && intel().jobs.find((j) => j.id === job.id)!.status === 'running');
    await ok('scout', 'POST', '/api/intel/record', { kind: 'finding', item: { area: 'pricing', title: 'Pro £8/mo', ...claim } });
    scoutPtys.at(-1)!.crash();
    await until(() => intel().jobs.find((j) => j.id === job.id)!.status === 'failed');
    expect(intel().jobs.find((j) => j.id === job.id)!.error).toMatch(/exited \(code 1\) before finish_intel_job/);
    expect(intel().findings.map((f) => f.title)).toContain('Pro £8/mo');
    const stopped = state().notes.find((n) => n.intel?.jobId === job.id)!;
    expect(stopped.intel).toMatchObject({ outcome: 'stopped', claims: 1 });
    expect(stopped.text).toMatch(/^Padlet research stopped early\nKept 1 claim\. scout stopped: .*exited \(code 1\)/);
    expect(stopped.open).toBe(true);
    const next = await ok<IntelJob>('captain', 'POST', '/api/intel/jobs', { kind: 'sweep' });
    await until(() => orch.agents.isRunning('scout') && intel().jobs.find((j) => j.id === next.id)!.status === 'running');
    expect(await ok<IntelJob>('captain', 'POST', `/api/intel/jobs/${next.id}/cancel`)).toMatchObject({ status: 'cancelled' });
    await until(() => scout()!.status === 'stopped');
    expect((await call('you', 'POST', `/api/intel/jobs/${next.id}/cancel`)).status).toBe(409);
    expect(state().notes.find((n) => n.intel?.jobId === next.id)!.text).toMatch(/research stopped early\n.*The Captain cancelled it\.$/);
    // you cancelling your own job: no note
    const mine = await ok<IntelJob>('you', 'POST', '/api/intel/jobs', { kind: 'competitor', competitorIds: ['padlet'] });
    await until(() => orch.agents.isRunning('scout') && intel().jobs.find((j) => j.id === mine.id)!.status === 'running');
    await ok('you', 'POST', `/api/intel/jobs/${mine.id}/cancel`);
    await until(() => scout()!.status === 'stopped');
    expect(state().notes.some((n) => n.intel?.jobId === mine.id)).toBe(false);
  });

  it('ask and reply on the gaps; per-idea ask goes to the idea thread', async () => {
    expect((await call('captain', 'POST', '/api/intel/ask', { text: 'x' })).status).toBe(403);
    await ok('you', 'POST', '/api/intel/ask', { text: 'Which gap first?' });
    expect(captainInbox().at(-1)).toBe('You asked about the gaps: Which gap first?. Read intel_overview, answer with intel_reply (and advise_idea per gap).');
    expect((await call('you', 'POST', '/api/intel/reply', { text: 'x' })).status).toBe(403);
    const r = await ok<{ captainThread: { from: string }[] }>('captain', 'POST', '/api/intel/reply', { text: 'R1 first.' });
    expect(r.captainThread.map((m) => m.from)).toEqual(['you', 'captain']);
    const idea = await ok<ResearchIdea>('you', 'POST', '/api/intel/ask', { text: 'Worth it?', ideaId: 'R1' });
    expect(idea.thread.at(-1)).toMatchObject({ from: 'you', text: 'Worth it?' });
  });

  it('report is Markdown; deleting a watch and rejecting an idea stop watches; removing a competitor keeps findings', async () => {
    const report = await call('you', 'GET', '/api/intel/report');
    expect(report.type).toMatch(/^text\/markdown/);
    expect(report.text).toContain('# Competitive intelligence — wall');
    expect(report.text).toContain('### F1 Approve posts before live — edge vs Padlet');
    const w = intel().watches.find((x) => x.subject.kind === 'competitor')!;
    expect((await call('captain', 'DELETE', `/api/intel/watches/${w.id}`)).status).toBe(403);
    expect(await ok('you', 'DELETE', `/api/intel/watches/${w.id}`)).toMatchObject({ active: false });
    // An approved idea without a goal can still be rejected; its watch stops.
    const r1 = await ok<ResearchIdea>('you', 'POST', '/api/research/ideas/R1/approve');
    await ok('you', 'POST', '/api/research/ideas/R1/reject', { note: 'Not now' });
    await until(() => intel().watches.find((x) => x.id === r1.watchId)!.active === false);
    expect((await call('you', 'DELETE', '/api/intel/competitors/us')).status).toBe(400);
    expect(await ok('you', 'DELETE', '/api/intel/competitors/padlet')).toEqual({ ok: true });
    expect((await ok<IntelStore>('you', 'GET', '/api/intel')).capabilities).toHaveLength(1);
  });

  it('with no competitors tracked, research ideas get a skipped check and approve at once', async () => {
    const run = await ok('you', 'POST', '/api/research/runs', { sources: { competitors: [], reviews: true, forums: [], ownApp: false }, depth: 'quick', browse: 'public' });
    expect(run).toMatchObject({ browse: 'public' });
    await ok('scout', 'POST', '/api/agents/scout/event', { event: 'session-start' });
    expect((await ok<{ text: string }>('scout', 'GET', '/api/research/brief')).text).toContain('none: ideas need no intel check');
    const idea = await ok<ResearchIdea>('scout', 'POST', '/api/research/ideas', { title: 'Dark mode', summary: 'Night use.', impact: 'low', effort: 'S', evidence: ev });
    expect(intel().checks.find((c) => c.id === idea.checkId)).toMatchObject({ status: 'skipped', skippedReason: 'no competitors tracked' });
    await ok('scout', 'POST', `/api/research/runs/${(run as { id: string }).id}/finish`, { summary: 'done' });
    expect(await ok<ResearchIdea>('you', 'POST', `/api/research/ideas/${idea.id}/approve`)).toMatchObject({ status: 'approved' });
  });

  it('a job queued behind a research run starts when the run is cancelled, in a fresh scout', async () => {
    await ok('you', 'POST', '/api/intel/competitors', { name: 'Wakelet', url: 'https://wakelet.com' });
    const run = await ok<{ id: string }>('you', 'POST', '/api/research/runs', { sources: { competitors: ['Wakelet'], reviews: true, forums: [], ownApp: false }, depth: 'quick' });
    const job = await ok<IntelJob>('captain', 'POST', '/api/intel/jobs', { kind: 'sweep' });
    await new Promise((r) => setTimeout(r, 30));
    expect(intel().jobs.find((j) => j.id === job.id)!.status).toBe('queued');
    await ok('you', 'POST', `/api/research/runs/${run.id}/cancel`);
    await until(() => intel().jobs.find((j) => j.id === job.id)!.status === 'running' && orch.agents.isRunning('scout'));
    await new Promise((r) => setTimeout(r, 50));
    expect(intel().jobs.find((j) => j.id === job.id)!.status).toBe('running');
    await ok('scout', 'POST', '/api/intel/finish', { summary: 'Swept.' });
    await until(() => scout()!.status === 'stopped');
  });
});
