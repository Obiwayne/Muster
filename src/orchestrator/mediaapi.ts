// Media in the orchestrator: the media store's runtime (herald's queue, suggestion checks) and every /api/media/*
// route. See docs/MEDIA.md.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowseMode, Evidence, IntelStore, MediaPiece, MediaPlatform, MediaPublishJob, MediaStore, MusterConfig, MusterState, Note, Task } from '../types.js';
import * as board from '../core/board.js';
import { badRequest, forbidden, notFound } from '../core/errors.js';
import { evidencePath } from '../core/evidence.js';
import { vellumServer } from '../core/claude.js';
import * as media from '../core/media.js';
import * as social from '../core/mediasocial.js';
import { convertRecording, renderSlideshow, type RenderOptions } from '../core/mediagif.js';
import type { MusterPaths } from '../core/paths.js';
import type { Store } from '../core/store.js';
import type { AgentManager, HeraldMedia } from './agents.js';

/** Pages herald may read per research or comment check. */
export const MEDIA_PAGE_BUDGET = 40;

export interface MediaRuntimeOptions {
  store: Store;
  file: media.MediaFile;
  paths: MusterPaths;
  config(): MusterConfig;
  log?: (msg: string) => void;
  /** Test seam: the ffmpeg path / runner / font behind demo GIF rendering (core/mediagif.ts). */
  gif?: RenderOptions;
  /** Test seams: how long media_publish_wait holds (default 5 min) and how often it looks (default 1 s). */
  publishWaitMs?: number;
  publishPollMs?: number;
}

/**
 * The media store's life in the orchestrator: herald hooks for AgentManager, the dispatcher that hands herald the next
 * queued piece, and the suggestion checks. `attach(agents)` once AgentManager exists.
 */
export class MediaRuntime implements HeraldMedia {
  readonly file: media.MediaFile;
  private agents?: AgentManager;
  private kickScheduled = false;
  private log: (msg: string) => void;
  /** Slideshow renders in flight, per piece; a piece edited mid-render renders again after. */
  private rendering = new Map<string, Promise<void>>();
  private renderAgain = new Set<string>();

  constructor(private o: MediaRuntimeOptions) {
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

  /** Saves the media store (rev + 1, 'media' event) and gives the dispatcher a chance. */
  commit(): void {
    this.file.commit();
    this.kick();
  }

  // ---- HeraldMedia (AgentManager hooks)

  draftingPiece(): MediaPiece | undefined {
    return media.draftingPiece(this.store);
  }

  /** The line herald is typed for the work it holds ("Draft MP3", "Put post PJ2 into X"), or undefined. */
  heraldWork(): string | undefined {
    const w = this.store.current;
    if (w && social.workOpen(this.store, w)) return social.workLabel(this.store, w);
    const piece = media.draftingPiece(this.store);
    return piece ? `Draft ${piece.id}` : undefined;
  }

  /** Whether herald has anything open or waiting (it is stopped when this turns false). */
  hasWork(): boolean {
    return social.hasWork(this.store);
  }

  onHeraldExit(reason: string): void {
    const piece = media.failCurrent(this.store, reason);
    const other = social.failWork(this.store, reason);
    if (!piece && !other) return;
    if (piece) board.feedEvent(this.state, board.SYSTEM, `media piece ${piece.id} failed: ${reason} (what herald saved is kept)`);
    if (other) board.feedEvent(this.state, board.SYSTEM, `media: ${other}`);
    this.settleReadyNotes();
    this.o.store.commit();
    this.file.commit();
  }

  /** Nothing left for herald: stop it after it has read its last result. */
  afterWork(): void {
    if (!this.agents || social.hasWork(this.store)) return;
    void this.agents.stopHerald('media queue empty', this.agents.scoutStopDelayMs);
  }

  // ---- dispatcher

  /** Schedules a dispatcher step (coalesced): after any piece change or an unpause. */
  kick(): void {
    if (this.kickScheduled) return;
    this.kickScheduled = true;
    setImmediate(() => {
      this.kickScheduled = false;
      void this.dispatch().catch((e) => this.log(`media dispatcher: ${e instanceof Error ? e.message : e}`));
    });
  }

  /**
   * When herald is free (never while paused), hands it the next piece of work (a post going out, a post image, a
   * draft, a research refresh, the comment check) and starts herald for it, or types it in. Returns the piece when
   * the work is a draft (older callers and tests look at it).
   */
  async dispatch(): Promise<MediaPiece | undefined> {
    if (!this.agents || this.state.usage.paused) return undefined;
    const work = social.pickWork(this.store);
    if (!work) return undefined;
    const piece = work.kind === 'draft' ? this.store.pieces.find((p) => p.id === work.id) : undefined;
    board.feedEvent(this.state, board.SYSTEM, piece ? `herald started ${media.pieceLabel(piece)}` : `herald: ${social.workLabel(this.store, work)}`);
    this.o.store.commit();
    this.file.commit();
    try {
      await this.agents.startHerald();
    } catch (e) {
      this.onHeraldExit(`herald could not start: ${e instanceof Error ? e.message : e}`);
    }
    return piece;
  }

  /** The hourly tick: the week that just ended may get a roundup suggestion; the daily comment check may be due. */
  tick(now = new Date()): void {
    const before = this.store.lastWeekly;
    const made = media.weeklyCheck(this.store, this.state, now);
    const watch = social.watchCheck(this.store, now.getTime());
    if (made || watch || this.store.lastWeekly !== before) this.commit();
  }

  // ---- post images, posting

  /** .muster/media/<piece>/images/: the post images herald exported from Vellum. */
  imagesDir(id: string): string {
    return join(this.gifDir(id), 'images');
  }

  /** Whether herald can design in Vellum here: a Vellum MCP server and the project's Vellum file. */
  vellumReady(): boolean {
    const config = this.o.config();
    return !!vellumServer(config) && !!config.vellumFile?.trim();
  }

  /** A post image's path (404 when the piece has no such design). */
  designPath(id: string, file: string): string {
    const piece = media.requirePiece(this.store, id);
    const d = piece.designs?.find((x) => x.file === file);
    const path = d && join(this.imagesDir(piece.id), d.file);
    if (!path || !existsSync(path)) throw notFound(`${piece.id} has no post image "${file}"`);
    return path;
  }

  /** The files a post on `platform` carries: its Vellum design, else the evidence images, else demo GIFs. */
  imagesFor(piece: MediaPiece, platform: MediaPlatform): string[] {
    const design = piece.designs?.find((d) => d.platform === platform);
    if (design) return [join(this.imagesDir(piece.id), design.file)];
    const shots = (piece.images ?? []).flatMap((im) => {
      const task = this.state.tasks.find((t) => t.id === im.taskId);
      return task ? [evidencePath(this.o.paths, task, im.evidenceId, im.name)] : [];
    });
    if (shots.length) return shots;
    return (piece.gifIds ?? []).flatMap((gid) => {
      const g = this.store.pieces.find((p) => p.id === gid);
      const f = g && media.currentGifFile(g);
      return g && f ? [join(this.gifDir(g.id), f.name)] : [];
    });
  }

  /** A job filled in and waiting for you: a board note, a toast and a notification. */
  announceReady(job: MediaPublishJob, ctx: Pick<MediaRouteContext, 'notify' | 'toast'>): void {
    const piece = job.pieceId ? this.store.pieces.find((p) => p.id === job.pieceId) : undefined;
    const where = social.PLATFORM_NAME[job.platform];
    const press = job.kind === 'reply' ? 'Reply' : 'Post';
    const note = board.postNote(this.state, {
      actor: board.SYSTEM,
      type: 'system',
      to: board.HUMAN,
      topic: 'media',
      text: `${social.readyNoteTitle(job)}\nCheck the ${where} tab in Chrome, then press ${press} in Muster${piece ? ` (${piece.id} · ${piece.title})` : ''}. Nothing is sent until you do.`,
    });
    note.open = true;
    delete note.taskId;
    delete note.branch;
    this.o.store.commit();
    const line = `${where} ${job.kind} ready: check the tab in Chrome and press ${press} in Muster`;
    ctx.toast('info', line);
    ctx.notify('Muster: ready to post', line);
  }

  /** Settles the "ready" notes of jobs that aren't ready any more. */
  settleReadyNotes(): void {
    const ready = new Set((this.store.publish ?? []).filter((j) => j.status === 'ready').map((j) => social.readyNoteTitle(j)));
    for (const n of this.state.notes as Note[]) {
      const head = n.text.split('\n')[0];
      if (n.topic !== 'media' || n.dismissed || !/ ready \(PJ\d+\)$/.test(head) || ready.has(head)) continue;
      board.closeNoteIfOpen(n);
      n.dismissed = true;
    }
  }

  // ---- browsing (research and the comment check)

  /** Pages herald has read per piece of work (keyed by the work's start). */
  private pagesRead = new Map<string, number>();

  /** herald's browse budget while it researches a social piece or checks comments; null otherwise. */
  browseWork(): { id: string; mode: BrowseMode; pagesLeft: number } | null {
    const w = this.store.current;
    if (!w || !social.workOpen(this.store, w)) return null;
    const piece = w.id ? this.store.pieces.find((p) => p.id === w.id) : undefined;
    const browsing = w.kind === 'research' || w.kind === 'watch' || (w.kind === 'draft' && piece?.kind === 'social');
    if (!browsing) return null;
    const key = `${w.kind}:${w.id ?? ''}:${w.startedAt}`;
    const mode = this.o.config().researchBrowser?.mode ?? 'profile';
    return { id: key, mode, pagesLeft: Math.max(0, MEDIA_PAGE_BUDGET - (this.pagesRead.get(key) ?? 0)) };
  }

  countPage(key: string): void {
    this.pagesRead.set(key, (this.pagesRead.get(key) ?? 0) + 1);
  }

  /** Where screenshots herald takes while browsing go. */
  shotsDir(): string {
    return join(this.o.paths.dir, 'media', 'shots');
  }

  /** media_publish_wait: holds until you press Post or Cancel, or the wait runs out ("waiting"). */
  async waitForDecision(id: string): Promise<{ decision: string; job: MediaPublishJob }> {
    const until = Date.now() + (this.o.publishWaitMs ?? social.PUBLISH_WAIT_MS);
    const every = this.o.publishPollMs ?? 1000;
    for (;;) {
      const decision = social.publishDecision(this.store, id);
      if (decision !== 'waiting' || Date.now() >= until) return { decision, job: social.requireJob(this.store, id) };
      await new Promise((r) => setTimeout(r, every));
    }
  }

  /** After every state change: newly finished stages get a suggestion. */
  sync(): void {
    if (media.syncStageSuggestions(this.store, this.state).length) this.file.commit();
  }

  // ---- demo GIF

  /** .muster/media/<piece id>/: the rendered GIFs of a piece. */
  gifDir(id: string): string {
    return join(this.o.paths.dir, 'media', id);
  }

  /** The GIF file of a piece (its current source, or the one asked for). 404 while it hasn't been made. */
  gifPath(id: string, source?: string): string {
    const piece = media.requirePiece(this.store, id);
    if (piece.kind !== 'gif' || !piece.gif) throw badRequest(`${piece.id} is not a demo GIF`);
    const which = source === undefined || source === '' ? piece.gif.source : source;
    if (which !== 'slideshow' && which !== 'recording') throw badRequest('source must be slideshow or recording');
    const file = which === 'recording' ? piece.gif.recording?.file : piece.gif.slideshow;
    const path = file && join(this.gifDir(piece.id), file.name);
    if (!path || !existsSync(path)) throw notFound(`${piece.id} has no ${which} GIF yet`);
    return path;
  }

  /** Renders a piece's slideshow (after herald finishes, or you change its frames). Resolves when it is saved. */
  renderSlideshow(id: string): Promise<void> {
    const busy = this.rendering.get(id);
    if (busy) {
      this.renderAgain.add(id);
      return busy;
    }
    const run = this.doRender(id).finally(() => {
      this.rendering.delete(id);
      if (this.renderAgain.delete(id)) void this.renderSlideshow(id);
    });
    this.rendering.set(id, run);
    return run;
  }

  private async doRender(id: string): Promise<void> {
    const piece = this.store.pieces.find((p) => p.id === id && p.kind === 'gif');
    if (!piece?.gif?.frames.length) return;
    let result: Parameters<typeof media.setSlideshow>[2];
    try {
      const frames = piece.gif.frames.map((f) => {
        const task = this.state.tasks.find((t) => t.id === f.taskId);
        if (!task) throw new Error(`task ${f.taskId} is gone`);
        return { path: evidencePath(this.o.paths, task, f.evidenceId, f.name), caption: f.caption, seconds: f.seconds };
      });
      result = { file: await renderSlideshow(this.gifDir(id), frames, this.o.gif) };
    } catch (e) {
      result = { error: e instanceof Error ? e.message : String(e) };
      this.log(`media: ${id} slideshow not rendered: ${result.error}`);
    }
    if (media.setSlideshow(this.store, id, result)) this.file.commit();
  }

  /**
   * New evidence on a task: when the task records a demo GIF and the evidence has a video or GIF, turn it into the
   * piece's recording.gif. Resolves with the piece once it is ready (undefined when this evidence isn't a recording).
   */
  async onEvidence(task: Task, record: Evidence): Promise<MediaPiece | undefined> {
    const piece = media.recordingFor(this.store, task.id);
    const clip = record.files.find((f) => f.kind === 'video' || /\.gif$/i.test(f.name));
    if (!piece || !clip) return undefined;
    const captions = (piece.gif?.frames ?? []).map((f) => f.caption);
    try {
      const file = await convertRecording(this.gifDir(piece.id), evidencePath(this.o.paths, task, record.id, clip.name), captions, this.o.gif);
      const done = media.recordingDone(this.store, this.state, piece.id, file);
      if (done) {
        this.o.store.commit();
        this.file.commit();
      }
      return done;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      this.log(`media: ${piece.id} recording not converted: ${why}`);
      if (media.recordingFailed(this.store, piece.id, why)) this.file.commit();
      return undefined;
    }
  }

  /** herald's brief for the work it holds: a draft (with research steps for a social piece without research yet), or the post / image / research / comment-check brief. */
  brief(intel?: IntelStore): string {
    const config = this.o.config();
    const w = this.store.current;
    if (w && w.kind !== 'draft' && social.workOpen(this.store, w))
      return social.workBrief(this.store, this.state, {
        projectName: config.projectName,
        userName: config.userName,
        vellumFile: config.vellumFile,
        imagesDir: (id) => this.imagesDir(id),
        evidencePath: (taskId, evidenceId, name) => {
          const task = this.state.tasks.find((t) => t.id === taskId);
          return task ? evidencePath(this.o.paths, task, evidenceId, name) : undefined;
        },
      });
    const text = media.mediaBrief(this.store, this.state, {
      intel,
      evidenceFile: (task, entryId, name) => evidencePath(this.o.paths, task, entryId, name),
      userName: config.userName,
      projectName: config.projectName,
      readme: readReadme(this.state.repoRoot),
    });
    const piece = media.draftingPiece(this.store);
    if (piece?.kind !== 'social') return text;
    const extra = [...(piece.research ? social.replyRules() : social.researchSteps(piece))];
    if (this.vellumReady())
      extra.push('', `Post images: Vellum file ${config.vellumFile}, page "Media"; export PNGs to ${this.imagesDir(piece.id)} and attach with media_designs. Sizes: ${(piece.platforms ?? []).map((p) => `${social.PLATFORM_NAME[p]} ${social.DESIGN_SIZES[p].join('×')}`).join(', ')}.`);
    return `${text}\n${extra.join('\n')}`;
  }
}

/** The project's README.md (first 8 KB) for whole-product pieces; '' when there is none. */
function readReadme(root: string): string {
  try {
    return readFileSync(join(root, 'README.md'), 'utf8').slice(0, 8000);
  } catch {
    return '';
  }
}

type Handler = (r: { params: Record<string, string>; query: URLSearchParams; body: Record<string, any> }) => unknown;

export interface MediaRouteContext {
  store: Store;
  runtime: MediaRuntime;
  agents: AgentManager;
  /** The intel store, for the intel lines in herald's brief. */
  intel?: () => IntelStore;
  notify(title: string, text: string): void;
  toast(level: 'info' | 'warn', text: string): void;
  /** A file sent as the response body (api.ts FileReply). */
  file(path: string, contentType: string): unknown;
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw badRequest(`Missing ${name}`);
  return v;
};

/** Every /api/media/* route. */
export function registerMediaRoutes(route: (method: string, path: string, handler: Handler) => void, ctx: MediaRouteContext): void {
  const { runtime, agents } = ctx;
  const state = () => ctx.store.state;
  const st = () => runtime.store;
  /** A mutation of the media store (and maybe state): commit both, dispatcher kicked. */
  const write = <T>(fn: () => T, touchesState = false): T => {
    const result = fn();
    if (touchesState) ctx.store.commit();
    runtime.commit();
    return result;
  };

  route('GET', '/api/media', () => st());
  route('GET', '/api/media/summary', () => media.mediaSummary(st()));
  route('GET', '/api/media/brief', () => ({ text: runtime.brief(ctx.intel?.()) }));

  // ---- pieces (you)
  route('POST', '/api/media/pieces', ({ body }) =>
    write(() => media.createPiece(st(), state(), str(body.actor, 'actor'), { kind: body.kind, about: body.about, note: body.note, platforms: body.platforms, suggestionId: body.suggestionId, purpose: body.purpose, link: body.link }), true),
  );
  route('POST', '/api/media/pieces/:id/edit', ({ params, body }) => {
    const before = framesOf(st(), params.id);
    const piece = write(() => {
      const p = media.editPiece(st(), state(), str(body.actor, 'actor'), params.id, withoutActor(body));
      // Changed frames make the old slideshow stale: drop it (the UI shows "Rendering…") and render again.
      if (p.gif && JSON.stringify(p.gif.frames) !== before) {
        delete p.gif.slideshow;
        delete p.gif.renderError;
      }
      return p;
    });
    if (piece.gif && JSON.stringify(piece.gif.frames) !== before) void runtime.renderSlideshow(piece.id);
    return piece;
  });
  route('POST', '/api/media/pieces/:id/record', ({ params, body }) => write(() => media.requestRecording(st(), state(), str(body.actor, 'actor'), params.id), true));
  route('GET', '/api/media/pieces/:id/gif', ({ params, query }) => ctx.file(runtime.gifPath(params.id, query.get('source') ?? undefined), 'image/gif'));
  route('POST', '/api/media/pieces/:id/ask', ({ params, body }) => write(() => media.askPiece(st(), str(body.actor, 'actor'), params.id, body.text)));
  route('POST', '/api/media/pieces/:id/claims/:cid/confirm', ({ params, body }) => write(() => media.confirmClaim(st(), str(body.actor, 'actor'), params.id, params.cid)));
  route('POST', '/api/media/pieces/:id/approve', ({ params, body }) => write(() => media.approvePiece(st(), state(), str(body.actor, 'actor'), params.id), true));
  route('POST', '/api/media/pieces/:id/used', ({ params, body }) => write(() => media.markUsed(st(), state(), str(body.actor, 'actor'), params.id), true));
  route('POST', '/api/media/pieces/:id/retry', ({ params, body }) => write(() => media.retryPiece(st(), str(body.actor, 'actor'), params.id)));
  route('DELETE', '/api/media/pieces/:id', async ({ params, body }) => {
    const piece = write(() => media.deletePiece(st(), state(), str(body.actor, 'actor'), params.id), true);
    if (piece.status === 'drafting') await agents.stopHerald(`${piece.id} was deleted`);
    return { ok: true };
  });
  route('PUT', '/api/media/style', ({ body }) => write(() => ({ houseStyle: media.setHouseStyle(st(), str(body.actor, 'actor'), body.text) })));

  // ---- suggestions
  route('POST', '/api/media/pieces/:id/recording', ({ params, body }) => write(() => media.linkRecording(st(), state(), str(body.actor, 'actor'), params.id, body.task), true));
  route('POST', '/api/media/suggestions', ({ body }) => write(() => media.suggestFeature(st(), state(), str(body.actor, 'actor'), { task: body.task, title: body.title, why: body.why })));
  route('POST', '/api/media/suggestions/dismiss-all', ({ body }) => write(() => ({ dismissed: media.dismissAllSuggestions(st(), str(body.actor, 'actor')) })));
  route('POST', '/api/media/suggestions/:id/accept', ({ params, body }) => write(() => ({ pieces: media.acceptSuggestion(st(), state(), str(body.actor, 'actor'), params.id) }), true));
  route('POST', '/api/media/suggestions/:id/dismiss', ({ params, body }) => write(() => media.dismissSuggestion(st(), str(body.actor, 'actor'), params.id)));

  // ---- herald
  route('POST', '/api/media/pieces/:id/draft', ({ params, body }) => write(() => media.saveDraft(st(), state(), str(body.actor, 'actor'), params.id, withoutActor(body))));
  route('POST', '/api/media/pieces/:id/finish', ({ params, body }) => {
    const piece = write(() => media.finishDraft(st(), state(), str(body.actor, 'actor'), params.id, body.summary), true);
    if (piece.kind === 'gif') void runtime.renderSlideshow(piece.id);
    const text = `herald finished ${piece.id}: ${piece.title}`;
    ctx.toast('info', text);
    ctx.notify('Muster: media ready', text);
    // More work is typed into herald by the dispatcher; with none left, herald stops after reading this.
    runtime.afterWork();
    return piece;
  });

  // ---- research (Refresh is yours; media_research is herald's)
  route('POST', '/api/media/pieces/:id/research', ({ params, body }) => {
    const actor = str(body.actor, 'actor');
    if (actor === board.HUMAN) return write(() => social.requestResearch(st(), actor, params.id));
    const piece = write(() => social.saveResearch(st(), state(), actor, params.id, withoutActor(body)));
    runtime.afterWork();
    return piece;
  });

  // ---- post images in Vellum
  route('POST', '/api/media/pieces/:id/design', ({ params, body }) => write(() => social.requestDesign(st(), str(body.actor, 'actor'), params.id, withoutActor(body), runtime.vellumReady())));
  route('POST', '/api/media/pieces/:id/designs', ({ params, body }) => {
    const id = media.requirePiece(st(), params.id).id;
    const dir = runtime.imagesDir(id);
    const piece = write(() => social.saveDesigns(st(), state(), str(body.actor, 'actor'), id, body.designs, dir, (file) => social.readPngSize(join(dir, file))));
    runtime.afterWork();
    return piece;
  });
  route('GET', '/api/media/pieces/:id/designs/:file', ({ params }) => ctx.file(runtime.designPath(params.id, params.file), 'image/png'));

  // ---- conversations
  route('POST', '/api/media/conversations', ({ body }) => write(() => ({ added: social.addConversations(st(), state(), str(body.actor, 'actor'), body.conversations) })));
  route('POST', '/api/media/conversations/:id/edit', ({ params, body }) => write(() => social.editConversation(st(), str(body.actor, 'actor'), params.id, body.draft)));
  route('POST', '/api/media/conversations/:id/skip', ({ params, body }) => write(() => social.skipConversation(st(), str(body.actor, 'actor'), params.id)));
  route('POST', '/api/media/conversations/:id/claims/:cid/confirm', ({ params, body }) => write(() => social.confirmConversationClaim(st(), str(body.actor, 'actor'), params.id, params.cid)));
  route('POST', '/api/media/conversations/:id/reply', ({ params, body }) => write(() => social.replyConversation(st(), str(body.actor, 'actor'), params.id)));
  route('PUT', '/api/media/reply-policy', ({ body }) => write(() => social.setReplyPolicy(st(), str(body.actor, 'actor'), withoutActor(body))));
  route('POST', '/api/media/watch/done', ({ body }) => {
    write(() => social.watchDone(st(), state(), str(body.actor, 'actor')));
    runtime.afterWork();
    return { ok: true };
  });

  // ---- posting through your Chrome (yours: start, stop, go, cancel)
  route('POST', '/api/media/publish', ({ body }) => write(() => ({ jobs: social.startPublish(st(), str(body.actor, 'actor'), str(body.pieceId, 'pieceId'), body.platforms, (piece, platform) => runtime.imagesFor(piece, platform)) })));
  route('POST', '/api/media/publish/stop', ({ body }) => {
    const stopped = write(() => social.stopPublish(st(), str(body.actor, 'actor'), str(body.pieceId, 'pieceId')));
    runtime.settleReadyNotes();
    ctx.store.commit();
    return { stopped };
  });
  route('POST', '/api/media/publish/:id/go', ({ params, body }) => {
    const job = write(() => social.goJob(st(), str(body.actor, 'actor'), params.id));
    runtime.settleReadyNotes();
    ctx.store.commit();
    return job;
  });
  route('POST', '/api/media/publish/:id/cancel', ({ params, body }) => {
    const job = write(() => social.cancelJob(st(), str(body.actor, 'actor'), params.id));
    runtime.settleReadyNotes();
    ctx.store.commit();
    return job;
  });

  // ---- posting (herald)
  route('POST', '/api/media/publish/next', ({ body }) => write(() => ({ job: social.publishNext(st(), state(), str(body.actor, 'actor')) ?? null })));
  route('POST', '/api/media/publish/:id/ready', ({ params, body }) => {
    const job = write(() => social.publishReady(st(), state(), str(body.actor, 'actor'), params.id, body.composer, body.attached));
    runtime.announceReady(job, ctx);
    return job;
  });
  route('POST', '/api/media/publish/:id/wait', async ({ params, body }) => {
    const actor = str(body.actor, 'actor');
    if (!media.isHerald(state(), actor)) throw forbidden('Only herald (the media agent) waits for your Post');
    return runtime.waitForDecision(params.id);
  });
  route('POST', '/api/media/publish/:id/done', ({ params, body }) => {
    const job = write(() => social.publishDone(st(), state(), str(body.actor, 'actor'), params.id, body.url), true);
    runtime.settleReadyNotes();
    ctx.store.commit();
    ctx.toast('info', `Posted on ${social.PLATFORM_NAME[job.platform]}`);
    runtime.afterWork();
    return job;
  });
  route('POST', '/api/media/publish/:id/failed', ({ params, body }) => {
    const job = write(() => social.publishFailed(st(), state(), str(body.actor, 'actor'), params.id, body.error, body.signin));
    runtime.settleReadyNotes();
    ctx.store.commit();
    ctx.toast('warn', `${social.PLATFORM_NAME[job.platform]}: ${job.error}`);
    runtime.afterWork();
    return job;
  });
}

/** A piece's GIF frames as JSON (to see whether an edit changed them); '' when it has none. */
function framesOf(store: MediaStore, id: string): string {
  const p = store.pieces.find((x) => x.id === String(id).trim().toUpperCase());
  return p?.gif ? JSON.stringify(p.gif.frames) : '';
}

function withoutActor(body: Record<string, any>): Record<string, any> {
  const { actor: _actor, ...rest } = body;
  return rest;
}

