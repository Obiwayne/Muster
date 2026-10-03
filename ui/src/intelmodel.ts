// Pure view-model helpers for the Intel page (no DOM): labels, verdict chips, cell pills, theme shares,
// the thin-evidence rule, roadmap status of an intel idea, and matrix filters.
import type {
  BrowseMode, CapabilityCell, CapabilityVerdict, IntelArea, IntelCapability, IntelClaim, IntelCompetitor, IntelConfidence, IntelJob, IntelLabel,
  IntelSample, IntelSource, IntelStore, IntelTheme, ResearchIdea, Roadmap,
} from '../../src/types';

// ---------------------------------------------------------------- tabs

export const INTEL_TABS = [
  'overview', 'features', 'roadmaps', 'reviews', 'opportunities', 'audience', 'pricing', 'marketing', 'team', 'ai', 'financials', 'changes',
] as const;
export type IntelTab = (typeof INTEL_TABS)[number];
export const TAB_LABELS: Record<IntelTab, string> = {
  overview: 'Overview', features: 'Features', roadmaps: 'Roadmaps', reviews: 'Reviews & social', opportunities: 'Opportunities',
  audience: 'Audience', pricing: 'Pricing', marketing: 'Marketing', team: 'Team', ai: 'AI', financials: 'Financials', changes: 'Changes',
};
export function parseTab(raw: string | null | undefined): IntelTab {
  return (INTEL_TABS as readonly string[]).includes(raw ?? '') ? (raw as IntelTab) : 'overview';
}

// ---------------------------------------------------------------- labels, dates, sources

export const LABEL_TEXT: Record<IntelLabel, string> = { fact: 'Fact', opinion: 'Customer opinion', prediction: 'Prediction' };
/** CSS class of the label dot: white fact, orange opinion, violet prediction. */
export function labelDotClass(label: IntelLabel): string {
  return `ld-${label}`;
}

export const AREA_LABELS: Record<IntelArea, string> = {
  features: 'Features', roadmap: 'Roadmap & launches', reviews: 'Reviews & pain points', gaps: 'Gaps & opportunities', audience: 'Audience',
  pricing: 'Pricing scenarios', ai: 'AI use', financials: 'Companies House', team: 'Team & hiring', marketing: 'Marketing & social', org: 'Org chart',
};
/** Short area names for change-log rows. */
export const AREA_SHORT: Record<IntelArea, string> = {
  features: 'Features', roadmap: 'Roadmap', reviews: 'Reviews', gaps: 'Gaps', audience: 'Audience', pricing: 'Pricing', ai: 'AI',
  financials: 'Filings', team: 'Hiring', marketing: 'Marketing', org: 'Org',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-10-02" (or an ISO time) → "2 Oct 2026"; `short` drops the year. Unparseable input comes back as is. */
export function fmtDate(d: string | undefined, short = false): string {
  if (!d) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return d;
  const day = Number(m[3]);
  const mon = MONTHS[Number(m[2]) - 1] ?? m[2];
  return short ? `${day} ${mon}` : `${day} ${mon} ${m[1]}`;
}

export function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] ?? url; }
}

/** Distinct sources of a claim, by url (or title for own-app sources). */
export function sourceCount(sources: IntelSource[]): number {
  return new Set(sources.map((s) => s.url ?? s.title)).size;
}

/** "Fact · high · 3 sources · 2 Oct 2026": the meta line every claim carries. */
export function claimMeta(c: IntelClaim): string {
  const n = sourceCount(c.sources);
  return [LABEL_TEXT[c.label], `${c.confidence} confidence`, `${n} source${n === 1 ? '' : 's'}`, fmtDate(c.asOf)].join(' · ');
}

/** "App Store · Padlet · 2★ · 14 Sep 2026" for one source (its own date when it has one, else when scout read it). */
export function sourceLine(s: IntelSource): string {
  return [s.title, fmtDate(s.publishedAt ?? s.seenAt)].filter(Boolean).join(' · ');
}

/** Safe external link: http(s) only. */
export function safeHref(url: string | undefined): string | undefined {
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}

// ---------------------------------------------------------------- companies

/** Chart/chip colour per colour slot (us is always the crew teal). */
export const COMPANY_COLOURS = ['#F27BA0', '#7FA0FF', '#E8C547', '#3FB68B', '#C08BFF', '#FF9F5A', '#5ED1E8', '#B8B8C0'];
export function companyColour(c: Pick<IntelCompetitor, 'isUs' | 'colour'> | undefined): string {
  if (!c) return 'var(--color-faint)';
  if (c.isUs) return 'var(--color-crew)';
  return COMPANY_COLOURS[((c.colour % 8) + 8) % 8]!;
}

/** Tracked companies in display order: us first, then the others as added; removed ones hidden. */
export function trackedCompanies(store: Pick<IntelStore, 'competitors'>): IntelCompetitor[] {
  const live = store.competitors.filter((c) => !c.removed);
  return [...live.filter((c) => c.isUs || c.id === 'us'), ...live.filter((c) => !(c.isUs || c.id === 'us'))];
}
export function rivals(store: Pick<IntelStore, 'competitors'>): IntelCompetitor[] {
  return trackedCompanies(store).filter((c) => !(c.isUs || c.id === 'us'));
}
export function companyName(store: Pick<IntelStore, 'competitors'>, id: string | undefined): string {
  if (!id) return 'Market-wide';
  return store.competitors.find((c) => c.id === id)?.name ?? id;
}

// ---------------------------------------------------------------- feature matrix

export type MatrixFilter = 'all' | 'gap' | 'edge' | 'open';
export function matrixCounts(caps: IntelCapability[]): Record<MatrixFilter, number> & { parity: number } {
  const n = (v: CapabilityVerdict) => caps.filter((c) => c.verdict === v).length;
  return { all: caps.length, gap: n('gap'), edge: n('edge'), open: n('open'), parity: n('parity') };
}
export function filterCapabilities(caps: IntelCapability[], f: MatrixFilter): IntelCapability[] {
  return f === 'all' ? caps : caps.filter((c) => c.verdict === f);
}
/** "3 gaps · 3 edges · 1 open" */
export function matrixSummary(caps: IntelCapability[]): string {
  const c = matrixCounts(caps);
  const p = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return [p(c.gap, 'gap', 'gaps'), p(c.edge, 'edge', 'edges'), `${c.open} open`].join(' · ');
}

export interface Pill { text: string; cls: string }
/** One matrix cell: "Yes", "Partial", "Paid tier", "Plan M3", "Missing"… (a note like "3 walls" replaces the word). */
export function cellPill(cell: CapabilityCell | undefined, isUs = false): Pill {
  if (!cell) return { text: '?', cls: 'unknown' };
  switch (cell.status) {
    case 'yes': return { text: cell.note || 'Yes', cls: 'yes' };
    case 'partial': return { text: cell.note || 'Partial', cls: 'partial' };
    case 'paid': return { text: cell.note || 'Paid tier', cls: 'paid' };
    case 'planned': return { text: isUs ? (cell.stageId ? `Plan ${cell.stageId}` : 'Planned') : cell.note || 'Planned', cls: 'planned' };
    case 'missing': return { text: cell.note || 'Missing', cls: isUs ? 'missing' : 'none' };
    default: return { text: cell.note || 'None', cls: 'none' };
  }
}

export interface VerdictChip { text: string; verdict: CapabilityVerdict; pending: boolean; title: string }
/**
 * The "For us" chip of a matrix row. Gap: "Gap · R12" (its idea), "Gap · closing M5" (we plan it), else "Gap vs Padlet".
 * Edge: "Edge at M3" (planned, nobody has it), "Edge vs Padlet", "Edge vs 2". Open: "Open · be first". Parity: "Parity".
 * `pending` = planned work (drawn dashed in the design).
 */
export function verdictChip(cap: IntelCapability, store: Pick<IntelStore, 'competitors'>, ideas: Pick<ResearchIdea, 'id' | 'opportunity'>[] = []): VerdictChip {
  const names = cap.verdictVs.map((id) => companyName(store, id));
  const vs = names.length === 1 ? names[0] : `${names.length}`;
  const title = names.length ? `${cap.verdict === 'gap' ? 'They have it' : 'They lack it'}: ${names.join(', ')}` : '';
  switch (cap.verdict) {
    case 'gap': {
      if (cap.verdictStage) return { text: `Gap · closing ${cap.verdictStage}`, verdict: 'gap', pending: true, title };
      if (cap.ideaId) {
        const test = ideas.find((i) => i.id === cap.ideaId)?.opportunity?.testFirst;
        return { text: `Gap · ${cap.ideaId}${test ? ' test' : ''}`, verdict: 'gap', pending: false, title };
      }
      return { text: names.length ? `Gap vs ${vs}` : 'Gap', verdict: 'gap', pending: false, title };
    }
    case 'edge':
      if (cap.verdictStage) return { text: `Edge at ${cap.verdictStage}`, verdict: 'edge', pending: true, title };
      return { text: names.length ? `Edge vs ${vs}` : 'Edge', verdict: 'edge', pending: false, title };
    case 'open':
      return { text: 'Open · be first', verdict: 'open', pending: false, title: 'Nobody does it yet' };
    default:
      return { text: 'Parity', verdict: 'parity', pending: false, title: 'Everyone has some of it' };
  }
}

/** Latest date any cell of these rows was checked ("checked 2 Oct 2026"). */
export function lastChecked(caps: IntelCapability[]): string | undefined {
  let best: string | undefined;
  for (const c of caps) for (const cell of Object.values(c.cells)) if (!best || cell.asOf > best) best = cell.asOf;
  return best;
}

// ---------------------------------------------------------------- themes and samples

/** Share of the reviewed sample, in whole percent. */
export function shareOfSample(t: Pick<IntelTheme, 'mentions' | 'sampleSize'>): number {
  return t.sampleSize > 0 ? Math.round((t.mentions / t.sampleSize) * 100) : 0;
}
/** Fewer than 5 independent sources: shown as "thin evidence", never as a finding. */
export const THIN_SOURCES = 5;
export function isThin(t: Pick<IntelTheme, 'independentSources'>): boolean {
  return t.independentSources < THIN_SOURCES;
}
/** Complaint themes that count as findings, biggest first (thin and love themes excluded). */
export function complaintThemes(themes: IntelTheme[]): IntelTheme[] {
  return themes.filter((t) => !t.love && !isThin(t)).sort((a, b) => shareOfSample(b) - shareOfSample(a) || b.mentions - a.mentions);
}
export function thinThemes(themes: IntelTheme[]): IntelTheme[] {
  return themes.filter((t) => isThin(t));
}
export function loveThemes(themes: IntelTheme[]): IntelTheme[] {
  return themes.filter((t) => t.love && !isThin(t)).sort((a, b) => b.mentions - a.mentions);
}
/** Themes as seen for one competitor (mentions = theirs). `null` = all. */
export function themesFor(themes: IntelTheme[], competitorId: string | null): IntelTheme[] {
  if (!competitorId) return themes;
  return themes.filter((t) => (t.byCompetitor[competitorId] ?? 0) > 0).map((t) => ({ ...t, mentions: t.byCompetitor[competitorId] ?? 0 }));
}

/** "412 reviews + 63 threads, last 12 months" (reviews = store/review-site counts; threads = forums/reddit). */
export function sampleLine(s: IntelSample | undefined, sep = ' + '): string {
  if (!s) return 'no reviewed sample yet';
  const reviewKinds = new Set(['app_store', 'google_play', 'g2', 'capterra']);
  const threadKinds = new Set(['reddit', 'forum']);
  const sum = (set: Set<string>) => s.counts.filter((c) => set.has(c.kind)).reduce((a, c) => a + c.n, 0);
  const reviews = sum(reviewKinds);
  const threads = sum(threadKinds);
  const parts = [reviews && `${reviews} reviews`, threads && `${threads} threads`].filter(Boolean) as string[];
  if (!parts.length) parts.push(`${s.total} items`);
  return `${parts.join(sep)}${sep === ' + ' ? ', ' : ' · '}${s.window}`;
}

export const SEVERITY_TEXT: Record<IntelTheme['severity'], string> = { severe: 'Severe', high: 'High', medium: 'Medium', low: 'Low' };
export const TREND_TEXT: Record<IntelTheme['trend'], string> = { rising: '↑ rising', steady: '→ steady', easing: '↓ easing', new: '• new' };

/** The tag on a theme row: Our edge / Opportunity R7 / Watch / Win them over. */
export function themeTag(t: Pick<IntelTheme, 'ourAnswer'>): { text: string; cls: string } | null {
  const a = t.ourAnswer;
  if (!a) return null;
  switch (a.kind) {
    case 'edge': return { text: 'Our edge', cls: 'edge' };
    case 'opportunity': return { text: a.ideaId ? `Opportunity ${a.ideaId}` : 'Opportunity', cls: 'open' };
    case 'watch': return { text: 'Watch', cls: 'watch' };
    default: return { text: 'Win them over', cls: 'edge' };
  }
}

/** Compact counts: 96000 → "96k", 1200 → "1.2k", 400 → "0.4k" only when asked. */
export function compact(n: number | undefined): string {
  if (n === undefined) return '—';
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

// ---------------------------------------------------------------- intel ideas on the roadmap

export type IdeaRoadmapStatus = { text: string; cls: 'on' | 'talking' | 'test' | 'parked' | 'none' };
/** On Mx when it has a goal; Talking when its thread is waiting on an answer or carries advice; Test first; Parked; else Not yet. */
export function ideaRoadmapStatus(idea: Pick<ResearchIdea, 'goalId' | 'thread' | 'status' | 'opportunity'>, roadmap: Pick<Roadmap, 'goals'> | null | undefined): IdeaRoadmapStatus {
  if (idea.goalId) {
    const stage = roadmap?.goals.find((g) => g.id === idea.goalId)?.stageId;
    return { text: stage ? `On ${stage}` : `On ${idea.goalId}`, cls: 'on' };
  }
  if (idea.status === 'new' && idea.thread.length > 0) return { text: 'Talking', cls: 'talking' };
  if (idea.opportunity?.testFirst) return { text: 'Test first', cls: 'test' };
  if (idea.opportunity?.priority === 'parked') return { text: 'Parked', cls: 'parked' };
  return { text: 'Not yet', cls: 'none' };
}

// ---------------------------------------------------------------- jobs

const JOB_KIND: Record<IntelJob['kind'], string> = {
  competitor: 'researching', sweep: 'sweeping', check: 'checking', recheck: 're-checking', watch: 'watching for changes at',
};
/** "scout is researching Padlet · 9 areas · 12 pages" */
export function jobLine(job: IntelJob, store: Pick<IntelStore, 'competitors'>): string {
  const who = job.ideaId ? job.ideaId : job.competitorIds.length ? job.competitorIds.map((id) => companyName(store, id)).join(', ') : 'every competitor';
  const parts = [`scout is ${JOB_KIND[job.kind]} ${who}`];
  if (job.kind === 'competitor' || job.kind === 'sweep') parts.push(`${job.areas.length} area${job.areas.length === 1 ? '' : 's'}`);
  parts.push(`${job.pagesBrowsed} page${job.pagesBrowsed === 1 ? '' : 's'} read`);
  return parts.join(' · ');
}
export function runningJob(store: Pick<IntelStore, 'jobs'>): IntelJob | undefined {
  return store.jobs.find((j) => j.status === 'running');
}
export function queuedJobs(store: Pick<IntelStore, 'jobs'>): IntelJob[] {
  return store.jobs.filter((j) => j.status === 'queued');
}

export const BROWSE_LABEL: Record<BrowseMode, string> = { profile: 'research profile', public: 'public pages', opera: 'Opera sign-ins' };

export const CONFIDENCE_RANK: Record<IntelConfidence, number> = { high: 3, medium: 2, low: 1 };

/** Distinct source urls across the whole store (the "214 sources" line, when the summary isn't loaded). */
export function storeSources(store: IntelStore): number {
  const urls = new Set<string>();
  const add = (c: { sources: IntelSource[] }) => c.sources.forEach((s) => urls.add(s.url ?? s.title));
  store.capabilities.forEach((cap) => Object.values(cap.cells).forEach(add));
  [store.themes, store.social, store.socialInsights, store.plans, store.findings, store.scenarios, store.filings, store.insights, store.changes]
    .forEach((list) => (list as { sources: IntelSource[] }[]).forEach(add));
  if (store.positioning) add(store.positioning);
  return urls.size;
}

/** Unseen changes (the dot on the Changes tab). */
export function unseenChanges(store: Pick<IntelStore, 'changes'>): number {
  return store.changes.filter((c) => !c.seen).length;
}
