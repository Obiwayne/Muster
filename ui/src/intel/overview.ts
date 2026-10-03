// Intel → Overview (4435-0): decision cards, feature matrix with the "For us" verdicts, positioning map,
// complaint themes and the change log.
import type { IntelCapability, IntelChange, IntelCompetitor, IntelInsight, IntelSource, IntelStore } from '../../../src/types';
import { h, setChildren, type Child } from '../dom';
import { events } from '../events';
import {
  AREA_SHORT, SEVERITY_TEXT, cellPill, companyColour, companyName, complaintThemes, filterCapabilities, fmtDate, lastChecked, loveThemes,
  matrixCounts, matrixSummary, rivals, sampleLine, shareOfSample, storeSources, thinThemes, trackedCompanies, verdictChip, type MatrixFilter,
} from '../intelmodel';
import { caption, emptyState, labelDot, openSources, predictionBlock, segmented, type IntelCtx } from './common';

let matrixFilter: MatrixFilter = 'all';
const OVERVIEW_ROWS = 7;

const INSIGHT_KIND: Record<IntelInsight['kind'], string> = {
  match: 'MATCH · CUSTOMERS EXPECT IT', advantage: 'CLEAR ADVANTAGE', audience: 'UNDERSERVED AUDIENCE', test: 'TEST BEFORE BUILDING',
};

/** "product pages, help centres, hands-on trial" from the kinds of sources behind a set of claims. */
export function sourceKindsText(sources: IntelSource[]): string {
  const words: Record<string, string> = {
    site: 'product pages', pricing: 'pricing pages', help: 'help centres', changelog: 'changelogs', roadmap: 'public roadmaps', own_app: 'hands-on trial',
    app_store: 'App Store', google_play: 'Google Play', g2: 'G2', capterra: 'Capterra', reddit: 'Reddit', forum: 'forums', press: 'press',
    linkedin: 'LinkedIn', youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram', x: 'X', facebook: 'Facebook', companies_house: 'Companies House',
    jobs: 'job posts', rss: 'feeds', other: 'other pages',
  };
  const seen: string[] = [];
  for (const s of sources) { const w = words[s.kind] ?? s.kind; if (!seen.includes(w)) seen.push(w); }
  return seen.join(', ');
}

export function renderOverview(host: HTMLElement, ctx: IntelCtx): void {
  const store = ctx.intel;
  if (!rivals(store).length) {
    setChildren(host, h('div.it-pad', null, emptyState('No competitors tracked yet',
      'Add a competitor and scout researches their features, reviews, plans, pricing and filings, then tells you what it means for you. Every finding carries its label, sources and date.',
      { label: 'Add competitor', onClick: ctx.addCompetitor })));
    return;
  }
  setChildren(host, h('div.it-pad.it-overview', null,
    decisions(ctx),
    h('div.it-row', null, matrix(ctx, host), positioning(store)),
    h('div.it-row', null, complaints(ctx), changeLog(ctx))));
}

// ---------------------------------------------------------------- decisions

function decisions(ctx: IntelCtx): HTMLElement {
  const store = ctx.intel;
  const us = store.competitors.find((c) => c.isUs || c.id === 'us');
  const lastJob = [...store.jobs].filter((j) => j.status === 'done' && j.finishedAt).sort((a, b) => (a.finishedAt! < b.finishedAt! ? 1 : -1))[0];
  const sources = events.intel?.sources ?? storeSources(store);
  const cards = store.insights.slice(0, 4);
  return h('div.it-decisions', null,
    h('div.it-dec-head', null,
      h('div.section-label', null, `WHAT THIS MEANS FOR ${(us?.name ?? 'US').toUpperCase()}`),
      h('div.flex1'),
      h('div.it-dec-meta', null, ['scout', lastJob?.finishedAt ? fmtDate(lastJob.finishedAt) : null, `${sources} sources`].filter(Boolean).join(' · '))),
    cards.length
      ? h('div.it-dec-cards', null, cards.map((i) => {
          const card = h('button.it-dec', { class: `k-${i.kind}`, title: 'Show sources' },
            h('div.it-dec-k', null, INSIGHT_KIND[i.kind]),
            h('div.it-dec-t', null, i.title),
            h('div.it-dec-m', null, labelDot(i.label), h('span', null, `${i.detail} · ${i.confidence}`)));
          card.onclick = () => openSources(card, i.title, i.sources, i);
          return card;
        }))
      : h('div.it-dec-none', null, 'scout has not drawn conclusions yet. They appear here after the first research job finishes.'));
}

// ---------------------------------------------------------------- feature matrix

function matrix(ctx: IntelCtx, host: HTMLElement): HTMLElement {
  const store = ctx.intel;
  const companies = trackedCompanies(store);
  const caps = store.capabilities;
  const counts = matrixCounts(caps);
  // Store order, with parity rows (nothing to decide) after the rest.
  const filtered = filterCapabilities(caps, matrixFilter);
  const sorted = [...filtered.filter((c) => c.verdict !== 'parity'), ...filtered.filter((c) => c.verdict === 'parity')];
  const shown = sorted.slice(0, OVERVIEW_ROWS);
  const allSources = caps.flatMap((c) => Object.values(c.cells).flatMap((x) => x.sources));
  const checked = lastChecked(caps);
  const pick = (f: MatrixFilter) => { matrixFilter = f; renderOverview(host, ctx); };
  return h('div.it-panel.it-matrix', null,
    h('div.it-panel-head', null,
      h('div.it-panel-t', null, 'Feature matrix'),
      h('div.it-panel-s', null, matrixSummary(caps)),
      h('div.flex1'),
      segmented<MatrixFilter>([
        { value: 'all', label: 'All' },
        { value: 'gap', label: `Gaps ${counts.gap}`, dot: 'var(--color-stuck)' },
        { value: 'edge', label: `Edges ${counts.edge}`, dot: 'var(--color-success)' },
        { value: 'open', label: `Open ${counts.open}`, dot: 'var(--color-research-text)' },
      ], matrixFilter, pick)),
    matrixTable(ctx, shown, companies),
    h('div.it-panel-foot', null, caption(
      caps.length
        ? `Source: ${sourceKindsText(allSources) || 'none yet'}${checked ? ` · checked ${fmtDate(checked)}` : ''} · ${shown.length} of ${caps.length} capabilities shown`
        : 'scout has not compared features yet.',
      sorted.length > shown.length ? h('button.it-link', { onclick: () => ctx.go('features') }, ' · All on Features →') : null)));
}

/** The matrix table (also used by the Features tab with every row). */
export function matrixTable(ctx: IntelCtx, rows: IntelCapability[], companies: IntelCompetitor[], emptyText?: string): HTMLElement {
  const store = ctx.intel;
  return h('div.it-mx', null,
    h('div.it-mx-head', null,
      h('div.it-mx-name.section-label', null, 'CAPABILITY'),
      companies.map((c) => h('div.it-mx-col', { class: (c.isUs || c.id === 'us') && 'us' }, c.isUs || c.id === 'us' ? 'Us' : c.name)),
      h('div.it-mx-verdict.section-label', null, 'FOR US')),
    rows.length
      ? rows.map((cap) => {
          const chip = verdictChip(cap, store, ctx.research.ideas);
          const chipEl = h('button.it-vchip', { class: [`v-${chip.verdict}`, chip.pending && 'pending'], title: chip.title },
            chip.verdict === 'edge' ? h('span.it-vchip-up') : h('span.it-vchip-dot'),
            chip.text);
          if (cap.ideaId) chipEl.onclick = () => { location.hash = `#/intel/opportunities?idea=${encodeURIComponent(cap.ideaId!)}`; };
          return h('div.it-mx-row', { class: `v-${cap.verdict}` },
            h('div.it-mx-name', { title: cap.group ?? '' }, cap.name),
            companies.map((c) => {
              const isUs = !!(c.isUs || c.id === 'us');
              const cell = cap.cells[c.id];
              const pill = cellPill(cell, isUs);
              const el = h('button.it-pill', { class: [pill.cls, isUs && cap.verdict === 'edge' && cell?.status === 'yes' && 'ring'], title: cell ? `${c.name}: ${cell.status}${cell.planNote ? ` · ${cell.planNote}` : ''}` : `${c.name}: not checked` }, pill.text);
              if (cell) el.onclick = (e: MouseEvent) => { e.stopPropagation(); openSources(el, `${cap.name} · ${c.name}`, cell.sources, cell); };
              return h('div.it-mx-col', null, el);
            }),
            h('div.it-mx-verdict', null, chipEl));
        })
      : h('div.it-mx-empty', null, emptyText ?? (matrixFilter === 'all' ? 'No capabilities compared yet.' : `No ${matrixFilter === 'gap' ? 'gaps' : matrixFilter === 'edge' ? 'edges' : 'open spaces'} right now.`)));
}

// ---------------------------------------------------------------- positioning map

function positioning(store: IntelStore): HTMLElement {
  const p = store.positioning;
  if (!p) {
    return h('div.it-panel.it-map', null,
      h('div.it-panel-head.col', null, h('div.it-panel-t', null, 'Positioning map')),
      h('div.it-map-none', null, 'scout draws the map once it has compared prices and features.'));
  }
  const pct = (v: number) => `${Math.max(0, Math.min(1, v)) * 100}%`;
  const os = p.openSpace;
  const mapEl = h('div.it-map-area', null,
    h('div.it-map-plot', null,
      h('div.it-map-hx'), h('div.it-map-vy'),
      os ? h('div.it-map-open', { style: { left: pct(os.x0), top: pct(1 - os.y1), width: pct(os.x1 - os.x0), height: pct(os.y1 - os.y0) } },
        h('div.it-map-open-l', null, os.label.toUpperCase())) : null,
      p.points.map((pt) => {
        const c = store.competitors.find((x) => x.id === pt.competitorId);
        const isUs = !!(c?.isUs || pt.competitorId === 'us');
        const name = pt.label ?? (isUs ? 'us' : companyName(store, pt.competitorId));
        return h('div.it-map-pt', { class: [isUs && 'us', pt.future && 'future', isUs && !pt.future && 'today'], style: { left: pct(pt.x), top: pct(1 - pt.y) } },
          h('span.it-map-dot', { style: { '--c': companyColour(c ?? { isUs, colour: 0 }) } }),
          h('span.it-map-n', null, name));
      })),
    h('div.it-map-y1', null, p.y.max), h('div.it-map-y0', null, p.y.min),
    h('div.it-map-x0', null, p.x.min), h('div.it-map-x1', null, p.x.max));
  const head = h('button.it-panel-head.col', { title: 'Show sources' },
    h('div.it-panel-t', null, 'Positioning map', labelDot(p.label)),
    h('div.it-panel-s', null, p.title));
  head.onclick = () => openSources(head, 'Positioning map', p.sources, p);
  return h('div.it-panel.it-map', null, head, mapEl,
    h('div.it-map-cap', null, caption(p.assumptions.join(' '), p.label === 'prediction' && p.prediction ? null : ` ${p.confidence} confidence.`)));
}

// ---------------------------------------------------------------- complaint themes

function complaints(ctx: IntelCtx): HTMLElement {
  const store = ctx.intel;
  // "Why they switch away" themes live on Reviews & social; the bars are complaints about the product.
  const themes = complaintThemes(store.themes).filter((t) => t.ourAnswer?.kind !== 'win_over').slice(0, 5);
  const love = loveThemes(store.themes)[0];
  const thin = thinThemes(store.themes).length;
  const comps = rivals(store);
  const max = Math.max(1, ...themes.map((t) => shareOfSample(t)));
  const bar = (byCompetitor: Record<string, number>, sampleSize: number, loveBar = false) => {
    const segs = comps.map((c, i) => ({ c, n: byCompetitor[c.id] ?? 0, i })).filter((s) => s.n > 0);
    return h('div.it-bar', null, segs.map((s, k) => h('div.it-bar-seg', {
      title: `${s.c.name}: ${s.n} mentions`,
      style: {
        width: `${Math.min(100, ((s.n / sampleSize) * 100 / max) * 90)}%`,
        background: loveBar ? `color-mix(in oklab, var(--color-success) ${k === 0 ? 60 : 35}%, transparent)` : companyColour(s.c),
      },
    })));
  };
  const kinds = store.sample?.counts.filter((c) => c.kind !== 'social_comments').map((c) => c.label).join(', ');
  return h('div.it-panel.it-pain', null,
    h('div.it-pain-head', null,
      h('div.it-panel-t', null, 'What customers complain about'),
      h('div.it-panel-s', null, sampleLine(store.sample)),
      h('div.flex1'),
      h('div.it-key', null, comps.map((c) => h('span', null, h('i', { style: { background: companyColour(c) } }), c.name)))),
    themes.length
      ? h('div.it-pain-rows', null,
          themes.map((t) => h('button.it-pain-row', { onclick: () => ctx.go('reviews'), title: `${t.mentions} of ${t.sampleSize} in the sample · ${t.independentSources} independent sources` },
            h('div.it-pain-t', null, t.title),
            bar(t.byCompetitor, t.sampleSize),
            h('div.it-pain-pct', null, `${shareOfSample(t)}%`),
            h('div.it-pain-sev', { class: `s-${t.severity}` }, SEVERITY_TEXT[t.severity]))),
          love ? h('button.it-pain-row.love', { onclick: () => ctx.go('reviews') },
            h('div.it-pain-t', null, `What they love: ${love.title}`),
            bar(love.byCompetitor, love.sampleSize, true),
            h('div.it-pain-pct', null, `${shareOfSample(love)}%`),
            h('div.it-pain-sev', null, 'Expect it')) : null,
          caption(`Share of reviewed sample, not of all customers. ${kinds ?? ''}${store.sample ? ` · ${fmtDate(store.sample.asOf)}` : ''}. Customer opinion.`,
            thin ? ` ${thin} theme${thin === 1 ? '' : 's'} with under 5 independent sources not shown.` : null))
      : h('div.it-map-none', null, store.themes.length
          ? `Only thin evidence so far: ${store.themes.length} theme${store.themes.length === 1 ? '' : 's'}, none with 5+ independent sources.`
          : "scout hasn't read reviews yet. Tick Reviews & pain points on a competitor to include them."));
}

// ---------------------------------------------------------------- change log

function changeLog(ctx: IntelCtx): HTMLElement {
  const store = ctx.intel;
  const list = [...store.changes].sort((a, b) => (a.at < b.at ? 1 : -1));
  const cadences = rivals(store).map((c) => c.watch).filter((w) => w !== 'off');
  const watching = cadences.length ? `watching ${mostCommon(cadences)}` : 'not watching';
  return h('div.it-panel.it-changes', null,
    h('div.it-panel-head', null,
      h('div.it-panel-t', null, 'What changed'),
      h('div.it-panel-s', null, watching),
      h('div.flex1'),
      h('button.it-link.muted', { onclick: () => ctx.go('changes') }, `All ${list.length} →`)),
    list.length ? list.slice(0, 4).map((c) => changeRow(store, c, true)) : h('div.it-map-none', null, 'Nothing has changed since scout started watching.'));
}

function mostCommon<T>(xs: T[]): T {
  const m = new Map<T, number>();
  xs.forEach((x) => m.set(x, (m.get(x) ?? 0) + 1));
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

/** One change-log row (overview and the Changes tab). */
export function changeRow(store: IntelStore, c: IntelChange, compact = false): HTMLElement {
  const comp = store.competitors.find((x) => x.id === c.competitorId);
  const respond = c.planImpact === 'respond';
  const text: Child[] = [c.implication ?? '', respond && c.suggestion ? ` ${c.suggestion}` : ''];
  const row = h('button.it-chg', { class: [respond && 'respond', !c.seen && 'unseen', compact && 'compact'], title: 'Show sources' },
    h('div.it-chg-date', null, fmtDate(c.at, true)),
    h('div.it-chg-body', null,
      h('div.it-chg-t', null, h('span.it-chg-dot', { style: { background: companyColour(comp) } }), h('span', null, c.title)),
      h('div.it-chg-i', null, ...text),
      !compact && c.label === 'prediction' && c.prediction ? predictionBlock(c.prediction) : null,
      !compact ? h('div.it-chg-meta', null, labelDot(c.label), `${companyName(store, c.competitorId)} · ${c.confidence} confidence · ${c.sources.length} source${c.sources.length === 1 ? '' : 's'}${c.ideaId ? ` · ${c.ideaId}` : ''}${c.planImpact !== 'none' ? ` · ${c.planImpact === 'respond' ? 'plan should respond' : 'watch'}` : ''}`) : null),
    h('div.it-chg-area', null, compact ? labelDot(c.label) : null, AREA_SHORT[c.area]));
  row.onclick = () => openSources(row, c.title, c.sources, c);
  return row;
}
