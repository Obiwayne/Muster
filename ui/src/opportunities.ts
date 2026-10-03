// Pure view-model for Intel → Opportunities (Vellum 5547-0): which ideas and matrix rows go in "What we're missing"
// (gaps), "Nobody does it · be first" (open) and "Where we win · protect these" (edges), their order, the
// value-vs-effort points, the at-risk flag and the gap-detail rows. Tested in opportunities.test.ts.
import type {
  IdeaEvidence, IntelCapability, IntelLabel, IntelOpportunity, IntelStore, ResearchIdea, Roadmap,
} from '../../src/types';
import { companyName, fmtDate, ideaRoadmapStatus, rivals, type IdeaRoadmapStatus } from './intelmodel';

export type OppKind = IntelOpportunity['kind'];

export interface OppItem {
  /** The idea (R#) when there is one; matrix rows nobody raised an idea for have none. */
  idea?: ResearchIdea;
  /** The feature-matrix rows behind it. */
  caps: IntelCapability[];
  kind: OppKind;
  id: string; // R# or F#
  title: string;
  status?: IdeaRoadmapStatus; // gaps
  /** Right-hand text on open / edge rows ("0 of 3", "Padlet caps at 3", "Wakelet building it"). */
  note: string;
  /** Edge under threat: who threatens it. */
  atRisk?: string;
  priority: IntelOpportunity['priority'];
  value: number; // 1–5
  effort: number; // 1–5
}

export interface OppGroups {
  gaps: OppItem[];
  open: OppItem[];
  edges: OppItem[];
}

const PRIORITY_RANK: Record<IntelOpportunity['priority'], number> = { now: 0, next: 1, later: 2, parked: 3 };
const IMPACT_VALUE: Record<ResearchIdea['impact'], number> = { high: 4, business: 4, medium: 3, low: 2 };
const EFFORT_SCORE: Record<ResearchIdea['effort'], number> = { S: 2, M: 3, L: 4 };
const num = (id: string) => Number(id.replace(/\D/g, '')) || 0;
const clamp = (n: number) => Math.max(1, Math.min(5, Math.round(n)));

/** Value 1–5 (scout's estimate, else from impact) and effort 1–5 (Captain's/scout's estimate, else from S/M/L). */
export function scores(idea: Pick<ResearchIdea, 'impact' | 'effort' | 'opportunity'>): { value: number; effort: number } {
  return {
    value: clamp(idea.opportunity?.valueScore ?? IMPACT_VALUE[idea.impact] ?? 3),
    effort: clamp(idea.opportunity?.effortScore ?? EFFORT_SCORE[idea.effort] ?? 3),
  };
}

/** Priority of an idea: its opportunity's, else approved = now, else next. */
export function priorityOf(idea: Pick<ResearchIdea, 'status' | 'opportunity'>): IntelOpportunity['priority'] {
  return idea.opportunity?.priority ?? (idea.status === 'approved' ? 'now' : 'next');
}

/**
 * Who threatens an edge: a competitor plan on those rows that is a commitment (planned / in progress) or a
 * prediction of medium+ confidence ("Wakelet building it", "Padlet likely building it"), else the opportunity's atRisk.
 */
export function atRiskOf(caps: Pick<IntelCapability, 'id'>[], store: Pick<IntelStore, 'plans' | 'competitors'>, opp?: Pick<IntelOpportunity, 'atRisk'>): string | undefined {
  if (opp?.atRisk) return opp.atRisk;
  const ids = new Set(caps.map((c) => c.id));
  const plan = store.plans.find((p) => p.capabilityIds.some((id) => ids.has(id))
    && ((p.kind === 'commitment' && (p.status === 'planned' || p.status === 'in_progress' || !p.status))
      || (p.kind === 'prediction' && p.confidence !== 'low')));
  if (!plan) return undefined;
  return `${companyName(store, plan.competitorId)} ${plan.kind === 'prediction' ? 'likely building it' : 'building it'}`;
}

function kindOf(idea: ResearchIdea, caps: IntelCapability[]): OppKind | undefined {
  if (idea.opportunity?.kind) return idea.opportunity.kind;
  const v = caps[0]?.verdict;
  return v === 'gap' || v === 'open' || v === 'edge' ? v : undefined;
}

/** "Padlet caps at 3" / "vs Padlet" for an edge; "2 of 3 weak"; "0 of 3" for open. */
function capNote(kind: OppKind, caps: IntelCapability[], store: Pick<IntelStore, 'competitors'>): string {
  const n = rivals(store).length;
  if (kind === 'open') return n ? `0 of ${n}` : '';
  const c = caps[0];
  if (!c) return '';
  if (kind === 'edge') {
    if (c.verdictStage) return `ours at ${c.verdictStage}`;
    if (c.verdictVs.length === 1) {
      const id = c.verdictVs[0];
      const note = c.cells[id]?.note;
      return note ? `${companyName(store, id)}: ${note}` : `vs ${companyName(store, id)}`;
    }
    return n ? `${c.verdictVs.length} of ${n} lack it` : '';
  }
  return c.verdictVs.length && n ? `${c.verdictVs.length} of ${n} have it` : '';
}

/**
 * Group the opportunities. Ideas count when scout raised them from intel (origin 'intel') or a matrix row links
 * them (capability.ideaId); rejected ideas are left out. Matrix rows with an edge or open verdict and no idea are
 * listed too (no detail), so "Where we win" shows every edge.
 */
export function groupOpportunities(
  ideas: ResearchIdea[],
  store: Pick<IntelStore, 'capabilities' | 'plans' | 'competitors' | 'checks'>,
  roadmap: Pick<Roadmap, 'goals'> | null | undefined,
): OppGroups {
  const capsByIdea = new Map<string, IntelCapability[]>();
  for (const c of store.capabilities) if (c.ideaId) capsByIdea.set(c.ideaId, [...(capsByIdea.get(c.ideaId) ?? []), c]);
  const out: OppGroups = { gaps: [], open: [], edges: [] };
  const seenIdeas = new Set<string>();

  for (const idea of ideas) {
    if (idea.status === 'rejected') continue;
    const linked = capsByIdea.get(idea.id) ?? [];
    const fromOpp = (idea.opportunity?.capabilityIds ?? []).map((id) => store.capabilities.find((c) => c.id === id)).filter((c): c is IntelCapability => !!c);
    const caps = [...new Map([...linked, ...fromOpp].map((c) => [c.id, c])).values()];
    if (idea.origin !== 'intel' && !linked.length) continue;
    const kind = kindOf(idea, caps);
    if (!kind) continue;
    seenIdeas.add(idea.id);
    const s = scores(idea);
    const atRisk = kind === 'edge' ? atRiskOf(caps, store, idea.opportunity) : undefined;
    const item: OppItem = {
      idea, caps, kind, id: idea.id, title: idea.title, priority: priorityOf(idea), value: s.value, effort: s.effort,
      note: atRisk ?? capNote(kind, caps, store), ...(atRisk ? { atRisk } : {}),
      ...(kind === 'gap' ? { status: ideaRoadmapStatus(idea, roadmap) } : {}),
    };
    (kind === 'gap' ? out.gaps : kind === 'open' ? out.open : out.edges).push(item);
  }
  for (const c of store.capabilities) {
    if (c.ideaId && seenIdeas.has(c.ideaId)) continue;
    if (c.ideaId && ideas.some((i) => i.id === c.ideaId && i.status === 'rejected')) continue;
    if (c.verdict !== 'edge' && c.verdict !== 'open') continue;
    const atRisk = c.verdict === 'edge' ? atRiskOf([c], store) : undefined;
    const item: OppItem = { caps: [c], kind: c.verdict, id: c.id, title: c.name, priority: 'next', value: 3, effort: 3, note: atRisk ?? capNote(c.verdict, [c], store), ...(atRisk ? { atRisk } : {}) };
    (c.verdict === 'open' ? out.open : out.edges).push(item);
  }
  const byPriority = (a: OppItem, b: OppItem) =>
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.value - a.value || a.effort - b.effort || num(a.id) - num(b.id);
  out.gaps.sort(byPriority);
  out.open.sort((a, b) => (a.idea ? 0 : 1) - (b.idea ? 0 : 1) || byPriority(a, b));
  out.edges.sort((a, b) => (b.atRisk ? 1 : 0) - (a.atRisk ? 1 : 0) || (a.idea ? 0 : 1) - (b.idea ? 0 : 1) || num(a.id) - num(b.id));
  return out;
}

/** Every item you can open (has an idea), in list order: the default selection is the first. */
export function selectable(g: OppGroups): OppItem[] {
  return [...g.gaps, ...g.open, ...g.edges].filter((i) => i.idea);
}

// ---------------------------------------------------------------- value vs effort

export type Quadrant = 'quick_win' | 'big_bet' | 'fill_in' | 'money_pit';
export const QUADRANT_TEXT: Record<Quadrant, string> = { quick_win: 'QUICK WIN', big_bet: 'BIG BET', fill_in: 'FILL-IN', money_pit: 'COSTLY' };
export function quadrant(value: number, effort: number): Quadrant {
  const hiV = value >= 3.5;
  const loE = effort <= 2.5;
  return hiV ? (loE ? 'quick_win' : 'big_bet') : (loE ? 'fill_in' : 'money_pit');
}

export interface MatrixPoint { item: OppItem; x: number; y: number; label: string; tone: 'on' | 'sel' | 'idle' | 'parked' | 'open' }

/**
 * Points on the 0..1 matrix (x = effort low→high, y = value high→low, inset so dots stay inside), for gaps and open
 * ideas. Dots sharing a cell are fanned out so none hides another.
 */
export function matrixPoints(g: OppGroups, selectedId: string | null): MatrixPoint[] {
  const items = [...g.gaps, ...g.open].filter((i) => i.idea);
  const pos = (s: number) => 0.1 + ((s - 1) / 4) * 0.8;
  const used = new Map<string, number>();
  return items.map((item) => {
    const cell = `${item.value}:${item.effort}`;
    const k = used.get(cell) ?? 0;
    used.set(cell, k + 1);
    const ang = (k * 2.4);
    const r = k ? 0.06 : 0;
    const x = Math.min(0.95, Math.max(0.05, pos(item.effort) + Math.cos(ang) * r));
    const y = Math.min(0.92, Math.max(0.08, 1 - pos(item.value) + Math.sin(ang) * r));
    const tone: MatrixPoint['tone'] = item.id === selectedId ? 'sel'
      : item.idea?.goalId || item.idea?.status === 'approved' ? 'on'
        : item.priority === 'parked' ? 'parked'
          : item.kind === 'open' ? 'open' : 'idle';
    return { item, x, y, label: item.id === selectedId ? item.id : String(num(item.id)), tone };
  });
}

// ---------------------------------------------------------------- gap detail

export interface EvidenceLine { text: string; label: IntelLabel; meta: string; url?: string }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Sep" for older dates this year, "2 Oct" for recent ones. */
function shortWhen(d: string | undefined, now: number): string {
  if (!d) return '';
  const t = Date.parse(d);
  if (!Number.isFinite(t)) return d;
  if (now - t < 14 * 86_400_000) return fmtDate(d, true);
  const dt = new Date(t);
  return dt.getFullYear() === new Date(now).getFullYear() ? MONTHS[dt.getMonth()] : `${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
}

const EVIDENCE_LABEL: Record<IdeaEvidence['kind'], IntelLabel> = { review: 'opinion', forum: 'opinion', competitor: 'fact', app: 'fact', web: 'fact' };

/** Evidence rows: the opportunity claim's sources (label + date), then the idea's evidence items. */
export function evidenceLines(idea: Pick<ResearchIdea, 'evidence' | 'opportunity'>, now = Date.now()): EvidenceLine[] {
  const out: EvidenceLine[] = [];
  const claim = idea.opportunity?.claim;
  if (claim) {
    for (const s of claim.sources) {
      out.push({ text: s.title, label: claim.label, meta: [claim.label === 'opinion' ? 'opinion' : claim.label, shortWhen(s.publishedAt ?? s.seenAt, now)].filter(Boolean).join(' · '), ...(s.url ? { url: s.url } : {}) });
    }
  }
  for (const e of idea.evidence) {
    const n = e.count ? ` (+${e.count})` : '';
    out.push({ text: `${e.text ? `“${e.text.replace(/^["“]|["”]$/g, '')}” · ` : ''}${e.source}${n}`, label: EVIDENCE_LABEL[e.kind] ?? 'fact', meta: EVIDENCE_LABEL[e.kind] ?? 'fact', ...(e.url ? { url: e.url } : {}) });
  }
  return out;
}

const PRIORITY_TEXT: Record<IntelOpportunity['priority'], string> = { now: 'Now', next: 'Next', later: 'Later', parked: 'Parked' };

export interface DetailRow { key: string; label: string; text?: string; sub?: string }
/** The opportunity fields in the design's order; empty fields are left out. Ideas without fields fall back to the summary. */
export function detailRows(idea: Pick<ResearchIdea, 'summary' | 'effort' | 'opportunity' | 'stageId'>): DetailRow[] {
  const o = idea.opportunity;
  const rows: DetailRow[] = [];
  const add = (key: string, label: string, text?: string, sub?: string) => { if (text?.trim()) rows.push({ key, label, text: text.trim(), ...(sub ? { sub } : {}) }); };
  add('problem', 'Customer problem', o?.problem || idea.summary);
  rows.push({ key: 'evidence', label: 'Evidence' });
  add('alternatives', 'Today they…', o?.alternatives);
  add('proposal', 'Proposed', o?.proposal);
  add('value', 'Value', o?.value);
  if (o?.effortNote?.trim()) {
    const [main, ...rest] = o.effortNote.split(/\s*·\s*(?=needs\b|depends\b|blocked\b)/i);
    add('effort', 'Effort', main, rest.join(' · ') || undefined);
  } else add('effort', 'Effort', { S: 'Small', M: 'Medium', L: 'Large' }[idea.effort], o?.effortScore ? `${o.effortScore}/5 estimate` : undefined);
  if (o?.priority) add('priority', 'Priority', PRIORITY_TEXT[o.priority], undefined);
  add('validation', 'Validate by', o?.validation);
  return rows;
}

/** "MATCH · QUICK WIN" style kicker. */
export function detailKicker(item: Pick<OppItem, 'kind' | 'value' | 'effort' | 'idea'>): string {
  const kind = item.kind === 'gap' ? (item.idea?.opportunity?.testFirst ? 'TEST FIRST' : 'MATCH') : item.kind === 'open' ? 'BE FIRST' : 'PROTECT';
  return `${kind} · ${QUADRANT_TEXT[quadrant(item.value, item.effort)]}`;
}
