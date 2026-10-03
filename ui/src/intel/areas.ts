// Intel tabs that list scout's findings per area: Features, Roadmaps, Audience, Pricing, Marketing, Team, AI,
// Financials and Changes. Simple and honest: every claim shows its label, sources, date and confidence, and an
// empty tab says what scout hasn't researched yet.
import type { IntelArea, IntelFinding, IntelPlan, IntelStore } from '../../../src/types';
import { h, setChildren, type Child } from '../dom';
import { run as runAction } from '../actions';
import { markChangesSeen } from '../intelapi';
import {
  AREA_LABELS, companyColour, companyName, fmtDate, lastChecked, matrixCounts, matrixSummary, rivals, trackedCompanies, type MatrixFilter,
} from '../intelmodel';
import { caption, claimLine, emptyState, labelDot, predictionBlock, segmented, type IntelCtx } from './common';
import { changeRow, matrixTable, sourceKindsText } from './overview';

/** Which companies haven't got `area` ticked, for the empty-state line. */
function notResearched(store: IntelStore, areas: IntelArea[]): string {
  const missing = rivals(store).filter((c) => !c.areas.some((a) => areas.includes(a))).map((c) => c.name);
  return missing.length ? ` ${missing.join(', ')} ${missing.length === 1 ? "doesn't" : "don't"} have ${areas.map((a) => AREA_LABELS[a]).join(' / ')} ticked.` : '';
}

function noRivals(host: HTMLElement, ctx: IntelCtx): boolean {
  if (rivals(ctx.intel).length) return false;
  setChildren(host, h('div.it-pad', null, emptyState('No competitors tracked yet', 'Add a competitor and pick what scout should research.', { label: 'Add competitor', onClick: ctx.addCompetitor })));
  return true;
}

function page(title: string, sub: Child, ...children: Child[]): HTMLElement {
  return h('div.it-pad.it-area', null, h('div.it-sec-head', null, h('div.it-sec-titles', null, h('div.it-sec-t', null, title), sub ? h('div.it-sec-s', null, sub) : null)), ...children);
}

function companyHead(store: IntelStore, id: string | undefined): HTMLElement {
  const c = store.competitors.find((x) => x.id === id);
  return h('div.it-co-head', null, h('span.it-chip-dot', { style: { background: companyColour(c) } }), id ? companyName(store, id) : 'Market-wide');
}

/** Findings grouped by company (market-wide last). */
function groupByCompany<T extends { competitorId?: string }>(store: IntelStore, items: T[]): [string | undefined, T[]][] {
  const order = [...trackedCompanies(store).map((c) => c.id), ...store.competitors.filter((c) => c.removed).map((c) => c.id)];
  const groups = new Map<string | undefined, T[]>();
  for (const it of items) groups.set(it.competitorId, [...(groups.get(it.competitorId) ?? []), it]);
  return [...groups.entries()].sort((a, b) => (a[0] === undefined ? 1 : b[0] === undefined ? -1 : order.indexOf(a[0]) - order.indexOf(b[0])));
}

/** One finding card: title, detail, key/value facts, AI verified/claimed, partial-view note, and its claim line. */
export function findingCard(f: IntelFinding): HTMLElement {
  const claim = claimLine(f, f.title, f.id, { omit: ['implication', 'prediction'] });
  return h('div.it-card', null,
    h('div.it-card-head', null,
      h('div.it-card-t', null, f.title),
      f.aiStatus ? h('span.it-tag', { class: f.aiStatus === 'verified' ? 'edge' : 'watch' }, f.aiStatus === 'verified' ? 'Seen working' : 'Marketing claim') : null),
    f.detail ? h('div.it-card-d', null, f.detail) : null,
    f.facts && Object.keys(f.facts).length ? h('div.it-kv', null, Object.entries(f.facts).map(([k, v]) => [h('div.it-kv-k', null, k), h('div.it-kv-v', null, v)])) : null,
    f.label === 'prediction' && f.prediction ? predictionBlock(f.prediction) : null,
    f.implication ? h('div.it-card-impl', null, h('span.faint', null, 'For us: '), f.implication) : null,
    f.partial ? h('div.it-card-partial', null, 'Partial public view: LinkedIn, job posts and filings only show part of a team.') : null,
    h('div.it-card-foot', null, claim.line),
    claim.panel);
}

function findingsTab(host: HTMLElement, ctx: IntelCtx, areas: IntelArea[], title: string, sub: string, what: string, extra?: (store: IntelStore) => Child): void {
  if (noRivals(host, ctx)) return;
  const store = ctx.intel;
  const list = store.findings.filter((f) => areas.includes(f.area));
  const more = extra?.(store);
  setChildren(host, page(title, sub,
    more,
    list.length
      ? groupByCompany(store, list).map(([id, items]) => h('div.it-co', null, companyHead(store, id), h('div.it-cards', null, items.map(findingCard))))
      : !more ? emptyState(`No ${what} yet`, `scout hasn't researched ${what} yet.${notResearched(store, areas)} Run a sweep to fill this tab.`) : null));
}

// ---------------------------------------------------------------- features

let featureFilter: MatrixFilter = 'all';
export function renderFeatures(host: HTMLElement, ctx: IntelCtx): void {
  if (noRivals(host, ctx)) return;
  const store = ctx.intel;
  const caps = store.capabilities;
  const counts = matrixCounts(caps);
  const rows = featureFilter === 'all' ? caps : caps.filter((c) => c.verdict === featureFilter);
  const groups = new Map<string, typeof rows>();
  for (const c of rows) groups.set(c.group ?? 'Other', [...(groups.get(c.group ?? 'Other') ?? []), c]);
  const checked = lastChecked(caps);
  const allSources = caps.flatMap((c) => Object.values(c.cells).flatMap((x) => x.sources));
  setChildren(host, page('Feature matrix', caps.length ? matrixSummary(caps) : 'nothing compared yet',
    caps.length ? h('div.it-area-tools', null, segmented<MatrixFilter>([
      { value: 'all', label: `All ${counts.all}` },
      { value: 'gap', label: `Gaps ${counts.gap}`, dot: 'var(--color-stuck)' },
      { value: 'edge', label: `Edges ${counts.edge}`, dot: 'var(--color-success)' },
      { value: 'open', label: `Open ${counts.open}`, dot: 'var(--color-research-text)' },
    ], featureFilter, (v) => { featureFilter = v; renderFeatures(host, ctx); }, 'md')) : null,
    caps.length
      ? [...groups.entries()].map(([g, list]) => h('div.it-panel.it-matrix', null,
          h('div.it-panel-head', null, h('div.it-panel-t', null, g), h('div.it-panel-s', null, `${list.length} capabilit${list.length === 1 ? 'y' : 'ies'}`)),
          matrixTable(ctx, list, trackedCompanies(store), 'Nothing here.')))
      : emptyState('No features compared yet', `scout hasn't compared features yet.${notResearched(store, ['features'])}`),
    caps.length && !rows.length ? emptyState('Nothing matches', 'No capabilities with that verdict right now.') : null,
    caps.length ? caption(`Gap = they have it, we don't. Edge = we have it (or have it planned) and they don't. Open = nobody does it. Source: ${sourceKindsText(allSources)}${checked ? ` · checked ${fmtDate(checked)}` : ''}. Click a cell for its sources.`) : null));
}

// ---------------------------------------------------------------- roadmaps

function planCard(store: IntelStore, p: IntelPlan): HTMLElement {
  const caps = p.capabilityIds.map((id) => store.capabilities.find((c) => c.id === id)?.name ?? id);
  const claim = claimLine(p, p.title, p.id, { omit: ['implication', 'prediction'] });
  const status = p.status ? { planned: 'Planned', in_progress: 'In progress', shipped: 'Shipped', dropped: 'Dropped' }[p.status] : null;
  return h('div.it-card', { class: p.kind === 'prediction' && 'pred' },
    h('div.it-card-head', null,
      h('span.it-chip-dot', { style: { background: companyColour(store.competitors.find((c) => c.id === p.competitorId)) } }),
      h('div.it-card-t', null, `${companyName(store, p.competitorId)}: ${p.title}`),
      status ? h('span.it-tag', { class: p.status === 'in_progress' ? 'gap' : p.status === 'shipped' ? 'edge' : 'watch' }, status) : null,
      p.timeframe ? h('span.it-tag.watch', null, p.timeframe) : null),
    caps.length ? h('div.it-card-d', null, h('span.faint', null, 'Touches: '), caps.join(', ')) : null,
    p.prediction ? predictionBlock(p.prediction) : null,
    p.implication ? h('div.it-card-impl', null, h('span.faint', null, 'For us: '), p.implication) : null,
    h('div.it-card-foot', null, claim.line),
    claim.panel);
}

export function renderRoadmaps(host: HTMLElement, ctx: IntelCtx): void {
  if (noRivals(host, ctx)) return;
  const store = ctx.intel;
  const commitments = store.plans.filter((p) => p.kind === 'commitment');
  const predictions = store.plans.filter((p) => p.kind === 'prediction');
  setChildren(host, page('Their roadmaps', 'What they have committed to in public, and what scout predicts from signals',
    h('div.it-two', null,
      h('div.it-col-plain', null,
        h('div.it-sub-head', null, labelDot('fact', 'md'), 'Commitments', h('span.faint', null, ` · ${commitments.length}`)),
        commitments.length ? commitments.map((p) => planCard(store, p)) : emptyState('No public commitments found', `scout hasn't found public roadmaps or announcements yet.${notResearched(store, ['roadmap'])}`),
        caption('Fact: seen on their public roadmap, changelog or announcements.')),
      h('div.it-col-plain', null,
        h('div.it-sub-head', null, labelDot('prediction', 'md'), 'Predictions', h('span.faint', null, ` · ${predictions.length}`)),
        predictions.length ? predictions.map((p) => planCard(store, p)) : emptyState('No predictions yet', 'scout predicts only with signals, a timeframe and what would change its mind.'),
        caption("Prediction: scout's inference, never a fact. Each shows its signals, timeframe and what would change it.")))));
}

// ---------------------------------------------------------------- pricing

export function renderPricing(host: HTMLElement, ctx: IntelCtx): void {
  findingsTab(host, ctx, ['pricing'], 'Pricing', 'Tiers from their public pricing pages and realistic cost scenarios', 'pricing', (store) => {
    if (!store.scenarios.length) return null;
    const comps = trackedCompanies(store);
    return store.scenarios.map((s) => {
      const claim = claimLine(s, s.name, s.id, { omit: ['implication', 'prediction'] });
      return h('div.it-panel', null,
      h('div.it-panel-head', null, h('div.it-panel-t', null, s.name), labelDot(s.label)),
      h('div.it-scn', null, comps.map((c) => {
        const cost = s.costs[c.id];
        return h('div.it-scn-c', null,
          h('div.it-scn-n', null, h('span.it-chip-dot', { style: { background: companyColour(c) } }), c.isUs || c.id === 'us' ? 'Us' : c.name),
          h('div.it-scn-v', null, !cost ? '?' : cost.amount === undefined ? 'Quote only' : `${new Intl.NumberFormat('en-GB', { style: 'currency', currency: cost.currency, maximumFractionDigits: 0 }).format(cost.amount)}`),
          h('div.it-scn-s', null, cost ? [`per ${cost.period}`, cost.note].filter(Boolean).join(' · ') : 'not priced'));
      })),
      s.implication ? h('div.it-card-impl.pad', null, h('span.faint', null, 'For us: '), s.implication) : null,
      h('div.it-panel-foot', null, caption(`Assumptions: ${s.assumptions.join('; ')}.`), h('div', null, claim.line)),
      claim.panel);
    });
  });
}

// ---------------------------------------------------------------- financials

export function renderFinancials(host: HTMLElement, ctx: IntelCtx): void {
  findingsTab(host, ctx, ['financials'], 'Financials', 'UK public filings from Companies House, with what they cannot tell you', 'filings', (store) => {
    if (!store.filings.length) return null;
    return h('div.it-cards', null, store.filings.map((f) => {
      const claim = claimLine(f, 'Filing', `${f.competitorId}:${f.companyNumber}`);
      return h('div.it-card', { class: f.overdue && 'warn' },
      h('div.it-card-head', null,
        h('span.it-chip-dot', { style: { background: companyColour(store.competitors.find((c) => c.id === f.competitorId)) } }),
        h('div.it-card-t', null, `${companyName(store, f.competitorId)} · ${f.companyNumber}`),
        h('span.it-tag', { class: f.status.startsWith('Active') && !f.status.includes('strike') ? 'edge' : 'gap' }, f.status),
        f.overdue ? h('span.it-tag.gap', null, 'Accounts overdue') : null),
      h('div.it-kv', null, ([
        ['Incorporated', fmtDate(f.incorporated)], ['Accounts', f.accountsType], ['Made up to', fmtDate(f.accountsMadeUpTo)], ['Next due', fmtDate(f.accountsDue)],
        ['Officers', f.officers !== undefined ? String(f.officers) : undefined], ['Control', f.pscs?.join(', ')],
        ...Object.entries(f.figures ?? {}),
      ] as [string, string | undefined][]).filter(([, v]) => v).map(([k, v]) => [h('div.it-kv-k', null, k), h('div.it-kv-v', null, v!)])),
      h('div.it-card-partial', null, `Limits: ${f.limits}`),
      h('div.it-card-foot', null, claim.line),
      claim.panel);
    }));
  });
}

// ---------------------------------------------------------------- simple finding tabs

export const renderAudience = (host: HTMLElement, ctx: IntelCtx) =>
  findingsTab(host, ctx, ['audience'], 'Audience', 'Who they claim to serve vs. who the evidence shows', 'their audience');
export const renderMarketing = (host: HTMLElement, ctx: IntelCtx) =>
  findingsTab(host, ctx, ['marketing'], 'Marketing', 'Channels, messages and what gets attention (attention is not sales)', 'their marketing');
export const renderTeam = (host: HTMLElement, ctx: IntelCtx) =>
  findingsTab(host, ctx, ['team', 'org'], 'Team & hiring', 'A partial public view: LinkedIn, job posts and filings', 'their team');
export const renderAi = (host: HTMLElement, ctx: IntelCtx) =>
  findingsTab(host, ctx, ['ai'], 'AI', 'Seen working vs. marketing claims', 'their AI use');

// ---------------------------------------------------------------- changes

let changeFilter: 'all' | 'respond' | 'watch' = 'all';
let seenRev = -1;
export function renderChanges(host: HTMLElement, ctx: IntelCtx): void {
  const store = ctx.intel;
  const unseen = store.changes.filter((c) => !c.seen).map((c) => c.id);
  // Opening the tab marks what you can see as seen (once per store revision).
  if (unseen.length && seenRev !== store.rev) {
    seenRev = store.rev;
    void runAction(markChangesSeen(unseen)).then((r) => { if (r) ctx.refresh(); });
  }
  const all = [...store.changes].sort((a, b) => (a.at < b.at ? 1 : -1));
  const list = changeFilter === 'all' ? all : all.filter((c) => c.planImpact === changeFilter);
  const n = (k: 'respond' | 'watch') => all.filter((c) => c.planImpact === k).length;
  setChildren(host, page('What changed', `${all.length} change${all.length === 1 ? '' : 's'} since scout started watching`,
    all.length ? h('div.it-area-tools', null, segmented([
      { value: 'all' as const, label: `All ${all.length}` },
      { value: 'respond' as const, label: `Plan should respond ${n('respond')}`, dot: 'var(--color-warm)' },
      { value: 'watch' as const, label: `Watch ${n('watch')}` },
    ], changeFilter, (v) => { changeFilter = v; renderChanges(host, ctx); }, 'md')) : null,
    list.length ? h('div.it-panel.it-changes', null, list.map((c) => changeRow(store, c))) : emptyState('Nothing changed yet', rivals(store).length
      ? 'Keep-watching sweeps record what changed, why it matters and whether the plan should respond.'
      : 'Add a competitor and turn on Keep watching.'),
    all.length ? caption('Rows that need the plan to respond are highlighted with the Captain\'s suggestion. Click a row for its sources.') : null));
}
