// Media in the orchestrator: the media store's runtime (herald's queue, suggestion checks) and every /api/media/*
// route. See docs/MEDIA.md.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Evidence, IntelStore, MediaPiece, MediaStore, MusterConfig, MusterState, Task } from '../types.js';
import * as board from '../core/board.js';
import { badRequest, notFound } from '../core/errors.js';
import { evidencePath } from '../core/evidence.js';
import * as media from '../core/media.js';
import { convertRecording, renderSlideshow, type RenderOptions } from '../core/mediagif.js';
import type { MusterPaths } from '../core/paths.js';
import type { Store } from '../core/store.js';
import type { AgentManager, HeraldMedia } from './agents.js';

export interface MediaRuntimeOptions {
  store: Store;
  file: media.MediaFile;
  paths: MusterPaths;
  config(): MusterConfig;
  log?: (msg: string) => void;
  /** Test seam: the ffmpeg path / runner / font behind demo GIF rendering (core/mediagif.ts). */
  gif?: RenderOptions;
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

  onHeraldExit(reason: string): void {
    const piece = media.failCurrent(this.store, reason);
    if (!piece) return;
    board.feedEvent(this.state, board.SYSTEM, `media piece ${piece.id} failed: ${reason} (what herald saved is kept)`);
    this.o.store.commit();
    this.file.commit();
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

  /** Starts the oldest queued piece when herald is free (never while paused), and starts herald for it (or types it in). */
  async dispatch(): Promise<MediaPiece | undefined> {
    if (!this.agents || this.state.usage.paused) return undefined;
    const piece = media.startNext(this.store);
    if (!piece) return undefined;
    board.feedEvent(this.state, board.SYSTEM, `herald started ${media.pieceLabel(piece)}`);
    this.o.store.commit();
    this.file.commit();
    try {
      await this.agents.startHerald();
    } catch (e) {
      this.onHeraldExit(`herald could not start: ${e instanceof Error ? e.message : e}`);
    }
    return piece;
  }

  /** The hourly tick: the week that just ended may get a roundup suggestion. */
  tick(now = new Date()): void {
    const before = this.store.lastWeekly;
    const made = media.weeklyCheck(this.store, this.state, now);
    if (made || this.store.lastWeekly !== before) this.file.commit();
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

  /** herald's brief for the piece it is drafting. */
  brief(intel?: IntelStore): string {
    const config = this.o.config();
    return media.mediaBrief(this.store, this.state, {
      intel,
      evidenceFile: (task, entryId, name) => evidencePath(this.o.paths, task, entryId, name),
      userName: config.userName,
      projectName: config.projectName,
    });
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
    write(() => media.createPiece(st(), state(), str(body.actor, 'actor'), { kind: body.kind, about: body.about, note: body.note, platforms: body.platforms, suggestionId: body.suggestionId }), true),
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
    // Another queued piece is typed into herald by the dispatcher; with none left, herald stops after reading this.
    if (!st().pieces.some((p) => p.status === 'queued' || p.status === 'drafting')) void agents.stopHerald('media queue empty', agents.scoutStopDelayMs); // after herald has read the result
    return piece;
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

