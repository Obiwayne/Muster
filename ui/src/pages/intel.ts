// Intel (#/intel, #/intel/<tab>): competitive intelligence. Header with the tracked companies, Export report and
// Run sweep; section tabs; the Fact / Opinion / Prediction legend; the running-job strip; and one tab body.
// GET /api/intel on show and again (debounced) after every `intel` event while the page is open.
import '../intel.css';
import type { IntelCompetitor, IntelStore } from '../../../src/types';
import { confirmDialog, h, icon, setChildren, showMenu, toast } from '../dom';
import { events, type Snapshot } from '../events';
import type { Page } from '../page';
import { run as runAction } from '../actions';
import { ago } from '../util';
import { ApiError, cancelJob, getIntel, getReport, removeCompetitor, startJob } from '../intelapi';
import {
  INTEL_TABS, TAB_LABELS, companyColour, domainOf, jobLine, parseTab, queuedJobs, runningJob, trackedCompanies, unseenChanges, type IntelTab,
} from '../intelmodel';
import type { IntelCtx } from '../intel/common';
import { emptyState } from '../intel/common';
import { TAB_RENDERERS } from '../intel/tabs';
import { openAddCompetitor } from '../intel/addcompetitor';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const EMPTY_INTEL: IntelStore = {
  version: 1, rev: 0, competitors: [], capabilities: [], themes: [], social: [], socialInsights: [], plans: [], findings: [], scenarios: [],
  filings: [], insights: [], changes: [], checks: [], watches: [], jobs: [], captainThread: [],
  nextIds: { capability: 1, theme: 1, insight: 1, plan: 1, finding: 1, scenario: 1, social: 1, change: 1, check: 1, watch: 1, job: 1 },
};

export function createIntel(): Page {
  let snap: Snapshot | null = null;
  let data: IntelStore | null = null;
  let loaded = false;
  let error = '';
  let visible = false;
  let tab: IntelTab = 'overview';

  const titleSub = h('div.it-title-s');
  const chips = h('div.it-chips');
  const exportBtn = h('button.btn.it-hbtn', { onclick: () => void exportReport() }, 'Export report') as HTMLButtonElement;
  const sweepBtn = h('button.btn.primary.it-hbtn', { onclick: () => void runSweep() }, icon('refresh', 13, 2.2), 'Run sweep') as HTMLButtonElement;
  const sub = h('div.it-sub', null,
    h('div.it-title', null, h('div.it-title-t', null, 'Competitive intelligence'), titleSub),
    chips, exportBtn, sweepBtn);
  const tabs = h('div.it-tabs');
  const jobStrip = h('div.it-job', { hidden: true });
  const body = h('div.it-body');
  const el = h('div.page.it-page', null, sub, tabs, jobStrip, body);

  // ---------------------------------------------------------------- fetching
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function load(): Promise<void> {
    const my = ++seq;
    try {
      const r = await getIntel();
      if (my !== seq) return;
      data = r ?? EMPTY_INTEL;
      error = '';
    } catch (e) {
      if (my !== seq) return;
      error = e instanceof ApiError && e.status === 404
        ? 'This Muster orchestrator has no /api/intel yet. Restart it on the latest build.'
        : errText(e);
    }
    loaded = true;
    render();
  }
  function refetch(): void {
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 250);
  }
  events.onIntel(() => { if (visible) refetch(); else loaded = false; });

  // ---------------------------------------------------------------- actions
  async function runSweep(): Promise<void> {
    const store = data ?? EMPTY_INTEL;
    if (!trackedCompanies(store).some((c) => !c.isUs && c.id !== 'us')) { toast('Add a competitor first'); return; }
    sweepBtn.disabled = true;
    try {
      const job = await runAction(startJob({ kind: 'sweep' }));
      if (job) { toast(job.status === 'queued' && runningJob(store) ? `Sweep ${job.id} queued after ${runningJob(store)!.id}` : `scout started sweep ${job.id}`); refetch(); }
    } finally { sweepBtn.disabled = false; }
  }
  async function exportReport(): Promise<void> {
    exportBtn.disabled = true;
    try {
      const md = await getReport();
      const a = h('a', { href: URL.createObjectURL(new Blob([md], { type: 'text/markdown' })), download: `intel-report-${new Date().toISOString().slice(0, 10)}.md` }) as HTMLAnchorElement;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) {
      toast(errText(e), 'error');
    } finally { exportBtn.disabled = false; }
  }
  function chipMenu(c: IntelCompetitor, anchor: HTMLElement): void {
    const r = anchor.getBoundingClientRect();
    showMenu([
      { label: `Research ${c.name} again`, onClick: () => void runAction(startJob({ kind: 'competitor', competitorIds: [c.id] }), `scout will research ${c.name}`).then(refetch) },
      ...(c.url ? [{ label: 'Open their site', onClick: () => window.open(c.url, '_blank', 'noreferrer') }] : []),
      'sep' as const,
      {
        label: 'Stop tracking', tone: 'danger' as const,
        onClick: async () => {
          if (!(await confirmDialog(`Stop tracking ${c.name}?`, 'Its watch stops and it leaves the chips and the matrix. What scout found stays in the history and the report.', 'Stop tracking', 'danger'))) return;
          if (await runAction(removeCompetitor(c.id), `Stopped tracking ${c.name}`)) refetch();
        },
      },
    ], r.left, r.bottom + 6);
  }
  const ctx = (): IntelCtx => ({
    intel: data ?? EMPTY_INTEL,
    research: snap?.state.research ?? { runs: [], ideas: [] },
    snapshot: snap!,
    refresh: refetch,
    go: (t) => { location.hash = t === 'overview' ? '#/intel' : `#/intel/${t}`; },
    addCompetitor: () => openAdd(),
  });
  function openAdd(): void {
    openAddCompetitor({ config: snap?.config ?? null, existing: data?.competitors ?? [], onAdded: () => refetch() });
  }

  // ---------------------------------------------------------------- render
  function renderHead(store: IntelStore): void {
    const companies = trackedCompanies(store);
    const tracked = companies.filter((c) => !c.isUs && c.id !== 'us');
    const swept = tracked.map((c) => c.lastSweptAt).filter(Boolean).sort().pop() ?? events.intel?.lastSweptAt;
    titleSub.textContent = `${tracked.length} tracked${swept ? ` · swept ${ago(swept)} ago` : ' · not swept yet'}`;
    setChildren(chips,
      companies.map((c) => {
        const us = c.isUs || c.id === 'us';
        const chip = h('button.it-chip', { class: us && 'us', title: c.url || (us ? 'Set our URL in Settings' : '') },
          h('span.it-chip-dot', { style: { background: companyColour(c) } }),
          h('span.it-chip-n', null, c.name),
          us ? h('span.it-chip-us', null, 'us') : c.url ? h('span.it-chip-d', null, domainOf(c.url)) : null);
        if (!us) chip.onclick = () => chipMenu(c, chip);
        return chip;
      }),
      h('button.it-chip.add', { onclick: () => openAdd() }, icon('plus', 12, 2.2), 'Add competitor'));
  }

  function renderTabs(store: IntelStore): void {
    const newIdeas = snap?.state.research?.ideas.filter((i) => i.origin === 'intel' && i.status === 'new').length ?? 0;
    const unseen = unseenChanges(store);
    setChildren(tabs,
      INTEL_TABS.map((t) => h('a.it-tab', { class: t === tab && 'on', href: t === 'overview' ? '#/intel' : `#/intel/${t}` },
        TAB_LABELS[t],
        t === 'opportunities' && newIdeas ? h('span.it-tab-n', null, String(newIdeas)) : null,
        t === 'changes' && unseen ? h('span.it-tab-dot', { title: `${unseen} unseen` }) : null)),
      h('div.flex1'),
      h('div.it-legend', null,
        h('span', null, h('i.ld-fact'), 'Fact'),
        h('span', null, h('i.ld-opinion'), 'Opinion'),
        h('span', null, h('i.ld-prediction'), 'Prediction')));
  }

  function renderJob(store: IntelStore): void {
    const job = runningJob(store);
    const queued = queuedJobs(store);
    jobStrip.hidden = !job && !queued.length;
    if (jobStrip.hidden) return;
    setChildren(jobStrip,
      h('span.it-job-pulse', { class: !job && 'idle' }),
      h('div.flex1.ellipsis', null,
        job ? jobLine(job, store) : `${queued.length} intel job${queued.length === 1 ? '' : 's'} queued`,
        job?.startedAt ? h('span.faint', null, ` · started ${ago(job.startedAt)} ago`) : null,
        job && queued.length ? h('span.faint', null, ` · ${queued.length} queued`) : null,
        snap?.state.usage.paused ? h('span.it-job-warn', null, ' · paused by the 5-hour limit') : null),
      job ? h('button.btn.sm', { onclick: () => void runAction(cancelJob(job.id), `Cancelled ${job.id}`).then(refetch) }, 'Cancel') : null);
  }

  function render(): void {
    if (!snap) return;
    const store = data ?? EMPTY_INTEL;
    renderHead(store);
    renderTabs(store);
    renderJob(store);
    if (!loaded) { setChildren(body, h('div.it-loading', null, 'Loading intel…')); return; }
    if (error) { setChildren(body, emptyState("Couldn't load intel", error, { label: 'Try again', onClick: () => void load() })); return; }
    body.dataset.tab = tab;
    TAB_RENDERERS[tab](body, ctx());
  }

  return {
    el,
    update(s) { snap = s; if (visible) render(); },
    params(p) {
      const next = parseTab(p.get('tab'));
      if (next !== tab) { tab = next; body.scrollTop = 0; }
      render();
    },
    show() { visible = true; if (!loaded) void load(); else refetch(); },
    hide() { visible = false; },
  };
}
