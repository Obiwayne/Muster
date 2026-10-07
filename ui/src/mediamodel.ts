// Media page model (docs/MEDIA.md): pure helpers for the library and editors. Sorting, counts, platform
// character limits, plain-text copy formats (article, website, video script), the CSV shot list and claim colours.
// No DOM, no fetch: tested in mediamodel.test.ts.
import type {
  MediaClaim, MediaClaimSource, MediaConversation, MediaDesign, MediaGif, MediaGifFile, MediaGifFrame, MediaImage, MediaKind, MediaPiece, MediaPlatform, MediaPost,
  MediaPublishJob, MediaReplyPolicy, MediaResearch, MediaShot, MediaStatus, MediaStore, MediaSuggestion, MusterState,
} from '../../src/types';

export const EMPTY_MEDIA: MediaStore = { version: 1, rev: 0, pieces: [], suggestions: [], houseStyle: '', nextIds: { piece: 1, suggestion: 1 } };

export const KIND_LABEL: Record<MediaKind, string> = { social: 'Social post', article: 'Article', website: 'Website', video: 'Video script', gif: 'Demo GIF' };
export const KIND_TAB: Record<MediaKind, string> = { social: 'Social posts', article: 'Articles', website: 'Website', video: 'Video scripts', gif: 'Demo GIFs' };
export const KIND_HINT: Record<MediaKind, string> = { social: 'X, LinkedIn, Bluesky', article: 'Devlog, blog, roundup', website: 'Feature page, changelog', video: 'Shorts, YouTube', gif: 'Screenshots or a recording' };
export const KINDS: MediaKind[] = ['social', 'article', 'website', 'video', 'gif'];

export const PLATFORM_LABEL: Record<MediaPlatform, string> = { x: 'X', linkedin: 'LinkedIn', facebook: 'Facebook', instagram: 'Instagram', bluesky: 'Bluesky', threads: 'Threads' };
export const PLATFORMS: MediaPlatform[] = ['x', 'linkedin', 'facebook', 'instagram', 'bluesky', 'threads'];
/** Short names for tight columns: "X LI FB". */
export const PLATFORM_SHORT: Record<MediaPlatform, string> = { x: 'X', linkedin: 'LI', facebook: 'FB', instagram: 'IG', bluesky: 'BS', threads: 'TH' };
/** Soft limits: shown as warnings, never enforced (the server only caps at 3000). LinkedIn has no practical limit here. */
/** Character limits (docs/MEDIA.md). Only the tight ones show as "241/280"; the rest show the count alone. */
export const PLATFORM_LIMIT: Record<MediaPlatform, number> = { x: 280, bluesky: 300, threads: 500, linkedin: 3000, facebook: 5000, instagram: 2200 };
const SHOW_LIMIT = new Set<MediaPlatform>(['x', 'bluesky', 'threads']);
/** New social pieces: X, LinkedIn and Facebook. Instagram is never on by default (it needs an image). */
export const DEFAULT_PLATFORMS: MediaPlatform[] = ['x', 'linkedin', 'facebook'];

export type StatusTone = 'media' | 'captain' | 'success' | 'faint' | 'stuck';
export const STATUS: Record<MediaStatus, { label: string; tone: StatusTone }> = {
  queued: { label: 'Queued', tone: 'media' },
  drafting: { label: 'Drafting', tone: 'media' },
  review: { label: 'Needs your review', tone: 'captain' },
  approved: { label: 'Approved', tone: 'success' },
  used: { label: 'Used', tone: 'faint' },
  failed: { label: 'Stopped', tone: 'stuck' },
};

const STATUS_ORDER: Record<MediaStatus, number> = { review: 0, drafting: 1, queued: 1, failed: 2, approved: 3, used: 4 };

/** Library order: review → drafting/queued → failed → approved → used, then newest first. */
export function sortPieces(pieces: MediaPiece[]): MediaPiece[] {
  return [...pieces].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
}

export type KindFilter = 'all' | MediaKind;

export function filterPieces(pieces: MediaPiece[], f: KindFilter): MediaPiece[] {
  return f === 'all' ? pieces : pieces.filter((p) => p.kind === f);
}

export function kindCounts(pieces: MediaPiece[]): Record<KindFilter, number> {
  const c: Record<KindFilter, number> = { all: pieces.length, social: 0, article: 0, website: 0, video: 0, gif: 0 };
  for (const p of pieces) c[p.kind]++;
  return c;
}

export const reviewCount = (pieces: MediaPiece[]) => pieces.filter((p) => p.status === 'review').length;
export const isBusy = (p: MediaPiece) => p.status === 'queued' || p.status === 'drafting';

export function openSuggestions(store: MediaStore): MediaSuggestion[] {
  return store.suggestions.filter((s) => s.status === 'open').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const TRIGGER_LABEL: Record<MediaSuggestion['trigger'], string> = { stage: 'STAGE LANDED', feature: 'BIG FEATURE', weekly: 'WEEKLY ROUNDUP' };

/** "STAGE LANDED · M3", "WEEKLY ROUNDUP · WEEK 40" */
export function suggestionTag(s: MediaSuggestion): string {
  const wk = /^\d{4}-W(\d{1,2})$/.exec(s.ref);
  return `${TRIGGER_LABEL[s.trigger]} · ${wk ? `WEEK ${Number(wk[1])}` : s.ref}`;
}

// ---------------------------------------------------------------- character limits

export interface CharCount { n: number; limit?: number; over: boolean; text: string }

/** "241/280" (over when past the limit), or just "912" for platforms without one. Counts code points like the sites do. */
export function charCount(platform: MediaPlatform, text: string): CharCount {
  const n = [...text].length;
  const limit = PLATFORM_LIMIT[platform];
  const show = SHOW_LIMIT.has(platform);
  return { n, limit: show ? limit : undefined, over: n > limit, text: show ? `${n}/${limit}` : String(n) };
}

// ---------------------------------------------------------------- hashtags

/** How many hashtags each platform wants (herald follows it; the UI only warns). */
export const HASHTAG_RULE: Record<MediaPlatform, { min: number; max: number; hint: string }> = {
  x: { min: 1, max: 2, hint: 'X: 1–2 hashtags · counted in the 280' },
  linkedin: { min: 3, max: 5, hint: 'LinkedIn: 3–5 hashtags at the end' },
  facebook: { min: 1, max: 3, hint: 'Facebook: 1–3 hashtags' },
  instagram: { min: 5, max: 10, hint: 'Instagram: 5–10 hashtags (30 at most)' },
  threads: { min: 1, max: 1, hint: 'Threads: 1 topic tag · counted in the 500' },
  bluesky: { min: 1, max: 2, hint: 'Bluesky: 1–2 hashtags · counted in the 300' },
};

/** The rule line under the chips, with a warning when the count is outside it (none yet is fine: herald adds them). */
export function hashtagHint(platform: MediaPlatform, n: number): { text: string; warn: boolean } {
  const r = HASHTAG_RULE[platform];
  const most = platform === 'instagram' ? 30 : r.max;
  if (n > most) return { text: `${r.hint} · you have ${n}`, warn: true };
  if (n > 0 && n < r.min) return { text: `${r.hint} · add ${r.min - n} more`, warn: true };
  return { text: r.hint, warn: false };
}

/** "#EdTech" / "edtech " → "EdTech"; null when it can't be a hashtag (letters, digits and _ only, up to 50). */
export function cleanTag(raw: string): string | null {
  const t = raw.trim().replace(/^#+/, '');
  return /^[A-Za-z0-9_]{1,50}$/.test(t) ? t : null;
}

/** The text that is copied and posted: the chosen version, a blank line, then "#tag #tag". */
export function fullPostText(post: MediaPost, version = post.chosen): string {
  const v = post.versions[Math.min(Math.max(0, version), post.versions.length - 1)] ?? '';
  const tags = (post.hashtags ?? []).map((t) => `#${t}`).join(' ');
  return tags ? `${v.trimEnd()}\n\n${tags}` : v;
}

export const versionLetter = (i: number) => String.fromCharCode(65 + i);

// ---------------------------------------------------------------- claims

export type ClaimTone = 'intel' | 'task' | 'opinion' | 'evidence' | 'other' | 'unsourced';

export function sourceTone(s: MediaClaimSource): ClaimTone {
  switch (s.kind) {
    case 'intel': case 'idea': return 'intel';
    case 'task': case 'stage': case 'goal': return 'task';
    case 'opinion': return 'opinion';
    case 'evidence': case 'readme': return 'evidence';
    default: return 'other';
  }
}

export const isUnsourced = (c: MediaClaim) => c.sources.length === 0;
export const unsourcedCount = (p: MediaPiece) => p.claims.filter(isUnsourced).length;

// ---------------------------------------------------------------- plain-text copy

/** Article / website as plain text: title, then each heading on its own line, blank line between paragraphs. */
export function sectionsText(p: MediaPiece): string {
  const parts: string[] = [p.title.trim()];
  for (const s of p.sections ?? []) {
    const body = s.text.trim();
    if (!s.heading.trim() && !body) continue;
    const block = [s.heading.trim(), body].filter(Boolean).join('\n\n');
    parts.push(block);
  }
  return parts.filter(Boolean).join('\n\n') + '\n';
}

/** The text Copy text puts on the clipboard for social: the chosen version of one platform. */
export function postText(p: MediaPiece, platform: MediaPlatform): string {
  const post = p.posts?.find((x) => x.platform === platform);
  if (!post || !post.versions.length) return '';
  return fullPostText(post);
}

/** Video script as plain text: title, chosen hook, then one block per shot. */
export function scriptText(p: MediaPiece): string {
  const lines: string[] = [p.title.trim()];
  const hook = p.hooks?.[p.hookChosen ?? 0];
  if (hook) lines.push('', `Hook: ${hook}`);
  for (const s of p.shots ?? []) {
    lines.push('', `[${s.at}] ${s.shot}${s.record ? ' (record)' : ''}`);
    if (s.voiceover) lines.push(`VO: ${s.voiceover}`);
    if (s.onScreen) lines.push(`On screen: ${s.onScreen}`);
  }
  return lines.join('\n') + '\n';
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Shot list as CSV text (for the Resolve edit): time, shot, voiceover, on screen, source. */
export function shotListCsv(shots: MediaShot[]): string {
  const rows = [['Time', 'Shot', 'Voiceover', 'On screen', 'Source']];
  for (const s of shots) {
    const src = s.evidence ? `${s.evidence.taskId}/${s.evidence.evidenceId}/${s.evidence.name}` : s.record ? 'record' : '';
    rows.push([s.at, s.shot, s.voiceover, s.onScreen ?? '', src]);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export interface ShotCounts { evidence: number; record: number }
export function shotCounts(shots: MediaShot[] = []): ShotCounts {
  return { evidence: shots.filter((s) => s.evidence).length, record: shots.filter((s) => s.record && !s.evidence).length };
}

// ---------------------------------------------------------------- library rail and rows

/** One-line meta under a piece's title in the library. */
export function pieceMeta(p: MediaPiece): string {
  const bits: string[] = [KIND_LABEL[p.kind]];
  if (p.kind === 'social') {
    const n = Math.max(0, ...(p.posts ?? []).map((x) => x.versions.length));
    if (n) bits.push(`${n} version${n === 1 ? '' : 's'}`);
    const imgs = p.images?.length ?? 0;
    if (imgs) bits.push(`${imgs} screenshot${imgs === 1 ? '' : 's'}`);
  } else if (p.kind === 'video') {
    const shots = p.shots?.length ?? 0;
    if (shots) bits.push(`${shots} shots`);
  } else if (p.kind === 'gif') {
    const g = p.gif;
    const f = g ? gifFile(g) : undefined;
    if (g?.source === 'recording') bits.push('real recording');
    else if (g?.frames.length) bits.push(`${g.frames.length} frame${g.frames.length === 1 ? '' : 's'}`);
    if (f) bits.push(`${formatSeconds(f.seconds)}`, formatBytes(f.bytes));
  } else {
    const words = wordCount(p);
    if (words) bits.push(`~${roundWords(words)} words`);
  }
  if (isBusy(p) && p.progress) bits.push(p.progress);
  if (p.status === 'failed' && p.error) bits.push(p.error);
  return bits.join(' · ');
}

export function wordCount(p: MediaPiece): number {
  return (p.sections ?? []).reduce((n, s) => n + (s.text.match(/\S+/g)?.length ?? 0), 0);
}
const roundWords = (n: number) => (n >= 100 ? (Math.round(n / 50) * 50).toLocaleString('en-GB') : String(n));

/** "X · LinkedIn · Bluesky", the website target, or "Devlog / blog". */
export function pieceFor(p: MediaPiece): string {
  if (p.kind === 'social') return (p.platforms ?? p.posts?.map((x) => x.platform) ?? []).map((x) => PLATFORM_LABEL[x]).join(' · ') || 'Social';
  if (p.kind === 'website') return p.target || 'Website';
  if (p.kind === 'video') return 'YouTube Shorts · TikTok';
  if (p.kind === 'gif') return 'Social · website';
  return 'Devlog / blog';
}

export interface SourceCounts { stages: string[]; merged: number; since?: string; screenshots: number; chat: number }

/** "What herald writes from": stages done, merged tasks since your last post (the newest piece marked used), evidence screenshots, chat lines. */
export function sourceCounts(state: MusterState, pieces: MediaPiece[]): SourceCounts {
  const stages = (state.roadmap?.stages ?? []).filter((s) => s.status === 'done').map((s) => s.id);
  const last = pieces.reduce<string | undefined>((m, p) => (p.usedAt && (!m || p.usedAt > m) ? p.usedAt : m), undefined);
  const merged = state.tasks.filter((t) => t.status === 'merged' && (!last || t.updatedAt > last)).length;
  const screenshots = state.tasks.reduce((n, t) => n + (t.evidence ?? []).reduce((k, e) => k + e.files.filter((f) => f.kind === 'image').length, 0), 0);
  return { stages, merged, since: last, screenshots, chat: state.feed.length };
}

/** Evidence images of the tasks a piece is about (for "+ Pick from N"); all merged tasks' images when none match. */
export function evidenceImages(state: MusterState, p: MediaPiece): { taskId: string; evidenceId: string; name: string; summary: string }[] {
  const taskIds = new Set(p.about.filter((a) => a.kind === 'task').map((a) => a.ref));
  const goalIds = new Set(p.about.filter((a) => a.kind === 'goal').map((a) => a.ref));
  const stageIds = new Set(p.about.filter((a) => a.kind === 'stage').map((a) => a.ref));
  for (const g of state.roadmap?.goals ?? []) if (stageIds.has(g.stageId)) goalIds.add(g.id);
  const linked = (t: MusterState['tasks'][number]) => taskIds.has(t.id) || (!!t.goalId && goalIds.has(t.goalId));
  let tasks = state.tasks.filter(linked);
  if (!tasks.some((t) => t.evidence?.length)) tasks = state.tasks.filter((t) => t.status === 'merged');
  const out: { taskId: string; evidenceId: string; name: string; summary: string }[] = [];
  for (const t of tasks) for (const e of t.evidence ?? []) for (const f of e.files) if (f.kind === 'image') out.push({ taskId: t.id, evidenceId: e.id, name: f.name, summary: e.summary });
  return out;
}

// ---------------------------------------------------------------- demo GIF

/** Upload limits for an animated GIF, per platform (the FITS card): X 15 MB, LinkedIn 5 MB, Bluesky 1 MB. */
export const GIF_LIMIT_BYTES: Partial<Record<MediaPlatform, number>> = { x: 15 * 1024 * 1024, linkedin: 5 * 1024 * 1024, bluesky: 1024 * 1024 };

export interface GifFit { platform: MediaPlatform; label: string; limit: number; ok: boolean }

/** Whether a GIF of `bytes` fits each platform's limit. */
export function gifFits(bytes: number): GifFit[] {
  return (Object.keys(GIF_LIMIT_BYTES) as MediaPlatform[]).map((platform) => {
    const limit = GIF_LIMIT_BYTES[platform]!;
    return { platform, label: PLATFORM_LABEL[platform], limit, ok: bytes <= limit };
  });
}

/** "1.8 MB", "640 KB", "900 B". */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** "9.5 s" (one decimal, trailing .0 dropped). */
export function formatSeconds(s: number): string {
  return `${Number(s.toFixed(1))} s`;
}

/** The slideshow's length: the sum of its frames. */
export function totalSeconds(frames: MediaGifFrame[]): number {
  return Math.round(frames.reduce((n, f) => n + (Number.isFinite(f.seconds) ? f.seconds : 0), 0) * 10) / 10;
}

/** When frame `i` starts, "0:02.5". */
export function frameStart(frames: MediaGifFrame[], i: number): string {
  const t = totalSeconds(frames.slice(0, i));
  const m = Math.floor(t / 60);
  const sec = t - m * 60;
  return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`;
}

/** A copy of `frames` with the frame at `from` moved to `to` (indices clamped; same array order otherwise). */
export function moveFrame<T>(frames: T[], from: number, to: number): T[] {
  const out = [...frames];
  if (from < 0 || from >= out.length) return out;
  const [f] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, f);
  return out;
}

/** Frame seconds as the server allows them: 0.5–8, rounded to a tenth. */
export function clampSeconds(v: number): number {
  if (!Number.isFinite(v)) return 2.5;
  return Math.round(Math.min(8, Math.max(0.5, v)) * 10) / 10;
}

/** The GIF file for the source in use (slideshow.gif or recording.gif), if it has been made. */
export function gifFile(g: MediaGif): MediaGifFile | undefined {
  return g.source === 'recording' ? g.recording?.file : g.slideshow;
}

/** Demo GIF pieces a social post can attach: waiting on review, approved or used, newest first. */
export function attachableGifs(pieces: MediaPiece[]): MediaPiece[] {
  return pieces.filter((p) => p.kind === 'gif' && (p.status === 'review' || p.status === 'approved' || p.status === 'used'))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** One line for the recording's state under "Record a real demo". */
export function recordingLine(g: MediaGif): string {
  const r = g.recording;
  if (!r) return 'This becomes a small task for the Captain. It uses sample data, never your real classes. The slideshow stays until the recording is ready.';
  switch (r.status) {
    case 'requested': return 'Asked the Captain. Waiting for a crew task to record it.';
    case 'recording': return `${r.taskId ?? 'A crew task'} is recording it. The slideshow stays until the recording is ready.`;
    case 'done': return `Recorded${r.taskId ? ` by ${r.taskId}` : ''}. Switch between the slideshow and the recording above.`;
    case 'failed': return `The recording could not be made into a GIF${r.error ? `: ${r.error}` : ''}. The slideshow stays.`;
  }
}

// ---------------------------------------------------------------- post images (Vellum designs, docs/MEDIA.md)

/** The size herald makes a post image in, per platform. */
export const DESIGN_SIZE: Record<MediaPlatform, { w: number; h: number }> = {
  x: { w: 1600, h: 900 }, linkedin: { w: 1200, h: 627 }, facebook: { w: 1200, h: 630 }, instagram: { w: 1080, h: 1080 }, threads: { w: 1080, h: 1350 }, bluesky: { w: 1600, h: 900 },
};

/** "X 1600×900 · LinkedIn 1200×627 · …" for the Make an image popover. */
export function designSizesLine(platforms: MediaPlatform[]): string {
  return platforms.map((p) => `${PLATFORM_LABEL[p]} ${DESIGN_SIZE[p].w}×${DESIGN_SIZE[p].h}`).join(' · ');
}

export const DESIGN_STYLES: { id: 'headline' | 'features' | 'quote'; label: string }[] = [
  { id: 'headline', label: 'Headline + screenshot' },
  { id: 'features', label: 'Feature list' },
  { id: 'quote', label: 'Big quote' },
];

export type PostImage = { kind: 'design'; design: MediaDesign } | { kind: 'evidence'; image: MediaImage } | { kind: 'gif'; pieceId: string };

/** What a platform's post carries: its own Vellum design when there is one, else the screenshots, else the demo GIFs. */
export function imagesFor(p: MediaPiece, platform: MediaPlatform): PostImage[] {
  const d = (p.designs ?? []).filter((x) => x.platform === platform);
  if (d.length) return d.map((design) => ({ kind: 'design', design }));
  if (p.images?.length) return p.images.map((image) => ({ kind: 'evidence', image }));
  return (p.gifIds ?? []).map((pieceId) => ({ kind: 'gif', pieceId }));
}

/** Designs in platform order, for the attachments row. */
export function sortedDesigns(p: MediaPiece): MediaDesign[] {
  const order = (pl: MediaPlatform) => PLATFORMS.indexOf(pl);
  return [...(p.designs ?? [])].sort((a, b) => order(a.platform) - order(b.platform));
}

// ---------------------------------------------------------------- posting through your Chrome

export const JOB_LIVE: MediaPublishJob['status'][] = ['queued', 'filling', 'ready', 'posting', 'signin'];
export const isLiveJob = (j: MediaPublishJob) => JOB_LIVE.includes(j.status);

export function jobsFor(store: MediaStore, pieceId: string): MediaPublishJob[] {
  return (store.publish ?? []).filter((j) => j.pieceId === pieceId);
}

/** The posting rail shows while a piece has post jobs that aren't all cancelled. */
export function showPublishRail(jobs: MediaPublishJob[]): boolean {
  return jobs.some((j) => j.kind === 'post' && j.status !== 'cancelled');
}

export interface JobLine { text: string; tone: StatusTone }

/** The status words on a rail row. */
export function jobLine(j: MediaPublishJob): JobLine {
  const where = PLATFORM_LABEL[j.platform];
  switch (j.status) {
    case 'queued': return { text: 'Waiting', tone: 'faint' };
    case 'filling': return { text: j.kind === 'reply' ? 'Filling in the reply…' : 'Filling in the post…', tone: 'media' };
    case 'ready': return { text: 'Ready: check and post', tone: 'captain' };
    case 'posting': return { text: 'Posting…', tone: 'media' };
    case 'posted': return { text: 'Posted', tone: 'success' };
    case 'cancelled': return { text: 'Cancelled', tone: 'faint' };
    case 'signin': return { text: `Sign in to ${where} in Chrome, then Retry`, tone: 'stuck' };
    case 'failed': return { text: `Didn't work${j.error ? `: ${j.error}` : ''}`, tone: 'stuck' };
  }
}

/** "Posting · 1 of 3 ready" for the editor chip while post jobs are live; null when none are. */
export function publishChip(jobs: MediaPublishJob[]): string | null {
  const posts = jobs.filter((j) => j.kind === 'post' && j.status !== 'cancelled');
  if (!posts.some(isLiveJob)) return null;
  const ready = posts.filter((j) => j.status === 'ready').length;
  const posted = posts.filter((j) => j.status === 'posted').length;
  return ready ? `Posting · ${ready} of ${posts.length} ready` : posted ? `Posting · ${posted} of ${posts.length} posted` : 'Posting · filling in';
}

/** One row of the "Want me to post it for you?" dialog. */
export interface PostRow { platform: MediaPlatform; line: string; checked: boolean; disabled?: string }

export function postRows(p: MediaPiece): PostRow[] {
  return (p.posts ?? []).filter((x) => x.versions.length).map((post) => {
    const imgs = imagesFor(p, post.platform);
    const cc = charCount(post.platform, fullPostText(post));
    const tags = post.hashtags?.length ? post.hashtags.map((t) => `#${t}`).join(' ') : 'no hashtags';
    const bits = [`Version ${versionLetter(post.chosen)}`, ...(cc.limit ? [cc.text] : []), tags, imgs.length ? `${imgs.length} image${imgs.length === 1 ? '' : 's'}` : 'no image'];
    if (post.platform === 'instagram' && !imgs.length) return { platform: post.platform, line: 'Instagram needs an image: attach one first', checked: false, disabled: 'needs an image' };
    if (cc.over) return { platform: post.platform, line: `${bits.join(' · ')} · too long`, checked: false, disabled: 'too long' };
    return { platform: post.platform, line: bits.join(' · '), checked: post.platform !== 'instagram' };
  });
}

// ---------------------------------------------------------------- research

/** "herald read 46 posts and 9 articles · X, LinkedIn, Facebook" (the page adds how long ago). */
export function researchLine(r: MediaResearch): string {
  const posts = `${r.read.posts} post${r.read.posts === 1 ? '' : 's'}`;
  const arts = r.read.articles ? ` and ${r.read.articles} article${r.read.articles === 1 ? '' : 's'}` : '';
  return `herald read ${posts}${arts} · ${r.platforms.map((p) => PLATFORM_LABEL[p]).join(', ')}`;
}

/** Theme count colours: the biggest is the stuck colour, the next amber, the rest muted. */
export function themeTone(i: number): 'stuck' | 'captain' | 'muted' {
  return i === 0 ? 'stuck' : i === 1 ? 'captain' : 'muted';
}

// ---------------------------------------------------------------- conversations

export const DEFAULT_REPLY_POLICY: MediaReplyPolicy = { perDay: 5, watchOwn: true };
export const replyPolicy = (store: MediaStore): MediaReplyPolicy => ({ ...DEFAULT_REPLY_POLICY, ...(store.replyPolicy ?? {}) });

const sameDay = (iso: string, now: Date) => {
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
};

/** Replies counted against today's limit: going out now, or posted today (local day). */
export function repliesToday(store: MediaStore, now = new Date()): number {
  return (store.publish ?? []).filter((j) => j.kind === 'reply' && (isLiveJob(j) || (j.status === 'posted' && sameDay(j.updatedAt, now)))).length;
}

/** Why "Reply for me" is off, or null when it can go. */
export function replyBlock(c: MediaConversation, store: MediaStore, now = new Date()): string | null {
  if (c.status === 'posted') return 'Already replied';
  if (c.status === 'skipped') return 'Skipped';
  if (c.status === 'queued') return 'Going out through Chrome';
  if (!c.draft.trim()) return 'Write a reply first';
  const open = c.claims.filter(isUnsourced);
  if (open.length === 1) return `"${open[0].quote}" has no source: confirm or cut it`;
  if (open.length) return `${open.length} lines have no source: confirm or cut them`;
  const p = replyPolicy(store);
  if (repliesToday(store, now) >= p.perDay) return `Today's limit of ${p.perDay} repl${p.perDay === 1 ? 'y' : 'ies'} is reached`;
  return null;
}

/** The Conversations tab for a piece: drafts first (comments on your posts before threads), then queued, posted, skipped. */
export function conversationsFor(store: MediaStore, pieceId: string): MediaConversation[] {
  const rank: Record<MediaConversation['status'], number> = { draft: 0, queued: 1, posted: 2, skipped: 3 };
  return (store.conversations ?? []).filter((c) => c.pieceId === pieceId)
    .sort((a, b) => rank[a.status] - rank[b.status] || (a.kind === b.kind ? 0 : a.kind === 'own' ? -1 : 1) || b.createdAt.localeCompare(a.createdAt));
}

/** "4 places where a reply would help · 2 replies to your own posts · max 5 replies a day". */
export function conversationsLine(list: MediaConversation[], policy: MediaReplyPolicy): string {
  const open = list.filter((c) => c.status === 'draft');
  const threads = open.filter((c) => c.kind === 'thread').length;
  const own = open.filter((c) => c.kind === 'own').length;
  const bits = [`${threads} place${threads === 1 ? '' : 's'} where a reply would help`];
  if (own) bits.push(`${own} comment${own === 1 ? '' : 's'} on your posts`);
  bits.push(`max ${policy.perDay} repl${policy.perDay === 1 ? 'y' : 'ies'} a day`);
  return bits.join(' · ');
}
