// Competitive intelligence in the orchestrator: the intel store's runtime (dispatcher, watch tick, scout hooks,
// browse budget for the research browser) and every /api/intel/* route. See docs/ARCHITECTURE.md § "Competitive intelligence".
import type { BrowseMode, IntelJob, MusterConfig, MusterState } from '../types.js';
import * as board from '../core/board.js';
import { badRequest, forbidden } from '../core/errors.js';
import * as intel from '../core/intel.js';
import * as intelcheck from '../core/intelcheck.js';
import * as intelprogress from '../core/intelprogress.js';
import type { MusterPaths } from '../core/paths.js';
import * as research from '../core/research.js';
import type { Store } from '../core/store.js';
import type { AgentManager, ScoutIntel } from './agents.js';

export interface IntelRuntimeOptions {
  store: Store;
  file: intel.IntelFile;
  paths: MusterPaths;
  config(): MusterConfig;
  log?: (msg: string) => void;
  /** A desktop notification (the "research is ready" / "stopped early" note). */
  notify?: (title: string, text: string) => void;
}

/** What the research browser routes (src/orchestrator/browserapi.ts) need to know about scout's current work. */
export interface BrowseWork {
  id: string;
  mode: BrowseMode;
  pagesLeft: number;
}

/**
 * The intel store's life in the orchestrator: scout hooks for AgentManager, the dispatcher that starts the next queued
 * job when scout is free, the watch tick, and the browse budget. `attach(agents)` once AgentManager exists.
 */
export class IntelRuntime implements ScoutIntel {
  readonly file: intel.IntelFile;
  private agents?: AgentManager;
  private kickScheduled = false;
  private runPages = new Map<string, number>(); // research runs have no stored page counter
  private log: (msg: string) => void;

  constructor(private o: IntelRuntimeOptions) {
    this.file = o.file;
    this.log = o.log ?? (() => {});
  }

  get store() {
    return this.file.store;
  }

  private get state(): MusterState {
    return this.o.store.state;
  }

  attach(agents: AgentManager): void {
    this.agents = agents;
  }

  /** Shutdown: the dispatcher starts nothing any more. */
  dispose(): void {
    this.agents = undefined;
  }

  /** Saves the intel store (rev + 1, 'intel' event) and gives the dispatcher a chance. */
  commit(): void {
    this.file.commit();
    this.kick();
  }

  // ---- ScoutIntel (AgentManager hooks)

  runningJob(): IntelJob | undefined {
    return intel.runningJob(this.store);
  }

  onScoutExit(reason: string): void {
    const job = intel.failJob(this.store, reason);
    if (!job) return;
    board.feedEvent(this.state, board.SYSTEM, `intel job ${job.id} failed: ${reason} (findings kept)`);
    this.postJobNote(job, 'stopped');
    this.o.store.commit();
    this.commit();
  }

  /** The Bulletin board note for you when a competitor / sweep / watch job ends (none for checks), plus a desktop notification. */
  postJobNote(job: IntelJob, outcome: 'ready' | 'stopped'): void {
    const note = intelprogress.postJobNote(this.store, this.state, job, outcome);
    if (!note) return;
    const [title, ...rest] = note.text.split('\n');
    this.o.notify?.(`Muster: ${title}`, rest.join(' '));
  }

  // ---- dispatcher

  /** Schedules a dispatcher step (coalesced): after any job or run change, an unpause, or a watch tick. */
  kick(): void {
    if (this.kickScheduled) return;
    this.kickScheduled = true;
    setImmediate(() => {
      this.kickScheduled = false;
      void this.dispatch().catch((e) => this.log(`intel dispatcher: ${e instanceof Error ? e.message : e}`));
    });
  }

  /** Starts the oldest queued job when scout is free, and starts scout for it (or types the job into it). */
  async dispatch(): Promise<IntelJob | undefined> {
    if (!this.agents) return undefined;
    const job = intel.startNextJob(this.store, this.state);
    if (!job) return undefined;
    board.feedEvent(this.state, board.SYSTEM, `scout started intel job ${job.id}: ${intel.jobLabel(this.store, job)}`);
    this.o.store.commit();
    this.file.commit();
    try {
      await this.agents.startScout();
    } catch (e) {
      this.onScoutExit(`scout could not start: ${e instanceof Error ? e.message : e}`);
    }
    return job;
  }

  /** The 10-minute tick: due watches queue their jobs (skipped while paused). */
  tick(now = Date.now()): IntelJob[] {
    if (this.state.usage.paused) return [];
    const before = JSON.stringify(this.store.watches);
    const jobs = intel.tickWatches(this.store, this.state, this.o.config(), now);
    if (jobs.length || JSON.stringify(this.store.watches) !== before) this.commit();
    return jobs;
  }

  /** Keeps checks, watches and verdicts in step with state (after every state change). */
  sync(): void {
    if (intelcheck.syncIntel(this.store, this.state)) this.file.commit();
  }

  // ---- research browser hookup (package B's browserapi.ts)

  /** The running intel job or research run scout is browsing for, or null. */
  currentWork(): BrowseWork | null {
    const max = this.o.config().researchBrowser.maxPagesPerJob;
    const job = this.runningJob();
    if (job) return { id: job.id, mode: job.browse, pagesLeft: Math.max(0, max - job.pagesBrowsed) };
    const run = research.runningRun(this.state);
    if (run) return { id: run.id, mode: run.browse ?? 'public', pagesLeft: Math.max(0, max - (this.runPages.get(run.id) ?? 0)) };
    return null;
  }

  countPage(id: string, page?: { url?: string; blocked?: string; loggedIn?: boolean; mode?: string }): void {
    const job = this.store.jobs.find((j) => j.id === id);
    if (job) {
      intelprogress.trackPage(job, page);
      this.file.commit();
    } else this.runPages.set(id, (this.runPages.get(id) ?? 0) + 1);
  }

  shotsDir(id: string): string {
    return intel.shotsDir(this.o.paths, id);
  }
}

type Handler = (r: { params: Record<string, string>; query: URLSearchParams; body: Record<string, any> }) => unknown;

export interface IntelRouteContext {
  store: Store;
  runtime: IntelRuntime;
  agents: AgentManager;
  config(): MusterConfig;
  notify(title: string, text: string): void;
  toast(level: 'info' | 'warn', text: string): void;
  /** A Markdown body sent as-is (GET /api/intel/report). */
  markdown(text: string, filename: string): unknown;
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw badRequest(`Missing ${name}`);
  return v;
};

/** Every /api/intel/* route except POST /api/intel/probe (the research browser package registers that). */
export function registerIntelRoutes(route: (method: string, path: string, handler: Handler) => void, ctx: IntelRouteContext): void {
  const { runtime, agents } = ctx;
  const state = () => ctx.store.state;
  const st = () => runtime.store;
  /** A mutation of the intel store (and maybe state): commit both, dispatcher kicked. */
  const write = <T>(fn: () => T, touchesState = false): T => {
    const result = fn();
    if (touchesState) ctx.store.commit();
    runtime.commit();
    return result;
  };

  route('GET', '/api/intel', () => st());
  route('GET', '/api/intel/summary', () => intel.intelSummary(st(), state()));
  route('GET', '/api/intel/brief', () => ({ text: intel.intelBrief(st(), state(), ctx.config()) }));
  route('GET', '/api/intel/report', () => ctx.markdown(intel.intelReport(st(), state()), `intel-report-${intel.today()}.md`));

  // ---- competitors and jobs
  route('POST', '/api/intel/competitors', ({ body }) =>
    write(() => {
      const actor = str(body.actor, 'actor');
      const competitor = intel.addCompetitor(st(), actor, body as intel.CompetitorInput, ctx.config());
      let job: IntelJob | undefined;
      if (body.start === true) {
        job = intel.requestJob(st(), state(), actor, { kind: 'competitor', competitorIds: [competitor.id], areas: competitor.areas, browse: competitor.browse, depth: body.depth }, ctx.config());
      }
      board.feedEvent(state(), actor, `started tracking ${competitor.name} (${competitor.url})${job ? `; scout researches it in ${job.id}` : ''}`);
      intelcheck.recomputeVerdicts(st(), state());
      return { competitor, ...(job ? { job } : {}) };
    }, true),
  );
  route('PATCH', '/api/intel/competitors/:id', ({ params, body }) => write(() => intel.patchCompetitor(st(), str(body.actor, 'actor'), params.id, body)));
  route('DELETE', '/api/intel/competitors/:id', ({ params, body }) =>
    write(() => {
      intel.removeCompetitor(st(), str(body.actor, 'actor'), params.id);
      intelcheck.recomputeVerdicts(st(), state());
      return { ok: true };
    }),
  );
  route('POST', '/api/intel/jobs', ({ body }) => write(() => intel.requestJob(st(), state(), str(body.actor, 'actor'), body, ctx.config())));
  route('POST', '/api/intel/jobs/:id/cancel', async ({ params, body }) => {
    const actor = str(body.actor, 'actor');
    const { job, wasRunning } = write(() => {
      const r = intel.cancelJob(st(), state(), actor, params.id);
      // You cancelled it yourself: no note. The Captain stopping a job that had started is worth telling you.
      if (r.wasRunning && actor !== board.HUMAN) runtime.postJobNote(r.job, 'stopped');
      return r;
    }, true);
    if (wasRunning) await agents.stopScout(`intel job ${job.id} cancelled`);
    return job;
  });

  // ---- scout's writes
  route('POST', '/api/intel/record', ({ body }) =>
    write(() => {
      const item = intel.recordIntel(st(), state(), str(body.actor, 'actor'), body.kind, body.item);
      intelcheck.recomputeVerdicts(st(), state());
      return item;
    }),
  );
  route('POST', '/api/intel/opportunities', ({ body }) =>
    write(() => {
      const idea = research.addOpportunity(state(), st(), str(body.actor, 'actor'), body as research.IdeaInput & { opportunity: unknown });
      intelprogress.trackClaim(intel.runningJob(st()), 'opportunity', body, idea);
      intelcheck.recomputeVerdicts(st(), state());
      return idea;
    }, true),
  );
  route('POST', '/api/intel/checks', ({ body }) => write(() => intelcheck.requestCheck(st(), state(), str(body.actor, 'actor'), body.ideaId, ctx.config()), true));
  route('POST', '/api/intel/checks/:ideaId', ({ params, body }) => {
    const r = write(() => intelcheck.writeCheck(st(), state(), str(body.actor, 'actor'), params.ideaId, body as intelcheck.CheckInput), true);
    if (r.alert) {
      ctx.notify('Muster: intel re-check', r.alert.notifyText);
      ctx.toast('warn', r.alert.notifyText);
    }
    return r.check;
  });
  route('POST', '/api/intel/finish', ({ body }) => {
    const job = write(() => {
      const j = intel.finishJob(st(), state(), str(body.actor, 'actor'), { summary: body.summary, sourcesRead: body.sourcesRead });
      board.feedEvent(state(), str(body.actor, 'actor'), `finished intel job ${j.id}: ${intel.jobLabel(st(), j)}`);
      runtime.postJobNote(j, 'ready');
      return j;
    }, true);
    if (job.kind === 'competitor' || job.kind === 'sweep') ctx.toast('info', `scout finished ${intel.jobLabel(st(), job)}`);
    // The next queued job is typed into scout by the dispatcher; with none, scout stops once it has read the result.
    if (!intel.queuedJobs(st()).length) void agents.stopScout(`intel job ${job.id} finished`, agents.scoutStopDelayMs);
    return job;
  });

  // ---- you and the Captain
  route('POST', '/api/intel/ask', ({ body }) => {
    const actor = str(body.actor, 'actor');
    if (body.ideaId !== undefined && body.ideaId !== null && body.ideaId !== '') {
      const idea = research.askIdea(state(), actor, str(body.ideaId, 'ideaId'), body.text);
      ctx.store.commit();
      return idea;
    }
    if (actor !== board.HUMAN) throw forbidden('Only you can ask the Captain about the gaps');
    const text = intel.text(body.text, 'text', 4000);
    return write(() => {
      st().captainThread.push({ at: board.nowIso(), from: actor, text });
      const captain = board.captainOf(state());
      if (captain) {
        board.addInbox(state(), {
          agentId: captain.id,
          from: actor,
          kind: 'system',
          text: `You asked about the gaps: ${text}. Read intel_overview, answer with intel_reply (and advise_idea per gap).`,
        });
      }
      board.feedEvent(state(), actor, 'asked the Captain about the gaps');
      return { captainThread: st().captainThread };
    }, true);
  });
  route('POST', '/api/intel/reply', ({ body }) => {
    write(() => intel.intelReply(st(), state(), str(body.actor, 'actor'), body.text));
    ctx.toast('info', 'The Captain answered about the gaps');
    return { captainThread: st().captainThread };
  });
  route('POST', '/api/intel/changes/seen', ({ body }) => write(() => ({ ok: true, marked: intel.markChangesSeen(st(), str(body.actor, 'actor'), body.ids) })));
  route('POST', '/api/intel/changes/:id/suggest', ({ params, body }) => write(() => intel.suggestOnChange(st(), state(), str(body.actor, 'actor'), params.id, body.text)));
  route('DELETE', '/api/intel/watches/:id', ({ params, body }) => {
    if (body.actor !== board.HUMAN) throw forbidden('Only you can stop a watch');
    return write(() => {
      const w = intel.requireWatch(st(), params.id);
      w.active = false;
      return w;
    });
  });
}
