// Pure helpers for the research pages (src/core/research.ts on the server): filters and counts,
// evidence chips, plan lines, the run strip and the "Captain updated it … ago" line. No DOM here.
import type {
  BrowseMode, FeedItem, IdeaEvidence, IdeaStatus, ResearchIdea, ResearchRun, ResearchSources, ResearchState, Roadmap,
} from '../../src/types';
import { estimateResearch } from '../../src/core/intelestimate';

export type IdeaFilter = 'new' | 'roadmap' | 'rejected';

export const EMPTY_RESEARCH: ResearchState = { runs: [], ideas: [] };

const FILTER_STATUS: Record<IdeaFilter, IdeaStatus> = { new: 'new', roadmap: 'approved', rejected: 'rejected' };

/** Roadmap → Research lists scout's research ideas; intel ideas (gaps scout raised from competitors) live on Intel → Opportunities. */
export function researchIdeas(ideas: ResearchIdea[]): ResearchIdea[] {
  return ideas.filter((i) => i.origin !== 'intel');
}

export function ideaMatches(i: ResearchIdea, f: IdeaFilter): boolean {
  return i.status === FILTER_STATUS[f];
}

export function ideaCounts(ideas: ResearchIdea[]): Record<IdeaFilter, number> {
  const c: Record<IdeaFilter, number> = { new: 0, roadmap: 0, rejected: 0 };
  for (const i of ideas) {
    if (i.status === 'new') c.new++;
    else if (i.status === 'approved') c.roadmap++;
    else if (i.status === 'rejected') c.rejected++;
  }
  return c;
}

const num = (id: string) => Number(id.replace(/\D/g, '')) || 0;
const IMPACT_RANK: Record<string, number> = { high: 0, business: 1, medium: 2, low: 3 };

/** Ideas for a filter: new ones by impact (high first), then newest; decided ones newest decision first. */
export function filterIdeas(ideas: ResearchIdea[], f: IdeaFilter): ResearchIdea[] {
  const list = ideas.filter((i) => ideaMatches(i, f));
  if (f === 'new') return list.sort((a, b) => (IMPACT_RANK[a.impact] ?? 9) - (IMPACT_RANK[b.impact] ?? 9) || num(b.id) - num(a.id));
  return list.sort((a, b) => Date.parse(b.decidedAt ?? b.createdAt) - Date.parse(a.decidedAt ?? a.createdAt) || num(b.id) - num(a.id));
}

/** Latest run (highest id / newest start). */
export function lastRun(r: ResearchState | null | undefined): ResearchRun | undefined {
  const runs = r?.runs ?? [];
  return [...runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || num(b.id) - num(a.id))[0];
}

export function runningRun(r: ResearchState | null | undefined): ResearchRun | undefined {
  return r?.runs.find((x) => x.status === 'running');
}

export function newCount(r: ResearchState | null | undefined): number {
  return (r?.ideas ?? []).filter((i) => i.status === 'new').length;
}

// ---------------------------------------------------------------- impact / effort / fits

export function impactPill(i: Pick<ResearchIdea, 'impact' | 'overlapsGoalId'>): { label: string; tone: 'success' | 'captain' | 'muted' | 'faint' } {
  if (i.overlapsGoalId) return { label: `OVERLAPS ${i.overlapsGoalId}`, tone: 'captain' };
  switch (i.impact) {
    case 'high': return { label: 'HIGH IMPACT', tone: 'success' };
    case 'business': return { label: 'BUSINESS', tone: 'captain' };
    case 'medium': return { label: 'MEDIUM IMPACT', tone: 'muted' };
    default: return { label: 'LOW IMPACT', tone: 'faint' };
  }
}

/** "M3 Sharing" from stage M3 "Sharing & invites". */
export function fitsLabel(r: Roadmap | null | undefined, stageId?: string): string | undefined {
  if (!stageId) return undefined;
  const s = r?.stages.find((x) => x.id === stageId);
  const word = s?.title.split(/[\s&·,/-]+/).find(Boolean);
  return word ? `${stageId} ${word}` : stageId;
}

// ---------------------------------------------------------------- evidence

export type EvidenceTone = 'review' | 'forum' | 'competitor';

export function evidenceTone(e: Pick<IdeaEvidence, 'kind'>): EvidenceTone {
  return e.kind === 'review' ? 'review' : e.kind === 'forum' ? 'forum' : 'competitor';
}

const isReddit = (s: string) => /(^|\W)r\/\w|reddit/i.test(s);

/** Chips on an idea card: reviews and forum threads are summed (each item + its "+N similar"); other evidence by source. */
export function evidenceChips(evidence: IdeaEvidence[], max = 3): { tone: EvidenceTone; label: string }[] {
  let reviews = 0;
  let threads = 0;
  let reddit = true;
  const others: string[] = [];
  for (const e of evidence) {
    const n = 1 + Math.max(0, Math.round(e.count ?? 0));
    if (e.kind === 'review') reviews += n;
    else if (e.kind === 'forum') { threads += n; if (!isReddit(e.source)) reddit = false; }
    else others.push(e.source);
  }
  const chips: { tone: EvidenceTone; label: string }[] = [];
  if (reviews) chips.push({ tone: 'review', label: `${reviews} ${reviews === 1 ? 'review' : 'reviews'}` });
  if (threads) chips.push({ tone: 'forum', label: `${threads} ${reddit ? 'Reddit' : 'forum'} ${threads === 1 ? 'thread' : 'threads'}` });
  for (const o of others) chips.push({ tone: 'competitor', label: o.length > 40 ? `${o.slice(0, 39)}…` : o });
  return chips.slice(0, max);
}

/** "+37 similar", "+5 threads", "+2 more" for the rail. */
export function evidenceCountLabel(e: Pick<IdeaEvidence, 'kind' | 'count'>): string {
  if (!e.count || e.count <= 0) return '';
  const n = Math.round(e.count);
  if (e.kind === 'review') return `+${n} similar`;
  if (e.kind === 'forum') return `+${n} ${n === 1 ? 'thread' : 'threads'}`;
  return `+${n} more`;
}

/** Only http(s) links are opened. */
export function safeUrl(u?: string): string | undefined {
  if (!u) return undefined;
  try {
    const x = new URL(u);
    return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- Captain's thread and plan

/** Footer state of a card. */
export function ideaFooter(i: ResearchIdea, r?: Roadmap | null): { tone: 'captain' | 'faint' | 'success' | 'muted'; text: string; goalStage?: string } {
  if (i.status === 'approved') {
    if (i.goalId) {
      const g = r?.goals.find((x) => x.id === i.goalId);
      const s = g ? r?.stages.find((x) => x.id === g.stageId) : undefined;
      return { tone: 'success', text: `Approved · Captain added it to ${s ? `${s.id} ${s.title.split(/[\s&·,/-]+/)[0]}` : 'the roadmap'} as ${i.goalId}`, goalStage: s?.id };
    }
    return { tone: 'success', text: 'Approved · Captain is adding it to the roadmap' };
  }
  if (i.status === 'rejected') return { tone: 'muted', text: 'Rejected' };
  const last = i.thread[i.thread.length - 1];
  if (last && last.from !== 'you') return { tone: 'captain', text: 'Captain advised · see right' };
  if (last && last.from === 'you') return { tone: 'muted', text: i.thread.some((m) => m.from !== 'you') ? 'You asked a follow-up · Captain answering' : 'Asked the Captain · answering' };
  return { tone: 'faint', text: 'No advice yet' };
}

/** "+ Add goal Moderation queue to M3 (Oct 13–17)" → { sign: '+', text, meta: 'Oct 13–17' }. */
export function parsePlanItem(line: string): { sign: '+' | '~' | '−' | '•'; text: string; meta?: string } {
  let s = line.trim();
  let sign: '+' | '~' | '−' | '•' = '•';
  const m = /^([+~\-−])\s*/.exec(s);
  if (m) {
    sign = m[1] === '+' ? '+' : m[1] === '~' ? '~' : '−';
    s = s.slice(m[0].length);
  }
  const meta = /\s*\(([^()]+)\)\s*$/.exec(s);
  if (meta) return { sign, text: s.slice(0, meta.index).trim(), meta: meta[1].trim() };
  return { sign, text: s };
}

/** Captain replies: first paragraph is the answer, the rest is detail (shown muted). */
export function splitAdvice(text: string): { lead: string; rest: string } {
  const parts = text.split(/\n\s*\n/);
  return { lead: parts[0].trim(), rest: parts.slice(1).join('\n\n').trim() };
}

// ---------------------------------------------------------------- run strip

function minutesBetween(a: string, b: string): number {
  return Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60_000));
}

/** Source chips for a run: Competitors / Reviews / Reddit (or Forums) / Our app. */
export function sourceChips(s: ResearchSources): string[] {
  const out: string[] = [];
  if (s.competitors.length) out.push('Competitors');
  if (s.reviews) out.push('Reviews');
  if (s.forums.length) out.push(s.forums.every((f) => isReddit(f)) ? 'Reddit' : 'Forums');
  if (s.ownApp) out.push('Our app');
  return out;
}

export function runStrip(run: ResearchRun, ideas: ResearchIdea[], now = Date.now()): { tone: 'blue' | 'stuck' | 'faint'; title: string; sub: string } {
  const mine = ideas.filter((i) => i.runId === run.id || run.ideaIds.includes(i.id));
  const n = Math.max(run.ideaIds.length, mine.length);
  const fresh = mine.filter((i) => i.status === 'new').length;
  const ideasWord = `${n} ${n === 1 ? 'idea' : 'ideas'}`;
  const end = run.finishedAt ?? new Date(now).toISOString();
  const mins = minutesBetween(run.startedAt, end);
  const took = `${mins < 1 ? 'under a minute' : `${mins} min`}`;
  switch (run.status) {
    case 'running': {
      const parts = [`Started ${mins < 1 ? 'just now' : `${mins} min ago`}`, run.depth === 'thorough' ? 'thorough' : 'quick'];
      if (run.sources.competitors.length) parts.push(run.sources.competitors.join(', '));
      if (run.focus) parts.push(`“${run.focus}”`);
      return { tone: 'blue', title: `researching… ${ideasWord} so far`, sub: parts.join(' · ') };
    }
    case 'done': {
      const read = run.sourcesRead ? `Read ${run.sourcesRead} sources in ${took}` : `Finished in ${took}`;
      return { tone: 'blue', title: `Research finished · ${ideasWord}${n ? `, ${fresh} new` : ''}`, sub: [read, run.summary].filter(Boolean).join(' · ') };
    }
    case 'failed':
      return { tone: 'stuck', title: `Research failed · ${ideasWord} found`, sub: run.summary || `Stopped after ${took}.` };
    default:
      return { tone: 'faint', title: `Research cancelled · ${ideasWord} found`, sub: `Cancelled after ${took}${run.summary ? ` · ${run.summary}` : ''}` };
  }
}

// ---------------------------------------------------------------- new research draft

export interface ResearchDraft {
  useCompetitors: boolean;
  competitors: string[];
  reviews: boolean;
  useForums: boolean;
  forums: string[];
  ownApp: boolean;
  focus: string;
  depth: 'quick' | 'thorough';
  fromLastRun: boolean; // competitor chips came from the last run (shown as "suggested by scout")
  browse?: BrowseMode; // "How should scout browse?" (absent = the server's default, config.researchBrowser.mode)
}

export const DEPTH = {
  quick: { label: 'Quick · ~10 min', usage: '≈ 3% of 5-hour window' },
  thorough: { label: 'Thorough · ~25 min', usage: '≈ 6% of 5-hour window' },
} as const;

/** A fresh draft: sources default to the last run's (competitors and forums), else everything but our own app. */
export function draftFromLastRun(run?: ResearchRun): ResearchDraft {
  const s = run?.sources;
  return {
    useCompetitors: s ? s.competitors.length > 0 : true,
    competitors: s ? [...s.competitors] : [],
    reviews: s ? s.reviews : true,
    useForums: s ? s.forums.length > 0 : true,
    forums: s ? [...s.forums] : [],
    ownApp: s ? s.ownApp : false,
    focus: '',
    depth: run?.depth ?? 'quick',
    fromLastRun: !!s && s.competitors.length > 0,
  };
}

/** Add a chip value (trimmed, no duplicates ignoring case). Returns the new list. */
export function addChip(list: string[], value: string): string[] {
  const v = value.trim().replace(/\s+/g, ' ');
  if (!v || list.some((x) => x.toLowerCase() === v.toLowerCase())) return list;
  return [...list, v];
}

/**
 * The estimate line under Depth, from the same `estimateResearch` the server uses. With competitors tracked, scout
 * writes an intel check after every idea, so the line includes them.
 */
export function researchEstimate(depth: 'quick' | 'thorough', competitors: number): { usage: string; checks: string } {
  const est = estimateResearch(depth, competitors);
  if (competitors <= 0) return { usage: est.text, checks: 'No intel checks: no competitors tracked' };
  return { usage: est.text, checks: `each idea is checked against ${competitors} competitor${competitors === 1 ? '' : 's'}` };
}

/** Body for POST /api/research/runs, or an error to show in the modal. */
export function draftToRun(d: ResearchDraft): { body?: { sources: ResearchSources; focus?: string; depth: 'quick' | 'thorough'; browse?: BrowseMode }; error?: string } {
  if (d.useCompetitors && !d.competitors.length) return { error: 'Add at least one similar app, or untick that source.' };
  if (d.useForums && !d.forums.length) return { error: 'Add at least one subreddit or forum, or untick that source.' };
  const sources: ResearchSources = {
    competitors: d.useCompetitors ? d.competitors : [],
    reviews: d.reviews,
    forums: d.useForums ? d.forums : [],
    ownApp: d.ownApp,
  };
  if (!sources.competitors.length && !sources.reviews && !sources.forums.length && !sources.ownApp) return { error: 'Pick at least one source.' };
  const focus = d.focus.trim();
  return { body: { sources, ...(focus ? { focus } : {}), depth: d.depth, ...(d.browse ? { browse: d.browse } : {}) } };
}

// ---------------------------------------------------------------- "Captain updated it … ago"

const ROADMAP_RE = /\broadmap\b|\bexit criterion\b|\b[MG]\d+\b/i;

/** Feed text without the leading actor ("captain ticked …" → "ticked …"). */
export function stripActor(f: Pick<FeedItem, 'from' | 'text'>): string {
  return f.text.startsWith(`${f.from} `) ? f.text.slice(f.from.length + 1) : f.text;
}

/** Short "what" for the latest roadmap change: "ticked an M3 criterion", "added G14 to M5". */
export function roadmapWhat(text: string): string {
  let m: RegExpExecArray | null;
  if ((m = /^(ticked|unticked) (M\d+) exit criterion/i.exec(text))) return `${m[1].toLowerCase()} an ${m[2]} criterion`;
  if ((m = /^added goal (G\d+)\b.*\bto (M\d+)/i.exec(text))) return `added ${m[1]} to ${m[2]}`;
  if ((m = /^completed (M\d+)/i.exec(text))) return `completed ${m[1]}`;
  if ((m = /^(?:put|took) (.+?) (on|off) (G\d+)/i.exec(text))) return `${m[2] === 'on' ? 'linked' : 'unlinked'} ${m[1]} ${m[2] === 'on' ? 'to' : 'from'} ${m[3]}`;
  if ((m = /^set ([MG]\d+)\b.* to (\w+)$/i.exec(text))) return `set ${m[1]} to ${m[2]}`;
  if (/^(drafted|updated) the roadmap/i.test(text)) return 'revised the plan';
  if (/^changed the approved roadmap/i.test(text)) return 'changed the plan';
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 48 ? `${t.slice(0, 47)}…` : t;
}

/** "42 min ago" style, like util.agoLong but takes `now` for tests. */
export function agoText(iso: string, now = Date.now()): string {
  const m = Math.round((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(m) || m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/**
 * "Captain updated it 12 min ago (ticked an M3 criterion)" from the newest roadmap event by the Captain;
 * "Updated 3h ago" from roadmap.updatedAt when the feed has none.
 */
export function updatedLine(feed: FeedItem[], roadmap: Pick<Roadmap, 'updatedAt'>, captainIds: Set<string>, now = Date.now()): string {
  let best: FeedItem | undefined;
  for (const f of feed) {
    if (!captainIds.has(f.from) || f.kind !== 'event' || !ROADMAP_RE.test(f.text) || f.text.startsWith('Roadmap: ')) continue; // roadmap_status lines show on their own
    if (!best || Date.parse(f.at) >= Date.parse(best.at)) best = f;
  }
  if (best) return `Captain updated it ${agoText(best.at, now)} (${roadmapWhat(stripActor(best))})`;
  return `Updated ${agoText(roadmap.updatedAt, now)}`;
}
