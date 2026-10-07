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
  MediaGif,
  MediaGifFile,
  MediaGifFrame,
  MediaImage,
  MediaKind,
  MediaPiece,
  MediaPlatform,
  MediaPurpose,
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
import { addInbox, captainOf, closeNoteIfOpen, feedEvent, findAgent, HUMAN, isCaptain, nowIso, postNote, SYSTEM } from './board.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import type { MusterPaths } from './paths.js';
import { writeAtomic, type StoreOptions } from './store.js';

/** herald's id: there is only ever one media agent. */
export const HERALD_ID = 'herald';
export const MEDIA_KINDS: readonly MediaKind[] = ['social', 'article', 'website', 'video', 'gif'];
export const PLATFORMS: readonly MediaPlatform[] = ['x', 'linkedin', 'facebook', 'instagram', 'bluesky', 'threads'];
/** Character limits the UI warns about (never rejected: a long LinkedIn post is fine). */
export const PLATFORM_LIMITS: Record<MediaPlatform, number> = { x: 280, linkedin: 3000, facebook: 5000, instagram: 2200, bluesky: 300, threads: 500 };
/** How many hashtags each platform's posts carry (herald follows it; the UI only warns). */
export const HASHTAG_RULE: Record<MediaPlatform, readonly [number, number]> = { x: [1, 2], linkedin: [3, 5], facebook: [1, 3], instagram: [5, 10], threads: [1, 1], bluesky: [1, 2] };
export const MAX_HASHTAGS = 30;
const HASHTAG_RE = /^[A-Za-z0-9_]{1,50}$/;
export const DEFAULT_PLATFORMS: MediaPlatform[] = ['x', 'linkedin', 'facebook'];
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
const MAX_FRAMES = 12;
const MAX_CAPTION = 60;
const MAX_STEPS = 12;
const MAX_STEP = 200;
const MAX_ALT = 400;
const MAX_GIFS = 3;
/** Image kinds ffmpeg reads as a still frame. */
const FRAME_EXT = /\.(png|jpe?g|webp|gif)$/i;
/** A stage that completed longer ago than this gets no suggestion (so old stages don't flood the page on first run). */
const STAGE_SUGGEST_WINDOW_MS = 14 * 24 * 3600_000;
/** A weekly roundup is suggested only for weeks with at least this many merged tasks. */
export const WEEKLY_MIN_MERGED = 5;

const KIND_LABEL: Record<MediaKind, string> = { social: 'Social post', article: 'Article', website: 'Website', video: 'Video script', gif: 'Demo GIF' };
const CLAIM_KINDS: readonly MediaClaimSource['kind'][] = ['task', 'stage', 'goal', 'idea', 'intel', 'chat', 'evidence', 'readme', 'opinion'];
const ABOUT_KINDS: readonly MediaAbout['kind'][] = ['stage', 'goal', 'task', 'idea', 'range', 'product'];
export const PURPOSES: readonly MediaPurpose[] = ['progress', 'announce', 'testers', 'launch'];
const MAX_LINK = 300;
export const PRODUCT_LABEL = 'The whole product';
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
  if (s.conversations !== undefined && !Array.isArray(s.conversations)) s.conversations = [];
  if (s.publish !== undefined && !Array.isArray(s.publish)) s.publish = [];
  if (s.conversations?.length) n.conversation = Math.max(n.conversation ?? 1, above(s.conversations.map((c) => c.id)));
  if (s.publish?.length) n.publish = Math.max(n.publish ?? 1, above(s.publish.map((j) => j.id)));
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
    conversations: (store.conversations ?? []).filter((c) => c.status === 'draft').length,
    publishReady: (store.publish ?? []).filter((j) => j.status === 'ready').length,
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

export function requireHuman(actor: string, what: string): void {
  if (actor !== HUMAN) throw forbidden(`Only you can ${what}`);
}

export function requireHerald(state: MusterState, actor: string, what: string): void {
  if (!isHerald(state, actor)) throw forbidden(`Only herald (the media agent) can ${what}`);
}

/** When a task merged (its last 'merged' history event), or undefined. */
export function mergedAt(task: Task): string | undefined {
  if (task.status !== 'merged') return undefined;
  for (let i = task.history.length - 1; i >= 0; i--) if (task.history[i].kind === 'merged') return task.history[i].at;
  return task.updatedAt;
}

// ------------------------------------------------------------------ validation

export const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

export function text(v: unknown, what: string, max: number, required = true): string {
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

export function list(v: unknown, what: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(v)) throw badRequest(`${what} must be a list`);
  if (v.length > max) throw badRequest(`${what}: at most ${max}`);
  if (v.length < min) throw badRequest(`${what}: at least ${min}`);
  return v;
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
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
  if (kind === 'product') return { kind, ref: 'product', label: PRODUCT_LABEL };
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
    const tags = raw.hashtags === undefined || raw.hashtags === null ? undefined : hashtags(raw.hashtags, `posts[${i}].hashtags`);
    return { platform, versions, chosen, ...(tags?.length ? { hashtags: tags } : {}) };
  });
}

/** Hashtags as stored: no "#", letters/digits/underscore, no repeats (case-insensitive). */
export function hashtags(v: unknown, what = 'hashtags'): string[] {
  const out: string[] = [];
  for (const [i, raw] of list(v, what, MAX_HASHTAGS).entries()) {
    const tag = text(raw, `${what}[${i}]`, 51).replace(/^#/, '');
    if (!HASHTAG_RE.test(tag)) throw badRequest(`${what}[${i}] "${tag}" isn't a hashtag: letters, digits and _ only, up to 50`);
    if (!out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  return out;
}

/** What gets copied or posted: the chosen version, then the hashtags on their own line. */
export function fullText(post: MediaPost): string {
  const body = post.versions[post.chosen] ?? post.versions[0] ?? '';
  return post.hashtags?.length ? `${body}

${post.hashtags.map((t) => `#${t}`).join(' ')}` : body;
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

export function claims(v: unknown): MediaClaim[] {
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

function frames(state: MusterState, v: unknown): MediaGifFrame[] {
  return list(v, 'gif.frames', MAX_FRAMES).map((raw, i) => {
    if (!isObj(raw)) throw badRequest(`gif.frames[${i}] must be an object`);
    const taskId = text(raw.taskId, `gif.frames[${i}].taskId`, 20).toUpperCase();
    const evidenceId = text(raw.evidenceId, `gif.frames[${i}].evidenceId`, 20).toUpperCase();
    const name = text(raw.name, `gif.frames[${i}].name`, 260);
    const task = state.tasks.find((t) => t.id === taskId);
    const entry = task?.evidence?.find((e) => e.id === evidenceId);
    if (!entry || !entry.files.some((f) => f.name === name)) throw badRequest(`No evidence file ${taskId}/${evidenceId}/${name}`);
    if (!FRAME_EXT.test(name)) throw badRequest(`gif.frames[${i}]: ${name} is not an image (png, jpg, webp or gif)`);
    const seconds = raw.seconds === undefined ? 2.5 : raw.seconds;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0.5 || seconds > 8) throw badRequest(`gif.frames[${i}].seconds must be a number from 0.5 to 8`);
    return { taskId, evidenceId, name, caption: text(raw.caption, `gif.frames[${i}].caption`, MAX_CAPTION, false), seconds: Math.round(seconds * 10) / 10 };
  });
}

/** gif: {source?, frames?, steps?, altText?} merged into the piece's MediaGif. Returns whether the frames changed. */
function applyGif(state: MusterState, piece: MediaPiece, v: unknown): boolean {
  if (!isObj(v)) throw badRequest('gif must be an object');
  for (const k of Object.keys(v)) if (!['source', 'frames', 'steps', 'altText'].includes(k)) throw badRequest(`gif.${k} can't be set`);
  const gif = (piece.gif ??= emptyGif());
  const before = JSON.stringify(gif.frames);
  if (v.frames !== undefined) gif.frames = frames(state, v.frames);
  if (v.steps !== undefined) gif.steps = list(v.steps, 'gif.steps', MAX_STEPS).map((t, i) => text(t, `step ${i + 1}`, MAX_STEP));
  if (v.altText !== undefined) gif.altText = text(v.altText, 'gif.altText', MAX_ALT, false);
  if (v.source !== undefined) {
    const source = oneOf(v.source, ['slideshow', 'recording'] as const, 'gif.source');
    if (source === 'recording' && !gif.recording?.file) throw conflict(`${piece.id} has no recording yet`);
    gif.source = source;
  }
  return JSON.stringify(gif.frames) !== before;
}

/** gifIds on a social post: demo GIF pieces that are in review, approved or used. */
function gifIds(store: MediaStore, v: unknown): string[] {
  return [...new Set(list(v, 'gifIds', MAX_GIFS).map((x, i) => text(x, `gifIds[${i}]`, 20).toUpperCase()))].map((id) => {
    const g = store.pieces.find((p) => p.id === id);
    if (!g || g.kind !== 'gif') throw badRequest(`${id} is not a demo GIF piece`);
    if (!['review', 'approved', 'used'].includes(g.status)) throw badRequest(`${id} is ${g.status}; attach a demo GIF once herald has finished it`);
    return id;
  });
}

export const emptyGif = (): MediaGif => ({ source: 'slideshow', frames: [], steps: [], altText: '' });

/** The text fields both you (edit) and herald (draft) may set, validated for the piece's kind. Returns whether the GIF frames changed (re-render). */
function applyText(store: MediaStore, state: MusterState, piece: MediaPiece, body: Record<string, any>): boolean {
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
  only('gif', ['gif']);
  only('gifIds', ['social']);
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
  if (body.gifIds !== undefined) piece.gifIds = gifIds(store, body.gifIds);
  return body.gif !== undefined && applyGif(state, piece, body.gif);
}

// ------------------------------------------------------------------ pieces (you)

export interface PieceInput {
  kind: unknown;
  about: unknown;
  note?: unknown;
  platforms?: unknown;
  suggestionId?: unknown;
  purpose?: unknown; // MediaPurpose; absent = progress
  link?: unknown;
}

/** An optional http(s) link, as typed (400 when it isn't one). */
function link(v: unknown): string {
  const t = text(v, 'link', MAX_LINK, false);
  if (t && !/^https?:\/\/[^\s]+$/i.test(t)) throw badRequest('link must start with http:// or https:// and have no spaces');
  return t;
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
    ...(kind === 'gif' ? { gif: emptyGif() } : {}),
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
  const purpose = input.purpose === undefined || input.purpose === null || input.purpose === '' ? 'progress' : oneOf(input.purpose, PURPOSES, 'purpose');
  const url = link(input.link);
  const suggestion = input.suggestionId === undefined || input.suggestionId === null || input.suggestionId === '' ? undefined : requireSuggestion(store, String(input.suggestionId));
  if (suggestion && suggestion.status === 'dismissed') throw conflict(`${suggestion.id} was dismissed`);
  const piece = newPiece(store, kind, about, {
    ...(note ? { note } : {}),
    ...(purpose !== 'progress' ? { purpose } : {}),
    ...(url ? { link: url } : {}),
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
  applyText(store, state, piece, body);
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
  if (piece.kind === 'gif' && !currentGifFile(piece)) throw conflict(`${piece.id} has no GIF yet${piece.gif?.renderError ? ` (${piece.gif.renderError})` : '; it is still rendering'}`);
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
  const at = nowIso();
  for (const j of store.publish ?? []) {
    if (j.pieceId !== piece.id || !['queued', 'filling', 'ready', 'signin'].includes(j.status)) continue;
    j.status = 'cancelled';
    j.updatedAt = at;
  }
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
  applyText(store, state, piece, body);
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
  if (piece.kind === 'gif') {
    if (!piece.gif?.frames.length) return 'no frames yet: save gif.frames (evidence screenshots with captions)';
    if (!piece.gif.steps.length) return 'no demo steps yet: save gif.steps';
    if (!piece.gif.altText.trim()) return 'no alt text yet: save gif.altText';
  }
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
export function settleNote(state: MusterState, pieceId: string): void {
  const heads = [`herald finished ${pieceId} ·`, `Demo recording ready for ${pieceId} ·`];
  for (const n of state.notes as Note[]) {
    if (n.topic !== 'media' || !heads.some((h) => n.text.startsWith(h)) || n.dismissed) continue;
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
    summary: `Social posts for X and LinkedIn, a section for the website and a demo GIF. ${why}`.slice(0, 600),
    plan: [{ kind: 'social', platforms: ['x', 'linkedin'] }, { kind: 'website' }, { kind: 'gif' }],
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

const PURPOSE_TEXT: Record<MediaPurpose, string> = {
  progress: 'a progress update for people following along',
  announce: 'announce that a new product is coming',
  testers: 'find early testers',
  launch: 'it is out now: launch it',
};

const PURPOSE_RULE: Record<MediaPurpose, string> = {
  progress: 'Progress update: what is new and why it matters to the people who use it.',
  announce: 'Announcement: a new product is coming. Lead with the problem it solves and what people will be able to do, then how to follow along (the link if there is one). Nothing is available yet unless the brief says it works today.',
  testers: 'Finding testers: invite people to try it early. Say who it is for, what testers get to do, and what you ask of them (try it, tell you what breaks). End with how to sign up: the link if there is one, else ask them to reply or message.',
  launch: 'Launch: it is available now. Say what it does, who it is for, and where to get it (the link if there is one).',
};

/** The tasks a piece is about: named tasks, the tasks of named goals/stages, and tasks merged in a range. */
export function aboutTasks(state: MusterState, about: MediaAbout[]): Task[] {
  const out = new Map<string, Task>();
  const goals = state.roadmap?.goals ?? [];
  for (const a of about) {
    if (a.kind === 'product') {
      for (const t of state.tasks) if (t.status === 'merged') out.set(t.id, t);
    } else if (a.kind === 'task') {
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

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** GET /api/media/brief: what herald works from for the piece it is drafting. `evidenceFile` gives absolute paths. */
export function mediaBrief(store: MediaStore, state: MusterState, opts: { intel?: IntelStore; evidenceFile?: (task: Task, entryId: string, name: string) => string; userName?: string; projectName?: string; readme?: string } = {}): string {
  const piece = draftingPiece(store);
  if (!piece) return 'No piece is being drafted. You are done; stop here.';
  const L: string[] = [];
  const who = opts.userName?.trim() || 'the user';
  L.push(`# ${piece.id} · ${KIND_LABEL[piece.kind]}${opts.projectName ? ` for ${opts.projectName}` : ''}`);
  L.push(`Working title: ${piece.title}`);
  if (piece.kind === 'social') L.push(`Platforms: ${(piece.platforms ?? DEFAULT_PLATFORMS).map((p) => `${p} (≤ ${PLATFORM_LIMITS[p]} chars with hashtags, ${HASHTAG_RULE[p][0] === HASHTAG_RULE[p][1] ? HASHTAG_RULE[p][0] : HASHTAG_RULE[p].join('–')} hashtag${HASHTAG_RULE[p][1] === 1 ? '' : 's'})`).join(', ')}`);
  if (piece.kind === 'website') L.push(`Target page: ${piece.target ?? '(suggest one, e.g. /features/moderation or /changelog)'}`);
  L.push(`About: ${piece.about.map((a) => a.label).join('; ')}`);
  const purpose = piece.purpose ?? 'progress';
  L.push(`Purpose: ${PURPOSE_TEXT[purpose]}`);
  if (piece.link) L.push(`Link: ${piece.link} (put it in the text exactly like this)`);
  const product = piece.about.some((a) => a.kind === 'product');
  if (piece.note) L.push(`Note from ${who}: ${piece.note}`);
  const open = piece.requests.filter((r) => !r.doneAt);
  if (open.length) {
    L.push('', `## Change requests from ${who} (do these now; keep everything else)`);
    for (const r of open) L.push(`- ${r.text}`);
  }
  if (piece.posts?.length || piece.sections?.length || piece.shots?.length || piece.gif?.frames.length) L.push('', 'There is already a draft (edited by you or by the user). Read it with the fields below and change only what the requests ask for.');
  for (const p of piece.posts ?? []) p.versions.forEach((v, i) => L.push(`[${p.platform} ${String.fromCharCode(65 + i)}${i === p.chosen ? ', chosen' : ''}] ${v}`));
  for (const s of piece.sections ?? []) L.push(`[${s.id} ${s.heading || '(no heading)'}] ${clip(s.text, 600)}`);
  if (piece.gif?.frames.length) piece.gif.frames.forEach((f, i) => L.push(`[frame ${i + 1}] ${f.taskId}/${f.evidenceId} · ${f.name} · ${f.seconds}s · "${f.caption}"`));
  if (piece.gif?.steps.length) piece.gif.steps.forEach((t, i) => L.push(`[step ${i + 1}] ${t}`));

  L.push('', '## House style', store.houseStyle);

  const goals = state.roadmap?.goals ?? [];
  const stages = state.roadmap?.stages ?? [];
  L.push('', '## What happened (only write about this)');
  if (product) {
    const name = opts.projectName || 'the product';
    L.push(`The whole product: ${name}. What it is and does, from the README, the roadmap and everything merged so far.`);
    if (opts.readme?.trim()) L.push('', 'README (cite it as {kind: "readme", ref: "README.md", label: "README"}):', clip(opts.readme.trim(), 4000), '');
    for (const st of stages) {
      L.push(`Stage ${st.id} ${st.title} (${st.status === 'done' ? 'works today' : st.status === 'active' ? 'being built now' : 'planned'}): ${clip(st.description, 300)}`);
      for (const g of goals.filter((x) => x.stageId === st.id)) L.push(`  Goal ${g.id} ${g.title} (${g.status === 'done' ? 'works today' : 'not ready yet'})`);
    }
  }
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
  // The whole product can be hundreds of tasks: newest 60, shorter, and only the first 30 evidence files.
  const shown = product ? [...tasks].sort((a, b) => (mergedAt(b) ?? '').localeCompare(mergedAt(a) ?? '')).slice(0, 60) : tasks;
  if (shown.length < tasks.length) L.push(`(${tasks.length} merged tasks; the newest ${shown.length} are listed.)`);
  let files = 0;
  for (const t of shown) {
    L.push(`Task ${t.id} ${t.title} (${t.status}${mergedAt(t) ? `, merged ${mergedAt(t)!.slice(0, 10)}` : ''}): ${clip(t.description.replace(/\s+/g, ' '), product ? 200 : 500)}`);
    if (product && files >= 30) continue;
    for (const e of t.evidence ?? []) {
      files += e.files.length;
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
  L.push('- Never put internal ids or words in the text: no stage, goal, task, idea or chat ids (M3, G4, T38, R12, F120), no "roadmap", "stage", "milestone", "crew", "Muster", "merged" or branch names. Readers only care what they can do. Ids belong in claim sources only.');
  if (product)
    L.push(
      `- Whole product: write for people who have never heard of ${opts.projectName || 'it'}. Say what it is, who it is for and what they can do with it, in plain words, grouped by what people do (not by how it was built). Say clearly what works today and what is coming; never present planned work as ready.`,
    );
  L.push(`- ${PURPOSE_RULE[purpose]}`);
  L.push('- Every factual sentence needs a claim: {quote: the words as they appear, sources: [{kind: task|stage|goal|idea|intel|chat|evidence|readme, ref: "T38" / "M3" / "F120" / "T38/E2", label: "T38 merged"}]}.');
  L.push(`- Anything you can't source: leave it out, or record it as a claim with sources: [] so ${who} can confirm it. Never invent numbers, quotes or users.`);
  L.push('- Save often with media_draft. Write a title first, then the body piece by piece, with progress ("writing section 3 of 5").');
  if (piece.kind === 'social') {
    L.push('- Social: 3 versions per platform, each within its limit. Attach 1–3 evidence images that show the feature (images: taskId, evidenceId, name, caption). Open screenshots with Read to choose.');
    L.push('- Hashtags: posts[].hashtags per platform (no "#"), as many as the platform line says, picked from the research hashtags when there are any. The limit counts the hashtags too: version + blank line + "#tag #tag". Instagram needs an image.');
    if (!piece.research)
      L.push('- Research first: before writing, look at what is being said about this on each platform and in recent articles (the browse tool for the search page of each platform, web search for articles), then save it with media_research. Use it: open with what people care about, pick hashtags people actually use, and add up to 6 media_conversations where a reply from the user would really help.');
    else {
      const r = piece.research;
      L.push(`- Research (${r.at.slice(0, 10)}): themes ${r.themes.map((t) => `"${t.text}" ×${t.count}`).join('; ') || 'none'}; hashtags in use ${r.hashtags.map((h) => `#${h.tag} (${h.platforms.join('/')})`).join(' ') || 'none'}. Build on it and keep research.used up to date with media_research when it changes how you write.`);
    }
    L.push('- No good screenshot? You may design a post image in Vellum (see the design steps in your prompt) and attach it with media_designs.');
  }
  if (piece.kind === 'article') L.push('- Article: 4–6 sections with plain headings, about 800–1,500 words. Mark sections todo/writing/done as you go.');
  if (piece.kind === 'website') L.push('- Website: a target path plus sections (hero line, feature blocks, FAQ or changelog entries). Short, scannable.');
  if (piece.kind === 'video') L.push('- Video: 3 opening hooks, then a shot table (at "0:04", shot, voiceover, onScreen). Use evidence screenshots where they exist (evidence: taskId, evidenceId, name); set record: true where someone has to film it. About 60 seconds unless asked.');
  if (piece.kind === 'gif')
    L.push(
      '- Demo GIF: open the evidence screenshots with Read and pick 2–6 that really show the feature, in the order a user would see it. Save gif.frames (taskId, evidenceId, name, caption ≤ 60 chars, seconds 1.5–4). Also save gif.steps (3–8 steps to demo it for real with sample data, never real users) and gif.altText (one or two sentences describing what the GIF shows). Muster renders the GIF after you finish. No screenshot shows it? Use the closest ones, say so in your summary, and the user can ask for a real recording.',
    );
  if (piece.kind === 'social') {
    const gifs = store.pieces.filter((p) => p.kind === 'gif' && ['review', 'approved', 'used'].includes(p.status) && p.about.some((a) => piece.about.some((b) => b.kind === a.kind && b.ref === a.ref)));
    if (gifs.length) L.push(`- Demo GIFs about the same work: ${gifs.map((g) => `${g.id} "${g.title}"`).join(', ')}. Attach one with gifIds when it fits the post better than a still.`);
  }
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


// ------------------------------------------------------------------ demo GIF (rendering: core/mediagif.ts)

/** The GIF file the piece currently uses (slideshow or recording), if it has been made. */
export function currentGifFile(piece: MediaPiece): MediaGifFile | undefined {
  const gif = piece.gif;
  if (!gif) return undefined;
  return gif.source === 'recording' ? gif.recording?.file : gif.slideshow;
}

function requireGif(store: MediaStore, id: string): MediaPiece & { gif: MediaGif } {
  const piece = requirePiece(store, id);
  if (piece.kind !== 'gif') throw badRequest(`${piece.id} is a ${KIND_LABEL[piece.kind].toLowerCase()}, not a demo GIF`);
  piece.gif ??= emptyGif();
  return piece as MediaPiece & { gif: MediaGif };
}

/** The slideshow finished rendering (or failed). Undefined when the piece was deleted meanwhile. The caller commits. */
export function setSlideshow(store: MediaStore, id: string, result: { file: MediaGifFile } | { error: string }): MediaPiece | undefined {
  const piece = store.pieces.find((p) => p.id === id && p.kind === 'gif');
  if (!piece) return undefined;
  const gif = (piece.gif ??= emptyGif());
  if ('file' in result) {
    gif.slideshow = result.file;
    delete gif.renderError;
  } else gif.renderError = result.error.slice(0, 400);
  return piece;
}

/** POST /api/media/pieces/:id/record: you ask for a real recording; the Captain gets the steps in its inbox. */
export function requestRecording(store: MediaStore, state: MusterState, actor: string, id: string): MediaPiece {
  requireHuman(actor, 'ask for demo recordings');
  const piece = requireGif(store, id);
  if (piece.status === 'queued' || piece.status === 'drafting') throw conflict(`herald is still writing ${piece.id}; ask for a recording when the draft is ready`);
  const rec = piece.gif.recording;
  if (rec && (rec.status === 'requested' || rec.status === 'recording')) throw conflict(`A recording of ${piece.id} is already ${rec.status === 'requested' ? 'requested' : `being made in ${rec.taskId}`}`);
  if (!piece.gif.steps.length) throw conflict(`${piece.id} has no demo steps; add them first`);
  const at = nowIso();
  piece.gif.recording = { status: 'requested', requestedAt: at };
  piece.updatedAt = at;
  const captain = captainOf(state);
  if (captain) {
    addInbox(state, {
      agentId: captain.id,
      from: SYSTEM,
      kind: 'system',
      text: [
        `The user wants a real recording of demo GIF ${piece.id} "${piece.title}".`,
        'Steps:',
        ...piece.gif.steps.map((t, i) => `${i + 1}. ${t}`),
        `Create one small task to record this demo with sample data (never real user data) and attach the recording as video evidence (.webm/.mp4) or a .gif (the before-and-after skill's scripts/record.mjs records a browser session); then call media_recording("${piece.id}", <task id>). Muster turns the recording into the GIF when the evidence arrives.`,
      ].join('\n'),
    });
  }
  feedEvent(state, actor, `asked for a real recording of demo GIF ${piece.id}`);
  return piece;
}

/** POST /api/media/pieces/:id/recording (media_recording): the Captain links the crew task that records the demo. */
export function linkRecording(store: MediaStore, state: MusterState, actor: string, id: string, taskId: unknown): MediaPiece {
  if (!isCaptain(state, actor)) throw forbidden('Only the Captain links a recording task');
  const piece = requireGif(store, id);
  const rec = piece.gif.recording;
  if (!rec || rec.status === 'done') throw conflict(`No recording of ${piece.id} was asked for${rec ? ' (the last one is done)' : ''}`);
  const tid = text(taskId, 'task', 20).toUpperCase();
  const task = state.tasks.find((t) => t.id === tid);
  if (!task) throw notFound(`No task "${taskId}"`);
  const other = store.pieces.find((p) => p !== piece && p.gif?.recording?.status === 'recording' && p.gif.recording.taskId === tid);
  if (other) throw conflict(`${tid} already records ${other.id}`);
  rec.status = 'recording';
  rec.taskId = tid;
  delete rec.error;
  piece.updatedAt = nowIso();
  feedEvent(state, actor, `linked ${tid} to record demo GIF ${piece.id}`);
  return piece;
}

/** The piece whose recording task is `taskId`, while it is being recorded. */
export function recordingFor(store: MediaStore, taskId: string): MediaPiece | undefined {
  return store.pieces.find((p) => p.kind === 'gif' && p.gif?.recording?.status === 'recording' && p.gif.recording.taskId === taskId);
}

/** The recording became recording.gif: it is now the GIF and the piece goes back to you. The caller commits both stores. */
export function recordingDone(store: MediaStore, state: MusterState, id: string, file: MediaGifFile): MediaPiece | undefined {
  const piece = store.pieces.find((p) => p.id === id && p.kind === 'gif');
  const rec = piece?.gif?.recording;
  if (!piece || !rec) return undefined;
  rec.status = 'done';
  rec.file = file;
  delete rec.error;
  piece.gif!.source = 'recording';
  const at = nowIso();
  piece.updatedAt = at;
  if (piece.status === 'approved' || piece.status === 'used' || piece.status === 'failed') {
    piece.status = 'review';
    delete piece.approvedAt;
    delete piece.usedAt;
  }
  settleNote(state, piece.id);
  const note = postNote(state, {
    actor: SYSTEM,
    type: 'system',
    to: HUMAN,
    topic: 'media',
    text: `Demo recording ready for ${piece.id} · ${piece.title}\nThe real recording (${rec.taskId}) is now the GIF: ${file.seconds.toFixed(1)} s, ${(file.bytes / 1048576).toFixed(1)} MB. Check it and approve.`,
  });
  note.open = true;
  delete note.taskId;
  delete note.branch;
  return piece;
}

/** Turning the recording into a GIF failed: the slideshow stays, and you can ask again. */
export function recordingFailed(store: MediaStore, id: string, error: string): MediaPiece | undefined {
  const piece = store.pieces.find((p) => p.id === id && p.kind === 'gif');
  const rec = piece?.gif?.recording;
  if (!piece || !rec) return undefined;
  rec.status = 'failed';
  rec.error = error.slice(0, 400);
  piece.updatedAt = nowIso();
  return piece;
}
