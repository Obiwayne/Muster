// Intel → Opportunities (#/intel/opportunities, Vellum 5547-0 "Intel — gaps & Captain"). Left: value-vs-effort
// matrix, "What we're missing" (gaps with roadmap status), "Nobody does it · be first" (open), "Where we win ·
// protect these" (edges, at-risk flagged). Middle: the selected idea's opportunity fields and its intel check.
// Right: the Talk to Captain rail. `#/intel/opportunities?idea=R10` (the matrix verdict chips) selects an idea.
// Approval goes through the same POST /api/research/ideas/:id/approve as Roadmap → Research.
import '../intelcheck.css';
import type { IntelStore, MusterConfig, ResearchIdea, ResearchState, Roadmap } from '../../../src/types';
import { h, icon, setChildren } from '../dom';
import type { Snapshot } from '../events';
import { askIntel } from '../intelapi';
import { LABEL_TEXT, safeHref } from '../intelmodel';
import { labelDot } from '../intel/common';
import { approveIdea, checkStatus, fillIntelCheckPanel, runIntelCheck } from '../intelcheck';
import { createCaptainRail, quickPrompts, type RailMode } from '../captainrail';
import {
  detailKicker, detailRows, evidenceLines, groupOpportunities, matrixPoints, selectable, type OppGroups, type OppItem,
} from '../opportunities';

export interface OpportunitiesCtx {
  intel: IntelStore;
  research: ResearchState;
  snapshot: Snapshot;
  /** Refetch the intel store and research state, then re-render. */
  refresh(): void;
}

/** `?idea=` of the current hash (C's ctx has no params; the page reads the hash itself). */
function ideaParam(): string | null {
  const q = location.hash.split('?')[1];
  return q ? new URLSearchParams(q).get('idea') : null;
}

interface View {
  root: HTMLElement;
  list: HTMLElement;
  detail: HTMLElement;
  check: HTMLElement;
  rail: ReturnType<typeof createCaptainRail>;
}

let view: View | null = null;
let ctx: OpportunitiesCtx | null = null;
let selected: string | null = null;
let mode: RailMode = 'idea';
let lastParam: string | null = null;
let busy = false;
const blocked = new Map<string, string>();
const checking = new Set<string>();
/** Ideas you answered "Not now" this session: left open on the server, just not auto-selected (and shown muted). */
const later = new Set<string>();

const research = () => ctx?.snapshot?.state.research ?? ctx?.research ?? { runs: [], ideas: [] };
const config = (): MusterConfig | null => ctx?.snapshot?.config ?? null;
const roadmap = (): Roadmap | null => ctx?.snapshot?.state.roadmap ?? null;

function select(id: string): void {
  selected = id;
  later.delete(id);
  mode = 'idea';
  lastParam = id;
  history.replaceState(null, '', `#/intel/opportunities?idea=${encodeURIComponent(id)}`);
  draw();
}

function ensureView(host: HTMLElement): View {
  if (view && host.contains(view.root)) return view;
  const list = h('div.op-list');
  const check = h('div.ic.op-check');
  const detail = h('div.op-detail');
  const rail = createCaptainRail({
    onMode: (m) => { mode = m; draw(); },
    onSend: async (text, ideaId) => {
      if (!ideaId && mode === 'idea') mode = 'all';
      await askIntel(text, ideaId);
      ctx?.refresh();
      draw();
    },
    onApprove: (i) => void approve(i),
    onNotNow: (i) => notNow(i),
    onRunCheck: (i) => void runCheck(i),
  });
  const root = h('div.op', null, list, h('div.op-mid', null, detail, check), rail.el);
  view = { root, list, detail, check, rail };
  setChildren(host, root);
  return view;
}

async function approve(i: ResearchIdea): Promise<void> {
  if (busy) return;
  busy = true;
  draw();
  const r = await approveIdea(i);
  busy = false;
  if (r.blocked) blocked.set(i.id, r.blocked);
  else blocked.delete(i.id);
  ctx?.refresh();
  draw();
}

/** "Not now" leaves the idea open and untouched (no rejection): it closes the detail and moves on to the next one. */
function notNow(i: ResearchIdea): void {
  later.add(i.id);
  blocked.delete(i.id);
  if (selected === i.id) selected = null;
  lastParam = null;
  history.replaceState(null, '', '#/intel/opportunities');
  draw();
}

async function runCheck(i: ResearchIdea): Promise<void> {
  if (checking.has(i.id)) return;
  checking.add(i.id);
  draw();
  const ok = await runIntelCheck(i.id);
  checking.delete(i.id);
  if (ok) blocked.delete(i.id);
  ctx?.refresh();
  draw();
}

export function renderOpportunities(host: HTMLElement, c: OpportunitiesCtx): void {
  ctx = c;
  ensureView(host);
  const want = ideaParam();
  if (want && want !== lastParam) { selected = want; mode = 'idea'; }
  lastParam = want;
  draw();
}

function draw(): void {
  if (!ctx || !view) return;
  const store = ctx.intel;
  const ideas = research().ideas;
  const groups = groupOpportunities(ideas, store, roadmap());
  const pickable = selectable(groups);
  if (!selected || !pickable.some((i) => i.id === selected)) {
    // a linked idea that isn't listed (e.g. rejected) can still be opened from the matrix chip
    if (!(selected && ideas.some((i) => i.id === selected))) selected = pickable.find((i) => !later.has(i.id))?.id ?? null;
  }
  const idea = selected ? ideas.find((i) => i.id === selected) : undefined;
  const item = pickable.find((i) => i.id === selected);

  if (!pickable.length && !groups.edges.length && !groups.open.length) {
    setChildren(view.list);
    setChildren(view.detail, h('div.it-empty', null,
      h('div.it-empty-t', null, 'No opportunities yet'),
      h('div.it-empty-s', null, 'When scout finds gaps (they have it, we don\'t), open space (nobody does it) or edges worth protecting, they are listed here with what it would take. Track a competitor and run a sweep to start.')));
    view.check.hidden = true;
  } else {
    drawList(groups);
    drawDetail(item, idea);
  }
  view.rail.update({
    mode: idea ? mode : 'all',
    ...(idea ? { idea } : {}),
    store,
    config: config(),
    prompts: quickPrompts(ideas.filter((i) => i.origin === 'intel' || store.capabilities.some((c) => c.ideaId === i.id))),
    ...(idea && blocked.get(idea.id) ? { blocked: blocked.get(idea.id) } : {}),
    busy,
  });
}

// ---------------------------------------------------------------- left column

function drawList(g: OppGroups): void {
  const v = view!;
  const scroll = v.list.scrollTop;
  const pts = matrixPoints(g, selected);
  const count = pts.length;
  const matrix = h('div.op-matrix', null,
    h('div.op-q'),
    h('div.op-vline'), h('div.op-hline'),
    h('div.op-ql.tl', null, 'QUICK WINS'),
    h('div.op-ql.tr', null, 'BIG BETS'),
    h('div.op-ql.bl', null, 'low effort →'),
    h('div.op-ql.br', null, 'high effort'),
    pts.map((p) => h('button.op-dot', {
      class: p.tone,
      style: { left: `${(p.x * 100).toFixed(1)}%`, top: `${(p.y * 100).toFixed(1)}%` },
      title: `${p.item.id} ${p.item.title} · value ${p.item.value}/5 · effort ${p.item.effort}/5`,
      onclick: () => select(p.item.id),
    }, p.label)));

  const gapRow = (i: OppItem) => h('button.op-row.gap', {
    class: [i.id === selected && 'sel', (i.status?.cls === 'parked' || later.has(i.id)) && 'parked', (i.status?.cls === 'none' || i.status?.cls === 'test') && 'edge-red'],
    onclick: () => select(i.id),
  },
  h('span.op-id', null, i.id),
  h('span.op-t', { title: i.title }, i.title),
  h('span.op-st-slot', null, i.status ? h('span.op-st', { class: i.status.cls }, i.status.text) : null));

  const sideRow = (i: OppItem, kind: 'open' | 'edge') => h(i.idea ? 'button.op-row' : 'div.op-row', {
    class: [kind, i.id === selected && 'sel', i.atRisk && 'risk', !i.idea && 'static'],
    title: i.idea ? '' : `${i.id} in the feature matrix; no idea raised for it`,
    onclick: i.idea ? () => select(i.id) : undefined,
  },
  kind === 'edge' ? h('span.op-up', null, icon('chevron', 12, 2.6)) : h('span.op-bdot'),
  h('span.op-t', { title: i.title }, i.title),
  i.idea ? h('span.op-id.r', null, i.id) : null,
  i.note ? h('span.op-note', { class: i.atRisk && 'risk' }, i.note) : null);

  setChildren(v.list,
    h('div.op-sec', null,
      h('div.op-sec-head', null, h('span.op-h', null, 'Value vs effort'), h('span.op-hs', null, `${count} ${count === 1 ? 'idea' : 'ideas'}`)),
      matrix,
      h('div.it-caption', null, "Value = scout's estimate from evidence. Effort = Captain's estimate once advised, scout's until then.")),
    h('div.op-sec', null,
      h('div.op-lab.gap', null, h('span.flex1', null, `WHAT WE'RE MISSING · ${g.gaps.length} ${g.gaps.length === 1 ? 'GAP' : 'GAPS'}`), h('span.op-sort', null, 'by priority')),
      g.gaps.length ? g.gaps.map(gapRow) : h('div.op-none', null, 'No gaps: nothing they have that we lack.')),
    h('div.op-sec.ruled', null,
      h('div.op-lab.open', null, 'NOBODY DOES IT · BE FIRST'),
      g.open.length ? g.open.map((i) => sideRow(i, 'open')) : h('div.op-none', null, 'No open space found yet.')),
    h('div.op-sec.ruled', null,
      h('div.op-lab.edge', null, 'WHERE WE WIN · PROTECT THESE'),
      g.edges.length ? g.edges.map((i) => sideRow(i, 'edge')) : h('div.op-none', null, 'No edges yet.')));
  v.list.scrollTop = scroll;
}

// ---------------------------------------------------------------- middle column

function drawDetail(item: OppItem | undefined, idea: ResearchIdea | undefined): void {
  const v = view!;
  if (!idea) {
    setChildren(v.detail, h('div.op-pick', null, 'Pick a gap to see what it would take.'));
    v.check.hidden = true;
    return;
  }
  const conf = idea.opportunity?.claim.confidence;
  const kicker = item ? detailKicker(item) : (idea.opportunity?.kind ?? 'IDEA').toUpperCase();
  const ev = evidenceLines(idea);
  const rows = detailRows(idea);
  const st = checkStatus(idea, ctx!.intel, config());
  setChildren(v.detail,
    h('div.op-dhead', null,
      h('div.op-kick', null,
        h('span.op-did', null, idea.id),
        h('span.op-kt', null, kicker),
        idea.status !== 'new' ? h('span.op-decided', { class: idea.status }, idea.status === 'approved' ? (idea.goalId ? `On the roadmap · ${idea.goalId}` : 'Approved') : 'Set aside') : null,
        h('span.flex1'),
        conf ? h('span.op-conf', { class: conf }, `${conf[0].toUpperCase()}${conf.slice(1)} confidence`) : null),
      h('div.op-title', null, idea.title),
      idea.opportunity?.claim.implication || idea.summary ? h('div.op-sum', null, idea.opportunity?.claim.implication ?? idea.summary) : null),
    h('div.op-fields', null, rows.map((r) => h('div.op-field', null,
      h('div.op-fl', null, r.label),
      r.key === 'evidence'
        ? h('div.op-fv.op-evs', null, ev.length
          ? ev.map((e) => {
              const href = safeHref(e.url);
              const text = href ? h('a.op-evt', { href, target: '_blank', rel: 'noopener noreferrer', title: href }, e.text) : h('span.op-evt', null, e.text);
              return h('div.op-ev', { title: LABEL_TEXT[e.label] }, labelDot(e.label), text, h('span.op-evm', null, e.meta));
            })
          : h('span.faint', null, 'No evidence attached.'))
        : h('div.op-fv', null, h('div', null, r.text), r.sub ? h('div.op-fsub', null, r.sub) : null)))));

  v.check.hidden = false;
  fillIntelCheckPanel(v.check, {
    idea, store: ctx!.intel, config: config(),
    onRun: () => void runCheck(idea),
    busy: checking.has(idea.id) || st.state === 'running' || st.state === 'queued',
    ...(blocked.get(idea.id) ? { blocked: blocked.get(idea.id) } : {}),
  });
}
