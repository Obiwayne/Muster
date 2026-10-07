// Media (.muster/media.json): herald, the media crew member, writes social posts, articles, website text and video
// scripts from what really shipped. You review, edit, approve, copy the text out and mark it used; Muster never posts.
// Everything here is a pure mutation of a MediaStore (plus MusterState for notes, feed and lookups); MediaFile loads
// and saves it. The orchestrator side (herald dispatch, routes) is src/orchestrator/mediaapi.ts. See docs/MEDIA.md.
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type {
  IntelStore,
  MediaAbout,
  MediaClaim,
  MediaClaimSource,
  MediaImage,
  MediaKind,
  MediaPiece,
  MediaPlatform,
  MediaPost,
  MediaSection,
  MediaShot,
  MediaStore,
  MediaSuggestion,
  MediaSummary,
  MusterState,
  Note,
  Task,
} from '../types.js';
import { closeNoteIfOpen, feedEvent, findAgent, HUMAN, isCaptain, nowIso, postNote, SYSTEM } from './board.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import type { MusterPaths } from './paths.js';
import { writeAtomic, type StoreOptions } from './store.js';

/** herald's id: there is only ever one media agent. */
export const HERALD_ID = 'herald';
export const MEDIA_KINDS: readonly MediaKind[] = ['social', 'article', 'website', 'video'];
export const PLATFORMS: readonly MediaPlatform[] = ['x', 'linkedin', 'bluesky', 'threads'];
/** Character limits the UI warns about (never rejected: a long LinkedIn post is fine). */
export const PLATFORM_LIMITS: Record<MediaPlatform, number> = { x: 280, linkedin: 3000, bluesky: 300, threads: 500 };
export const DEFAULT_PLATFORMS: MediaPlatform[] = ['x', 'linkedin', 'bluesky'];
export const DEFAULT_HOUSE_STYLE =
  "Plain words, no hype, short sentences. Name the real feature, show the screenshot, say who it helps. No em dashes, no 'not X but Y', no rule-of-three lists, no 'game-changer', 'seamless', 'unlock', 'elevate'.";

const MAX_TITLE = 160;
const MAX_NOTE = 2000;
const MAX_REQUEST = 2000;
const MAX_STYLE = 4000;
const MAX_VERSION = 3000;
const MAX_VERSIONS = 3;
const MAX_SECTION = 8000;
const MAX_HEADING = 200;
const MAX_SECTIONS = 20;
const MAX_SHOTS = 40;
const MAX_SHOT_TEXT = 1000;
const MAX_HOOKS = 3;
const MAX_HOOK = 300;
const MAX_CLAIMS = 60;
const MAX_QUOTE = 300;
const MAX_CLAIM_SOURCES = 8;
const MAX_LABEL = 120;
const MAX_IMAGES = 6;
const MAX_ABOUT = 10;
const MAX_PROGRESS = 200;
const MAX_TARGET = 200;
/** A stage that completed longer ago than this gets no suggestion (so old stages don't flood the page on first run). */
const STAGE_SUGGEST_WINDOW_MS = 14 * 24 * 3600_000;
/** A weekly roundup is suggested only for weeks with at least this many merged tasks. */
export const WEEKLY_MIN_MERGED = 5;

const KIND_LABEL: Record<MediaKind, string> = { social: 'Social post', article: 'Article', website: 'Website', video: 'Video script' };
const CLAIM_KINDS: readonly MediaClaimSource['kind'][] = ['task', 'stage', 'goal', 'idea', 'intel', 'chat', 'evidence', 'opinion'];
const ABOUT_KINDS: readonly MediaAbout['kind'][] = ['stage', 'goal', 'task', 'idea', 'range'];
const OPINION: MediaClaimSource = { kind: 'opinion', ref: '', label: 'opinion · your voice' };

// ------------------------------------------------------------------ store

export function emptyMedia(): MediaStore {
  return { version: 1, rev: 0, pieces: [], suggestions: [], houseStyle: DEFAULT_HOUSE_STYLE, nextIds: { piece: 1, suggestion: 1 } };
}

const above = (ids: string[]) => ids.reduce((m, id) => Math.max(m, (Number(id.replace(/\D/g, '')) || 0) + 1), 1);

/** Fills fields a hand-edited or older file lacks, and keeps the id counters above every id in use. */
export function migrateMedia(raw: Partial<MediaStore>): MediaStore {
  const s: MediaStore = { ...emptyMedia(), ...raw, version: 1 };
  s.pieces = Array.isArray(s.pieces) ? s.pieces : [];
  s.suggestions = Array.isArray(s.suggestions) ? s.suggestions : [];
  if (typeof s.houseStyle !== 'string') s.houseStyle = DEFAULT_HOUSE_STYLE;
  if (typeof s.rev !== 'number') s.rev = 0;
  const n = (s.nextIds = { ...{ piece: 1, suggestion: 1 }, ...s.nextIds });
  n.piece = Math.max(n.piece, above(s.pieces.map((p) => p.id)));
  n.suggestion = Math.max(n.suggestion, above(s.suggestions.map((x) => x.id)));
  for (const p of s.pieces) {
    p.claims ??= [];
    p.requests ??= [];
    p.about ??= [];
  }
  return s;
}

export const mediaFile = (paths: MusterPaths) => join(paths.dir, 'media.json');

/**
 * Owns .muster/media.json. Callers mutate `store` and call `commit()`: rev + 1, atomic write, then a 'change' event.
 * A missing file is an empty store; a corrupt one is set aside and logged.
 */
export class MediaFile extends EventEmitter {
  store: MediaStore;
  private log: (msg: string) => void;

  constructor(
    private file: string,
    private opts: StoreOptions = {},
  ) {
    super();
    this.log = opts.log ?? ((msg) => console.error(msg));
    this.store = this.load();
  }

  private load(): MediaStore {
    if (!existsSync(this.file)) return emptyMedia();
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<MediaStore>;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
      return migrateMedia(raw);
    } catch (e) {
      const aside = `${this.file}.corrupt-${Date.now()}`;
      try {
        renameSync(this.file, aside);
      } catch {
        /* keep going with an empty store */
      }
      this.log(`${this.file} could not be read (${e instanceof Error ? e.message : e}); starting with an empty media store (old file kept as ${aside})`);
      return emptyMedia();
    }
  }

  save(): boolean {
    return writeAtomic(this.file, JSON.stringify(this.store, null, 1), this.opts);
  }

  /** rev + 1, save, and notify listeners (even if the save failed: memory is the truth). */
  commit(): void {
    this.store.rev++;
    try {
      this.save();
    } finally {
      this.emit('change', this.store.rev);
    }
  }
}

// ------------------------------------------------------------------ lookups

export function mediaSummary(store: MediaStore): MediaSummary {
  const working = store.pieces.find((p) => p.status === 'drafting');
  return {
    rev: store.rev,
    review: store.pieces.filter((p) => p.status === 'review').length,
    drafting: store.pieces.filter((p) => p.status === 'drafting' || p.status === 'queued').length,
    openSuggestions: store.suggestions.filter((x) => x.status === 'open').length,
    ...(working ? { working: { id: working.id, title: working.title, ...(working.progress ? { progress: working.progress } : {}) } } : {}),
  };
}

/** The piece herald is writing now. */
export const draftingPiece = (store: MediaStore) => store.pieces.find((p) => p.status === 'drafting');

/** A piece by id; "current" is the one being drafted (herald's tools don't need to know its id). */
export function requirePiece(store: MediaStore, id: string): MediaPiece {
  const key = String(id).trim().toUpperCase();
  const piece = key === 'CURRENT' ? draftingPiece(store) : store.pieces.find((p) => p.id === key);
  if (!piece) throw notFound(key === 'CURRENT' ? 'No piece is being drafted' : `No piece "${id}"`);
  return piece;
}

export function requireSuggestion(store: MediaStore, id: string): MediaSuggestion {
  const s = store.suggestions.find((x) => x.id === String(id).trim().toUpperCase());
  if (!s) throw notFound(`No suggestion "${id}"`);
  return s;
}

export const isHerald = (state: MusterState, actor: string) => findAgent(state, actor)?.role === 'media';

function requireHuman(actor: string, what: string): void {
  if (actor !== HUMAN) throw forbidden(`Only you can ${what}`);
}

function requireHerald(state: MusterState, actor: string, what: string): void {
  if (!isHerald(state, actor)) throw forbidden(`Only herald (the media agent) can ${what}`);
}

/** When a task merged (its last 'merged' history event), or undefined. */
export function mergedAt(task: Task): string | undefined {
  if (task.status !== 'merged') return undefined;
  for (let i = task.history.length - 1; i >= 0; i--) if (task.history[i].kind === 'merged') return task.history[i].at;
  return task.updatedAt;
}

// ------------------------------------------------------------------ validation

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

function text(v: unknown, what: string, max: number, required = true): string {
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`${what} is empty`);
    return '';
  }
  if (typeof v !== 'string') throw badRequest(`${what} must be text`);
  const t = v.trim();
  if (required && !t) throw badRequest(`${what} is empty`);
  if (t.length > max) throw badRequest(`${what} is longer than ${max} characters`);
  return t;
}

function list(v: unknown, what: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(v)) throw badRequest(`${what} must be a list`);
  if (v.length > max) throw badRequest(`${what}: at most ${max}`);
  if (v.length < min) throw badRequest(`${what}: at least ${min}`);
  return v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) throw badRequest(`${what} must be one of ${allowed.join(', ')}`);
  return v as T;
}

function index(v: unknown, what: string, length: number): number {
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) >= Math.max(1, length)) throw badRequest(`${what} must be a whole number from 0 to ${Math.max(0, length - 1)}`);
  return v as number;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `{kind, ref}` → a MediaAbout with its label, checked against the roadmap, tasks and ideas (400 when unknown). */
export function resolveAbout(state: MusterState, v: unknown): MediaAbout {
  if (!isObj(v)) throw badRequest('about items must be objects like {kind: "stage", ref: "M3"}');
  const kind = oneOf(v.kind, ABOUT_KINDS, 'about.kind');
  const raw = text(v.ref, 'about.ref', 40);
  if (kind === 'range') {
    const [from, to] = raw.split('..');
    if (!DAY_RE.test(from ?? '') || !DAY_RE.test(to ?? '') || from > to) throw badRequest('A range is "YYYY-MM-DD..YYYY-MM-DD", oldest first');
    return { kind, ref: `${from}..${to}`, label: `Merged ${shortDay(from)} – ${shortDay(to)}` };
  }
  const ref = raw.toUpperCase();
  if (kind === 'stage') {
    const s = state.roadmap?.stages.find((x) => x.id === ref);
    if (!s) throw badRequest(`No stage "${raw}" on the roadmap`);
    return { kind, ref, label: `Stage ${s.id} · ${s.title}` };
  }
  if (kind === 'goal') {
    const g = state.roadmap?.goals.find((x) => x.id === ref);
    if (!g) throw badRequest(`No goal "${raw}" on the roadmap`);
    return { kind, ref, label: `${g.id} ${g.title}` };
  }
  if (kind === 'task') {
    const t = state.tasks.find((x) => x.id === ref);
    if (!t) throw badRequest(`No task "${raw}"`);
    return { kind, ref, label: `${t.id} ${t.title}` };
  }
  const idea = state.research?.ideas.find((x) => x.id === ref);
  if (!idea) throw badRequest(`No idea "${raw}"`);
  return { kind, ref, label: `${idea.id} ${idea.title}` };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDay = (day: string) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1] ?? ''}`;

function platforms(v: unknown): MediaPlatform[] {
  if (v === undefined || v === null) return [...DEFAULT_PLATFORMS];
  const items = [...new Set(list(v, 'platforms', PLATFORMS.length, 1).map((p) => oneOf(p, PLATFORMS, 'platform')))];
  return items;
}

function posts(v: unknown, piece: MediaPiece): MediaPost[] {
  return list(v, 'posts', PLATFORMS.length).map((raw, i) => {
    if (!isObj(raw)) throw badRequest(`posts[${i}] must be an object`);
    const platform = oneOf(raw.platform, PLATFORMS, `posts[${i}].platform`);
    const versions = list(raw.versions, `posts[${i}].versions`, MAX_VERSIONS, 1).map((t, j) => text(t, `${platform} version ${String.fromCharCode(65 + j)}`, MAX_VERSION));
    const chosen = raw.chosen === undefined ? 0 : index(raw.chosen, `posts[${i}].chosen`, versions.length);
    if (piece.platforms && !piece.platforms.includes(platform)) piece.platforms.push(platform);
    return { platform, versions, chosen };
  });
}

function images(state: MusterState, v: unknown): MediaImage[] {
  return list(v, 'images', MAX_IMAGES).map((raw, i) => {
    if (!isObj(raw)) throw badRequest(`images[${i}] must be an object`);
    const taskId = text(raw.taskId, `images[${i}].taskId`, 20).toUpperCase();
    const evidenceId = text(raw.evidenceId, `images[${i}].evidenceId`, 20).toUpperCase();
    const name = text(raw.name, `images[${i}].name`, 260);
    const task = state.tasks.find((t) => t.id === taskId);
    const entry = task?.evidence?.find((e) => e.id === evidenceId);
    if (!entry || !entry.files.some((f) => f.name === name)) throw badRequest(`No evidence file ${taskId}/${evidenceId}/${name}`);
    return { taskId, evidenceId, name, caption: text(raw.caption, `images[${i}].caption`, MAX_LABEL, false) };
  });
}

function sections(v: unknown): MediaSection[] {
  return list(v, 'sections', MAX_SECTIONS).map((raw, i) => {
    if (!isObj(raw)) throw badRequest(`sections[${i}] must be an object`);
    return {
      id: `S${i + 1}`,
      heading: text(raw.heading, `sections[${i}].heading`, MAX_HEADING, false),
      text: text(raw.text, `sections[${i}].text`, MAX_SECTION, false),
      status: raw.status === undefined ? 'done' : oneOf(raw.status, ['todo', 'writing', 'done'] as const, `sections[${i}].status`),
    };
  });
}

function evidenceRef(v: unknown, what: string): MediaShot['evidence'] {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) throw badRequest(`${what} must be an object`);
  return { taskId: text(v.taskId, `${what}.taskId`, 20).toUpperCase(), evidenceId: text(v.evidenceId, `${what}.evidenceId`, 20).toUpperCase(), name: text(v.name, `${what}.name`, 260) };
}

function shots(v: unknown): MediaShot[] {
  return list(v, 'shots', MAX_SHOTS).map((raw, i) => {
    if (!isObj(raw)) throw badRequest(`shots[${i}] must be an object`);
    const at = text(raw.at, `shots[${i}].at`, 10);
    if (!/^\d{1,2}:\d{2}$/.test(at)) throw badRequest(`shots[${i}].at must look like 0:04`);
    const evidence = evidenceRef(raw.evidence, `shots[${i}].evidence`);
    const onScreen = text(raw.onScreen, `shots[${i}].onScreen`, MAX_SHOT_TEXT, false);
    return {
      at,
      shot: text(raw.shot, `shots[${i}].shot`, MAX_SHOT_TEXT),
      voiceover: text(raw.voiceover, `shots[${i}].voiceover`, MAX_SHOT_TEXT, false),
      ...(onScreen ? { onScreen } : {}),
      ...(evidence ? { evidence } : {}),
      ...(raw.record === true ? { record: true } : {}),
    };
  });
}

function claims(v: unknown): MediaClaim[] {
  return list(v, 'claims', MAX_CLAIMS).map((raw, i) => {
    if (!isObj(raw)) throw badRequest(`claims[${i}] must be an object`);
    const sources = list(raw.sources ?? [], `claims[${i}].sources`, MAX_CLAIM_SOURCES).map((src, j) => {
      if (!isObj(src)) throw badRequest(`claims[${i}].sources[${j}] must be an object`);
      const kind = oneOf(src.kind, CLAIM_KINDS, `claims[${i}].sources[${j}].kind`);
      return { kind, ref: text(src.ref, `claims[${i}].sources[${j}].ref`, 40, false), label: text(src.label, `claims[${i}].sources[${j}].label`, MAX_LABEL) };
    });
    return { id: `C${i + 1}`, quote: text(raw.quote, `claims[${i}].quote`, MAX_QUOTE), sources };
  });
}

/** The text fields both you (edit) and herald (draft) may set, validated for the piece's kind. */
function applyText(state: MusterState, piece: MediaPiece, body: Record<string, any>): void {
  const kind = piece.kind;
  const only = (field: string, kinds: MediaKind[]) => {
    if (body[field] !== undefined && !kinds.includes(kind)) throw badRequest(`${field} is for ${kinds.map((k) => KIND_LABEL[k].toLowerCase()).join(' or ')} pieces, not a ${KIND_LABEL[kind].toLowerCase()}`);
  };
  only('posts', ['social']);
  only('images', ['social']);
  only('sections', ['article', 'website']);
  only('target', ['website']);
  only('hooks', ['video']);
  only('hookChosen', ['video']);
  only('shots', ['video']);
  if (body.title !== undefined) piece.title = text(body.title, 'title', MAX_TITLE);
  if (body.posts !== undefined) piece.posts = posts(body.posts, piece);
  if (body.images !== undefined) piece.images = images(state, body.images);
  if (body.sections !== undefined) piece.sections = sections(body.sections);
  if (body.target !== undefined) piece.target = text(body.target, 'target', MAX_TARGET, false) || undefined;
  if (body.hooks !== undefined) {
    piece.hooks = list(body.hooks, 'hooks', MAX_HOOKS).map((h, i) => text(h, `hook ${i + 1}`, MAX_HOOK));
    if ((piece.hookChosen ?? 0) >= piece.hooks.length) piece.hookChosen = 0;
  }
  if (body.hookChosen !== undefined) piece.hookChosen = index(body.hookChosen, 'hookChosen', piece.hooks?.length ?? 0);
  if (body.shots !== undefined) piece.shots = shots(body.shots);
}

// ------------------------------------------------------------------ pieces (you)

export interface PieceInput {
  kind: unknown;
  about: unknown;
  note?: unknown;
  platforms?: unknown;
  suggestionId?: unknown;
}

function newPiece(store: MediaStore, kind: MediaKind, about: MediaAbout[], extra: Partial<MediaPiece> = {}): MediaPiece {
  const at = nowIso();
  const piece: MediaPiece = {
    id: `MP${store.nextIds.piece++}`,
    kind,
    title: `${KIND_LABEL[kind]}: ${about.map((a) => a.label).join(', ')}`.slice(0, MAX_TITLE),
    status: 'queued',
    about,
    ...(kind === 'social' ? { platforms: [...DEFAULT_PLATFORMS] } : {}),
    claims: [],
    requests: [],
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
  store.pieces.push(piece);
  return piece;
}

/** POST /api/media/pieces: you only. Queued; the caller starts herald. A suggestionId accepts that suggestion. */
export function createPiece(store: MediaStore, state: MusterState, actor: string, input: PieceInput): MediaPiece {
  requireHuman(actor, 'ask for new media pieces');
  const kind = oneOf(input.kind, MEDIA_KINDS, 'kind');
  const about = list(input.about, 'about', MAX_ABOUT, 1).map((a) => resolveAbout(state, a));
  const note = text(input.note, 'note', MAX_NOTE, false);
  const suggestion = input.suggestionId === undefined || input.suggestionId === null || input.suggestionId === '' ? undefined : requireSuggestion(store, String(input.suggestionId));
  if (suggestion && suggestion.status === 'dismissed') throw conflict(`${suggestion.id} was dismissed`);
  const piece = newPiece(store, kind, about, {
    ...(note ? { note } : {}),
    ...(kind === 'social' ? { platforms: platforms(input.platforms) } : {}),
    ...(suggestion ? { suggestionId: suggestion.id } : {}),
  });
  if (suggestion) {
    suggestion.status = 'accepted';
    suggestion.decidedAt ??= piece.createdAt;
    (suggestion.pieceIds ??= []).push(piece.id);
  }
  feedEvent(state, actor, `asked herald for ${KIND_LABEL[kind].toLowerCase()} ${piece.id} about ${about.map((a) => a.label).join(', ')}`);
  return piece;
}

/** POST /api/media/pieces/:id/edit: you only, not while herald writes it. An approved piece goes back to review. */
export function editPiece(store: MediaStore, state: MusterState, actor: string, id: string, body: Record<string, any>): MediaPiece {
  requireHuman(actor, 'edit media pieces');
  const piece = requirePiece(store, id);
  if (piece.status === 'drafting') throw conflict(`herald is writing ${piece.id}; edit it when the draft is ready`);
  for (const k of ['claims', 'progress', 'status']) if (body[k] !== undefined) throw badRequest(`${k} can't be edited`);
  applyText(state, piece, body);
  const at = nowIso();
  piece.editedAt = at;
  piece.updatedAt = at;
  if (piece.status === 'approved') {
    piece.status = 'review';
    delete piece.approvedAt;
  }
  return piece;
}

/** POST /api/media/pieces/:id/ask: you only. Adds a request; a finished piece goes back in herald's queue. */
export function askPiece(store: MediaStore, actor: string, id: string, v: unknown): MediaPiece {
  requireHuman(actor, 'ask herald for changes');
  const piece = requirePiece(store, id);
  const request = text(v, 'Your request', MAX_REQUEST);
  const at = nowIso();
  piece.requests.push({ at, from: HUMAN, text: request });
  if (piece.status !== 'drafting' && piece.status !== 'queued') {
    piece.status = 'queued';
    delete piece.approvedAt;
    delete piece.usedAt;
    delete piece.error;
  }
  piece.updatedAt = at;
  return piece;
}

/** POST /api/media/pieces/:id/claims/:cid/confirm: you vouch for an unsourced claim (your own voice). */
export function confirmClaim(store: MediaStore, actor: string, id: string, claimId: string): MediaPiece {
  requireHuman(actor, 'confirm claims');
  const piece = requirePiece(store, id);
  const claim = piece.claims.find((c) => c.id === String(claimId).trim().toUpperCase());
  if (!claim) throw notFound(`${piece.id} has no claim "${claimId}"`);
  if (!claim.sources.some((s) => s.kind === 'opinion')) claim.sources.push({ ...OPINION });
  piece.updatedAt = nowIso();
  return piece;
}

export const unsourced = (piece: MediaPiece) => piece.claims.filter((c) => !c.sources.length);

/** POST /api/media/pieces/:id/approve: you only, a piece in review with every claim sourced or confirmed. */
export function approvePiece(store: MediaStore, state: MusterState, actor: string, id: string): MediaPiece {
  requireHuman(actor, 'approve media pieces');
  const piece = requirePiece(store, id);
  if (piece.status !== 'review') throw conflict(`${piece.id} is ${piece.status}, not waiting for review`);
  const open = unsourced(piece);
  if (open.length) throw conflict(`${piece.id} has ${open.length} claim${open.length === 1 ? '' : 's'} with no source (${open.map((c) => c.id).join(', ')}): confirm ${open.length === 1 ? 'it' : 'them'} or ask herald to cut ${open.length === 1 ? 'it' : 'them'}`);
  piece.status = 'approved';
  piece.approvedAt = piece.updatedAt = nowIso();
  settleNote(state, piece.id);
  return piece;
}

/** POST /api/media/pieces/:id/used: you posted it somewhere. */
export function markUsed(store: MediaStore, state: MusterState, actor: string, id: string): MediaPiece {
  requireHuman(actor, 'mark media pieces used');
  const piece = requirePiece(store, id);
  if (piece.status !== 'approved') throw conflict(`${piece.id} is ${piece.status}; approve it before marking it used`);
  piece.status = 'used';
  piece.usedAt = piece.updatedAt = nowIso();
  settleNote(state, piece.id);
  return piece;
}

/** POST /api/media/pieces/:id/retry: a failed piece goes back in the queue. */
export function retryPiece(store: MediaStore, actor: string, id: string): MediaPiece {
  requireHuman(actor, 'retry media pieces');
  const piece = requirePiece(store, id);
  if (piece.status !== 'failed') throw conflict(`${piece.id} is ${piece.status}, not failed`);
  piece.status = 'queued';
  delete piece.error;
  piece.updatedAt = nowIso();
  return piece;
}

/** DELETE /api/media/pieces/:id: you only. Returns the piece (the caller stops herald when it was drafting it). */
export function deletePiece(store: MediaStore, state: MusterState, actor: string, id: string): MediaPiece {
  requireHuman(actor, 'delete media pieces');
  const piece = requirePiece(store, id);
  store.pieces = store.pieces.filter((p) => p !== piece);
  settleNote(state, piece.id);
  return piece;
}

/** PUT /api/media/style: you only. */
export function setHouseStyle(store: MediaStore, actor: string, v: unknown): string {
  requireHuman(actor, 'change the house style');
  store.houseStyle = text(v, 'House style', MAX_STYLE);
  return store.houseStyle;
}

// ------------------------------------------------------------------ herald

/** The oldest queued piece becomes the one being drafted, unless herald is already on one. Returns the newly started piece. */
export function startNext(store: MediaStore): MediaPiece | undefined {
  if (draftingPiece(store)) return undefined;
  const next = store.pieces.filter((p) => p.status === 'queued').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.createdAt.localeCompare(b.createdAt))[0];
  if (!next) return undefined;
  next.status = 'drafting';
  next.progress = 'starting';
  next.updatedAt = nowIso();
  return next;
}

/** herald exited or was stopped mid-draft: the piece fails (what it saved stays). */
export function failCurrent(store: MediaStore, reason: string): MediaPiece | undefined {
  const piece = draftingPiece(store);
  if (!piece) return undefined;
  piece.status = 'failed';
  piece.error = reason;
  delete piece.progress;
  piece.updatedAt = nowIso();
  return piece;
}

/** POST /api/media/pieces/:id/draft: herald saves part of a draft. */
export function saveDraft(store: MediaStore, state: MusterState, actor: string, id: string, body: Record<string, any>): MediaPiece {
  requireHerald(state, actor, 'save drafts');
  const piece = requirePiece(store, id);
  if (piece.status !== 'drafting') throw conflict(`${piece.id} is ${piece.status}, not being drafted; call media_brief for the current piece`);
  applyText(state, piece, body);
  if (body.claims !== undefined) piece.claims = claims(body.claims);
  if (body.progress !== undefined) piece.progress = text(body.progress, 'progress', MAX_PROGRESS, false) || undefined;
  piece.updatedAt = nowIso();
  return piece;
}

/** What a finished draft lacks, or undefined when it is complete enough for review. */
function missing(piece: MediaPiece): string | undefined {
  if (piece.kind === 'social') {
    if (!piece.posts?.length) return 'no posts yet: save one per platform with media_draft(posts)';
    const without = (piece.platforms ?? []).filter((p) => !piece.posts!.some((x) => x.platform === p));
    if (without.length) return `no post for ${without.join(', ')}`;
  }
  if ((piece.kind === 'article' || piece.kind === 'website') && !piece.sections?.some((s) => s.text.trim())) return 'no sections with text yet';
  if (piece.kind === 'video' && !piece.shots?.length) return 'no shots yet';
  return undefined;
}

/** POST /api/media/pieces/:id/finish: herald only. drafting → review, requests done, and a board note for you. */
export function finishDraft(store: MediaStore, state: MusterState, actor: string, id: string, summary?: unknown): MediaPiece {
  requireHerald(state, actor, 'finish drafts');
  const piece = requirePiece(store, id);
  if (piece.status !== 'drafting') throw conflict(`${piece.id} is ${piece.status}, not being drafted`);
  const gap = missing(piece);
  if (gap) throw conflict(`${piece.id} isn't finished: ${gap}`);
  const wrap = text(summary, 'summary', 1000, false);
  const at = nowIso();
  piece.status = 'review';
  delete piece.progress;
  delete piece.error;
  for (const s of piece.sections ?? []) s.status = 'done';
  for (const r of piece.requests) r.doneAt ??= at;
  piece.updatedAt = at;
  settleNote(state, piece.id);
  const open = unsourced(piece).length;
  const note = postNote(state, {
    actor: findAgent(state, actor) ? actor : SYSTEM,
    type: 'system',
    to: HUMAN,
    topic: 'media',
    text: `${noteTitle(piece)}\n${wrap || `${KIND_LABEL[piece.kind]} ready for your review.`}${open ? ` ${open} claim${open === 1 ? ' needs' : 's need'} a source or your OK.` : ''}`,
  });
  note.open = true;
  delete note.taskId;
  delete note.branch;
  return piece;
}

const noteTitle = (piece: MediaPiece) => `herald finished ${piece.id} · ${piece.title}`;

/** The board note of a piece is settled once it's approved, used, deleted or redrafted. */
function settleNote(state: MusterState, pieceId: string): void {
  const head = `herald finished ${pieceId} ·`;
  for (const n of state.notes as Note[]) {
    if (n.topic !== 'media' || !n.text.startsWith(head) || n.dismissed) continue;
    closeNoteIfOpen(n);
    n.dismissed = true;
  }
}

// ------------------------------------------------------------------ suggestions

function hasSuggestion(store: MediaStore, trigger: MediaSuggestion['trigger'], ref: string): boolean {
  return store.suggestions.some((x) => x.trigger === trigger && x.ref === ref && x.status !== 'dismissed');
}

function addSuggestion(store: MediaStore, input: Omit<MediaSuggestion, 'id' | 'status' | 'createdAt'>): MediaSuggestion {
  const s: MediaSuggestion = { id: `MS${store.nextIds.suggestion++}`, status: 'open', createdAt: nowIso(), ...input };
  store.suggestions.push(s);
  return s;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const evidenceCount = (tasks: Task[]) => tasks.reduce((n, t) => n + (t.evidence ?? []).reduce((m, e) => m + e.files.filter((f) => f.kind === 'image').length, 0), 0);

/** Tasks that deliver a stage (through its goals). */
function stageTasks(state: MusterState, stageId: string): Task[] {
  const goals = new Set(state.roadmap?.goals.filter((g) => g.stageId === stageId).map((g) => g.id));
  return state.tasks.filter((t) => t.goalId && goals.has(t.goalId) && t.status === 'merged');
}

/**
 * Stages completed in the last two weeks without a suggestion get one: an article, a social post and a changelog
 * entry. Called whenever state changes. Returns the new suggestions.
 */
export function syncStageSuggestions(store: MediaStore, state: MusterState, now = Date.now()): MediaSuggestion[] {
  const made: MediaSuggestion[] = [];
  for (const stage of state.roadmap?.stages ?? []) {
    if (stage.status !== 'done' || !stage.completedAt || hasSuggestion(store, 'stage', stage.id)) continue;
    if (now - Date.parse(stage.completedAt) > STAGE_SUGGEST_WINDOW_MS) continue;
    const tasks = stageTasks(state, stage.id);
    const shots = evidenceCount(tasks);
    made.push(
      addSuggestion(store, {
        trigger: 'stage',
        ref: stage.id,
        title: `${stage.title} is done`,
        summary: `Article + social post + a changelog entry. Built from ${plural(tasks.length, 'merged task')}${shots ? ` and ${plural(shots, 'screenshot')}` : ''}.`,
        plan: [{ kind: 'article' }, { kind: 'social', platforms: ['x', 'linkedin', 'bluesky'] }, { kind: 'website' }],
        about: [{ kind: 'stage', ref: stage.id, label: `Stage ${stage.id} · ${stage.title}` }],
      }),
    );
  }
  return made;
}

/** POST /api/media/suggestions (suggest_media): the Captain flags a merged, user-visible feature. */
export function suggestFeature(store: MediaStore, state: MusterState, actor: string, input: { task: unknown; title: unknown; why: unknown }): MediaSuggestion {
  if (!isCaptain(state, actor)) throw forbidden('Only the Captain suggests media for a feature');
  const id = text(input.task, 'task', 20).toUpperCase();
  const task = state.tasks.find((t) => t.id === id);
  if (!task) throw notFound(`No task "${input.task}"`);
  if (task.status !== 'merged') throw conflict(`${task.id} is ${task.status}; suggest media once it has merged`);
  const title = text(input.title, 'title', MAX_TITLE);
  const why = text(input.why, 'why', 600);
  if (hasSuggestion(store, 'feature', task.id)) throw conflict(`${task.id} already has a media suggestion`);
  return addSuggestion(store, {
    trigger: 'feature',
    ref: task.id,
    title,
    summary: `Social posts for X and LinkedIn, plus a section for the website. ${why}`.slice(0, 600),
    plan: [{ kind: 'social', platforms: ['x', 'linkedin'] }, { kind: 'website' }],
    about: [{ kind: 'task', ref: task.id, label: `${task.id} ${task.title}` }],
  });
}

/** ISO week of a date (local time): its label "2026-W40" and its Monday 00:00 / next Monday 00:00. */
export function isoWeek(d: Date): { label: string; start: Date; end: Date } {
  const day = (d.getDay() + 6) % 7; // Monday = 0
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  const thursday = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 3);
  const jan4 = new Date(thursday.getFullYear(), 0, 4);
  const week1 = new Date(jan4.getFullYear(), 0, 4 - ((jan4.getDay() + 6) % 7));
  const week = 1 + Math.round((thursday.getTime() - week1.getTime()) / (7 * 24 * 3600_000));
  return { label: `${thursday.getFullYear()}-W${String(week).padStart(2, '0')}`, start, end };
}

const dayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * The week that just ended (Mon–Sun) is considered once (lastWeekly): with at least WEEKLY_MIN_MERGED merged tasks it
 * gets a roundup suggestion (an article and a video script). Returns it, or undefined. Startup and hourly.
 */
export function weeklyCheck(store: MediaStore, state: MusterState, now = new Date()): MediaSuggestion | undefined {
  const thisWeek = isoWeek(now);
  const last = isoWeek(new Date(thisWeek.start.getTime() - 24 * 3600_000));
  if (store.lastWeekly === last.label) return undefined;
  store.lastWeekly = last.label;
  const merged = state.tasks.filter((t) => {
    const at = mergedAt(t);
    const ms = at ? Date.parse(at) : NaN;
    return ms >= last.start.getTime() && ms < last.end.getTime();
  });
  if (merged.length < WEEKLY_MIN_MERGED || hasSuggestion(store, 'weekly', last.label)) return undefined;
  const from = dayOf(last.start);
  const to = dayOf(new Date(last.end.getTime() - 24 * 3600_000));
  return addSuggestion(store, {
    trigger: 'weekly',
    ref: last.label,
    title: `Week ${Number(last.label.slice(6))}: ${plural(merged.length, 'task')} merged`,
    summary: `A devlog article and a 60-second video script. Herald only suggests a roundup in weeks with ${WEEKLY_MIN_MERGED} or more merged tasks.`,
    plan: [{ kind: 'article' }, { kind: 'video' }],
    about: [{ kind: 'range', ref: `${from}..${to}`, label: `Merged ${shortDay(from)} – ${shortDay(to)}` }],
  });
}

/** POST /api/media/suggestions/:id/accept (Write it): one queued piece per plan item. */
export function acceptSuggestion(store: MediaStore, state: MusterState, actor: string, id: string): MediaPiece[] {
  requireHuman(actor, 'accept suggestions');
  const s = requireSuggestion(store, id);
  if (s.status !== 'open') throw conflict(`${s.id} is already ${s.status}`);
  const pieces = s.plan.map((p) =>
    newPiece(store, p.kind, s.about.map((a) => ({ ...a })), {
      suggestionId: s.id,
      ...(p.kind === 'social' ? { platforms: [...(p.platforms ?? DEFAULT_PLATFORMS)] } : {}),
    }),
  );
  s.status = 'accepted';
  s.decidedAt = nowIso();
  s.pieceIds = [...(s.pieceIds ?? []), ...pieces.map((p) => p.id)];
  feedEvent(state, actor, `asked herald to write ${s.id}: ${pieces.map((p) => `${p.id} (${KIND_LABEL[p.kind].toLowerCase()})`).join(', ')}`);
  return pieces;
}

export function dismissSuggestion(store: MediaStore, actor: string, id: string): MediaSuggestion {
  requireHuman(actor, 'dismiss suggestions');
  const s = requireSuggestion(store, id);
  if (s.status !== 'open') throw conflict(`${s.id} is already ${s.status}`);
  s.status = 'dismissed';
  s.decidedAt = nowIso();
  return s;
}

export function dismissAllSuggestions(store: MediaStore, actor: string): number {
  requireHuman(actor, 'dismiss suggestions');
  const open = store.suggestions.filter((x) => x.status === 'open');
  const at = nowIso();
  for (const s of open) {
    s.status = 'dismissed';
    s.decidedAt = at;
  }
  return open.length;
}

// ------------------------------------------------------------------ brief

/** The tasks a piece is about: named tasks, the tasks of named goals/stages, and tasks merged in a range. */
export function aboutTasks(state: MusterState, about: MediaAbout[]): Task[] {
  const out = new Map<string, Task>();
  const goals = state.roadmap?.goals ?? [];
  for (const a of about) {
    if (a.kind === 'task') {
      const t = state.tasks.find((x) => x.id === a.ref);
      if (t) out.set(t.id, t);
    } else if (a.kind === 'goal' || a.kind === 'stage') {
      const ids = new Set(a.kind === 'goal' ? [a.ref] : goals.filter((g) => g.stageId === a.ref).map((g) => g.id));
      for (const t of state.tasks) if (t.goalId && ids.has(t.goalId) && t.status === 'merged') out.set(t.id, t);
    } else if (a.kind === 'range') {
      const [from, to] = a.ref.split('..');
      for (const t of state.tasks) {
        const at = mergedAt(t);
        if (!at) continue;
        const day = dayOf(new Date(at));
        if (day >= from && day <= to) out.set(t.id, t);
      }
    }
  }
  return [...out.values()];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** GET /api/media/brief: what herald works from for the piece it is drafting. `evidenceFile` gives absolute paths. */
export function mediaBrief(store: MediaStore, state: MusterState, opts: { intel?: IntelStore; evidenceFile?: (task: Task, entryId: string, name: string) => string; userName?: string; projectName?: string } = {}): string {
  const piece = draftingPiece(store);
  if (!piece) return 'No piece is being drafted. You are done; stop here.';
  const L: string[] = [];
  const who = opts.userName?.trim() || 'the user';
  L.push(`# ${piece.id} · ${KIND_LABEL[piece.kind]}${opts.projectName ? ` for ${opts.projectName}` : ''}`);
  L.push(`Working title: ${piece.title}`);
  if (piece.kind === 'social') L.push(`Platforms: ${(piece.platforms ?? DEFAULT_PLATFORMS).map((p) => `${p} (≤ ${PLATFORM_LIMITS[p]} chars)`).join(', ')}`);
  if (piece.kind === 'website') L.push(`Target page: ${piece.target ?? '(suggest one, e.g. /features/moderation or /changelog)'}`);
  L.push(`About: ${piece.about.map((a) => a.label).join('; ')}`);
  if (piece.note) L.push(`Note from ${who}: ${piece.note}`);
  const open = piece.requests.filter((r) => !r.doneAt);
  if (open.length) {
    L.push('', `## Change requests from ${who} (do these now; keep everything else)`);
    for (const r of open) L.push(`- ${r.text}`);
  }
  if (piece.posts?.length || piece.sections?.length || piece.shots?.length) L.push('', 'There is already a draft (edited by you or by the user). Read it with the fields below and change only what the requests ask for.');
  for (const p of piece.posts ?? []) p.versions.forEach((v, i) => L.push(`[${p.platform} ${String.fromCharCode(65 + i)}${i === p.chosen ? ', chosen' : ''}] ${v}`));
  for (const s of piece.sections ?? []) L.push(`[${s.id} ${s.heading || '(no heading)'}] ${clip(s.text, 600)}`);

  L.push('', '## House style', store.houseStyle);

  const goals = state.roadmap?.goals ?? [];
  const stages = state.roadmap?.stages ?? [];
  L.push('', '## What happened (only write about this)');
  for (const a of piece.about) {
    if (a.kind === 'stage') {
      const s = stages.find((x) => x.id === a.ref);
      if (s) L.push(`Stage ${s.id} ${s.title} (${s.status}${s.completedAt ? `, done ${s.completedAt.slice(0, 10)}` : ''}): ${s.description}`);
      for (const g of goals.filter((x) => x.stageId === a.ref)) L.push(`  Goal ${g.id} ${g.title} (${g.status}): ${clip(g.description, 300)}`);
    } else if (a.kind === 'goal') {
      const g = goals.find((x) => x.id === a.ref);
      if (g) L.push(`Goal ${g.id} ${g.title} (${g.status}): ${g.description}`);
    } else if (a.kind === 'idea') {
      const i = state.research?.ideas.find((x) => x.id === a.ref);
      if (i) L.push(`Idea ${i.id} ${i.title}: ${i.summary}${i.evidence.length ? ` Evidence: ${i.evidence.map((e) => e.source).join('; ')}` : ''}`);
    }
  }
  const tasks = aboutTasks(state, piece.about);
  if (!tasks.length) L.push('No merged tasks match yet. Write only what the roadmap says, and say it is planned or in progress.');
  for (const t of tasks) {
    L.push(`Task ${t.id} ${t.title} (${t.status}${mergedAt(t) ? `, merged ${mergedAt(t)!.slice(0, 10)}` : ''}): ${clip(t.description.replace(/\s+/g, ' '), 500)}`);
    for (const e of t.evidence ?? []) {
      L.push(`  Evidence ${t.id}/${e.id}: ${clip(e.summary, 200)}`);
      for (const f of e.files) L.push(`    ${t.id}/${e.id} · ${f.name} (${f.kind})${opts.evidenceFile ? ` · ${safePath(opts.evidenceFile, t, e.id, f.name)}` : ''}`);
    }
  }

  const ideas = (state.research?.ideas ?? []).filter((i) => i.origin === 'intel' && i.status !== 'rejected');
  const insights = opts.intel?.insights ?? [];
  if (ideas.length || insights.length) {
    L.push('', '## Intel (competitors; use only if it relates, and cite it)');
    for (const i of insights.slice(0, 12)) L.push(`- intel ${i.id} (${i.kind}): ${i.title}`);
    for (const i of ideas.slice(0, 12)) L.push(`- idea ${i.id}${i.opportunity ? ` (${i.opportunity.kind})` : ''}: ${i.title}`);
  }

  const ids = new Set(tasks.map((t) => t.id));
  const chat = state.feed.filter((f) => f.kind !== 'event' && ((f.taskId && ids.has(f.taskId)) || [...ids].some((id) => new RegExp(`\\b${id}\\b`).test(f.text)))).slice(-40);
  if (chat.length) {
    L.push('', '## Crew chat about these tasks (cite as chat with the F-id)');
    for (const f of chat) L.push(`${f.id} ${f.at.slice(0, 10)} ${f.from}: ${clip(f.text.replace(/\s+/g, ' '), 240)}`);
  }

  L.push('', '## Rules');
  L.push('- Plain text only: no Markdown, no HTML, no emoji headings. Headings are plain text.');
  L.push('- Every factual sentence needs a claim: {quote: the words as they appear, sources: [{kind: task|stage|goal|idea|intel|chat|evidence, ref: "T38" / "M3" / "F120" / "T38/E2", label: "T38 merged"}]}.');
  L.push(`- Anything you can't source: leave it out, or record it as a claim with sources: [] so ${who} can confirm it. Never invent numbers, quotes or users.`);
  L.push('- Save often with media_draft. Write a title first, then the body piece by piece, with progress ("writing section 3 of 5").');
  if (piece.kind === 'social') L.push('- Social: 3 versions per platform, each within its limit. Attach 1–3 evidence images that show the feature (images: taskId, evidenceId, name, caption). Open screenshots with Read to choose.');
  if (piece.kind === 'article') L.push('- Article: 4–6 sections with plain headings, about 800–1,500 words. Mark sections todo/writing/done as you go.');
  if (piece.kind === 'website') L.push('- Website: a target path plus sections (hero line, feature blocks, FAQ or changelog entries). Short, scannable.');
  if (piece.kind === 'video') L.push('- Video: 3 opening hooks, then a shot table (at "0:04", shot, voiceover, onScreen). Use evidence screenshots where they exist (evidence: taskId, evidenceId, name); set record: true where someone has to film it. About 60 seconds unless asked.');
  L.push('- When done, call media_finish. Never post anything, push, edit files or claim tasks.');
  return L.join('\n');
}

function safePath(fn: (task: Task, entryId: string, name: string) => string, task: Task, entryId: string, name: string): string {
  try {
    return fn(task, entryId, name);
  } catch {
    return '(file missing)';
  }
}

/** What a piece is called in the Captain's inbox and the feed. */
export const pieceLabel = (piece: MediaPiece) => `${piece.id} ${KIND_LABEL[piece.kind].toLowerCase()} "${clip(piece.title, 60)}"`;

