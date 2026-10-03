// Per-job progress for the Intel page's research-in-progress overlay, and the Bulletin board note when a job ends
// (docs/ARCHITECTURE.md, Competitive intelligence → "Research in progress"). Counters are bumped as scout records
// and browses, so the overlay is fed from the small `intel` summary rather than the whole store.
import type {
  IntelArea, IntelJob, IntelJobNote, IntelJobProgress, IntelJobView, IntelLabel, IntelStore, MusterState, Note,
} from '../types.js';
import { siteForHost } from '../browser/sites.js';
import { HUMAN, nowIso, postNote, SYSTEM } from './board.js';

const MAX_LIST = 10;
const MAX_LATEST = 160;

/** Which research area a `record_intel` kind feeds (finding and change carry their own). Undefined = not a claim (profile, sample). */
export function recordArea(kind: string, item: Record<string, any> | undefined): IntelArea | undefined {
  switch (kind) {
    case 'capability': return 'features';
    case 'theme': return 'reviews';
    case 'social': case 'social_insight': return 'marketing';
    case 'plan': return 'roadmap';
    case 'scenario': return 'pricing';
    case 'filing': return 'financials';
    case 'positioning': case 'insight': case 'opportunity': return 'gaps';
    case 'finding': case 'change': return typeof item?.area === 'string' ? (item.area as IntelArea) : undefined;
    default: return undefined;
  }
}

/** The one-line text of a recorded claim for "Latest: …". */
export function claimText(kind: string, item: Record<string, any> | undefined): string | undefined {
  if (!item) return undefined;
  const t = kind === 'capability' ? item.name
    : kind === 'social_insight' ? item.text
    : kind === 'scenario' ? item.name
    : kind === 'filing' ? `Companies House: ${item.status ?? 'filing'}`
    : kind === 'social' ? `${item.channel ?? 'social'}: ${item.presence ?? ''}`.trim()
    : item.title;
  if (typeof t !== 'string' || !t.trim()) return undefined;
  const s = t.trim().replace(/\s+/g, ' ');
  return s.length > MAX_LATEST ? `${s.slice(0, MAX_LATEST - 1)}…` : s;
}

/** The label of a stored claim (a capability's is that of its newest cell). */
function claimLabel(kind: string, stored: Record<string, any> | undefined): IntelLabel {
  if (stored && typeof stored.label === 'string') return stored.label as IntelLabel;
  if (kind === 'capability' && stored?.cells) {
    const cells = Object.values(stored.cells as Record<string, { label?: IntelLabel }>);
    return cells.at(-1)?.label ?? 'fact';
  }
  if (kind === 'opportunity' && stored?.opportunity?.claim?.label) return stored.opportunity.claim.label;
  return kind === 'theme' || kind === 'social_insight' ? 'opinion' : 'fact';
}

const progressOf = (job: IntelJob): IntelJobProgress => (job.progress ??= { claims: 0, areas: {} });

/** After a record_intel / add_opportunity during `job`: one more claim in its area, the latest claim line. */
export function trackClaim(job: IntelJob | undefined, kind: string, item: Record<string, any> | undefined, stored?: unknown): void {
  if (!job) return;
  const area = recordArea(kind, (stored as Record<string, any>) ?? item) ?? recordArea(kind, item);
  if (!area) return;
  const p = progressOf(job);
  p.claims++;
  p.areas[area] = (p.areas[area] ?? 0) + 1;
  p.current = area;
  const text = claimText(kind, (stored as Record<string, any>) ?? item) ?? claimText(kind, item);
  if (text) p.latest = { text, label: claimLabel(kind, stored as Record<string, any>), at: nowIso() };
}

/** A friendly name for the page scout is on: known sites by label, stores by name, else the bare host. */
export function siteName(url: string): string {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return url.slice(0, 60); }
  if (host === 'apps.apple.com') return 'App Store';
  if (host === 'play.google.com') return 'Google Play';
  if (host.endsWith('company-information.service.gov.uk')) return 'Companies House';
  if (host.endsWith('capterra.com')) return 'Capterra';
  const known = siteForHost(host);
  if (known) return known.label;
  return host.replace(/^www\./, '');
}

const pushOnce = (list: string[] | undefined, v: string): string[] => {
  const out = list ?? [];
  if (!out.includes(v) && out.length < MAX_LIST) out.push(v);
  return out;
};

/** After every browse call for `job`: the page counter, what it's reading, blocks and missing sign-ins. */
export function trackPage(job: IntelJob, page: { url?: string; blocked?: string; loggedIn?: boolean; mode?: string } = {}): void {
  job.pagesBrowsed++;
  if (!page.url) return;
  const p = progressOf(job);
  p.reading = { url: page.url, site: siteName(page.url), at: nowIso() };
  let host = '';
  try { host = new URL(page.url).hostname.toLowerCase().replace(/^www\./, ''); } catch { /* not a URL */ }
  if (page.blocked && host) p.blocked = pushOnce(p.blocked, host);
  const known = host ? siteForHost(host) : undefined;
  if (known && page.loggedIn === false && page.mode !== 'public' && !page.blocked) p.notSignedIn = pushOnce(p.notSignedIn, known.label);
}

/** The overlay's view of a job (summary.runningJob / summary.queue). */
export function jobView(store: Pick<IntelStore, 'competitors'>, job: IntelJob): IntelJobView {
  return {
    competitorIds: job.competitorIds,
    names: job.competitorIds.map((id) => store.competitors.find((c) => c.id === id)?.name ?? id),
    areas: job.areas,
    depth: job.depth,
    by: job.by,
    pages: job.pagesBrowsed,
    ...(job.progress ? { progress: job.progress } : {}),
  };
}

// ------------------------------------------------------------------ the Bulletin board note

/** Jobs that get a note when they end: research of competitors. Checks and re-checks note only on a verdict change (intelcheck). */
export const NOTE_KINDS: IntelJob['kind'][] = ['competitor', 'sweep', 'watch'];

/** "Padlet", "Padlet and Wakelet", "Padlet, Wakelet and Linoit". */
export function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? 'Competitor';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** "9m 12s", "45s", "1h 4m". */
export function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What a job found, counted when it ends. */
export function jobNoteData(store: IntelStore, state: MusterState, job: IntelJob, outcome: IntelJobNote['outcome']): IntelJobNote {
  const vs = new Set(job.competitorIds);
  const touches = (ids: string[]) => ids.some((id) => vs.has(id));
  const caps = store.capabilities;
  const p = job.progress;
  const started = Date.parse(job.startedAt ?? job.queuedAt);
  const ended = Date.parse(job.finishedAt ?? nowIso());
  const reasons: string[] = [];
  if (outcome === 'stopped') {
    if (job.status === 'cancelled') reasons.push('The Captain cancelled it');
    else if (job.error) reasons.push(`scout stopped: ${job.error}`);
    if (p?.blocked?.length) {
      const one = p.blocked.length === 1;
      reasons.push(`${nameList(p.blocked)} blocked the research browser; read ${one ? 'its public page' : 'their public pages'} instead`);
    }
    if (p?.notSignedIn?.length) reasons.push(`${nameList(p.notSignedIn)} not signed in`);
  }
  return {
    jobId: job.id,
    kind: job.kind,
    outcome,
    competitorIds: job.competitorIds,
    names: job.competitorIds.map((id) => store.competitors.find((c) => c.id === id)?.name ?? id),
    sources: job.sourcesRead ?? job.pagesBrowsed,
    durationMs: Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : 0,
    claims: p?.claims ?? 0,
    areas: p ? Object.values(p.areas).filter((n) => (n ?? 0) > 0).length : 0,
    gaps: caps.filter((c) => c.verdict === 'gap' && touches(c.verdictVs)).length,
    edges: caps.filter((c) => c.verdict === 'edge' && touches(c.verdictVs)).length,
    open: caps.filter((c) => c.verdict === 'open' && job.competitorIds.some((id) => c.cells[id])).length,
    ideas: (state.research?.ideas ?? []).filter((i) => i.origin === 'intel' && i.runId === job.id).length,
    ...(reasons.length ? { reasons } : {}),
  };
}

/** Title and body of the note ("Figma research is ready" / "Read 41 sources in 9m 12s. 38 claims across 9 areas."). */
export function jobNoteText(d: IntelJobNote): { title: string; body: string } {
  const who = nameList(d.names);
  const what = d.kind === 'watch' ? 're-check' : 'research';
  if (d.outcome === 'ready') {
    const read = d.sources > 0 ? `Read ${plural(d.sources, 'source')} in ${durationText(d.durationMs)}.` : `Finished in ${durationText(d.durationMs)}.`;
    const found = d.claims > 0 ? ` ${plural(d.claims, 'claim')} across ${plural(d.areas, 'area')}.` : ' Nothing new recorded.';
    return { title: `${who} ${what} is ready`, body: read + found };
  }
  const kept = d.claims > 0 ? `Kept ${plural(d.claims, 'claim')}.` : 'Nothing was recorded.';
  const why = d.reasons?.length ? ` ${d.reasons.join('. ')}.` : '';
  return { title: `${who} ${what} stopped early`, body: kept + why };
}

/**
 * Posts the "research is ready" / "stopped early" note to you (open, Needs you) for a competitor, sweep or watch job.
 * Returns undefined for check / recheck jobs (their verdict-change note is intelcheck's).
 */
export function postJobNote(store: IntelStore, state: MusterState, job: IntelJob, outcome: IntelJobNote['outcome']): Note | undefined {
  if (!NOTE_KINDS.includes(job.kind)) return undefined;
  const data = jobNoteData(store, state, job, outcome);
  const { title, body } = jobNoteText(data);
  const scout = state.agents.find((a) => a.role === 'research');
  const note = postNote(state, { actor: scout?.id ?? SYSTEM, type: 'system', to: HUMAN, topic: 'intel', text: `${title}\n${body}` });
  note.open = true;
  delete note.taskId;
  delete note.branch;
  note.intel = data;
  return note;
}
