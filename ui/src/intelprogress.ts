// The research-in-progress overlay's model (Intel page), derived from the `intel` summary only: which job to show,
// area chips (done / current / pending), "N of M areas", pages · elapsed · ≈ left, the latest claim. Pure, so tested.
// Also the per-browser Peek memory: jobs you chose to peek at keep the overlay hidden until "Show progress".
import type { IntelArea, IntelJobKind, IntelJobProgress, IntelJobView, IntelSummary } from '../../src/types';
import { estimateIntelJob } from '../../src/core/intelestimate';

/** Chip names, as in the design ("AI use", "Social"). */
export const CHIP_LABEL: Record<IntelArea, string> = {
  features: 'Features', roadmap: 'Roadmap', reviews: 'Reviews', gaps: 'Gaps', audience: 'Audience', pricing: 'Pricing', ai: 'AI use',
  financials: 'Financials', team: 'Team', marketing: 'Social', org: 'Org',
};

/** Jobs that get the overlay: researching competitors. Checks, re-checks and scheduled watches keep the slim strip. */
export const OVERLAY_KINDS: IntelJobKind[] = ['competitor', 'sweep'];

export type ChipState = 'done' | 'current' | 'pending';
export interface AreaChip { area: IntelArea; label: string; state: ChipState; count: number; reading?: string }

const READING_FRESH_MS = 3 * 60_000;

/**
 * Chips for the job's requested areas: an area with claims is done, the area of the latest claim is current, the rest
 * pending. Before the first claim the first area is current. Ordered done → current → pending, like the design.
 */
export function areaChips(areas: IntelArea[], p: IntelJobProgress | undefined, now = Date.now()): AreaChip[] {
  const list = areas.length ? areas : (Object.keys(p?.areas ?? {}) as IntelArea[]);
  let current = p?.current && list.includes(p.current) ? p.current : undefined;
  if (!current) current = list.find((a) => !(p?.areas[a] ?? 0));
  const reading = p?.reading && now - Date.parse(p.reading.at) < READING_FRESH_MS ? p.reading.site : undefined;
  const chips = list.map((area): AreaChip => {
    const count = p?.areas[area] ?? 0;
    const state: ChipState = area === current ? 'current' : count > 0 ? 'done' : 'pending';
    return { area, label: CHIP_LABEL[area] ?? area, state, count, ...(state === 'current' && reading ? { reading } : {}) };
  });
  const rank: Record<ChipState, number> = { done: 0, current: 1, pending: 2 };
  return chips.map((c, i) => ({ c, i })).sort((a, b) => rank[a.c.state] - rank[b.c.state] || a.i - b.i).map((x) => x.c);
}

/**
 * Time left, only when it can be said soundly: from the pace so far once two areas are done, else from the
 * estimate the Add competitor modal showed (src/core/intelestimate.ts). Undefined when overdue or nearly done.
 */
export function etaLeftMs(kind: IntelJobKind, depth: 'quick' | 'thorough', competitors: number, elapsedMs: number, done: number, total: number): number | undefined {
  if (total <= 0 || done >= total || elapsedMs < 0) return undefined;
  const left = done >= 2 ? (elapsedMs / done) * (total - done) : estimateIntelJob(kind, depth, competitors).minutes * 60_000 - elapsedMs;
  return left >= 60_000 ? left : undefined;
}

/** "3m 40s", "12s", "1h 4m". */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "Figma", "Padlet and Wakelet", "Padlet, Wakelet and Linoit", "5 competitors". */
export function namesText(names: string[]): string {
  if (!names.length) return 'a competitor';
  if (names.length === 1) return names[0];
  if (names.length > 3) return `${names.length} competitors`;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

export interface OverlayModel {
  jobId: string;
  mode: 'running' | 'queued';
  title: string; // "scout is researching Figma" / "Figma research is queued"
  line: string;
  done: number;
  total: number;
  pct: number; // 0–100
  meta: string; // "23 pages · 3m 40s · ≈ 6 min left"
  chips: AreaChip[];
  latest?: string; // "Latest: “Figma Dev Mode moved to paid seats” · fact"
}

const LINE = "Reading their site, reviews and social. You can keep working on other pages; we'll post on the Bulletin board when it's ready.";

function view(job: IntelJobView & { id: string; kind: IntelJobKind }, mode: OverlayModel['mode'], now: number, startedAt?: string, waitingOn?: string): OverlayModel {
  const chips = areaChips(job.areas, job.progress, now);
  const total = chips.length;
  const done = chips.filter((c) => c.state === 'done').length;
  const who = namesText(job.names);
  const latest = job.progress?.latest;
  if (mode === 'queued') {
    return {
      jobId: job.id, mode, title: `${who} research is queued`,
      line: `Queued behind ${waitingOn ?? 'other work'}. scout starts on it next; you can keep working on other pages.`,
      done: 0, total, pct: 0, meta: `${total} area${total === 1 ? '' : 's'} · waiting`, chips: chips.map((c) => ({ ...c, state: 'pending' as const, reading: undefined })),
    };
  }
  const elapsed = startedAt ? now - Date.parse(startedAt) : 0;
  const left = etaLeftMs(job.kind, job.depth, job.competitorIds.length, elapsed, done, total);
  const meta = [`${job.pages} page${job.pages === 1 ? '' : 's'}`, fmtElapsed(elapsed), ...(left !== undefined ? [`≈ ${Math.ceil(left / 60_000)} min left`] : [])].join(' · ');
  return {
    jobId: job.id, mode, title: `scout is researching ${who}`, line: LINE, done, total, pct: total ? Math.round((done / total) * 100) : 0, meta, chips,
    ...(latest ? { latest: `Latest: “${latest.text}” · ${latest.label}` } : {}),
  };
}

/** What the overlay shows: the running competitor/sweep job, else your oldest queued one (with what it waits on). */
export function overlayModel(summary: IntelSummary | null | undefined, now = Date.now()): OverlayModel | null {
  if (!summary) return null;
  const run = summary.runningJob;
  if (run && OVERLAY_KINDS.includes(run.kind) && run.areas) return view(run, 'running', now, run.startedAt);
  const mine = summary.queue?.find((j) => OVERLAY_KINDS.includes(j.kind) && j.by === 'you');
  if (mine) return view(mine, 'queued', now, undefined, summary.waitingOn ?? (run ? `${run.id} ${run.label}` : undefined));
  return null;
}

/** Jobs you peeked at (overlay hidden until Show progress). Kept per browser tab; storage failures are ignored. */
export class PeekMemory {
  private ids: string[];
  constructor(private storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeSession(), private key = 'muster.intelPeek') {
    let ids: unknown = [];
    try { ids = JSON.parse(this.storage?.getItem(this.key) ?? '[]'); } catch { /* ignore */ }
    this.ids = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
  }
  isPeeked(jobId: string): boolean { return this.ids.includes(jobId); }
  peek(jobId: string): void { if (!this.isPeeked(jobId)) { this.ids = [...this.ids, jobId].slice(-20); this.save(); } }
  show(jobId: string): void { if (this.isPeeked(jobId)) { this.ids = this.ids.filter((x) => x !== jobId); this.save(); } }
  private save(): void { try { this.storage?.setItem(this.key, JSON.stringify(this.ids)); } catch { /* ignore */ } }
}

function safeSession(): Storage | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}
