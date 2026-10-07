// Media in the orchestrator: the media store's runtime (herald's queue, suggestion checks) and every /api/media/*
// route. See docs/MEDIA.md.
import type { IntelStore, MediaPiece, MusterConfig, MusterState } from '../types.js';
import * as board from '../core/board.js';
import { badRequest } from '../core/errors.js';
import { evidencePath } from '../core/evidence.js';
import * as media from '../core/media.js';
import type { MusterPaths } from '../core/paths.js';
import type { Store } from '../core/store.js';
import type { AgentManager, HeraldMedia } from './agents.js';

export interface MediaRuntimeOptions {
  store: Store;
  file: media.MediaFile;
  paths: MusterPaths;
  config(): MusterConfig;
  log?: (msg: string) => void;
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
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw badRequest(`Missing ${name}`);
  return v;
};

/** How long herald gets to read media_finish's answer before it is stopped (like scout after finish_research). */
export const HERALD_STOP_DELAY_MS = 3000;

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
  route('POST', '/api/media/pieces/:id/edit', ({ params, body }) => write(() => media.editPiece(st(), state(), str(body.actor, 'actor'), params.id, withoutActor(body))));
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
  route('POST', '/api/media/suggestions', ({ body }) => write(() => media.suggestFeature(st(), state(), str(body.actor, 'actor'), { task: body.task, title: body.title, why: body.why })));
  route('POST', '/api/media/suggestions/dismiss-all', ({ body }) => write(() => ({ dismissed: media.dismissAllSuggestions(st(), str(body.actor, 'actor')) })));
  route('POST', '/api/media/suggestions/:id/accept', ({ params, body }) => write(() => ({ pieces: media.acceptSuggestion(st(), state(), str(body.actor, 'actor'), params.id) }), true));
  route('POST', '/api/media/suggestions/:id/dismiss', ({ params, body }) => write(() => media.dismissSuggestion(st(), str(body.actor, 'actor'), params.id)));

  // ---- herald
  route('POST', '/api/media/pieces/:id/draft', ({ params, body }) => write(() => media.saveDraft(st(), state(), str(body.actor, 'actor'), params.id, withoutActor(body))));
  route('POST', '/api/media/pieces/:id/finish', ({ params, body }) => {
    const piece = write(() => media.finishDraft(st(), state(), str(body.actor, 'actor'), params.id, body.summary), true);
    const text = `herald finished ${piece.id}: ${piece.title}`;
    ctx.toast('info', text);
    ctx.notify('Muster: media ready', text);
    // Another queued piece is typed into herald by the dispatcher; with none left, herald stops after reading this.
    if (!st().pieces.some((p) => p.status === 'queued' || p.status === 'drafting')) void agents.stopHerald('media queue empty', HERALD_STOP_DELAY_MS);
    return piece;
  });
}

function withoutActor(body: Record<string, any>): Record<string, any> {
  const { actor: _actor, ...rest } = body;
  return rest;
}

