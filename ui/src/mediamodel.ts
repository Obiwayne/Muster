// Media page model (docs/MEDIA.md): pure helpers for the library and editors. Sorting, counts, platform
// character limits, plain-text copy formats (article, website, video script), the CSV shot list and claim colours.
// No DOM, no fetch: tested in mediamodel.test.ts.
import type {
  MediaClaim, MediaClaimSource, MediaKind, MediaPiece, MediaPlatform, MediaShot, MediaStatus, MediaStore, MediaSuggestion, MusterState,
} from '../../src/types';

export const EMPTY_MEDIA: MediaStore = { version: 1, rev: 0, pieces: [], suggestions: [], houseStyle: '', nextIds: { piece: 1, suggestion: 1 } };

export const KIND_LABEL: Record<MediaKind, string> = { social: 'Social post', article: 'Article', website: 'Website', video: 'Video script' };
export const KIND_TAB: Record<MediaKind, string> = { social: 'Social posts', article: 'Articles', website: 'Website', video: 'Video scripts' };
export const KINDS: MediaKind[] = ['social', 'article', 'website', 'video'];

export const PLATFORM_LABEL: Record<MediaPlatform, string> = { x: 'X', linkedin: 'LinkedIn', bluesky: 'Bluesky', threads: 'Threads' };
export const PLATFORMS: MediaPlatform[] = ['x', 'linkedin', 'bluesky', 'threads'];
/** Soft limits: shown as warnings, never enforced (the server only caps at 3000). LinkedIn has no practical limit here. */
export const PLATFORM_LIMIT: Partial<Record<MediaPlatform, number>> = { x: 280, bluesky: 300, threads: 500 };
export const DEFAULT_PLATFORMS: MediaPlatform[] = ['x', 'linkedin', 'bluesky'];

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
  const c: Record<KindFilter, number> = { all: pieces.length, social: 0, article: 0, website: 0, video: 0 };
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
  return { n, limit, over: limit !== undefined && n > limit, text: limit !== undefined ? `${n}/${limit}` : String(n) };
}

export const versionLetter = (i: number) => String.fromCharCode(65 + i);

// ---------------------------------------------------------------- claims

export type ClaimTone = 'intel' | 'task' | 'opinion' | 'evidence' | 'other' | 'unsourced';

export function sourceTone(s: MediaClaimSource): ClaimTone {
  switch (s.kind) {
    case 'intel': case 'idea': return 'intel';
    case 'task': case 'stage': case 'goal': return 'task';
    case 'opinion': return 'opinion';
    case 'evidence': return 'evidence';
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
  return post.versions[Math.min(Math.max(0, post.chosen), post.versions.length - 1)];
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
  return 'Devlog / blog';
}

export interface SourceCounts { stages: string[]; merged: number; since?: string; screenshots: number; chat: number }

/** "What herald writes from": stages done, merged tasks since the last piece, evidence screenshots, chat lines. */
export function sourceCounts(state: MusterState, pieces: MediaPiece[]): SourceCounts {
  const stages = (state.roadmap?.stages ?? []).filter((s) => s.status === 'done').map((s) => s.id);
  const last = pieces.reduce<string | undefined>((m, p) => (!m || p.createdAt > m ? p.createdAt : m), undefined);
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
