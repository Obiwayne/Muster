// The dashboard's Intel client (ui/src/intelapi.ts) against a real orchestrator: every endpoint the Intel page and
// the add-competitor modal call, with the request bodies they send and the shapes they read back.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IntelCheck, IntelStore, ResearchBrowserStatus, ResearchIdea } from '../types.js';
import { tempRepo } from '../core/testutil.js';
import { probeSite, type FetchLike } from '../core/intelprobe.js';
import { startOrchestrator, type Orchestrator } from './server.js';
import type { BrowserLike } from './browserapi.js';
import type { PtyLauncher, PtyProcess } from './terminal.js';

// The UI's token plumbing (meta tag / ?token=) stands in as the human token of the test orchestrator.
const token = vi.hoisted(() => ({ value: '' }));
vi.mock('../../ui/src/api', () => ({
  getToken: () => token.value,
  refreshToken: async () => false,
  ApiError: class ApiError extends Error {
    constructor(message: string, public status: number) {
      super(message);
    }
  },
}));
const ui = await import('../../ui/src/intelapi');

class FakePty implements PtyProcess {
  static nextPid = 9500;
  pid = FakePty.nextPid++;
  private exitCbs: ((e: { exitCode: number }) => void)[] = [];
  onData() {}
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCbs.push(cb);
  }
  write() {}
  resize() {}
  kill() {
    setImmediate(() => this.exitCbs.splice(0).forEach((cb) => cb({ exitCode: 1 })));
  }
}
const launcher: PtyLauncher = () => new FakePty();

const STATUS: ResearchBrowserStatus = {
  available: true, channel: 'chrome', profileDir: 'X', state: 'idle', sites: [], tools: [], opera: { found: false, allow: [] },
  blocked: [{ domain: 'padlet.com', reason: 'bot check (Cloudflare)', at: '2026-10-03T10:00:00.000Z' }],
};
const browser: BrowserLike & { close(): Promise<void> } = {
  status: async () => STATUS,
  read: async (url, o) => ({ url, title: 'T', status: 200, text: 'hi', via: o.mode }),
  screenshot: async (url, o) => ({ url, title: 'T', status: 200, screenshot: o.path, via: o.mode }),
  scroll: async (url, o) => ({ url, title: 'T', status: 200, scrolled: { y: 0, height: 0 }, via: o.mode }),
  openLogin: async () => STATUS,
  closeLogin: async () => STATUS,
  operaImport: async () => STATUS,
  forget: async () => STATUS,
  close: async () => undefined,
};

// The real probe over the fixture site (no network).
const fixture = (name: string) => readFileSync(new URL(`../core/fixtures/${name}`, import.meta.url), 'utf8');
const siteFetch: FetchLike = async (url) => {
  const body = url.startsWith('https://boardly.io/legal/privacy') ? fixture('probe-privacy.html') : url.startsWith('https://boardly.io') ? fixture('probe-home.html') : url.includes('company-information') ? fixture('probe-ch-search.html') : '';
  return { ok: !!body, status: body ? 200 : 404, url, text: async () => body };
};

let repo: string;
let orch: Orchestrator;
const realFetch = globalThis.fetch;

async function scoutCall<T = any>(method: string, path: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await realFetch(orch.url + path, { method, headers: { 'content-type': 'application/json', 'x-muster-token': orch.agentToken('scout') }, body: JSON.stringify({ actor: 'scout', ...body }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`scout ${method} ${path} → ${res.status} ${text}`);
  return JSON.parse(text) as T;
}
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeAll(async () => {
  process.env.MUSTER_NO_NOTIFY = '1';
  repo = tempRepo();
  const uiDir = mkdtempSync(join(tmpdir(), 'muster-ui-'));
  writeFileSync(join(uiDir, 'index.html'), '<html></html>');
  mkdirSync(join(repo, '.muster'), { recursive: true });
  writeFileSync(join(repo, '.muster', 'config.json'), JSON.stringify({ claudePath: 'C:/fake/claude.exe', maxCrew: 1, projectName: 'wall' }));
  orch = await startOrchestrator({
    repoRoot: repo,
    port: 0,
    launcher,
    uiDir,
    log: () => {},
    browser,
    probe: (url, opts) => probeSite(url, { ...opts, fetch: siteFetch }),
    timings: { enterDelayMs: 1, firstPromptDelayMs: 1, nudgeDebounceMs: 10, scoutStopDelayMs: 20, stopConfirmMs: 200 },
  });
  token.value = orch.token;
  // The dashboard fetches relative paths from its own origin.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => realFetch(typeof input === 'string' && input.startsWith('/') ? orch.url + input : input, init)) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await orch?.shutdown();
  rmSync(repo, { recursive: true, force: true });
});

describe('ui/src/intelapi.ts against the orchestrator', () => {
  it('reads the store, the summary and the research browser status', async () => {
    const store = await ui.getIntel();
    expect(store.competitors.map((c) => c.id)).toEqual(['us']);
    expect(store).toHaveProperty('captainThread');
    const summary = await ui.getIntelSummary();
    expect(summary).toMatchObject({ rev: store.rev, competitors: 0, alerts: 0, queuedJobs: 0 });
    expect(await ui.getBrowserStatus()).toEqual(STATUS);
  });

  let ideaId = '';
  it('add competitor: probe, then add & start research with the body the modal sends', async () => {
    const p = await ui.probe('https://boardly.io');
    expect(p).toMatchObject({ url: 'https://boardly.io/', found: true });
    expect(p.sources.length).toBeGreaterThan(0);
    const ch = p.companies[0];
    const legal = p.legal[0];
    const r = await ui.addCompetitor({
      ...(p.suggestedId ? { id: p.suggestedId } : {}),
      name: p.name ?? 'Boardly',
      url: p.url,
      ...(p.tagline ? { tagline: p.tagline } : {}),
      identity: {
        ...(legal ? { legalName: legal.name, matchedFrom: legal.matchedFrom } : {}),
        ...(ch ? { companiesHouse: { number: ch.number, status: ch.status, ...(ch.incorporated ? { incorporated: ch.incorporated } : {}), ...(ch.address ? { registeredOffice: ch.address } : {}), url: ch.url } } : {}),
      },
      sources: p.sources,
      areas: ['features', 'pricing'],
      watch: 'weekly',
      browse: 'profile',
      depth: 'thorough',
      start: true,
    });
    expect(r.competitor).toMatchObject({ name: p.name, watch: 'weekly', browse: 'profile', areas: ['features', 'pricing'] });
    expect(r.competitor.sources).toEqual(p.sources);
    expect(r.job).toMatchObject({ kind: 'competitor', depth: 'thorough', competitorIds: [r.competitor.id] });
    await until(() => orch.agents.isRunning('scout'));

    const patched = await ui.patchCompetitor(r.competitor.id, { watch: 'monthly' });
    expect(patched).toMatchObject({ id: r.competitor.id, watch: 'monthly' });

    // Scout raises an opportunity; the page asks for its intel check.
    const claim = { label: 'fact', confidence: 'high', sources: [{ kind: 'site', title: 'Boardly pricing', url: 'https://boardly.io/pricing' }], asOf: '2026-10-01' };
    const idea = await scoutCall<ResearchIdea>('POST', '/api/intel/opportunities', {
      title: 'Free tier with more boards', summary: 'Boardly caps free at 3.', impact: 'medium', effort: 'S',
      evidence: [{ kind: 'competitor', source: 'Boardly pricing', text: '3 boards free', url: 'https://boardly.io/pricing' }],
      opportunity: { kind: 'gap', capabilityIds: [], problem: 'Free cap', alternatives: 'Pay', proposal: 'More free boards', value: 'Adoption', effortNote: 'Small', priority: 'next', validation: 'Ask teachers', valueScore: 3, effortScore: 2, claim: { ...claim, implication: 'Easy win' } },
    });
    ideaId = idea.id;
    const check: IntelCheck = await ui.requestCheck(idea.id);
    expect(check).toMatchObject({ ideaId: idea.id, status: 'queued' });
    await scoutCall('POST', '/api/intel/record', { kind: 'change', item: { competitorId: r.competitor.id, area: 'pricing', title: 'Gold to $8', planImpact: 'respond', implication: 'Price gap widens', ...claim } });
  });

  it('jobs: run sweep, cancel it', async () => {
    const job = await ui.startJob({ kind: 'sweep' });
    expect(job).toMatchObject({ kind: 'sweep', status: 'queued' });
    const cancelled = await ui.cancelJob(job.id);
    expect(cancelled).toMatchObject({ id: job.id, status: 'cancelled' });
  });

  it('ask the Captain (general and about one idea), mark changes seen', async () => {
    const general = await ui.askIntel('Which gap first?');
    expect(general).toMatchObject({ captainThread: [{ from: 'you', text: 'Which gap first?' }] });
    const about = await ui.askIntel('Worth it?', ideaId);
    expect(about).toMatchObject({ id: ideaId });
    expect((await ui.getIntelSummary()).alerts).toBeGreaterThan(0);
    expect(await ui.markChangesSeen()).toMatchObject({ ok: true });
    expect((await ui.getIntelSummary()).alerts).toBe(0);
  });

  it('export report: Markdown fetched with the token header (a bare link would get 401)', async () => {
    const md = await ui.getReport();
    expect(md).toMatch(/^# /);
    expect(md).toContain('Boardly');
    expect((await realFetch(orch.url + ui.reportUrl())).status).toBe(401);
  });

  it('remove competitor', async () => {
    const store: IntelStore = await ui.getIntel();
    const id = store.competitors.find((c) => !c.isUs)!.id;
    expect(await ui.removeCompetitor(id)).toEqual({ ok: true });
    expect((await ui.getIntel()).competitors.find((c) => c.id === id)).toMatchObject({ removed: true });
  });

  it('errors come back as ApiError with the server message', async () => {
    await expect(ui.patchCompetitor('nobody', { watch: 'daily' })).rejects.toMatchObject({ status: 404, message: 'No competitor "nobody"' });
    await expect(ui.probe('')).rejects.toMatchObject({ status: 400 });
  });
});
