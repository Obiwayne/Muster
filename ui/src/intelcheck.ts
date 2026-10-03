// The shared Intel check (Vellum 6644-0, also in Intel → Opportunities 5547-0): one row per area (features,
// complaints, social, their plans, pricing, audience, AI) with its label dot, the verdict chip, confidence and
// sources, coverage "n of 7", and the check's state. Approving an idea needs a done (or skipped) check younger
// than config.intel.checkMaxAgeDays; the server answers 409 otherwise, and the UI offers "Run intel check".
// Pure helpers first (tested in intelcheck.test.ts), then the panel and the approve/run actions.
import './intelcheck.css';
import {
  INTEL_CHECK_AREAS, type IntelCapability, type IntelCheck, type IntelCheckArea, type IntelCheckRow, type IntelStore, type MusterConfig,
  type ResearchIdea,
} from '../../src/types';
import { h, icon, setChildren, toast } from './dom';
import { ApiError, api } from './api';
import { requestCheck } from './intelapi';
import { LABEL_TEXT, claimMeta, companyName, fmtDate, rivals } from './intelmodel';
import { labelDot, openSources } from './intel/common';

// ---------------------------------------------------------------- pure: state of an idea's check

export const CHECK_AREA_LABELS: Record<IntelCheckArea, string> = {
  features: 'Features', complaints: 'Complaints', social: 'Social', plans: 'Their plans', pricing: 'Pricing', audience: 'Audience', ai: 'AI',
};
export const DEFAULT_CHECK_MAX_AGE_DAYS = 14;
const DAY = 86_400_000;

export type CheckState = 'missing' | 'queued' | 'running' | 'stale' | 'done' | 'skipped' | 'failed';

export interface CheckStatus {
  state: CheckState;
  /** The check the panel shows: the newest one for the idea (a queued re-run included). */
  check?: IntelCheck;
  /** The check the approve gate looks at (idea.checkId, else the newest). */
  gate?: IntelCheck;
  /** Whole days since the gate check finished. */
  ageDays?: number;
  /** Approve is allowed (a fresh done/skipped check, or no competitors tracked: the server skips the check). */
  canApprove: boolean;
  /** One line for the panel and the disabled Approve button's tooltip. */
  reason: string;
  /** "Run intel check" (or "Run it again") makes sense. */
  canRun: boolean;
}

type CheckCfg = Pick<MusterConfig, 'intel'> | null | undefined;
const maxAge = (cfg: CheckCfg) => {
  const n = cfg?.intel?.checkMaxAgeDays;
  return typeof n === 'number' && n > 0 ? n : DEFAULT_CHECK_MAX_AGE_DAYS;
};
const idNum = (id: string) => Number(id.replace(/\D/g, '')) || 0;

/** Every check written for the idea, newest first. */
export function checksFor(idea: Pick<ResearchIdea, 'id' | 'checkId'>, store: Pick<IntelStore, 'checks'> | null | undefined): IntelCheck[] {
  return (store?.checks ?? []).filter((c) => c.ideaId === idea.id || c.id === idea.checkId).sort((a, b) => idNum(b.id) - idNum(a.id));
}

/** The state of an idea's intel check, and whether Approve may be pressed. */
export function checkStatus(
  idea: Pick<ResearchIdea, 'id' | 'checkId'>,
  store: Pick<IntelStore, 'checks' | 'competitors' | 'jobs'> | null | undefined,
  config: CheckCfg,
  now = Date.now(),
): CheckStatus {
  const all = checksFor(idea, store);
  const newest = all[0];
  const gate = (idea.checkId && all.find((c) => c.id === idea.checkId)) || all.find((c) => c.status === 'done' || c.status === 'skipped') || newest;
  const days = maxAge(config);
  const noRivals = !!store && rivals(store).length === 0;

  let ageDays: number | undefined;
  let fresh = false;
  if (gate && (gate.status === 'done' || gate.status === 'skipped')) {
    const t = Date.parse(gate.doneAt ?? gate.createdAt);
    const age = Number.isFinite(t) ? Math.max(0, now - t) : Infinity;
    ageDays = Number.isFinite(age) ? Math.floor(age / DAY) : undefined;
    fresh = age < days * DAY;
  }
  const canApprove = fresh || (!gate && noRivals);

  if (newest && (newest.status === 'queued' || newest.status === 'running')) {
    const job = newest.jobId ? store?.jobs.find((j) => j.id === newest.jobId) : undefined;
    const running = newest.status === 'running' || job?.status === 'running';
    const n = store ? rivals(store).length : 0;
    return {
      state: running ? 'running' : 'queued', check: newest, gate, ageDays, canApprove, canRun: false,
      reason: running
        ? `scout is checking this idea against ${n} competitor${n === 1 ? '' : 's'}…`
        : `Intel check queued${newest.jobId ? ` (${newest.jobId})` : ''}. scout starts it when it's free.`,
    };
  }
  if (!gate) {
    if (noRivals) {
      return { state: 'skipped', canApprove: true, canRun: false, reason: 'No competitors tracked, so there is nothing to check against. Approving skips the check.' };
    }
    return { state: 'missing', canApprove: false, canRun: true, reason: 'No intel check yet. Approving needs one.' };
  }
  if (gate.status === 'failed') {
    return { state: 'failed', check: gate, gate, canApprove: false, canRun: true, reason: 'The last intel check failed. Run it again before approving.' };
  }
  if (!fresh) {
    return {
      state: 'stale', check: gate, gate, ageDays, canApprove: false, canRun: true,
      reason: `Checked ${ageDays ?? '?'} days ago. Checks older than ${days} days need a fresh one before you approve.`,
    };
  }
  if (gate.status === 'skipped') {
    return { state: 'skipped', check: gate, gate, ageDays, canApprove: true, canRun: rivals(store ?? { competitors: [] }).length > 0, reason: gate.skippedReason ? `Skipped: ${gate.skippedReason}.` : 'Skipped: no competitors tracked.' };
  }
  return {
    state: 'done', check: gate, gate, ageDays, canApprove: true, canRun: true,
    reason: `Checked ${ageDays === 0 ? 'today' : ageDays === 1 ? 'yesterday' : `${ageDays} days ago`}${gate.revision > 1 ? ` · revision ${gate.revision}` : ''}`,
  };
}

/** "7 of 7": areas with a row. */
export function coverage(check: Pick<IntelCheck, 'rows'> | undefined): number {
  if (!check) return 0;
  return new Set(check.rows.map((r) => r.area).filter((a) => INTEL_CHECK_AREAS.includes(a))).size;
}

/** Rows in display order, one per area; missing areas are undefined. */
export function rowsByArea(check: Pick<IntelCheck, 'rows'> | undefined): { area: IntelCheckArea; row?: IntelCheckRow }[] {
  return INTEL_CHECK_AREAS.map((area) => ({ area, row: check?.rows.find((r) => r.area === area) }));
}

export type ChipTone = 'gap' | 'edge' | 'open' | 'parity' | 'unclear' | 'none' | 'running';
export interface CheckChip {
  text: string;
  tone: ChipTone;
  /** Planned work or an edge at risk: drawn outlined/with a marker in the design. */
  pending: boolean;
  /** Edges get a caret instead of a dot. */
  mark: 'dot' | 'ring' | 'up' | 'spin';
  stale: boolean;
  title: string;
}

function linkedCaps(check: Pick<IntelCheck, 'capabilityIds'>, store: Pick<IntelStore, 'capabilities'>): IntelCapability[] {
  return check.capabilityIds.map((id) => store.capabilities.find((c) => c.id === id)).filter((c): c is IntelCapability => !!c);
}

/**
 * The verdict chip on an idea card (6644-0): "Edge · at risk", "Edge vs Padlet", "Gap · 2 of 3 have it", "Gap · closing M5",
 * "Open · be first"; "No intel check" / "Checking…" while there is none; a stale check keeps its verdict, marked stale.
 */
export function checkChip(
  idea: Pick<ResearchIdea, 'id' | 'checkId'>,
  store: Pick<IntelStore, 'checks' | 'competitors' | 'jobs' | 'capabilities'> | null | undefined,
  config: CheckCfg,
  now = Date.now(),
): CheckChip {
  const st = checkStatus(idea, store, config, now);
  const base = { pending: false, stale: false, title: st.reason };
  if (st.state === 'queued' || st.state === 'running') {
    const prev = st.gate && st.gate !== st.check && (st.gate.status === 'done') ? st.gate : undefined;
    if (!prev) return { ...base, text: st.state === 'running' ? 'Checking…' : 'Check queued', tone: 'running', mark: 'spin' };
  }
  if (st.state === 'missing') return { ...base, text: 'No intel check', tone: 'none', mark: 'ring' };
  if (st.state === 'failed') return { ...base, text: 'Check failed', tone: 'none', mark: 'ring' };
  if (st.state === 'skipped') return { ...base, text: 'No competitors', tone: 'none', mark: 'ring' };
  const check = st.gate!;
  const caps = store ? linkedCaps(check, store) : [];
  const n = store ? rivals(store).length : 0;
  const stale = st.state === 'stale';
  const chip = (text: string, tone: ChipTone, mark: CheckChip['mark'], pending = false): CheckChip =>
    ({ text: stale ? `${text} · stale` : text, tone, mark, pending, stale, title: check.verdictText || st.reason });
  switch (check.verdict) {
    case 'edge_at_risk': return chip('Edge · at risk', 'edge', 'up', true);
    case 'edge': {
      const stage = caps.find((c) => c.verdictStage && c.verdict === 'edge')?.verdictStage;
      if (stage) return chip(`Edge at ${stage}`, 'edge', 'up', true);
      const vs = [...new Set(caps.flatMap((c) => (c.verdict === 'edge' ? c.verdictVs : [])))];
      if (vs.length === 1) return chip(`Edge vs ${companyName(store!, vs[0])}`, 'edge', 'up');
      if (vs.length > 1) return chip(`Edge vs ${vs.length}`, 'edge', 'up');
      return chip('Edge', 'edge', 'up');
    }
    case 'gap': {
      const stage = caps.find((c) => c.verdict === 'gap' && c.verdictStage)?.verdictStage;
      if (stage) return chip(`Gap · closing ${stage}`, 'gap', 'ring', true);
      const have = new Set(caps.flatMap((c) => (c.verdict === 'gap' ? c.verdictVs : []))).size;
      if (have && n) return chip(`Gap · ${have} of ${n} have it`, 'gap', 'dot');
      return chip('Gap', 'gap', 'dot');
    }
    case 'open': return chip('Open · be first', 'open', 'dot');
    case 'parity': return chip('Parity', 'parity', 'dot');
    default: return chip('Unclear', 'unclear', 'ring');
  }
}

const VERDICT_TEXT: Record<IntelCheck['verdict'], string> = {
  gap: 'Gap', edge: 'Edge', edge_at_risk: 'Edge · at risk', open: 'Open · be first', parity: 'Parity', unclear: 'Unclear',
};
const VERDICT_TONE: Record<IntelCheck['verdict'], ChipTone> = {
  gap: 'gap', edge: 'edge', edge_at_risk: 'edge', open: 'open', parity: 'parity', unclear: 'unclear',
};
export function verdictLabel(v: IntelCheck['verdict']): { text: string; tone: ChipTone } {
  return { text: VERDICT_TEXT[v], tone: VERDICT_TONE[v] };
}

const cap1 = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "High · 214 sources" */
export function confidenceLine(check: Pick<IntelCheck, 'confidence' | 'sourceCount'>): string {
  return `${cap1(check.confidence)} · ${check.sourceCount} source${check.sourceCount === 1 ? '' : 's'}`;
}

/**
 * The re-check line under "On approve, Captain will": "Re-check weekly; alert if Wakelet changes" + "intel 7/7".
 * From config.intel.recheck and check.watchFor; null when re-checks are off.
 */
export function recheckLine(check: Pick<IntelCheck, 'watchFor' | 'rows'> | undefined, config: CheckCfg): { text: string; meta: string } | null {
  const cadence = config?.intel?.recheck ?? 'weekly';
  if (cadence === 'off') return null;
  const watch = check?.watchFor?.trim().replace(/\.$/, '');
  return {
    text: `Re-check ${cadence}${watch ? `; alert if ${watch}` : ''}`,
    meta: check ? `intel ${coverage(check)}/${INTEL_CHECK_AREAS.length}` : '',
  };
}

/** The 409 the approve route answers with when the check is missing, running or stale. */
export function isGateError(e: unknown): e is ApiError {
  return e instanceof ApiError && e.status === 409 && /intel check|check/i.test(e.message);
}

// ---------------------------------------------------------------- actions (shared by Research and Opportunities)

/** POST /api/intel/checks: queue scout's check for the idea. */
export async function runIntelCheck(ideaId: string): Promise<boolean> {
  try {
    const c = await requestCheck(ideaId);
    toast(c.status === 'skipped' ? `No competitors tracked: ${ideaId} needs no check` : `scout will check ${ideaId} against your competitors`);
    return true;
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'error');
    return false;
  }
}

/**
 * POST /api/research/ideas/:id/approve. A 409 about the check comes back as `blocked` (shown next to the button,
 * with "Run intel check"); other errors are toasted.
 */
export async function approveIdea(idea: Pick<ResearchIdea, 'id'>): Promise<{ idea?: ResearchIdea; blocked?: string }> {
  try {
    const i = await api.approveIdea(idea.id);
    toast(`Approved ${idea.id}. The Captain adds it to the roadmap`);
    return { idea: i };
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) return { blocked: e.message };
    toast(e instanceof Error ? e.message : String(e), 'error');
    return {};
  }
}

// ---------------------------------------------------------------- DOM

/** The verdict chip element (card and panel header). */
export function chipEl(c: CheckChip, small = false): HTMLElement {
  const mark = c.mark === 'up'
    ? h('span.ic-mark', null, icon('chevron', 10, 2.6))
    : c.mark === 'spin' ? h('span.ic-spin') : h('span.ic-dot', { class: c.mark === 'ring' && 'ring' });
  return h('span.ic-chip', { class: [c.tone, c.pending && 'pending', c.stale && 'stale', small && 'sm'], title: c.title }, mark, h('span', null, c.text));
}

export interface IntelCheckPanelOpts {
  idea: ResearchIdea;
  store: IntelStore | null;
  config: CheckCfg;
  /** "Run intel check" pressed. */
  onRun(): void;
  /** A 409 from the last approve attempt. */
  blocked?: string;
  /** Run pressed and waiting for the server. */
  busy?: boolean;
  /** Heading text (default "INTEL CHECK"). */
  label?: string;
}

/** The Intel check section: header (coverage + verdict chip), the 7 area rows, verdict + confidence, state and Run. */
export function intelCheckPanel(o: IntelCheckPanelOpts): HTMLElement {
  const el = h('div.ic');
  fillIntelCheckPanel(el, o);
  return el;
}

export function fillIntelCheckPanel(el: HTMLElement, o: IntelCheckPanelOpts): void {
  const label = o.label ?? 'INTEL CHECK';
  if (!o.store) {
    setChildren(el, h('div.ic-head', null, h('div.ic-label', null, label)), h('div.ic-state', null, 'Loading the intel check…'));
    return;
  }
  const st = checkStatus(o.idea, o.store, o.config);
  const shown = st.state === 'queued' || st.state === 'running' ? (st.gate && st.gate.status === 'done' ? st.gate : st.check) : st.check;
  const cov = coverage(shown);
  const hasRows = !!shown && shown.rows.length > 0;
  const chip = checkChip(o.idea, o.store, o.config);

  const runBtn = st.canRun
    ? h('button.ic-run', { class: (st.state === 'missing' || st.state === 'stale' || st.state === 'failed') ? 'btn sm primary' : 'ic-link', disabled: !!o.busy, onclick: (e: MouseEvent) => { e.stopPropagation(); o.onRun(); } },
      icon('refresh', 12, 2.2), st.state === 'done' ? 'Run again' : 'Run intel check')
    : null;

  const stateLine = st.state === 'done' && !o.blocked
    ? null
    : h('div.ic-state', { class: [st.state, o.blocked && 'blocked'] },
      st.state === 'running' || st.state === 'queued' ? h('span.ic-spin') : icon(st.state === 'skipped' ? 'circle' : 'alert', 13),
      h('span.flex1', null, o.blocked ?? st.reason),
      st.state !== 'done' ? runBtn : null);

  const rows = hasRows
    ? h('div.ic-rows', null, rowsByArea(shown).map(({ area, row }) => {
        if (!row) {
          return h('div.ic-row.empty', null,
            h('div.ic-area', null, CHECK_AREA_LABELS[area]),
            h('div.ic-find', null, 'Not checked'),
            h('span.ic-rdot'));
        }
        const r = h('button.ic-row', {
          class: [row.signal, row.changed && 'changed'],
          title: `${LABEL_TEXT[row.label]} · ${claimMeta(row)}`,
        },
        h('div.ic-area', null, CHECK_AREA_LABELS[area]),
        h('div.ic-find', null, row.finding, row.changed ? h('span.ic-changed', null, 'changed') : null),
        labelDot(row.label));
        r.onclick = (e: MouseEvent) => { e.stopPropagation(); openSources(r, `${CHECK_AREA_LABELS[area]} · ${row.finding}`, row.sources, row); };
        return r;
      }))
    : null;

  const verdict = hasRows && shown && (shown.status === 'done' || shown.status === 'skipped')
    ? h('div.ic-verdict', null,
      h('div.ic-verdict-t', null, shown.verdictText ? `Verdict: ${shown.verdictText.replace(/^verdict:\s*/i, '')}` : `Verdict: ${verdictLabel(shown.verdict).text}`),
      h('div.ic-verdict-m', null, confidenceLine(shown)))
    : null;

  const foot = shown && (shown.status === 'done' || shown.status === 'skipped')
    ? h('div.ic-foot', null,
      h('span', null, [shown.id, shown.doneAt ? `checked ${fmtDate(shown.doneAt)}` : '', shown.revision > 1 ? `revision ${shown.revision}` : ''].filter(Boolean).join(' · ')),
      shown.watchFor ? h('span.ic-watch', { title: 'What would change the verdict' }, `watching: ${shown.watchFor}`) : null,
      h('span.flex1'),
      st.state === 'done' ? runBtn : null)
    : null;

  setChildren(el,
    h('div.ic-head', null,
      h('div.ic-label', null, `${label} · ${cov} OF ${INTEL_CHECK_AREAS.length}`),
      hasRows || st.state !== 'missing' ? chipEl(chip, true) : null),
    stateLine,
    rows,
    verdict,
    foot);
}
