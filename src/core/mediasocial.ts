// Media, the social side (docs/MEDIA.md "Hashtags, Vellum post images, platform research, conversations and
// posting"): post images herald designs in Vellum, what it finds on the platforms, reply drafts, the posts and replies
// it puts into your Chrome (sent only when you press Post), and herald's one-thing-at-a-time work queue.
// Pure mutations of a MediaStore (plus MusterState for notes and feed); the orchestrator side is mediaapi.ts.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type {
  MediaConversation,
  MediaDesign,
  MediaDesignStyle,
  MediaPiece,
  MediaPlatform,
  MediaPublishJob,
  MediaReplyPolicy,
  MediaResearch,
  MediaResearchPost,
  MediaStore,
  MediaWork,
  MusterState,
} from '../types.js';
import { nowIso } from './board.js';
import { badRequest, conflict, notFound } from './errors.js';
import {
  claims,
  clip,
  draftingPiece,
  fullText,
  hashtags,
  isObj,
  list,
  oneOf,
  PLATFORMS,
  requireHerald,
  requireHuman,
  requirePiece,
  startNext,
  text,
} from './media.js';

export const PLATFORM_NAME: Record<MediaPlatform, string> = { x: 'X', linkedin: 'LinkedIn', facebook: 'Facebook', instagram: 'Instagram', bluesky: 'Bluesky', threads: 'Threads' };
/** Post image sizes per platform (Vellum artboards are made at these sizes). */
export const DESIGN_SIZES: Record<MediaPlatform, readonly [number, number]> = {
  x: [1600, 900],
  linkedin: [1200, 627],
  facebook: [1200, 630],
  instagram: [1080, 1080],
  threads: [1080, 1350],
  bluesky: [1600, 900],
};
export const DESIGN_STYLES: readonly MediaDesignStyle[] = ['headline', 'features', 'quote'];
export const DEFAULT_REPLY_POLICY: MediaReplyPolicy = { perDay: 5, watchOwn: true };
/** Comments on your posts are checked at most this often, for posts at most this old. */
export const WATCH_EVERY_MS = 24 * 3600_000;
export const WATCH_POSTS_FOR_MS = 14 * 24 * 3600_000;
/** How long media_publish_wait holds before answering "waiting" (under Node's 5-minute request timeout). */
export const PUBLISH_WAIT_MS = 4 * 60_000;

const ACTIVE: readonly MediaPublishJob['status'][] = ['queued', 'filling', 'ready', 'posting'];
const MAX_DESIGNS = 12;
const MAX_CONVERSATIONS_PER_CALL = 10;
const MAX_DRAFT = 3000;
const URL_RE = /^https?:\/\/\S+$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const conversationsOf = (store: MediaStore) => (store.conversations ??= []);
const jobsOf = (store: MediaStore) => (store.publish ??= []);
export const replyPolicy = (store: MediaStore): MediaReplyPolicy => ({ ...DEFAULT_REPLY_POLICY, ...store.replyPolicy });

function url(v: unknown, what: string, required = true): string {
  const t = text(v, what, 500, required);
  if (t && !URL_RE.test(t)) throw badRequest(`${what} must be a full http(s) link`);
  return t;
}

function requireSocial(store: MediaStore, id: string): MediaPiece {
  const piece = requirePiece(store, id);
  if (piece.kind !== 'social') throw badRequest(`${piece.id} is a ${piece.kind} piece; this is for social posts`);
  return piece;
}

export function requireJob(store: MediaStore, id: string): MediaPublishJob {
  const key = String(id).trim().toUpperCase();
  const job = key === 'CURRENT' ? currentJob(store) : jobsOf(store).find((j) => j.id === key);
  if (!job) throw notFound(key === 'CURRENT' ? 'No post or reply is being put in right now' : `No post job "${id}"`);
  return job;
}

export function requireConversation(store: MediaStore, id: string): MediaConversation {
  const c = conversationsOf(store).find((x) => x.id === String(id).trim().toUpperCase());
  if (!c) throw notFound(`No conversation "${id}"`);
  return c;
}

/** Width and height from a PNG's IHDR chunk, or undefined when the bytes aren't a PNG. */
export function pngSize(buf: Uint8Array): { width: number; height: number } | undefined {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24 || sig.some((b, i) => buf[i] !== b)) return undefined;
  if (String.fromCharCode(buf[12], buf[13], buf[14], buf[15]) !== 'IHDR') return undefined;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const width = dv.getUint32(16);
  const height = dv.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** Reads a PNG's size from disk (undefined when it's missing or not a PNG). */
export function readPngSize(path: string): { width: number; height: number } | undefined {
  try {
    return pngSize(readFileSync(path));
  } catch {
    return undefined;
  }
}

/** The local calendar day of an ISO time ("2026-10-07"); replies per day count by your day, not UTC's. */
export function localDay(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ Vellum post images

/** POST /api/media/pieces/:id/design: you only. `vellumReady` = the project has Vellum and a Vellum file. */
export function requestDesign(store: MediaStore, actor: string, id: string, body: Record<string, any>, vellumReady: boolean): MediaPiece {
  requireHuman(actor, 'ask for post images');
  const piece = requireSocial(store, id);
  if (!vellumReady) throw conflict("Vellum isn't set up for this project: set the Vellum file in Settings first");
  const style = oneOf(body.style ?? 'headline', DESIGN_STYLES, 'style');
  const note = text(body.note, 'note', 500, false);
  const platforms =
    body.platforms === undefined || body.platforms === null
      ? [...(piece.platforms ?? [])]
      : [...new Set(list(body.platforms, 'platforms', PLATFORMS.length, 1).map((p) => oneOf(p, PLATFORMS, 'platform')))];
  if (!platforms.length) throw badRequest('Pick at least one platform to make an image for');
  piece.designRequest = { style, platforms, at: nowIso(), ...(note ? { note } : {}) };
  piece.updatedAt = piece.designRequest.at;
  return piece;
}

/**
 * POST /api/media/pieces/:id/designs (media_designs): herald only. Each file must be a PNG herald exported into the
 * piece's images folder (`dir`); its size is read from the file. Replaces the designs for those platforms and settles
 * the design request.
 */
export function saveDesigns(store: MediaStore, state: MusterState, actor: string, id: string, v: unknown, dir: string, sizeOf: (file: string) => { width: number; height: number } | undefined): MediaPiece {
  requireHerald(state, actor, 'attach post images');
  const piece = requireSocial(store, id);
  const at = nowIso();
  const made = list(v, 'designs', MAX_DESIGNS, 1).map((raw, i): Omit<MediaDesign, 'id'> => {
    if (!isObj(raw)) throw badRequest(`designs[${i}] must be an object`);
    const platform = oneOf(raw.platform, PLATFORMS, `designs[${i}].platform`);
    const file = text(raw.file, `designs[${i}].file`, 200);
    if (basename(file) !== file || file.includes('..') || !/\.png$/i.test(file)) throw badRequest(`designs[${i}].file must be a PNG file name inside ${dir} (export there, then give just the name)`);
    const size = sizeOf(file);
    if (!size) throw badRequest(`designs[${i}]: ${file} isn't a PNG in ${dir}; export the artboard there first`);
    let vellum: MediaDesign['vellum'];
    if (raw.vellum !== undefined && raw.vellum !== null) {
      if (!isObj(raw.vellum)) throw badRequest(`designs[${i}].vellum must be {fileId, pageId?, nodeId}`);
      const pageId = text(raw.vellum.pageId, `designs[${i}].vellum.pageId`, 80, false);
      vellum = { fileId: text(raw.vellum.fileId, `designs[${i}].vellum.fileId`, 80), nodeId: text(raw.vellum.nodeId, `designs[${i}].vellum.nodeId`, 80), ...(pageId ? { pageId } : {}) };
    }
    return {
      platform,
      file,
      width: size.width,
      height: size.height,
      style: oneOf(raw.style ?? piece.designRequest?.style ?? 'headline', DESIGN_STYLES, `designs[${i}].style`),
      caption: text(raw.caption, `designs[${i}].caption`, 300),
      ...(vellum ? { vellum } : {}),
      createdAt: at,
    };
  });
  const platforms = new Set(made.map((d) => d.platform));
  const kept = (piece.designs ?? []).filter((d) => !platforms.has(d.platform));
  piece.designs = [...kept, ...made].slice(-MAX_DESIGNS).map((d, i) => ({ ...d, id: `D${i + 1}` }));
  delete piece.designRequest;
  piece.updatedAt = at;
  return piece;
}

// ------------------------------------------------------------------ research

function researchPost(raw: unknown, i: number): MediaResearchPost {
  if (!isObj(raw)) throw badRequest(`top[${i}] must be an object`);
  const platform = raw.platform === 'article' ? 'article' : oneOf(raw.platform, PLATFORMS, `top[${i}].platform`);
  const at = text(raw.at, `top[${i}].at`, 10, false);
  if (at && !DAY_RE.test(at)) throw badRequest(`top[${i}].at must be YYYY-MM-DD`);
  const engagement = text(raw.engagement, `top[${i}].engagement`, 100, false);
  const link = url(raw.url, `top[${i}].url`, false);
  return { platform, text: text(raw.text, `top[${i}].text`, 300), who: text(raw.who, `top[${i}].who`, 100), ...(engagement ? { engagement } : {}), ...(link ? { url: link } : {}), ...(at ? { at } : {}) };
}

/** POST /api/media/pieces/:id/research (media_research): herald only, a social piece. A Refresh is done by this. */
export function saveResearch(store: MediaStore, state: MusterState, actor: string, id: string, body: Record<string, any>): MediaPiece {
  requireHerald(state, actor, 'save research');
  const piece = requireSocial(store, id);
  const read = isObj(body.read) ? body.read : {};
  const count = (v: unknown, what: string) => {
    if (v === undefined || v === null) return 0;
    if (!Number.isInteger(v) || (v as number) < 0) throw badRequest(`${what} must be a whole number`);
    return v as number;
  };
  const research: MediaResearch = {
    at: nowIso(),
    platforms: [...new Set(list(body.platforms ?? piece.platforms ?? [], 'platforms', PLATFORMS.length).map((p) => oneOf(p, PLATFORMS, 'platform')))],
    query: list(body.query ?? [], 'query', 8).map((q, i) => text(q, `query[${i}]`, 100)),
    read: { posts: count(read.posts, 'read.posts'), articles: count(read.articles, 'read.articles') },
    top: list(body.top ?? [], 'top', 8).map(researchPost),
    themes: list(body.themes ?? [], 'themes', 8).map((raw, i) => {
      if (!isObj(raw)) throw badRequest(`themes[${i}] must be an object`);
      const n = raw.count ?? 1;
      if (!Number.isInteger(n) || n < 1) throw badRequest(`themes[${i}].count must be a whole number from 1`);
      return { text: text(raw.text, `themes[${i}].text`, 200), count: n };
    }),
    hashtags: list(body.hashtags ?? [], 'hashtags', 12).map((raw, i) => {
      if (!isObj(raw)) throw badRequest(`hashtags[${i}] must be an object`);
      const [tag] = hashtags([raw.tag], `hashtags[${i}].tag`);
      const note = text(raw.note, `hashtags[${i}].note`, 100, false);
      const on = [...new Set(list(raw.platforms ?? [], `hashtags[${i}].platforms`, PLATFORMS.length).map((p) => oneOf(p, PLATFORMS, 'platform')))];
      return { tag, platforms: on, ...(note ? { note } : {}) };
    }),
    used: list(body.used ?? [], 'used', 6).map((u, i) => text(u, `used[${i}]`, 300)),
  };
  piece.research = research;
  delete piece.researchQueued;
  piece.updatedAt = research.at;
  return piece;
}

/** POST /api/media/pieces/:id/research/refresh: you only. herald researches the piece again (no redraft). */
export function requestResearch(store: MediaStore, actor: string, id: string): MediaPiece {
  requireHuman(actor, 'refresh research');
  const piece = requireSocial(store, id);
  if (piece.status === 'drafting' || piece.status === 'queued') throw conflict(`${piece.id} is ${piece.status}: herald researches it as part of the draft`);
  piece.researchQueued = nowIso();
  return piece;
}

// ------------------------------------------------------------------ conversations

/** POST /api/media/conversations (media_conversations): herald only. One per thread URL; known URLs are skipped. Returns the added ones. */
export function addConversations(store: MediaStore, state: MusterState, actor: string, v: unknown): MediaConversation[] {
  requireHerald(state, actor, 'add conversations');
  const list_ = conversationsOf(store);
  const at = nowIso();
  const added: MediaConversation[] = [];
  for (const [i, raw] of list(v, 'conversations', MAX_CONVERSATIONS_PER_CALL, 1).entries()) {
    if (!isObj(raw)) throw badRequest(`conversations[${i}] must be an object`);
    const link = url(raw.url, `conversations[${i}].url`);
    if (list_.some((c) => c.url === link) || added.some((c) => c.url === link)) continue;
    let pieceId: string | undefined;
    if (raw.pieceId !== undefined && raw.pieceId !== null && raw.pieceId !== '') pieceId = requirePiece(store, String(raw.pieceId)).id;
    const engagement = text(raw.engagement, `conversations[${i}].engagement`, 100, false);
    const n = (store.nextIds.conversation ??= 1);
    store.nextIds.conversation = n + 1;
    added.push({
      id: `MC${n}`,
      ...(pieceId ? { pieceId } : {}),
      platform: oneOf(raw.platform, PLATFORMS, `conversations[${i}].platform`),
      kind: oneOf(raw.kind ?? 'thread', ['thread', 'own'] as const, `conversations[${i}].kind`),
      url: link,
      who: text(raw.who, `conversations[${i}].who`, 100),
      quote: text(raw.quote, `conversations[${i}].quote`, 500),
      ...(engagement ? { engagement } : {}),
      why: text(raw.why, `conversations[${i}].why`, 300),
      draft: text(raw.draft, `conversations[${i}].draft`, MAX_DRAFT),
      claims: claims(raw.claims ?? []),
      mentionsProduct: raw.mentionsProduct === true,
      status: 'draft',
      createdAt: at,
    });
  }
  list_.push(...added);
  return added;
}

function requireDraftConversation(store: MediaStore, id: string): MediaConversation {
  const c = requireConversation(store, id);
  if (c.status !== 'draft') throw conflict(`${c.id} is ${c.status}`);
  return c;
}

/** POST /api/media/conversations/:id/edit: you only. */
export function editConversation(store: MediaStore, actor: string, id: string, draft: unknown): MediaConversation {
  requireHuman(actor, 'edit replies');
  const c = requireDraftConversation(store, id);
  c.draft = text(draft, 'draft', MAX_DRAFT);
  return c;
}

/** POST /api/media/conversations/:id/skip: you only. */
export function skipConversation(store: MediaStore, actor: string, id: string): MediaConversation {
  requireHuman(actor, 'skip replies');
  const c = requireConversation(store, id);
  if (c.status === 'posted') throw conflict(`${c.id} was already posted`);
  c.status = 'skipped';
  for (const j of jobsOf(store)) if (j.conversationId === c.id && ['queued', 'filling', 'ready', 'signin'].includes(j.status)) cancel(j);
  return c;
}

/** POST /api/media/conversations/:id/claims/:cid/confirm: you only. */
export function confirmConversationClaim(store: MediaStore, actor: string, id: string, claimId: string): MediaConversation {
  requireHuman(actor, 'confirm claims');
  const c = requireConversation(store, id);
  const claim = c.claims.find((x) => x.id === String(claimId).trim().toUpperCase());
  if (!claim) throw notFound(`${c.id} has no claim "${claimId}"`);
  if (!claim.sources.some((s) => s.kind === 'opinion')) claim.sources.push({ kind: 'opinion', ref: '', label: 'opinion · your voice' });
  return c;
}

/** Replies that count against today's limit: posted, or still going out, made on your local day. */
export function repliesToday(store: MediaStore, now = new Date()): number {
  const today = localDay(now);
  return jobsOf(store).filter((j) => j.kind === 'reply' && (j.status === 'posted' || ACTIVE.includes(j.status)) && localDay(j.createdAt) === today).length;
}

/** POST /api/media/conversations/:id/reply: you only. A reply job for herald (sent only when you press Reply). */
export function replyConversation(store: MediaStore, actor: string, id: string, now = new Date()): MediaPublishJob {
  requireHuman(actor, 'send replies');
  const c = requireDraftConversation(store, id);
  const open = c.claims.filter((x) => !x.sources.length);
  if (open.length) throw conflict(`${c.id} has ${open.length} claim${open.length === 1 ? '' : 's'} with no source (${open.map((x) => x.id).join(', ')}): confirm or cut ${open.length === 1 ? 'it' : 'them'} first`);
  const { perDay } = replyPolicy(store);
  if (repliesToday(store, now) >= perDay) throw conflict(`That's ${perDay} repl${perDay === 1 ? 'y' : 'ies'} today, your daily limit. Change it under How herald replies, or reply tomorrow.`);
  c.status = 'queued';
  return newJob(store, { conversationId: c.id, platform: c.platform, kind: 'reply', text: c.draft, images: [] });
}

/** PUT /api/media/reply-policy: you only. */
export function setReplyPolicy(store: MediaStore, actor: string, body: Record<string, any>): MediaReplyPolicy {
  requireHuman(actor, 'change how herald replies');
  const next = replyPolicy(store);
  if (body.perDay !== undefined) {
    if (!Number.isInteger(body.perDay) || body.perDay < 0 || body.perDay > 20) throw badRequest('perDay must be a whole number from 0 to 20');
    next.perDay = body.perDay;
  }
  if (body.watchOwn !== undefined) {
    if (typeof body.watchOwn !== 'boolean') throw badRequest('watchOwn must be true or false');
    next.watchOwn = body.watchOwn;
  }
  store.replyPolicy = next;
  if (!next.watchOwn) delete store.watchQueuedAt;
  return next;
}

// ------------------------------------------------------------------ posting through your Chrome

function newJob(store: MediaStore, input: Pick<MediaPublishJob, 'platform' | 'kind' | 'text' | 'images'> & Partial<Pick<MediaPublishJob, 'pieceId' | 'conversationId'>>): MediaPublishJob {
  const n = (store.nextIds.publish ??= 1);
  store.nextIds.publish = n + 1;
  const at = nowIso();
  const job: MediaPublishJob = { id: `PJ${n}`, ...input, status: 'queued', createdAt: at, updatedAt: at };
  jobsOf(store).push(job);
  return job;
}

function cancel(job: MediaPublishJob): void {
  job.status = 'cancelled';
  job.updatedAt = nowIso();
}

/**
 * POST /api/media/publish: you only, an approved (or used) social piece. One job per platform, with the full text and
 * its images (a design for that platform, else the evidence images, else demo GIFs; `imagesFor` gives the paths).
 * A platform with a job already going out is skipped. Returns the new jobs.
 */
export function startPublish(store: MediaStore, actor: string, pieceId: string, v: unknown, imagesFor: (piece: MediaPiece, platform: MediaPlatform) => string[]): MediaPublishJob[] {
  requireHuman(actor, 'post');
  const piece = requireSocial(store, pieceId);
  if (piece.status !== 'approved' && piece.status !== 'used') throw conflict(`${piece.id} is ${piece.status}; approve it before posting`);
  const platforms = [...new Set(list(v, 'platforms', PLATFORMS.length, 1).map((p) => oneOf(p, PLATFORMS, 'platform')))];
  const prepared = platforms.map((platform) => {
    const post = piece.posts?.find((p) => p.platform === platform);
    if (!post) throw badRequest(`${piece.id} has no ${PLATFORM_NAME[platform]} post`);
    const images = imagesFor(piece, platform);
    if (platform === 'instagram' && !images.length) throw badRequest('Instagram posts need an image: attach a screenshot or make one in Vellum first');
    return { platform, text: fullText(post), images };
  });
  const busy = new Set(jobsOf(store).filter((j) => j.pieceId === piece.id && j.kind === 'post' && ACTIVE.includes(j.status)).map((j) => j.platform));
  const made = prepared.filter((p) => !busy.has(p.platform)).map((p) => newJob(store, { pieceId: piece.id, kind: 'post', ...p }));
  if (!made.length) throw conflict(`${platforms.map((p) => PLATFORM_NAME[p]).join(', ')} ${platforms.length === 1 ? 'is' : 'are'} already being posted`);
  return made;
}

/** POST /api/media/publish/stop: you only. Cancels the piece's jobs that haven't gone out (not one being posted). */
export function stopPublish(store: MediaStore, actor: string, pieceId: string): MediaPublishJob[] {
  requireHuman(actor, 'stop posting');
  const piece = requirePiece(store, pieceId);
  const stopped = jobsOf(store).filter((j) => j.pieceId === piece.id && ['queued', 'filling', 'ready', 'signin'].includes(j.status));
  stopped.forEach(cancel);
  return stopped;
}

/** POST /api/media/publish/:id/go: you only. A job filled in and checked: herald may press Post/Reply once. */
export function goJob(store: MediaStore, actor: string, id: string): MediaPublishJob {
  requireHuman(actor, 'press Post');
  const job = requireJob(store, id);
  if (job.status !== 'ready') throw conflict(`${job.id} is ${job.status}, not ready to post`);
  job.status = 'posting';
  job.updatedAt = nowIso();
  return job;
}

/** POST /api/media/publish/:id/cancel: you only. A reply's conversation goes back to a draft. */
export function cancelJob(store: MediaStore, actor: string, id: string): MediaPublishJob {
  requireHuman(actor, 'cancel posts');
  const job = requireJob(store, id);
  if (job.status === 'posting') throw conflict(`${job.id} is being posted right now; it can't be stopped`);
  if (job.status === 'posted' || job.status === 'cancelled') throw conflict(`${job.id} is ${job.status}`);
  cancel(job);
  backToDraft(store, job);
  return job;
}

function backToDraft(store: MediaStore, job: MediaPublishJob): void {
  if (!job.conversationId) return;
  const c = conversationsOf(store).find((x) => x.id === job.conversationId);
  if (c && c.status === 'queued') c.status = 'draft';
}

/** The job herald is putting in right now (current work), if any. */
export function currentJob(store: MediaStore): MediaPublishJob | undefined {
  const c = store.current;
  return c?.kind === 'publish' ? jobsOf(store).find((j) => j.id === c.id) : undefined;
}

/** media_publish_next: herald only. The job it was handed goes from queued to filling. undefined = nothing to post. */
export function publishNext(store: MediaStore, state: MusterState, actor: string): MediaPublishJob | undefined {
  requireHerald(state, actor, 'post');
  const job = currentJob(store);
  if (!job || !ACTIVE.includes(job.status)) return undefined;
  if (job.status === 'queued') {
    job.status = 'filling';
    job.updatedAt = nowIso();
  }
  return job;
}

function requireMine(store: MediaStore, id: string): MediaPublishJob {
  const job = requireJob(store, id);
  if (currentJob(store)?.id !== job.id) throw conflict(`${job.id} isn't the post you're on; call media_publish_next`);
  return job;
}

/** media_publish_ready: herald only. Filled in; waits for your Post. `composer` = the text read back from the page. */
export function publishReady(store: MediaStore, state: MusterState, actor: string, id: string, composer: unknown, attached: unknown): MediaPublishJob {
  requireHerald(state, actor, 'post');
  const job = requireMine(store, id);
  if (job.status !== 'filling') throw conflict(`${job.id} is ${job.status}, not being filled in`);
  job.composer = text(composer, 'composer', 6000);
  if (attached !== undefined && attached !== null && (!Number.isInteger(attached) || (attached as number) < 0)) throw badRequest('attached must be a whole number');
  job.attached = (attached as number | undefined) ?? 0;
  job.status = 'ready';
  delete job.error;
  job.updatedAt = nowIso();
  return job;
}

/** What media_publish_wait answers: go (you pressed Post), cancel, waiting (still ready), or the job's status otherwise. */
export function publishDecision(store: MediaStore, id: string): 'go' | 'cancel' | 'waiting' | MediaPublishJob['status'] {
  const job = requireJob(store, id);
  return job.status === 'posting' ? 'go' : job.status === 'cancelled' ? 'cancel' : job.status === 'ready' ? 'waiting' : job.status;
}

/** media_publish_done: herald only, after pressing Post once. A piece with nothing left going out (and something posted) is used. */
export function publishDone(store: MediaStore, state: MusterState, actor: string, id: string, link: unknown): MediaPublishJob {
  requireHerald(state, actor, 'post');
  const job = requireMine(store, id);
  if (job.status !== 'posting') throw conflict(`${job.id} is ${job.status}: press Post only after media_publish_wait says go`);
  const at = nowIso();
  job.status = 'posted';
  job.url = url(link, 'url', false) || undefined;
  job.updatedAt = at;
  if (job.conversationId) {
    const c = conversationsOf(store).find((x) => x.id === job.conversationId);
    if (c) {
      c.status = 'posted';
      c.postedAt = at;
      if (job.url) c.postedUrl = job.url;
    }
  }
  const piece = job.pieceId ? store.pieces.find((p) => p.id === job.pieceId) : undefined;
  if (piece && job.kind === 'post') {
    const mine = jobsOf(store).filter((j) => j.pieceId === piece.id && j.kind === 'post');
    if (!mine.some((j) => ACTIVE.includes(j.status)) && piece.status === 'approved') {
      piece.status = 'used';
      piece.usedAt = piece.updatedAt = at;
    }
  }
  delete store.current;
  return job;
}

/** media_publish_failed: herald only. signin = a login page showed (sign in in Chrome, then Retry). */
export function publishFailed(store: MediaStore, state: MusterState, actor: string, id: string, error: unknown, signin: unknown): MediaPublishJob {
  requireHerald(state, actor, 'post');
  const job = requireMine(store, id);
  if (!ACTIVE.includes(job.status)) throw conflict(`${job.id} is ${job.status}`);
  job.status = signin === true ? 'signin' : 'failed';
  job.error = text(error, 'error', 500, false) || (signin === true ? `Sign in to ${PLATFORM_NAME[job.platform]} in Chrome, then Retry` : 'herald could not put it in');
  job.updatedAt = nowIso();
  backToDraft(store, job);
  delete store.current;
  return job;
}

// ------------------------------------------------------------------ the daily watch

/** Posts herald should check for comments: posted with a link in the last 14 days. */
export function watchedPosts(store: MediaStore, now = Date.now()): MediaPublishJob[] {
  return jobsOf(store).filter((j) => j.kind === 'post' && j.status === 'posted' && j.url && now - Date.parse(j.updatedAt) <= WATCH_POSTS_FOR_MS);
}

/** The hourly tick: queue the comment check when it is on, due (24 h) and there is something to check. Returns true when queued. */
export function watchCheck(store: MediaStore, now = Date.now()): boolean {
  if (!replyPolicy(store).watchOwn || store.watchQueuedAt) return false;
  if (store.lastWatch && now - Date.parse(store.lastWatch) < WATCH_EVERY_MS) return false;
  if (!watchedPosts(store, now).length) return false;
  store.watchQueuedAt = new Date(now).toISOString();
  return true;
}

/** POST /api/media/watch/done (media_watch_done): herald only. */
export function watchDone(store: MediaStore, state: MusterState, actor: string): void {
  requireHerald(state, actor, 'finish the comment check');
  store.lastWatch = nowIso();
  delete store.watchQueuedAt;
  if (store.current?.kind === 'watch') delete store.current;
}

// ------------------------------------------------------------------ herald's queue

/** Whether the work herald was handed is still open. */
export function workOpen(store: MediaStore, w: MediaWork | undefined = store.current): boolean {
  if (!w) return false;
  const piece = () => store.pieces.find((p) => p.id === w.id);
  switch (w.kind) {
    case 'publish': {
      const job = jobsOf(store).find((j) => j.id === w.id);
      return !!job && ACTIVE.includes(job.status);
    }
    case 'design':
      return !!piece()?.designRequest;
    case 'draft':
      return piece()?.status === 'drafting';
    case 'research':
      return !!piece()?.researchQueued;
    case 'watch':
      return !!store.watchQueuedAt;
  }
}

/**
 * Hands herald its next piece of work when it has none open: a post going out, then a post image, then a draft
 * (a queued piece starts drafting), then a research refresh, then the comment check. Returns the work newly handed
 * out (undefined when herald is still busy or there is nothing to do).
 */
export function pickWork(store: MediaStore): MediaWork | undefined {
  if (workOpen(store)) return undefined;
  const at = nowIso();
  const hand = (kind: MediaWork['kind'], id?: string) => (store.current = { kind, ...(id ? { id } : {}), startedAt: at });
  const drafting = draftingPiece(store); // a draft started before there was a queue
  if (drafting) return hand('draft', drafting.id);
  delete store.current;
  const job = jobsOf(store).filter((j) => j.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (job) return hand('publish', job.id);
  const design = store.pieces.filter((p) => p.designRequest && p.status !== 'queued').sort((a, b) => a.designRequest!.at.localeCompare(b.designRequest!.at))[0];
  if (design) return hand('design', design.id);
  const next = startNext(store);
  if (next) return hand('draft', next.id);
  const research = store.pieces.filter((p) => p.researchQueued).sort((a, b) => a.researchQueued!.localeCompare(b.researchQueued!))[0];
  if (research) return hand('research', research.id);
  if (store.watchQueuedAt) return hand('watch');
  return undefined;
}

/** Whether herald has anything open or waiting (it is stopped when this turns false). */
export function hasWork(store: MediaStore): boolean {
  return (
    workOpen(store) ||
    !!draftingPiece(store) ||
    jobsOf(store).some((j) => j.status === 'queued') ||
    store.pieces.some((p) => p.status === 'queued' || p.designRequest || p.researchQueued) ||
    !!store.watchQueuedAt
  );
}

/** "Post PJ3 on X", "Make post images for MP4": the line herald is typed when it gets the work. */
export function workLabel(store: MediaStore, w: MediaWork): string {
  switch (w.kind) {
    case 'publish': {
      const job = jobsOf(store).find((j) => j.id === w.id);
      return job ? `Put ${job.kind === 'reply' ? 'reply' : 'post'} ${job.id} into ${PLATFORM_NAME[job.platform]}` : `Post ${w.id}`;
    }
    case 'design':
      return `Make post images for ${w.id}`;
    case 'draft':
      return `Draft ${w.id}`;
    case 'research':
      return `Research ${w.id} again`;
    case 'watch':
      return 'Check comments on the user\'s posts';
  }
}

/**
 * herald exited or was stopped with work open: it can't finish it. A post not yet sent fails (Retry puts it in
 * again); one being posted fails with a warning to check the platform first; a design or research request or the
 * comment check is dropped. Drafts are failed by media.failCurrent. Returns what happened (for the feed), or undefined.
 */
export function failWork(store: MediaStore, reason: string): string | undefined {
  const w = store.current;
  if (!w || !workOpen(store, w) || w.kind === 'draft') {
    if (w && w.kind !== 'draft') delete store.current;
    return undefined;
  }
  const at = nowIso();
  delete store.current;
  if (w.kind === 'publish') {
    const job = jobsOf(store).find((j) => j.id === w.id)!;
    const posting = job.status === 'posting';
    job.status = 'failed';
    job.error = posting ? `herald stopped while posting (${reason}): check ${PLATFORM_NAME[job.platform]} before you retry` : `herald stopped before it went out (${reason}); Retry puts it in again`;
    job.updatedAt = at;
    backToDraft(store, job);
    return `${job.id} (${PLATFORM_NAME[job.platform]}) failed: ${job.error}`;
  }
  if (w.kind === 'design') {
    const piece = store.pieces.find((p) => p.id === w.id)!;
    delete piece.designRequest;
    return `the post images for ${piece.id} weren't made (${reason}); ask again`;
  }
  if (w.kind === 'research') {
    const piece = store.pieces.find((p) => p.id === w.id)!;
    delete piece.researchQueued;
    return `the research refresh of ${piece.id} stopped (${reason})`;
  }
  store.lastWatch = at;
  delete store.watchQueuedAt;
  return `the comment check stopped (${reason}); it runs again tomorrow`;
}

/** The board note title of a job filled in and waiting for you. */
export const readyNoteTitle = (job: MediaPublishJob) => `${PLATFORM_NAME[job.platform]} ${job.kind} ready (${job.id})`;



// ------------------------------------------------------------------ briefs for the non-draft work

/** Where herald opens a new post on each platform. */
export const COMPOSE_URL: Record<MediaPlatform, string> = {
  x: 'https://x.com/compose/post',
  linkedin: 'https://www.linkedin.com/feed/?shareActive=true',
  facebook: 'https://www.facebook.com/ (click "What\'s on your mind")',
  instagram: 'https://www.instagram.com/ (Create, then Post)',
  bluesky: 'https://bsky.app/ (New Post)',
  threads: 'https://www.threads.net/ (New thread)',
};

/** Search pages herald reads with the browse tool when researching (q = the subject). */
export const SEARCH_URL: Record<MediaPlatform, (q: string) => string> = {
  x: (q) => `https://x.com/search?q=${encodeURIComponent(q)}&f=top`,
  linkedin: (q) => `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(q)}`,
  facebook: (q) => `https://www.facebook.com/search/posts/?q=${encodeURIComponent(q)}`,
  instagram: (q) => `https://www.instagram.com/explore/tags/${encodeURIComponent(q.replace(/[^A-Za-z0-9_]/g, ''))}/`,
  bluesky: (q) => `https://bsky.app/search?q=${encodeURIComponent(q)}`,
  threads: (q) => `https://www.threads.net/search?q=${encodeURIComponent(q)}`,
};

export interface WorkBriefOptions {
  projectName?: string;
  userName?: string;
  vellumFile?: string;
  /** Absolute folder herald exports a piece's post images into. */
  imagesDir(pieceId: string): string;
  /** Absolute path of an evidence image of a piece (for designs). */
  evidencePath?(taskId: string, evidenceId: string, name: string): string | undefined;
}

/** herald's brief for the work it is on when that isn't a draft (media_brief). */
export function workBrief(store: MediaStore, state: MusterState, o: WorkBriefOptions): string {
  const w = store.current;
  if (!w || !workOpen(store, w) || w.kind === 'draft') return 'Nothing to do right now. You are done; stop here.';
  const who = o.userName?.trim() || 'the user';
  const L: string[] = [`# ${workLabel(store, w)}${o.projectName ? ` (${o.projectName})` : ''}`];
  if (w.kind === 'publish') {
    const job = jobsOf(store).find((j) => j.id === w.id)!;
    const c = job.conversationId ? conversationsOf(store).find((x) => x.id === job.conversationId) : undefined;
    L.push(`Job ${job.id}: ${job.kind} on ${PLATFORM_NAME[job.platform]}, status ${job.status}.`);
    L.push(c ? `Reply to: ${c.url} (${c.who}: "${clip(c.quote, 200)}")` : `Open: ${COMPOSE_URL[job.platform]}`);
    L.push('', 'Text to put in, exactly (keep the line breaks):', '<<<', job.text, '>>>');
    L.push(job.images.length ? `Images to attach, in this order:\n${job.images.map((p) => `- ${p}`).join('\n')}` : 'No images.');
    L.push(
      '',
      "## Steps (Claude in Chrome, the user's own signed-in Chrome)",
      '1. If the job is queued, call media_publish_next first (it moves it to filling).',
      '2. Open a NEW tab and go to the address above. A login page shows? Call media_publish_failed(job, "not signed in", signin: true) and stop.',
      '3. Paste the text exactly and attach the images with the file upload tool. Nothing else: no other text, mentions or links.',
      `4. Read the composer back from the page and call media_publish_ready(job, composer, attached). Then call media_publish_wait(job) and keep calling it while it says waiting: ${who} checks the tab and presses Post in Muster.`,
      '5. Only when it says go: press Post (or Reply) once, read the address of the new post, and call media_publish_done(job, url).',
      '6. When it says cancel: discard the draft, close the tab, and stop.',
      '7. Anything goes wrong (the page changed, an upload fails): media_publish_failed(job, what happened). Never press Post to "try".',
      "Never like, follow, DM, quote, repost or post anything that isn't this text.",
    );
    return L.join('\n');
  }
  const piece = store.pieces.find((p) => p.id === w.id);
  if (w.kind === 'design' && piece?.designRequest) {
    const r = piece.designRequest;
    L.push(`Piece ${piece.id} "${piece.title}". Style: ${r.style === 'headline' ? 'Headline + screenshot' : r.style === 'features' ? 'Feature list' : 'Big quote'}.${r.note ? ` Note from ${who}: ${r.note}` : ''}`);
    L.push(`Vellum file: ${o.vellumFile || '(not set: use list_files to find the project file)'}. Design on its page called "Media" (create it if missing).`);
    L.push(`Sizes: ${r.platforms.map((p) => `${PLATFORM_NAME[p]} ${DESIGN_SIZES[p][0]}×${DESIGN_SIZES[p][1]}`).join(', ')}. Name each artboard "${piece.id} · <Platform> <W>×<H>".`);
    for (const post of piece.posts ?? []) L.push(`Post (${PLATFORM_NAME[post.platform]}): ${clip(post.versions[post.chosen] ?? '', 300)}`);
    const shots = (piece.images ?? []).map((im) => o.evidencePath?.(im.taskId, im.evidenceId, im.name)).filter((x): x is string => !!x);
    if (shots.length) L.push(`Screenshots you may use:\n${shots.map((x) => `- ${x}`).join('\n')}`);
    L.push(
      '',
      '## Steps (Vellum tools)',
      '1. get_guide, then get_basic_info and get_tokens of the file: use its colours, fonts and logo. Short headline from the post, big and readable on a phone.',
      `2. One artboard per size above. Then export each as PNG with outputDir "${o.imagesDir(piece.id)}" (absolute).`,
      '3. media_designs(piece, designs: [{platform, file: "<exported file name>", caption: "<alt text>", vellum: {fileId, pageId, nodeId}}]). Muster checks the files and attaches them. Then stop.',
    );
    return L.join('\n');
  }
  if (w.kind === 'research' && piece) {
    const subject = piece.about.map((a) => a.label).join('; ');
    L.push(`Piece ${piece.id} "${piece.title}" about ${subject}. Platforms: ${(piece.platforms ?? []).map((p) => PLATFORM_NAME[p]).join(', ')}.`);
    L.push(...researchSteps(piece));
    L.push("This is a refresh: save it with media_research (that finishes the job); don't change the posts.");
    return L.join('\n');
  }
  if (w.kind === 'watch') {
    const posts = watchedPosts(store);
    L.push(`Check the comments on ${who}'s recent posts and draft replies only where one would really help.`);
    for (const j of posts) L.push(`- ${PLATFORM_NAME[j.platform]} ${j.url} (${j.pieceId ?? 'post'}, posted ${j.updatedAt.slice(0, 10)})`);
    const known = conversationsOf(store).map((c) => c.url);
    if (known.length) L.push(`Already drafted or answered (skip these): ${known.join(' ')}`);
    L.push(
      '',
      '## Steps',
      '1. Read each post with the browse tool (it is signed in like the user). Look at the comments since the last check.',
      "2. For each comment worth answering, media_conversations([{kind: \"own\", pieceId, platform, url (the comment's link, or the post's), who, quote, why, draft, claims, mentionsProduct}]).",
      '3. Then media_watch_done() and stop. Nothing worth answering? Just media_watch_done().',
    );
    L.push(...replyRules());
    return L.join('\n');
  }
  return 'Nothing to do right now. You are done; stop here.';
}

/** How herald researches a social piece (draft brief and refresh). */
export function researchSteps(piece: MediaPiece): string[] {
  const q = piece.about.map((a) => a.label.replace(/^(Stage \w+ · |[TGR]\d+ )/, '')).join(' ').slice(0, 80) || piece.title;
  return [
    '',
    '## Research steps',
    `1. Pick 2–4 search phrases people would use for this (not your product name), e.g. "${q}".`,
    `2. Read each platform's search with the browse tool: ${(piece.platforms ?? []).map((p) => `${PLATFORM_NAME[p]} ${SEARCH_URL[p]('<phrase>')}`).join('; ')}. Recent articles: web search.`,
    '3. Note the posts and articles that do well (engagement, link), what people keep saying (count how often), and the hashtags they really use per platform.',
    '4. media_research(piece, {platforms, query, read: {posts, articles}, top, themes, hashtags, used}). Themes are what people said, not facts.',
    '5. Up to 6 media_conversations where a reply from the user would really help (see the reply rules).',
    ...replyRules(),
  ];
}

/** The reply rules, word for word in every brief that drafts replies. */
export function replyRules(): string[] {
  return [
    '',
    '## Reply rules',
    "- Reply only where it adds something real: an answer, the user's experience, a fix.",
    "- Name the product only when someone asked for a tool, and then say it is the user's own (mentionsProduct: true). No copy-paste promotion.",
    '- One reply per thread. Every factual phrase is a claim with its sources; unsourced claims block the reply until the user confirms or cuts them.',
  ];
}
