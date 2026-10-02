// Research and usage-alert routes through the HTTP API: who may call them, scout's lifecycle, and the effects.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Agent, MusterConfig, MusterState, Note, ResearchIdea, ResearchRun, ResearchState, RoadmapGoal, UsageState } from '../types.js';
import { tempRepo } from '../core/testutil.js';
import { startOrchestrator, type Orchestrator } from './server.js';
import type { PtyLauncher, PtyProcess } from './terminal.js';

const typed: string[] = [];
class FakePty implements PtyProcess {
  static nextPid = 8000;
  pid = FakePty.nextPid++;
  private exitCbs: ((e: { exitCode: number }) => void)[] = [];
  onData() {}
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCbs.push(cb);
  }
  write(data: string) {
    typed.push(data);
  }
  resize() {}
  kill() {
    setImmediate(() => this.exitCbs.splice(0).forEach((cb) => cb({ exitCode: 1 })));
  }
}
const launches: { cwd: string }[] = [];
const launcher: PtyLauncher = (_file, _args, opts) => {
  launches.push({ cwd: opts.cwd });
  return new FakePty();
};

let repo: string;
let orch: Orchestrator;

async function call<T = any>(actor: string, method: string, path: string, body: Record<string, unknown> = {}): Promise<{ status: number; data: T }> {
  const token = actor === 'you' ? orch.token : orch.agentToken(actor);
  const res = await fetch(orch.url + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-muster-token': token },
    body: method === 'GET' ? undefined : JSON.stringify({ actor, ...body }),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}
async function ok<T = any>(actor: string, method: string, path: string, body?: Record<string, unknown>): Promise<T> {
  const r = await call<T>(actor, method, path, body);
  if (r.status !== 200) throw new Error(`${actor} ${method} ${path} → ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
const state = () => orch.store.state as MusterState;
const scout = () => state().agents.find((a) => a.id === 'scout');
const captainInbox = () => state().inbox.filter((i) => i.agentId === 'captain').map((i) => i.text);
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sources = { competitors: ['Padlet'], reviews: true, forums: [], ownApp: true };
const evidence = [{ kind: 'forum', source: 'r/Teachers · 412 upvotes', text: 'Kids post before I can check', url: 'https://example.com/t/1' }];

beforeAll(async () => {
  process.env.MUSTER_NO_NOTIFY = '1';
  repo = tempRepo();
  const ui = mkdtempSync(join(tmpdir(), 'muster-ui-'));
  writeFileSync(join(ui, 'index.html'), '<html></html>');
  mkdirSync(join(repo, '.muster'), { recursive: true });
  writeFileSync(join(repo, '.muster', 'config.json'), JSON.stringify({ lines: { feature: { label: 'Feature', stations: ['build'] } }, claudePath: 'C:/fake/claude.exe', maxCrew: 1 }));
  orch = await startOrchestrator({
    repoRoot: repo,
    port: 0,
    launcher,
    uiDir: ui,
    log: () => {},
    timings: { enterDelayMs: 1, firstPromptDelayMs: 1, nudgeDebounceMs: 10, scoutStopDelayMs: 20, stopConfirmMs: 200 },
  });
  await ok<Agent>('you', 'POST', '/api/agents', {}); // the one crew agent maxCrew allows
});

afterAll(async () => {
  await orch?.shutdown();
  rmSync(repo, { recursive: true, force: true });
});

describe('research API', () => {
  it('starts empty; only you start a run, with a source and a depth', async () => {
    expect(await ok<ResearchState>('you', 'GET', '/api/research')).toEqual({ runs: [], ideas: [] });
    const crew = state().agents.find((a) => a.role === 'crew')!.id;
    expect((await call(crew, 'POST', '/api/research/runs', { sources, depth: 'quick' })).status).toBe(403);
    expect((await call('you', 'POST', '/api/research/runs', { sources: { competitors: [], reviews: false, forums: [], ownApp: false }, depth: 'quick' })).status).toBe(400);
    expect((await call('you', 'POST', '/api/agents', { role: 'research' })).status).toBe(400); // never added by hand
  });

  it('spawns scout at the repo root (no worktree, crewModel, not counted in maxCrew) with its first prompt', async () => {
    const run = await ok<ResearchRun>('you', 'POST', '/api/research/runs', { sources, depth: 'quick', focus: 'moderation' });
    expect(run).toMatchObject({ id: 'RR1', status: 'running', agentId: 'scout' });
    expect(scout()).toMatchObject({ role: 'research', worktree: repo, branch: 'main', model: 'sonnet' });
    expect(launches.at(-1)!.cwd).toBe(repo);
    expect(orch.agents.isRunning('scout')).toBe(true);
    await ok('scout', 'POST', '/api/agents/scout/event', { event: 'session-start' });
    await until(() => typed.includes('[muster] You are scout (research). Call research_brief and start.'));
    expect((await call('you', 'POST', '/api/research/runs', { sources, depth: 'quick' })).status).toBe(409);
    expect(state().feed.some((f) => f.text.startsWith('started research RR1'))).toBe(true);
  });

  it('scout never takes tasks', async () => {
    const t = await ok('you', 'POST', '/api/tasks', { title: 'Something' });
    expect((await call('you', 'POST', `/api/tasks/${t.id}/assign`, { agentId: 'scout' })).status).toBe(409);
    expect((await call('scout', 'POST', '/api/tasks/claim')).status).toBe(409);
    expect((await call('you', 'POST', '/api/agents/scout/role', { role: 'crew' })).status).toBe(409);
    await ok('you', 'POST', `/api/tasks/${t.id}/cancel`, { reason: 'test' });
  });

  it('brief for scout or you; ideas only from scout', async () => {
    expect((await call('captain', 'GET', '/api/research/brief')).status).toBe(403);
    const { text } = await ok<{ text: string }>('scout', 'GET', '/api/research/brief');
    expect(text).toContain('Research run RR1 (quick).');
    expect(text).toContain('Focus from the user: moderation');
    expect((await ok<{ text: string }>('you', 'GET', '/api/research/brief')).text).toBe(text);
    const idea = { title: 'Moderation queue', summary: 'Teachers approve posts first.', impact: 'high', effort: 'M', evidence };
    expect((await call('captain', 'POST', '/api/research/ideas', idea)).status).toBe(403);
    expect((await call('scout', 'POST', '/api/research/ideas', { ...idea, evidence: [] })).status).toBe(400);
    expect((await call('scout', 'POST', '/api/research/ideas', { ...idea, stageId: 'M1' })).status).toBe(400); // no roadmap yet
    expect(await ok<ResearchIdea>('scout', 'POST', '/api/research/ideas', idea)).toMatchObject({ id: 'R1', runId: 'RR1', status: 'new' });
    await ok('scout', 'POST', '/api/research/ideas', { ...idea, title: 'Export to PDF', impact: 'low', effort: 'S' });
  });

  it('finish marks the run done and stops scout', async () => {
    expect((await call('you', 'POST', '/api/research/runs/RR1/finish', { summary: 'x' })).status).toBe(403);
    const run = await ok<ResearchRun>('scout', 'POST', '/api/research/runs/RR1/finish', { summary: 'Read 9 pages.', sourcesRead: 9 });
    expect(run).toMatchObject({ status: 'done', ideaIds: ['R1', 'R2'], sourcesRead: 9 });
    await until(() => scout()!.status === 'stopped');
    expect(orch.agents.isRunning('scout')).toBe(false);
    expect((await call('scout', 'POST', '/api/research/ideas', { title: 'Late', summary: 's', impact: 'low', effort: 'S', evidence })).status).toBe(409);
  });

  it('a new run restarts the same scout; cancel stops it', async () => {
    const run = await ok<ResearchRun>('you', 'POST', '/api/research/runs', { sources, depth: 'thorough' });
    expect(run.id).toBe('RR2');
    expect(state().agents.filter((a) => a.role === 'research')).toHaveLength(1);
    expect(orch.agents.isRunning('scout')).toBe(true);
    expect((await call('scout', 'POST', '/api/research/runs/RR2/cancel')).status).toBe(403);
    expect(await ok<ResearchRun>('you', 'POST', '/api/research/runs/RR2/cancel')).toMatchObject({ status: 'cancelled' });
    expect(scout()!.status).toBe('stopped');
    expect((await call('you', 'POST', '/api/research/runs/RR2/cancel')).status).toBe(409);
  });

  it('ask → Captain inbox, advice from the Captain, approve → goal on the roadmap without a second approval', async () => {
    await ok('captain', 'PUT', '/api/roadmap', { title: 'wall v1', summary: '', stages: [{ title: 'Basics', exitCriteria: [], goals: [{ title: 'Posting' }] }] });
    await ok('you', 'POST', '/api/roadmap/approve');
    expect((await call('captain', 'POST', '/api/research/ideas/R1/ask', { text: 'q' })).status).toBe(403);
    const asked = await ok<ResearchIdea>('you', 'POST', '/api/research/ideas/R1/ask', { text: 'Worth it?' });
    expect(asked.thread).toMatchObject([{ from: 'you', text: 'Worth it?' }]);
    expect(captainInbox().at(-1)).toMatch(/^You asked about R1 Moderation queue: Worth it\?\. Read it with get_idea R1/);
    expect((await call('you', 'POST', '/api/research/ideas/R1/advice', { text: 'x' })).status).toBe(403);
    const advised = await ok<ResearchIdea>('captain', 'POST', '/api/research/ideas/R1/advice', { text: 'Small; fits M1.', plan: ['+ Add goal Moderation queue to M1'] });
    expect(advised.plan).toEqual(['+ Add goal Moderation queue to M1']);
    expect((await call('captain', 'POST', '/api/research/ideas/R1/approve')).status).toBe(403);
    expect(await ok<ResearchIdea>('you', 'POST', '/api/research/ideas/R1/approve')).toMatchObject({ status: 'approved' });
    expect(captainInbox().at(-1)).toMatch(/^R1 Moderation queue approved\. Add it to the roadmap now/);
    const r = await ok<{ goal: RoadmapGoal; roadmap: { status: string } }>('captain', 'POST', '/api/roadmap/goals', { stageId: 'M1', title: 'Moderation queue', ideaId: 'R1' });
    expect(r.roadmap.status).toBe('approved');
    expect((await ok<ResearchState>('you', 'GET', '/api/research')).ideas[0].goalId).toBe(r.goal.id);
    expect((await call('captain', 'POST', '/api/roadmap/goals', { stageId: 'M1', title: 'Again', ideaId: 'R1' })).status).toBe(409);
  });

  it('reject and reopen are yours', async () => {
    expect((await call('captain', 'POST', '/api/research/ideas/R2/reject')).status).toBe(403);
    expect(await ok<ResearchIdea>('you', 'POST', '/api/research/ideas/R2/reject', { note: 'Later' })).toMatchObject({ status: 'rejected' });
    expect(await ok<ResearchIdea>('you', 'POST', '/api/research/ideas/R2/reopen')).toMatchObject({ status: 'new' });
    expect((await call('you', 'POST', '/api/research/ideas/R9/reopen')).status).toBe(404);
  });
});

describe('usage alerts API', () => {
  it('weekly alert note → remind me at 90%, dismissed in the same call', async () => {
    await ok('you', 'POST', '/api/usage', { agentId: 'captain', rate_limits: { seven_day: { used_percentage: 80 } } });
    const [note] = await ok<Note[]>('you', 'GET', '/api/notes?needsYou=1');
    expect(note).toMatchObject({ type: 'system', topic: 'weekly_usage', open: true });
    expect((await call('captain', 'POST', '/api/usage/weekly-alert', { action: 'remind_at', percent: 90 })).status).toBe(403);
    expect((await call('you', 'POST', '/api/usage/weekly-alert', { action: 'remind_at', percent: 50 })).status).toBe(400);
    const r = await ok<{ usage: UsageState; config: MusterConfig }>('you', 'POST', '/api/usage/weekly-alert', { action: 'remind_at', percent: 90, noteId: note.id });
    expect(r.usage).toMatchObject({ weeklyRemindAt: 90, weeklyWarned: false });
    expect((await ok<Note[]>('you', 'GET', '/api/notes')).some((n) => n.id === note.id)).toBe(false);
    expect((await ok<Note[]>('you', 'GET', '/api/notes?dismissed=1')).find((n) => n.id === note.id)).toMatchObject({ dismissed: true, open: false });
    expect(await ok<Note[]>('you', 'GET', '/api/notes?needsYou=1')).toEqual([]);
  });

  it('dismiss is yours; never turns weekly alerts off in config; PATCH turns them back on', async () => {
    const n = await ok<Note>('captain', 'POST', '/api/notes', { type: 'progress', text: 'hello' });
    expect((await call('captain', 'POST', `/api/notes/${n.id}/dismiss`)).status).toBe(403);
    expect(await ok<Note>('you', 'POST', `/api/notes/${n.id}/dismiss`)).toMatchObject({ dismissed: true });
    const r = await ok<{ config: MusterConfig }>('you', 'POST', '/api/usage/weekly-alert', { action: 'never' });
    expect(r.config.weeklyAlerts).toBe(false);
    expect((await ok<MusterConfig>('you', 'GET', '/api/config')).weeklyAlerts).toBe(false);
    expect((await call('you', 'PATCH', '/api/config', { weeklyAlerts: 'yes' })).status).toBe(400);
    expect((await ok<MusterConfig>('you', 'PATCH', '/api/config', { weeklyAlerts: true })).weeklyAlerts).toBe(true);
    const snooze = await ok<{ usage: UsageState }>('you', 'POST', '/api/usage/weekly-alert', { action: 'snooze_week' });
    expect(Date.parse(snooze.usage.weeklySnoozedUntil!)).toBeGreaterThan(Date.now());
  });
});
