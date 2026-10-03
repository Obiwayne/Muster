// Research: the "New research" modal (also opened from the Roadmap page) and the research page at
// #/roadmap/research (Vellum 6644-0): run strip, New / On roadmap / Rejected filter, idea cards with their intel
// check verdict chip, and a rail with the selected idea's Intel check, the Captain's advice and what the Captain
// will change on approval. Approve needs a fresh intel check (the server answers 409 otherwise).
// GET /api/research, re-fetched (debounced) on each state event while the page is open; GET /api/intel on show
// and after each `intel` event. Intel ideas (origin 'intel') are listed on Intel -> Opportunities instead.
import '../intelcheck.css';
import type { IntelCheck, IntelStore, MusterState, ResearchIdea, ResearchRun, ResearchState, Roadmap } from '../../../src/types';
import { closeFloating, h, icon, setChildren, toast, type Child } from '../dom';
import { events, type Snapshot } from '../events';
import type { Page } from '../page';
import { ApiError, api } from '../api';
import { run as runAction } from '../actions';
import { displayName } from '../util';
import {
  DEPTH, EMPTY_RESEARCH, addChip, draftFromLastRun, draftToRun, evidenceChips, filterIdeas, fitsLabel,
  ideaCounts, ideaFooter, impactPill, lastRun, parsePlanItem, researchEstimate, researchIdeas, runStrip, runningRun, sourceChips, splitAdvice,
  type IdeaFilter, type ResearchDraft,
} from '../research';
import { browseFootnote, createBrowseChoice, initialBrowseMode } from '../browsechoice';
import { getBrowserStatus, getIntel } from '../intelapi';
import { approveIdea, checkChip, checkStatus, chipEl, fillIntelCheckPanel, planLines, recheckLine, runIntelCheck, watchLine } from '../intelcheck';

const go = (hash: string) => { location.hash = hash; };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------- New research modal

/** One modal per page; the draft survives closing it until a run starts. */
export function createResearchModal(onStarted?: (run: ResearchRun) => void): { open(research: ResearchState | null): void } {
  let draft: ResearchDraft | null = null;

  function open(research: ResearchState | null): void {
    closeFloating();
    const d = draft ?? (draft = draftFromLastRun(lastRun(research)));
    const cfg = events.snapshot?.config ?? null;
    const competitors = events.intel?.competitors ?? 0;
    if (!d.browse) d.browse = initialBrowseMode(cfg, null);
    let busy = false;
    const error = h('div.rs-modal-err', { hidden: true });
    const focus = h('textarea.rs-focus', { rows: 2, placeholder: 'e.g. Why do teachers stop using wall apps after the first month?' }) as HTMLTextAreaElement;
    focus.value = d.focus;
    focus.addEventListener('input', () => { d.focus = focus.value; });
    const sources = h('div.rs-sources');
    const depthRow = h('div.rs-depth-row');
    const startBtn = h('button.btn.rs-start', null, 'Start research') as HTMLButtonElement;
    const footText = h('div.flex1.faint', null, `${browseFootnote(d.browse)} No code changes.`);
    const setFoot = () => { footText.textContent = `${browseFootnote(d.browse ?? 'profile')} No code changes.`; };
    const browse = createBrowseChoice({
      value: d.browse, operaAllow: cfg?.researchBrowser?.operaAllow ?? [],
      onChange: (m) => { d.browse = m; setFoot(); },
    });
    void getBrowserStatus().then((st) => { browse.setStatus(st, cfg?.researchBrowser?.operaAllow); d.browse = browse.value(); setFoot(); }, () => { /* status unknown: keep the choice */ });

    const showError = (msg: string) => { error.textContent = msg; error.hidden = !msg; };

    /** Chips with × and an inline "+ Add" input (Enter adds and stays open for the next one). */
    function chipRow(list: () => string[], set: (v: string[]) => void, addLabel: string, placeholder: string, mono: boolean, extra?: () => Child): HTMLElement {
      const row = h('div.rs-chips');
      const draw = (adding = false) => {
        const add = adding
          ? (() => {
              const input = h('input.rs-chip-input', { placeholder, class: mono && 'mono' }) as HTMLInputElement;
              let done = false;
              const finish = (commit: boolean, again: boolean) => {
                if (done) return;
                done = true;
                if (commit && input.value.trim()) { set(addChip(list(), input.value)); d.fromLastRun = false; }
                draw(again);
              };
              input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); finish(true, !!input.value.trim()); }
                if (e.key === 'Escape') { e.stopPropagation(); finish(false, false); }
              });
              input.addEventListener('blur', () => finish(true, false));
              setTimeout(() => input.focus());
              return input;
            })()
          : h('button.rs-chip-add', { onclick: (e: MouseEvent) => { e.stopPropagation(); draw(true); } }, addLabel);
        setChildren(row,
          list().map((v) => h('span.rs-chip', { class: mono && 'mono' }, v,
            h('button.x', { title: `Remove ${v}`, onclick: (e: MouseEvent) => { e.stopPropagation(); set(list().filter((x) => x !== v)); d.fromLastRun = false; draw(); } }, '×'))),
          add,
          extra?.());
      };
      draw();
      return row;
    }

    function source(on: boolean, toggleOn: (v: boolean) => void, title: string, sub: string, chips?: HTMLElement): HTMLElement {
      const box = h('span.rs-check', { class: on && 'on' }, on ? icon('tick', 10, 3.5) : null);
      return h('div.rs-source', {
        class: on && 'on',
        role: 'checkbox',
        'aria-checked': String(on),
        tabindex: 0,
        onclick: () => { toggleOn(!on); showError(''); drawSources(); },
        onkeydown: (e: KeyboardEvent) => { if ((e.key === ' ' || e.key === 'Enter') && e.target === e.currentTarget) { e.preventDefault(); toggleOn(!on); drawSources(); } },
      },
      box,
      h('div.rs-source-body', null,
        h('div.rs-source-t', null, title),
        h('div.rs-source-s', null, sub),
        on && chips ? h('div', { onclick: (e: MouseEvent) => e.stopPropagation() }, chips) : null));
    }

    function drawSources(): void {
      setChildren(sources,
        source(d.useCompetitors, (v) => { d.useCompetitors = v; }, 'Similar apps and their roadmaps', 'Features, pricing, public roadmaps and changelogs',
          chipRow(() => d.competitors, (v) => { d.competitors = v; }, '+ Add app', 'App name or URL', false,
            () => (d.fromLastRun && d.competitors.length ? h('span.rs-suggested', null, 'from the last run') : null))),
        source(d.reviews, (v) => { d.reviews = v; }, 'Customer reviews and complaints', 'App Store, Google Play and G2 reviews of those apps, low ratings first'),
        source(d.useForums, (v) => { d.useForums = v; }, 'Reddit and forums', 'What people ask for, complain about and switch away from',
          chipRow(() => d.forums, (v) => { d.forums = v; }, '+ Add', 'r/Teachers', true)),
        source(d.ownApp, (v) => { d.ownApp = v; }, 'Our own app', 'Read the code and the roadmap for rough edges and quick wins'));
    }

    function drawDepth(): void {
      const b = (v: 'quick' | 'thorough') => h('button', { class: d.depth === v && 'on', onclick: () => { d.depth = v; drawDepth(); } }, DEPTH[v].label);
      const est = researchEstimate(d.depth, competitors);
      setChildren(depthRow,
        h('div.section-label', null, 'DEPTH'),
        h('div.rm-toggle.rs-depth', null, b('quick'), b('thorough')),
        h('div.flex1'),
        h('div.rs-est', { title: DEPTH[d.depth].usage + ' for the research itself' }, h('div.rs-usage-est', null, est.usage), h('div.rs-est-note', null, est.checks)));
    }

    drawSources();
    drawDepth();

    const close = () => {
      back.remove();
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('hashchange', close);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };

    startBtn.onclick = async () => {
      if (busy) return;
      const r = draftToRun(d);
      if (!r.body) { showError(r.error ?? 'Pick at least one source.'); return; }
      busy = true;
      startBtn.disabled = true;
      showError('');
      try {
        const started = await api.startResearch(r.body);
        draft = null;
        close();
        onStarted?.(started);
        toast('scout started researching');
        if (location.hash !== '#/roadmap/research') go('#/roadmap/research');
      } catch (e) {
        showError(e instanceof ApiError && e.status === 409 && /running/i.test(e.message)
          ? `${e.message}. Cancel it on the research page first, or wait for it to finish.`
          : errText(e));
      } finally {
        busy = false;
        startBtn.disabled = false;
      }
    };

    const modal = h('div.modal.rs-modal', { role: 'dialog', 'aria-label': 'New research' },
      h('div.rs-modal-head', null,
        h('div.rs-icon-box', null, icon('search-plus', 18)),
        h('div.flex1', null,
          h('div.rs-modal-title', null, 'New research'),
          h('div.rs-modal-sub', null, 'scout reads the web (read-only), comes back with ideas, and you decide what reaches the roadmap.')),
        h('button.icon-btn', { title: 'Close', onclick: close }, icon('x', 14))),
      h('div.rs-modal-body', null,
        h('div.section-label', null, 'LOOK AT'),
        sources,
        h('div.rs-field', null, h('div.section-label', null, 'ANYTHING SPECIFIC? (OPTIONAL)'), focus),
        depthRow,
        browse.el),
      error,
      h('div.rs-modal-foot', null,
        icon('lock', 14),
        footText,
        h('button.btn', { onclick: close }, 'Cancel'),
        startBtn));
    const back = h('div.modal-back', { onmousedown: (e: MouseEvent) => { if (e.target === back) close(); } }, modal);
    document.body.appendChild(back);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('hashchange', close);
  }

  return { open };
}

// ---------------------------------------------------------------- page

export function createResearch(): Page {
  let snap: Snapshot | null = null;
  let data: ResearchState | null = null;
  let loaded = false;
  let error = '';
  let visible = false;
  let filter: IdeaFilter = 'new';
  let selected: string | null = null;
  let askError = '';
  let asking = false;
  let intel: IntelStore | null = null;
  let deciding = false;
  const blocked = new Map<string, string>(); // idea -> the approve 409 (or the gate reason) shown in the rail
  const checking = new Set<string>();
  const askDrafts = new Map<string, string>();
  const modal = createResearchModal((run) => { filter = 'new'; selected = null; applyRun(run); });

  const subbar = h('div.rm-sub');
  const list = h('div.rs-main');
  const railHead = h('div.rs-rail-head');
  const railEvidence = h('div.rs-rail-sec.ic');
  const railThread = h('div.rs-thread');
  const askInput = h('input.rs-ask-input', { placeholder: 'Ask a follow-up…' }) as HTMLInputElement;
  const askBox = h('label.rs-ask', null, askInput, h('span.rs-kbd', null, 'Enter'));
  const askErr = h('div.rs-ask-err', { hidden: true });
  const railActions = h('div.rs-rail-actions');
  const railGate = h('div.cr-gate', { hidden: true });
  const railAsk = h('div.rs-rail-ask', null, h('div.section-label', null, 'ASK CAPTAIN'), railThread, askBox, askErr, railGate, railActions);
  const railEmpty = h('div.rs-rail-empty');
  const rail = h('aside.rs-rail', null, railHead, railEvidence, railAsk, railEmpty);
  const el = h('div.page', null, subbar, h('div.rs-body', null, list, rail));

  // ---------------------------------------------------------------- fetching
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function load(): Promise<void> {
    const my = ++seq;
    try {
      const r = await api.research();
      if (my !== seq) return;
      data = r ?? EMPTY_RESEARCH;
      error = '';
    } catch (e) {
      if (my !== seq) return;
      error = e instanceof ApiError && e.status === 404
        ? 'This Muster orchestrator has no /api/research yet. Restart it on the latest build.'
        : errText(e);
    }
    loaded = true;
    render();
  }
  function refetch(): void {
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 300);
  }
  let intelSeq = 0;
  let intelTimer: ReturnType<typeof setTimeout> | undefined;
  async function loadIntel(): Promise<void> {
    const my = ++intelSeq;
    try {
      const r = await getIntel();
      if (my !== intelSeq) return;
      intel = r;
    } catch {
      // an orchestrator without /api/intel: no checks to show, and Approve works as before
      if (my !== intelSeq) return;
    }
    render();
  }
  events.onIntel(() => {
    if (!visible) return;
    clearTimeout(intelTimer);
    intelTimer = setTimeout(() => void loadIntel(), 250);
  });
  /** Put an idea from an action's response in place right away, then refresh. */
  function applyIdea(i: ResearchIdea | undefined): void {
    if (!i || !data) return;
    seq++;
    data = { ...data, ideas: data.ideas.map((x) => (x.id === i.id ? i : x)) };
    render();
    refetch();
  }
  function applyRun(r: ResearchRun | undefined): void {
    if (!r || !data) return;
    seq++;
    data = { ...data, runs: data.runs.some((x) => x.id === r.id) ? data.runs.map((x) => (x.id === r.id ? r : x)) : [...data.runs, r] };
    render();
    refetch();
  }

  // ---------------------------------------------------------------- actions
  const research = () => data ?? snap?.state.research ?? EMPTY_RESEARCH;
  async function approve(i: ResearchIdea): Promise<void> {
    if (deciding) return;
    const st = intel ? checkStatus(i, intel, snap?.config) : null;
    if (st && !st.canApprove) {
      // the card's Approve can't pass the gate: show why in the rail, with "Run intel check"
      blocked.set(i.id, st.reason);
      selected = i.id;
      render();
      return;
    }
    deciding = true;
    const r = await approveIdea(i);
    deciding = false;
    if (r.blocked) { blocked.set(i.id, r.blocked); selected = i.id; render(); void loadIntel(); return; }
    blocked.delete(i.id);
    applyIdea(r.idea);
  }
  async function runCheck(i: ResearchIdea): Promise<void> {
    if (checking.has(i.id)) return;
    checking.add(i.id);
    render();
    const ok = await runIntelCheck(i.id);
    checking.delete(i.id);
    if (ok) blocked.delete(i.id);
    await loadIntel();
  }
  const reject = async (i: ResearchIdea) => applyIdea(await runAction(api.rejectIdea(i.id), `Rejected ${i.id}`));
  const reopen = async (i: ResearchIdea) => applyIdea(await runAction(api.reopenIdea(i.id), `${i.id} is back in New`));
  const cancelRun = async (r: ResearchRun) => applyRun(await runAction(api.cancelResearch(r.id), 'Research cancelled'));
  const askCaptain = (i: ResearchIdea) => { selected = i.id; render(); askInput.focus(); };

  async function sendAsk(): Promise<void> {
    const text = askInput.value.trim();
    const id = selected;
    if (!text || !id || asking) return;
    asking = true;
    askInput.disabled = true;
    askError = '';
    try {
      const i = await api.askIdea(id, text);
      askDrafts.delete(id);
      if (selected === id) askInput.value = '';
      applyIdea(i);
    } catch (e) {
      askError = errText(e);
    } finally {
      asking = false;
      askInput.disabled = false;
      render();
      if (selected === id) askInput.focus();
    }
  }
  askInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) void sendAsk(); });
  askInput.addEventListener('input', () => { if (selected) askDrafts.set(selected, askInput.value); if (askError) { askError = ''; askErr.hidden = true; } });

  // ---------------------------------------------------------------- render
  function render(): void {
    if (!snap) return;
    const state = snap.state;
    const r = research();
    const mine = researchIdeas(r.ideas);
    const counts = ideaCounts(mine);
    const tab = (f: IdeaFilter, label: string) => h('button', { class: filter === f && 'on', onclick: () => { filter = f; selected = null; render(); } },
      label, h('span.rs-count', null, String(counts[f])));
    setChildren(subbar,
      h('div.rm-crumbs', null,
        h('button.rm-crumb', { onclick: () => go('#/roadmap') }, icon('chevron-left', 14), 'Roadmap'),
        h('span.faint', null, '/'),
        h('span.rm-crumb-title', null, 'Research')),
      h('div.rm-toggle.rs-filter', null, tab('new', 'New'), tab('roadmap', 'On roadmap'), tab('rejected', 'Rejected')),
      h('button.btn.sm.primary', { onclick: () => modal.open(r) }, icon('search', 13, 2.2), 'New research'));

    const ideas = filterIdeas(mine, filter);
    if (!selected || !ideas.some((i) => i.id === selected)) selected = ideas[0]?.id ?? null;
    const sel = r.ideas.find((i) => i.id === selected);
    const rm = state.roadmap ?? null;

    const scroll = list.scrollTop;
    if (!loaded && !snap.state.research) setChildren(list, h('div.empty', null, 'Loading research…'));
    else if (error && !r.runs.length) setChildren(list, h('div.hero-empty', null, h('div.hero-card', null, h('div.big.rm-hero', null, 'Research'), h('p', null, error), h('button.btn.secondary', { onclick: () => void load() }, 'Try again'))));
    else if (!r.runs.length && !mine.length) setChildren(list, emptyHero(r));
    else {
      const last = lastRun(r);
      setChildren(list,
        last ? runStripEl(last, r) : null,
        ideas.length ? h('div.rs-cards', null, ideas.map((i) => card(i, rm, state))) : h('div.rs-none', null, emptyText(r)));
    }
    list.scrollTop = scroll;
    renderRail(sel, rm, state);
  }

  function emptyText(r: ResearchState): string {
    if (filter === 'roadmap') return 'Nothing approved yet. Ideas you approve go onto the roadmap through the Captain.';
    if (filter === 'rejected') return 'No rejected ideas.';
    return runningRun(r) ? 'No new ideas yet. They show up here as scout finds them.' : 'No new ideas. Start a new research run to look again.';
  }

  function emptyHero(r: ResearchState): HTMLElement {
    return h('div.hero-empty', null, h('div.hero-card', null,
      h('div.big.rm-hero', null, 'No research yet'),
      h('p', null, 'scout reads public pages: similar apps and their roadmaps, reviews and forum threads, and your own app. It comes back with ideas backed by evidence, and you decide which reach the roadmap.'),
      h('button.btn.primary.lg', { onclick: () => modal.open(r) }, icon('search', 14), 'New research')));
  }

  function runStripEl(run: ResearchRun, r: ResearchState): HTMLElement {
    const st = runStrip(run, r.ideas);
    const running = run.status === 'running';
    return h('div.rs-run', { class: [st.tone, running && 'running'] },
      h('div.rs-icon-box', null, running ? h('span.rs-pulse') : icon(run.status === 'failed' ? 'alert' : run.status === 'cancelled' ? 'x' : 'search', 16)),
      h('div.flex1', null,
        h('div.rs-run-t', null, h('span.rs-who', null, run.agentId || 'scout'), h('span', null, st.title)),
        h('div.rs-run-s', { title: st.sub }, st.sub)),
      running
        ? h('button.btn.sm', { onclick: () => void cancelRun(run) }, 'Cancel')
        : h('div.rs-run-chips', null, sourceChips(run.sources).map((c) => h('span.rs-src', null, c))));
  }

  function card(i: ResearchIdea, rm: Roadmap | null, state: MusterState): HTMLElement {
    const pill = impactPill(i);
    const fits = fitsLabel(rm, i.stageId);
    const curStage = state.roadmap?.stages.find((s) => s.status === 'active')?.id;
    const foot = ideaFooter(i, rm);
    const stop = (fn: () => void) => (e: MouseEvent) => { e.stopPropagation(); fn(); };
    const gate = intel ? checkStatus(i, intel, snap?.config) : null;
    const actions: Child[] = i.status === 'new'
      ? [h('button.rs-act', { onclick: stop(() => void reject(i)) }, 'Reject'),
         h('button.rs-act.ask', { onclick: stop(() => askCaptain(i)) }, 'Ask Captain'),
         h('button.rs-act.ok', {
           class: gate && !gate.canApprove && 'gated',
           title: gate && !gate.canApprove ? gate.reason : 'Approve; the Captain adds it to the roadmap',
           onclick: stop(() => void approve(i)),
         }, 'Approve')]
      : i.status === 'approved'
        ? [foot.goalStage ? h('button.rs-act.strong', { onclick: stop(() => go(`#/roadmap/${encodeURIComponent(foot.goalStage!)}`)) }, 'Open on roadmap →') : null]
        : [h('button.rs-act', { onclick: stop(() => void reopen(i)) }, 'Reopen')];
    return h('div.rs-card', {
      class: [i.id === selected && 'sel', i.status],
      tabindex: 0,
      onclick: () => { selected = i.id; render(); },
      onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' && e.target === e.currentTarget) { selected = i.id; render(); } },
    },
    h('div.rs-card-top', null,
      h('div.flex1', null,
        h('div.rs-card-title', null, h('span.rs-id', null, i.id), h('span', null, i.title)),
        i.summary ? h('div.rs-card-sum', null, i.summary) : null),
      h('div.rs-pills', null,
        h('span.rs-pill', { class: pill.tone }, pill.label),
        h('span.rs-effort', null, `Effort ${i.effort}`))),
    h('div.rs-card-ev', null,
      intel ? chipEl(checkChip(i, intel, snap?.config)) : null,
      evidenceChips(i.evidence).map((c) => h('span.rs-ev', null, h('span.d', { class: c.tone }), c.label)),
      h('span.flex1'),
      fits ? [h('span.faint', null, 'fits'), h('span.rs-fits', { class: i.stageId === curStage && 'cur' }, fits)] : null),
    h('div.rs-card-foot', null,
      h('span.rs-status', { class: foot.tone }, h('span.d'), foot.text),
      h('span.flex1'),
      actions));
  }

  /** The re-check and link lines the intel check adds to "On approve, Captain will". */
  function planIntelLines(check: IntelCheck | undefined): HTMLElement[] {
    const out: HTMLElement[] = [];
    const re = recheckLine(check, snap?.config);
    if (re) out.push(h('div.rs-plan-row', null, h('span.rs-plan-sign.watch', null, '◉'), h('span.rs-plan-text', null, re.text), re.meta ? h('span.rs-plan-meta', null, re.meta) : null));
    if (check) out.push(h('div.rs-plan-row', null, h('span.rs-plan-sign', null, '↳'), h('span.rs-plan-text.muted', null, `Attach intel check ${check.id} to the new goal`)));
    return out;
  }

  function renderRail(i: ResearchIdea | undefined, rm: Roadmap | null, state: MusterState): void {
    for (const sec of [railHead, railEvidence, railAsk]) sec.hidden = !i;
    railEmpty.hidden = !!i;
    if (!i) {
      setChildren(railEmpty, research().ideas.length ? 'Pick an idea to see its evidence and ask the Captain about it.' : 'Ideas show up here with their evidence.');
      return;
    }
    if (askInput.dataset.idea !== i.id) {
      askInput.dataset.idea = i.id;
      askInput.value = askDrafts.get(i.id) ?? '';
      askError = '';
    }
    const ago = agoUpper(i.createdAt);
    setChildren(railHead,
      h('div.rs-rail-kicker', null, h('span.rs-id', null, i.id), h('span', null, `FOUND BY ${(state.agents.find((a) => a.role === 'research')?.id ?? 'scout').toUpperCase()} · ${ago}`)),
      h('div.rs-rail-title', null, i.title),
      i.status !== 'new' ? h('div.rs-rail-state', { class: i.status }, i.status === 'approved' ? ideaFooter(i, rm).text : 'Rejected') : null);

    // 6644-0: the Intel check replaces the evidence list (the evidence chips stay on the card)
    railEvidence.hidden = !intel;
    if (intel) {
      fillIntelCheckPanel(railEvidence, {
        idea: i, store: intel, config: snap?.config,
        onRun: () => void runCheck(i),
        busy: checking.has(i.id),
        ...(i.status === 'new' && blocked.get(i.id) ? { blocked: blocked.get(i.id) } : {}),
      });
    }
    const st = intel ? checkStatus(i, intel, snap?.config) : null;

    const items: HTMLElement[] = i.thread.map((m) => {
      if (m.from === 'you') return h('div.rs-msg.you', { title: m.at }, m.text);
      const { lead, rest } = splitAdvice(m.text);
      return h('div.rs-msg.captain', { title: m.at },
        h('div.rs-msg-who', null, h('span.d'), displayName(m.from)),
        h('div.rs-msg-text', null, lead),
        rest ? h('div.rs-msg-rest', null, rest) : null);
    });
    if (!i.thread.length) items.push(h('div.rs-hint', null, 'Ask what it would cost, where it fits, or what it would push back. The Captain answers here.'));
    const waiting = i.thread.length > 0 && i.thread[i.thread.length - 1].from === 'you';
    if (waiting) items.push(h('div.rs-hint', null, h('span.rs-typing'), 'The Captain will answer here.'));
    const plan = planLines(i.plan);
    const watched = i.status === 'approved' ? watchLine(i, intel) : null;
    if (plan.length || watched) {
      items.push(h('div.rs-plan', null,
        h('div.rs-plan-t', null, i.status === 'approved' ? 'CAPTAIN IS MAKING THESE CHANGES' : 'ON APPROVE, CAPTAIN WILL'),
        plan.map((line) => {
          const p = parsePlanItem(line);
          return h('div.rs-plan-row', null, h('span.rs-plan-sign', { class: p.sign === '+' ? 'add' : p.sign === '~' ? 'move' : p.sign === '−' ? 'drop' : '' }, p.sign),
            h('span.rs-plan-text', null, p.text), p.meta ? h('span.rs-plan-meta', { title: p.meta }, p.meta) : null);
        }),
        watched ? h('div.rs-plan-row', null, h('span.rs-plan-sign.watch', null, '◉'), h('span.rs-plan-text', null, watched.text), watched.meta ? h('span.rs-plan-meta', null, watched.meta) : null) : null,
        i.status === 'new' && intel ? planIntelLines(st?.check) : null));
    }
    setChildren(railThread, items);
    askErr.textContent = askError;
    askErr.hidden = !askError;
    askInput.placeholder = i.thread.length ? 'Ask a follow-up…' : 'Ask the Captain about this idea…';

    // a server 409 is repeated next to the buttons (the check panel above already explains a missing/stale check)
    const gateMsg = i.status === 'new' ? blocked.get(i.id) ?? '' : '';
    railGate.hidden = !gateMsg;
    setChildren(railGate, icon('alert', 13), h('span.flex1', null, gateMsg),
      st && st.canRun ? h('button.btn.sm', { disabled: checking.has(i.id), onclick: () => void runCheck(i) }, 'Run intel check') : null);
    const canApprove = !st || st.canApprove;
    setChildren(railActions,
      i.status === 'new'
        ? [h('button.rs-big', { onclick: () => void reject(i) }, 'Reject'),
           h('button.rs-big.ok', { disabled: !canApprove || deciding, title: canApprove ? '' : st!.reason, onclick: () => void approve(i) }, 'Approve & add to roadmap')]
        : i.status === 'rejected'
          ? h('button.rs-big', { onclick: () => void reopen(i) }, 'Reopen')
          : (() => { const st = ideaFooter(i, rm).goalStage; return st ? h('button.rs-big', { onclick: () => go(`#/roadmap/${encodeURIComponent(st)}`) }, 'Open on roadmap →') : null; })());
    const nearBottom = railThread.scrollHeight - railThread.scrollTop - railThread.clientHeight < 40;
    if (nearBottom) railThread.scrollTop = railThread.scrollHeight;
  }

  return {
    el,
    update(s) {
      snap = s;
      if (visible) refetch();
      render();
    },
    params(p) {
      const id = p.get('idea');
      if (id) {
        const i = research().ideas.find((x) => x.id === id);
        if (i) filter = i.status === 'approved' ? 'roadmap' : i.status === 'rejected' ? 'rejected' : 'new';
        selected = id;
        render();
      }
    },
    show() {
      visible = true;
      void load();
      void loadIntel();
    },
    hide() {
      visible = false;
      clearTimeout(timer);
    },
  };
}

function agoUpper(iso: string): string {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(m) || m < 1) return 'JUST NOW';
  if (m < 60) return `${m}M AGO`;
  const hrs = Math.round(m / 60);
  if (hrs < 48) return `${hrs}H AGO`;
  return `${Math.round(hrs / 24)}D AGO`;
}
