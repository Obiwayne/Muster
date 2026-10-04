// Roadmap: overview (summary strip, stage timeline by week, panels) at #/roadmap and
// stage detail (goal groups → task table, exit criteria, stage activity) at #/roadmap/<stageId>.
// Everything is counted by the orchestrator: GET /api/roadmap, re-fetched (debounced) on each state event.
import type { MusterState, Roadmap, RoadmapGoal, RoadmapHealth, RoadmapProgress, RoadmapStage, Task } from '../../../src/types';
import { h, icon, setChildren, type Child } from '../dom';
import { events, type Snapshot } from '../events';
import type { Page } from '../page';
import { ApiError, api, type RoadmapResponse } from '../api';
import { approveRoadmap, askCaptain, run, sendBackRoadmap } from '../actions';
import { ageShort, displayName, hhmm, idNum, roleOf, stationRole, taskIsStuck } from '../util';
import { agoText, newCount, updatedLine } from '../research';
import { createResearchModal } from './research';
import {
  DAY, HEALTH, average, barSpan, currentStageId, frac, labelStep, launchText, localDay, mergedPerDay, nextStage, parseDay,
  recentlyLanded, shortDate, shortDay, spanStyle, stageById, stageFeed, stageGoals, stageOfTask, stageWeights, stationWord,
  timelineScale, todayFrac, stageCount, stageBasis, goalCount, overallText, unlinkedText, columnIndex, columnStarts, type Scale, type Span,
} from '../roadmap';

type View = 'timeline' | 'stages';
type StageP = RoadmapProgress['stages'][string];
type GoalP = RoadmapProgress['goals'][string];

const VIEW_KEY = 'muster.roadmapView';
const NO_STAGE: StageP = { done: 0, total: 0, percent: 0, health: 'not_started', criteriaDone: 0, criteriaTotal: 0 };
const NO_GOAL: GoalP = { done: 0, total: 0, percent: 0, agents: [] };
const EMPTY_PROGRESS: RoadmapProgress = { overall: { done: 0, total: 0, percent: 0 }, health: 'not_started', stages: {}, goals: {} };

const go = (hash: string) => { location.hash = hash; };
const stageHash = (id: string) => `#/roadmap/${encodeURIComponent(id)}`;

/** Colour of a stage id / label by status. */
function stageTone(s: RoadmapStage, current: boolean): string {
  if (s.status === 'done') return 'var(--color-success)';
  if (current || s.status === 'active') return 'var(--color-crew)';
  return 'var(--color-faint)';
}

function pct(n: number): string { return `${Math.max(0, Math.min(100, n))}%`; }

function healthPill(hl: RoadmapHealth): HTMLElement {
  const c = HEALTH[hl] ?? HEALTH.not_started;
  return h('div.rm-health', { style: { '--p': c.color } }, h('span.d'), c.label);
}

export function createRoadmap(): Page {
  let snap: Snapshot | null = null;
  let data: RoadmapResponse | null = null;
  let loaded = false;
  let error = '';
  let stageId: string | null = null;
  let visible = false;
  let view: View = 'timeline';
  try { if (localStorage.getItem(VIEW_KEY) === 'stages') view = 'stages'; } catch { /* ignore */ }
  const stageOpen = new Map<string, boolean>(); // timeline: stage expanded (overrides "current stage is open")
  const goalOpen = new Map<string, boolean>(); // detail: goal group expanded (overrides "current goal is open")
  const researchModal = createResearchModal(); // opened straight from here while there is no research yet

  const subbar = h('div.rm-sub');
  const said = h('div.rm-said-host'); // the Captain's latest roadmap_status line
  const banner = h('div.rm-banner-host');
  const overview = h('div.rm-scroll');
  const dmain = h('div.rm-dmain');
  const rail = h('aside.rm-rail');
  const detail = h('div.rm-detail', { hidden: true }, dmain, rail);
  const el = h('div.page.rm', null, subbar, said, banner, overview, detail);

  // ---------------------------------------------------------------- fetching
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function load(): Promise<void> {
    const my = ++seq;
    try {
      const r = await api.roadmap();
      if (my !== seq) return;
      data = r;
      error = '';
    } catch (e) {
      if (my !== seq) return;
      error = e instanceof ApiError && e.status === 404
        ? 'This Muster orchestrator has no /api/roadmap yet. Restart it on the latest build.'
        : e instanceof Error ? e.message : String(e);
    }
    loaded = true;
    render();
  }
  function refetch(): void {
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 250);
  }
  /** Use a response from an action (approve, tick…) right away. */
  function apply(r: RoadmapResponse | undefined): void {
    if (!r) return;
    seq++;
    data = r;
    loaded = true;
    error = '';
    render();
  }

  // ---------------------------------------------------------------- actions
  const replan = () => askCaptain('Ask the Captain to replan',
    'Say what changed or what you want different. The Captain revises the roadmap and sends it back to you for approval.',
    'e.g. Move the wall editor before sharing; launch can slip a week',
    'Please replan the roadmap (set_roadmap) and send it to me for approval. What I want changed: ');
  const newStage = () => askCaptain('New stage',
    'Describe the stage you want. The Captain adds it to the roadmap, with dates, goals and exit criteria, and the change comes back to you for approval.',
    'e.g. A two-week beta with three schools after sharing',
    'Please add a new stage to the roadmap (set_roadmap): ');
  const addGoal = (s: RoadmapStage) => askCaptain(`Add a goal to ${s.id}`,
    `Describe the goal. The Captain adds it to ${s.id} ${s.title} (add_goal) and the change comes back to you for approval.`,
    'e.g. Teachers can revoke a link',
    `Please add a goal to ${s.id} ${s.title} (add_goal): `);
  const draftOne = (state: MusterState) => {
    const goal = state.goal?.text ? ` The goal so far: "${state.goal.text}".` : '';
    void run(api.ask(`Please draft a roadmap for this project before more build work: stages (milestones) with start and due dates and exit criteria, and the goals for each stage. Save it with set_roadmap; it comes to me for approval.${goal}`), 'Asked the Captain to draft a roadmap');
  };

  // ---------------------------------------------------------------- render
  function render(): void {
    if (!snap) return;
    const state = snap.state;
    const rm = data?.roadmap ?? null;
    const pg = data?.progress ?? EMPTY_PROGRESS;
    const st = rm && stageId ? stageById(rm, stageId) : undefined;
    detail.hidden = !st;
    overview.hidden = !!st;

    if (!rm) {
      subbar.hidden = true;
      setChildren(said);
      setChildren(banner);
      setChildren(overview, emptyState(state));
      return;
    }
    subbar.hidden = false;
    setChildren(said, rm.statusLine ? saidLine(rm.statusLine) : null);
    setChildren(banner, rm.status === 'draft' ? draftBanner(rm) : null);
    if (st) renderDetail(state, rm, pg, st);
    else renderOverview(state, rm, pg);
  }

  function emptyState(state: MusterState): HTMLElement {
    if (!loaded) return h('div.empty', null, 'Loading the roadmap…');
    if (error) return h('div.hero-empty', null, h('div.hero-card', null, h('div.big.rm-hero', null, 'Roadmap'), h('p', null, error),
      h('button.btn.secondary', { onclick: () => void load() }, 'Try again')));
    return h('div.hero-empty', null, h('div.hero-card', null,
      h('div.big.rm-hero', null, 'No roadmap yet'),
      h('p', null, 'The roadmap is the plan the crew works to: stages with dates and exit criteria, goals inside each stage, and the tasks that deliver them. The Captain drafts it, you approve it, and progress here counts itself as tasks merge.'),
      h('button.btn.primary.lg', { onclick: () => draftOne(state) }, icon('route', 14), 'Ask the Captain to draft one')));
  }

  /** "Captain · 14 min ago" over the Captain's last word on where the project stands. */
  function saidLine(st: NonNullable<Roadmap['statusLine']>): HTMLElement {
    return h('div.rm-said', { title: new Date(st.at).toLocaleString() },
      h('div.rm-said-by', null, `Captain · ${agoText(st.at)}`),
      h('div.rm-said-text', null, st.text));
  }

  function draftBanner(rm: Roadmap): HTMLElement {
    return h('div.banner.warm.rm-draft', null, icon('alert', 16),
      h('div.flex1', null, `Roadmap draft · revision ${rm.revision + 1} — waiting for your approval`),
      h('button.btn.sm', { onclick: async () => apply(await sendBackRoadmap()) }, 'Send back'),
      h('button.btn.sm.merge', { onclick: async () => apply(await approveRoadmap()) }, 'Approve'));
  }

  // ---------------------------------------------------------------- overview
  function renderOverview(state: MusterState, rm: Roadmap, pg: RoadmapProgress): void {
    const toggleBtn = (v: View, label: string) => h('button', {
      class: view === v && 'on',
      onclick: () => { view = v; try { localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ } render(); },
    }, label);
    const captains = new Set(['captain', ...state.agents.filter((a) => a.role === 'captain').map((a) => a.id)]);
    const summary = [rm.title, rm.launchDate ? `launch ${shortDate(rm.launchDate)}` : '', updatedLine(state.feed, rm, captains)].filter(Boolean).join(' · ');
    setChildren(subbar,
      h('div.rm-sub-text', { title: rm.summary ? `${summary}

${rm.summary}` : summary }, summary),
      researchButton(state),
      h('div.rm-toggle', null, toggleBtn('timeline', 'Timeline'), toggleBtn('stages', 'Stages')),
      h('button.btn.sm', { onclick: () => void replan() }, 'Ask Captain to replan'),
      h('button.btn.sm.primary', { onclick: () => void newStage() }, 'New stage'));

    const today = localDay();
    const cur = pg.currentStageId ?? currentStageId(rm);
    setChildren(overview,
      summaryStrip(rm, pg, cur),
      view === 'timeline' ? timeline(rm, pg, cur, today) : stageCards(rm, pg, cur),
      h('div.rm-panels', null, landedPanel(state, rm, cur), velocityPanel(state, today), upNextPanel(rm, pg, cur)));
  }

  /** Blue Research button with the count of new ideas: the research page, or the New research modal when there is none yet. */
  function researchButton(state: MusterState): HTMLElement {
    const r = state.research;
    const n = newCount(r);
    const none = !r || (!r.runs.length && !r.ideas.length);
    return h('button.rs-btn', {
      title: none ? 'Start research: scout reads similar apps, reviews and forums for ideas' : n ? `${n} new ${n === 1 ? 'idea' : 'ideas'} from scout` : 'Research ideas from scout',
      onclick: () => { if (none) researchModal.open(r ?? null); else go('#/roadmap/research'); },
    }, icon('search-plus', 14), h('span', null, 'Research'), n ? h('span.rs-btn-n', null, `${n} new`) : null);
  }

  function summaryStrip(rm: Roadmap, pg: RoadmapProgress, cur?: string): HTMLElement {
    const weights = stageWeights(rm, pg.stages);
    const sp = (id: string) => pg.stages[id] ?? NO_STAGE;
    return h('div.rm-summary', null,
      h('div.rm-overall', null,
        h('div.section-label', null, 'OVERALL'),
        h('div.rm-overall-row', null, h('div.rm-big', null, `${pg.overall.percent}%`), h('div.rm-of', null, overallText(pg.overall))),
        pg.overall.unlinked ? h('div.rm-unlinked', { title: 'Tasks with no goal are left out of the counts; the Captain links them to their goals' }, unlinkedText(pg.overall)) : null),
      h('div.rm-segs', null,
        h('div.rm-segbar', null, rm.stages.map((s, i) => {
          const p = sp(s.id);
          const isCur = s.id === cur;
          return h('div.rm-segbar-s', { class: [s.status === 'done' && 'done'], style: { flex: weights[i] }, title: `${s.id} ${s.title} · ${p.percent}% · ${stageBasis(p)}` },
            s.status !== 'done' && p.percent > 0 ? h('div.fill', { class: !isCur && 'muted', style: { width: pct(p.percent) } }) : null);
        })),
        h('div.rm-seglabels', null, rm.stages.map((s, i) => {
          const isCur = s.id === cur;
          return h('button.rm-seglabel', { class: [isCur ? 'cur' : s.status === 'done' ? 'done' : 'planned'], style: { flex: weights[i] }, title: `${s.id} ${s.title}`, onclick: () => go(stageHash(s.id)) },
            `${s.id} ${s.title}${isCur ? ' · now' : ''}`);
        }))),
      h('div.rm-status', null, healthPill(pg.health), pg.daysToLaunch !== undefined ? h('div.rm-launch-txt', null, launchText(pg.daysToLaunch)) : null));
  }

  function timeline(rm: Roadmap, pg: RoadmapProgress, cur: string | undefined, today: number): HTMLElement {
    const sc = timelineScale(rm, today);
    const weeks = columnStarts(sc);
    const curW = columnIndex(sc, today);
    const step = labelStep(sc.cols);
    const rows: HTMLElement[] = [];
    rm.stages.forEach((s, i) => {
      const open = stageOpen.get(s.id) ?? s.id === cur;
      rows.push(stageRow(rm, pg, s, sc, s.id === cur, open, i === rm.stages.length - 1));
      if (open) {
        const goals = stageGoals(rm, s.id);
        const activeGoal = goals.find((g) => g.status === 'active');
        const firstQueued = activeGoal ? goals.slice(goals.indexOf(activeGoal) + 1).find((g) => g.status === 'planned') : undefined;
        for (const g of goals) rows.push(goalRow(pg, s, g, sc, g.id === pg.currentGoalId || (!pg.currentGoalId && g === activeGoal), g === firstQueued ? activeGoal : undefined));
        if (!goals.length) rows.push(h('div.rm-row.rm-goalrow', null, h('div.rm-lab.rm-goal-lab', null, h('span.rm-title.faint', null, 'No goals yet')), h('div.rm-trk')));
      }
    });
    const showToday = today >= sc.start && columnIndex(sc, today) >= 0;
    const tf = todayFrac(sc, today);
    return h('div.rm-tl-wrap', null, h('div.rm-tl', null,
      h('div.rm-grid', null, weeks.map(() => h('div'))),
      h('div.rm-row.rm-head', null,
        h('div.rm-lab.section-label', null, 'STAGE'),
        h('div.rm-trk.rm-weeks', null, weeks.map((w, i) => h('div.rm-wk', { class: i === curW && 'now' }, i === curW ? (sc.unit === DAY ? 'Today' : `${shortDay(w)} · now`) : i % step === 0 ? shortDay(w) : '')))),
      rows.map((r, i) => (i === rows.length - 1 ? (r.classList.add('rm-last'), r) : r)),
      showToday ? h('div.rm-today', { style: { left: `calc(280px + (100% - 280px) * ${tf.toFixed(4)})` }, title: `Today · ${shortDay(today)}` }) : null));
  }

  /** Text placed after a bar, or before it when the bar runs to the right edge. */
  function afterBar(sp: Span, child: HTMLElement): HTMLElement {
    const end = sp.left + sp.width;
    if (end > 0.82) child.style.right = `calc(${((1 - sp.left) * 100).toFixed(3)}% + 10px)`;
    else child.style.left = `calc(${(end * 100).toFixed(3)}% + 10px)`;
    return child;
  }

  function stageIcon(s: RoadmapStage, isCur: boolean, isLaunch: boolean): HTMLElement {
    if (s.status === 'done') return h('span.rm-sicon.done', null, icon('tick', 14, 2.5));
    if (isCur || s.status === 'active') return h('span.rm-sicon', null, h('span.rm-live'));
    if (isLaunch) return h('span.rm-sicon', null, h('span.rm-diamond-o'));
    return h('span.rm-sicon', null, h('span.rm-ring'));
  }

  function stageRow(rm: Roadmap, pg: RoadmapProgress, s: RoadmapStage, sc: Scale, isCur: boolean, open: boolean, isLast: boolean): HTMLElement {
    const p = pg.stages[s.id] ?? NO_STAGE;
    const isLaunch = isLast && !!rm.launchDate;
    const sp = barSpan(sc, s.start, s.due);
    const track: Child[] = [];
    if (!sp) track.push(h('div.rm-nodate', null, 'No dates yet'));
    else if (s.status === 'done') {
      const t = `Shipped ${shortDate(s.completedAt ?? s.due)}`;
      track.push(h('div.rm-bar.done', { style: spanStyle(sp), title: t }, h('span', null, t)));
    } else if (isCur || s.status === 'active') {
      const t = `${p.percent}%${s.due ? ` · due ${shortDate(s.due)}` : ''}`;
      track.push(h('div.rm-bar.active', { style: spanStyle(sp), title: `${s.id} ${s.title} · ${t}` }, h('div.fill', { style: { width: pct(p.percent) } }), h('span', null, t)));
      track.push(afterBar(sp, h('button.rm-open', { onclick: (e: MouseEvent) => { e.stopPropagation(); go(stageHash(s.id)); } }, 'Open stage', icon('arrow', 11))));
    } else {
      const t = s.start && s.due ? `Planned · ${shortDate(s.start)} – ${shortDate(s.due)}` : 'Planned';
      track.push(h('div.rm-bar.planned', { style: spanStyle(sp), title: t }, h('span', null, t)));
    }
    if (isLaunch && rm.launchDate) {
      const ld = parseDay(rm.launchDate)!;
      track.push(h('div.rm-launch', { style: { left: `${(frac(sc, ld + DAY / 2) * 100).toFixed(3)}%` }, title: `Launch ${shortDate(rm.launchDate)}` }));
    }
    return h('div.rm-row.rm-stage', { class: [isCur && 'cur', s.status], onclick: () => go(stageHash(s.id)), title: s.description || undefined },
      h('div.rm-lab', null,
        h('button.rm-chev', {
          title: open ? 'Collapse' : 'Show goals',
          onclick: (e: MouseEvent) => { e.stopPropagation(); stageOpen.set(s.id, !open); render(); },
        }, icon(open ? 'chevron' : 'chevron-right', 14)),
        stageIcon(s, isCur, isLaunch),
        h('span.rm-id', { style: { color: isCur ? 'var(--color-crew)' : undefined } }, s.id),
        h('span.rm-title', null, s.title),
        h('span.rm-count', { title: stageBasis(p) }, stageCount(p))),
      h('div.rm-trk', null, track));
  }

  function goalRow(pg: RoadmapProgress, s: RoadmapStage, g: RoadmapGoal, sc: Scale, isCurGoal: boolean, queuedAfter?: RoadmapGoal): HTMLElement {
    const p = pg.goals[g.id] ?? NO_GOAL;
    const sp = barSpan(sc, g.start, g.due, s);
    const track: Child[] = [];
    if (sp && g.status !== 'cancelled') {
      if (g.status === 'active') {
        track.push(h('div.rm-gbar.active', { style: spanStyle(sp), title: `${g.id} ${g.title} · ${p.done}/${p.total}` }, h('div.fill', { style: { width: pct(p.percent) } })));
        track.push(afterBar(sp, h('div.rm-gtext', null, p.agents.length ? p.agents.join(' · ') : 'no one on it yet')));
      } else if (g.status === 'done') {
        track.push(h('div.rm-gbar.done', { style: spanStyle(sp), title: `${g.id} done` }));
        track.push(afterBar(sp, h('div.rm-gtext.faint', null, g.completedAt ? `done ${shortDate(g.completedAt)}` : 'done')));
      } else {
        track.push(h('div.rm-gbar.planned', { style: spanStyle(sp) }));
        track.push(afterBar(sp, h('div.rm-gtext.faint', null, queuedAfter ? `queued · after ${queuedAfter.title}` : 'planned')));
      }
    } else if (g.status === 'cancelled') track.push(h('div.rm-nodate', null, 'cancelled'));
    const dot = g.status === 'done' ? h('span.rm-gdot.done') : g.status === 'active' ? h('span.rm-gdot.active') : h('span.rm-gdot');
    return h('div.rm-row.rm-goalrow', {
      class: g.status,
      title: g.description || undefined,
      onclick: () => { goalOpen.set(g.id, true); go(stageHash(s.id)); },
    },
    h('div.rm-lab.rm-goal-lab', null, dot,
      h('span.rm-title', { class: g.status === 'active' ? 'on' : g.status === 'cancelled' ? 'struck' : '' }, g.title),
      isCurGoal ? h('span.rm-tag', null, 'GOAL') : null,
      h('span.rm-count', { class: g.status === 'active' && 'on' }, goalCount(p, g.status))),
    h('div.rm-trk', null, track));
  }

  function stageCards(rm: Roadmap, pg: RoadmapProgress, cur?: string): HTMLElement {
    return h('div.rm-cards', null, rm.stages.map((s) => {
      const p = pg.stages[s.id] ?? NO_STAGE;
      const isCur = s.id === cur;
      return h('button.rm-card', { class: isCur && 'cur', onclick: () => go(stageHash(s.id)) },
        h('div.rm-card-head', null,
          h('span.rm-id', { style: { color: stageTone(s, isCur) } }, s.id),
          h('span.rm-card-title', null, s.title),
          statusPill(s, isCur)),
        s.description ? h('div.rm-card-desc', null, s.description) : null,
        h('div.rm-prog', null, h('div.fill', { class: s.status === 'done' && 'done', style: { width: pct(s.status === 'done' ? 100 : p.percent) } })),
        h('div.rm-card-meta', null,
          h('span', null, p.total ? `${p.done}/${p.total} tasks` : `${p.percent}%`),
          h('span', null, s.start || s.due ? `${shortDate(s.start) || '…'} – ${shortDate(s.due) || '…'}` : 'no dates'),
          p.criteriaTotal ? h('span', null, `${p.criteriaDone}/${p.criteriaTotal} criteria`) : null),
        h('div.rm-card-goals', null, stageGoals(rm, s.id).map((g) => {
          const gp = pg.goals[g.id] ?? NO_GOAL;
          return h('div.rm-li', null, h(g.status === 'done' ? 'span.rm-gdot.done' : g.status === 'active' ? 'span.rm-gdot.active' : 'span.rm-gdot'),
            h('span.flex1.ellipsis', { class: g.status !== 'active' && 'muted' }, g.title), h('span.rm-mono-faint', null, goalCount(gp, g.status)));
        })));
    }));
  }

  function landedPanel(state: MusterState, rm: Roadmap, cur?: string): HTMLElement {
    const items = recentlyLanded(state.tasks, Date.now(), 7, 5);
    return h('div.rm-panel', null,
      h('div.rm-panel-head', null, h('div.rm-panel-title', null, 'Recently landed'), h('div.faint', null, 'last 7 days')),
      items.length
        ? h('div.rm-list', null, items.map(({ task, at, ready }) => {
            const sid = stageOfTask(rm, task);
            return h('div.rm-li', { title: `${task.id} ${task.title}` },
              h('span.rm-li-id', { style: { color: sid && sid === cur ? 'var(--color-crew)' : undefined } }, sid ?? task.id),
              h('span.flex1.ellipsis', { class: !ready && 'muted' }, task.title),
              ready ? h('span.rm-ready', null, 'ready to merge') : h('span.rm-mono-faint', null, shortDate(at)));
          }))
        : h('div.rm-panel-empty', null, 'Nothing merged in the last 7 days.'));
  }

  function velocityPanel(state: MusterState, today: number): HTMLElement {
    const days = mergedPerDay(state.tasks, today, 12);
    const max = Math.max(1, ...days.map((d) => d.count));
    return h('div.rm-panel', null,
      h('div.rm-panel-head', null, h('div.rm-panel-title', null, 'Tasks merged per day'), h('div.rm-mono-muted', null, `avg ${average(days)}`)),
      h('div.rm-chart', null,
        days.map((d, i) => h('div.rm-col', {
          class: i === days.length - 1 && 'today',
          style: { height: d.count ? `${Math.max(4, (d.count / max) * 100)}%` : '2px' },
          title: `${shortDay(d.day)}: ${d.count} merged`,
        })),
        h('div.rm-chart-from', null, shortDay(days[0].day)),
        h('div.rm-chart-to', null, 'today')));
  }

  function upNextPanel(rm: Roadmap, pg: RoadmapProgress, cur?: string): HTMLElement {
    const next = cur ? nextStage(rm, cur) : undefined;
    const curStage = stageById(rm, cur);
    if (!next) {
      return h('div.rm-panel', null,
        h('div.rm-panel-head', null, h('div.rm-panel-title', null, 'Up next')),
        h('div.rm-panel-empty', null, !curStage
          ? 'Every stage is done.'
          : `${curStage.id} ${curStage.title} is the last stage.${rm.launchDate ? ` Launch target ${shortDate(rm.launchDate)}.` : ''}`));
    }
    const goals = stageGoals(rm, next.id);
    return h('div.rm-panel', { onclick: () => go(stageHash(next.id)), style: 'cursor:pointer' },
      h('div.rm-panel-head', null,
        h('div.rm-panel-title.ellipsis', null, `Up next · ${next.id} ${next.title}`),
        next.start ? h('div.faint', { style: 'flex-shrink:0' }, `starts ${shortDate(next.start)}`) : null),
      goals.length
        ? h('div.rm-list', null, goals.slice(0, 5).map((g) => {
            const n = (pg.goals[g.id] ?? NO_GOAL).total;
            return h('div.rm-li', { title: g.description || undefined }, h('span.rm-gdot'), h('span.flex1.ellipsis.muted', null, g.title),
              h('span.rm-mono-faint', null, n ? `${n} ${n === 1 ? 'task' : 'tasks'}` : 'no tasks yet'));
          }))
        : h('div.rm-panel-empty', null, 'No goals planned for it yet.'),
      curStage ? h('div.rm-panel-foot', null, `Captain breaks these into tasks when ${curStage.id} lands.`) : null);
  }

  // ---------------------------------------------------------------- stage detail
  function statusPill(s: RoadmapStage, isCur: boolean): HTMLElement {
    const [label, color] = s.status === 'done' ? ['DONE', 'var(--color-success)']
      : isCur || s.status === 'active' ? ['IN PROGRESS', 'var(--color-crew)']
      : ['PLANNED', 'var(--color-muted)'];
    return h('div.rm-spill', { style: { '--p': color } }, h('span.d'), label);
  }

  function renderDetail(state: MusterState, rm: Roadmap, pg: RoadmapProgress, s: RoadmapStage): void {
    const cur = pg.currentStageId ?? currentStageId(rm);
    const isCur = s.id === cur;
    setChildren(subbar,
      h('div.rm-crumbs', null,
        h('button.rm-crumb', { onclick: () => go('#/roadmap') }, icon('chevron-left', 14), 'Roadmap'),
        h('span.faint', null, '/'),
        h('span.rm-crumb-id', { style: { color: stageTone(s, isCur) } }, s.id),
        h('span.rm-crumb-title', null, s.title)),
      h('div.rm-stepper', null, rm.stages.map((x) => h('button', {
        class: x.id === s.id && 'on',
        style: { color: stageTone(x, x.id === cur) },
        title: `${x.id} ${x.title}`,
        onclick: () => go(stageHash(x.id)),
      }, x.id))),
      h('button.btn.sm.primary', { onclick: () => void addGoal(s) }, 'Add goal'));

    const p = pg.stages[s.id] ?? NO_STAGE;
    const goals = stageGoals(rm, s.id);
    const crew = new Set(goals.flatMap((g) => (pg.goals[g.id] ?? NO_GOAL).agents));
    const curGoal = goals.find((g) => g.id === pg.currentGoalId)?.id ?? goals.find((g) => g.status === 'active')?.id ?? goals.find((g) => g.status !== 'done' && g.status !== 'cancelled')?.id;
    const stat = (label: string, value: string) => h('div.rm-stat', null, h('div.section-label', null, label), h('div.rm-stat-v', null, value));

    const scroll = dmain.scrollTop;
    setChildren(dmain,
      h('div.rm-dhead', null,
        h('div.flex1', null,
          h('div.rm-dtitle-row', null, h('h1.rm-dtitle', null, s.title), statusPill(s, isCur)),
          s.description ? h('div.rm-ddesc', null, s.description) : null),
        h('div.rm-stats', null,
          stat(p.total ? 'TASKS' : 'PROGRESS', p.total ? `${p.done} / ${p.total}` : `${p.percent}%`),
          stat('WINDOW', s.start || s.due ? `${shortDate(s.start) || '…'} – ${shortDate(s.due) || '…'}` : '—'),
          stat('CREW ON IT', String(crew.size)))),
      goals.length ? null : h('div.rm-goal.rm-goal-empty', null, 'No goals in this stage yet. Use Add goal to ask the Captain for one.'),
      goals.map((g, i) => goalGroup(state, pg, g, g.id === curGoal, goalOpen.get(g.id) ?? g.id === curGoal, goals, i)),
      criteria(s, p));
    dmain.scrollTop = scroll;

    renderRail(state, rm, s);
  }

  function goalGroup(state: MusterState, pg: RoadmapProgress, g: RoadmapGoal, isCur: boolean, open: boolean, goals: RoadmapGoal[], i: number): HTMLElement {
    const p = pg.goals[g.id] ?? NO_GOAL;
    const toggle = () => { goalOpen.set(g.id, !open); render(); };
    const bar = h('div.rm-gprog', null, h('div.fill', { class: g.status === 'done' && 'done', style: { width: pct(p.percent) } }));
    const count = h('div.rm-gcount', { class: open && 'on' }, goalCount(p, g.status));
    if (!open) {
      const active = goals.find((x) => x.status === 'active');
      const word = g.status === 'done' ? `done${g.completedAt ? ` ${shortDate(g.completedAt)}` : ''}`
        : g.status === 'active' ? 'in progress'
        : g.status === 'cancelled' ? 'cancelled'
        : active && goals.indexOf(active) === i - 1 ? 'queued' : 'planned';
      return h('button.rm-goal', { class: [g.status], onclick: toggle, title: g.description || undefined },
        h('span.rm-goal-chev', null, icon('chevron-right', 14)),
        h('span.rm-goal-title', null, g.title),
        h('span.rm-goal-sub', null, [word, g.description].filter(Boolean).join(' · ')),
        bar, count);
    }
    const tasks = state.tasks.filter((t) => t.goalId === g.id && t.status !== 'cancelled').sort((a, b) => idNum(a.id) - idNum(b.id));
    const tag = isCur ? h('span.rm-tag', null, 'CURRENT GOAL')
      : g.status === 'done' ? h('span.rm-tag', { style: { '--p': 'var(--color-success)' } }, 'DONE')
      : g.status === 'cancelled' ? h('span.rm-tag', { style: { '--p': 'var(--color-muted)' } }, 'CANCELLED')
      : g.status === 'planned' ? h('span.rm-tag', { style: { '--p': 'var(--color-muted)' } }, 'PLANNED') : null;
    return h('div.rm-goal.open', { class: [isCur && 'cur', g.status] },
      h('button.rm-goal-head', { onclick: toggle, title: g.description || undefined },
        h('span.rm-goal-chev.on', null, icon('chevron', 14)),
        h('span.rm-goal-title.on', null, g.title),
        tag,
        h('span.flex1'),
        bar, count),
      g.description ? h('div.rm-goal-desc', null, g.description) : null,
      tasks.length
        ? [h('div.rm-trow.rm-thead', null, h('div.c-id'), h('div.c-task', null, 'TASK'), h('div.c-agent', null, 'AGENT'), h('div.c-st', null, 'STATIONS'), h('div.c-status', null, 'STATUS'), h('div.c-upd', null, 'UPDATED')),
           tasks.map((t) => taskRow(state, t))]
        : h('div.rm-trow.rm-tnone', null, g.status === 'done' ? 'No tasks.' : 'No tasks yet. The Captain breaks this goal into tasks when it starts.'));
  }

  function taskRow(state: MusterState, t: Task): HTMLElement {
    const stuck = t.status === 'in_progress' ? taskIsStuck(state, t) : undefined;
    const idle = t.status === 'ready' || t.status === 'blocked';
    const agentId = t.status === 'review' ? 'captain' : t.assignee;
    const agent = t.status === 'blocked' ? h('div.c-agent.faint', null, '—')
      : !agentId ? h('div.c-agent.faint', null, 'unclaimed')
      : h('div.c-agent', { class: `r-${roleOf(state, agentId)}` }, h('span.dot.sm'), h('span.rm-agent', null, displayName(agentId)));
    let stations: HTMLElement;
    if (t.status === 'blocked') {
      const waits = t.dependsOn.filter((d) => {
        const dt = state.tasks.find((x) => x.id === d);
        return !dt || (dt.status !== 'ready_for_merge' && dt.status !== 'merged');
      });
      stations = h('div.c-st.faint', null, waits.length ? `waits on ${waits.join(', ')}` : 'blocked');
    } else {
      const finished = t.status === 'ready_for_merge' || t.status === 'merged';
      const working = t.status === 'in_progress' || t.status === 'review' || t.status === 'awaiting_approval';
      stations = h('div.c-st.rm-segs-row', null, t.stations.map((stn, i) => {
        let bg = 'var(--color-surface-2)';
        if (finished || i < t.stationIndex) bg = 'var(--color-success)';
        else if (i === t.stationIndex && working) bg = stuck ? 'var(--color-stuck)' : t.status === 'awaiting_approval' ? 'var(--color-warm)' : `var(--color-${stationRole(stn) === 'human' ? 'warm' : stationRole(stn)})`;
        return h('div', { style: { background: bg }, title: stn });
      }));
    }
    const station = t.stations[t.stationIndex] ?? '';
    const [label, color, kind] = t.status === 'merged' ? ['Merged', 'var(--color-success)', '']
      : t.status === 'ready_for_merge' ? ['Ready to merge', 'var(--color-success)', '']
      : t.status === 'review' ? ['Captain review', 'var(--color-captain)', '']
      : t.status === 'awaiting_approval' ? ['Awaiting you', 'var(--color-warm)', '']
      : t.status === 'ready' ? ['Ready', '', 'outline']
      : t.status === 'blocked' ? ['Blocked', '', 'dashed']
      : stuck ? [`Stuck · ${stuck.id}`, 'var(--color-stuck)', '']
      : [stationWord(station), `var(--color-${stationRole(station) === 'human' ? 'warm' : stationRole(station)})`, ''];
    const pill = h(stuck ? 'button.rm-tpill' : 'span.rm-tpill', {
      class: kind,
      style: color ? { '--p': color } : undefined,
      title: stuck ? `Open ${stuck.id} on the board` : undefined,
      onclick: stuck ? () => go(`#/board?note=${encodeURIComponent(stuck.id)}`) : undefined,
    }, label);
    const age = idle ? '—' : ageShort(t.updatedAt);
    return h('div.rm-trow', { class: stuck && 'stuck', title: t.description ? `${t.id} ${t.title}\n\n${t.description}` : `${t.id} ${t.title}` },
      h('div.c-id', null, t.id),
      h('div.c-task', { class: idle && 'muted' }, t.title),
      agent, stations,
      h('div.c-status', null, pill),
      h('div.c-upd', { class: age === 'now' && 'now' }, age));
  }

  function criteria(s: RoadmapStage, p: StageP): HTMLElement {
    const all = s.exitCriteria.length > 0 && s.exitCriteria.every((c) => c.done);
    return h('div.rm-crit', null,
      h('div.rm-crit-head', null, h('div.section-label', null, 'STAGE IS DONE WHEN'),
        s.exitCriteria.length ? h('span.rm-mono-faint', null, `${p.criteriaDone || s.exitCriteria.filter((c) => c.done).length}/${s.exitCriteria.length}`) : null),
      s.exitCriteria.length
        ? h('div.rm-crit-list', null, s.exitCriteria.map((c, i) => h('button.rm-check', {
            class: c.done && 'on',
            title: c.done ? `Ticked${c.by ? ` by ${displayName(c.by)}` : ''}${c.doneAt ? ` · ${shortDate(c.doneAt)}` : ''}. Click to untick.` : 'Tick when this is true',
            onclick: async () => apply(await run(api.checkCriterion(s.id, i, !c.done))),
          }, h('span.box', null, c.done ? icon('tick', 11, 3) : null), h('span', null, c.text))))
        : h('div.faint', { style: 'font-size:13px' }, 'No exit criteria yet.'),
      all && s.status !== 'done'
        ? h('div', null, h('button.btn.sm.merge', { onclick: async () => apply(await run(api.completeStage(s.id), `${s.id} complete`)) }, icon('check', 14), `Complete ${s.id}`))
        : null);
  }

  function renderRail(state: MusterState, rm: Roadmap, s: RoadmapStage): void {
    const items = stageFeed(state.feed, rm, state.tasks, s.id, 40);
    const goalIds = stageGoals(rm, s.id).map((g) => g.id);
    const today = localDay();
    setChildren(rail,
      h('div.rm-rail-head', null, h('div.rm-panel-title', null, 'Stage activity'),
        h('div.rm-live-ind', { class: !events.connected && 'off' }, h('span.d'), events.connected ? 'live' : 'offline')),
      items.length
        ? h('div.rm-feed', null, items.map((f, i) => {
            const role = roleOf(state, f.from);
            const color = f.noteType === 'stuck' ? 'var(--color-stuck)' : role === 'you' ? 'var(--color-muted)' : role === 'muster' ? 'var(--color-faint)' : `var(--color-${role === 'human' ? 'warm' : role})`;
            const ref = f.taskId ?? goalIds.find((g) => new RegExp(`\\b${g}\\b`).test(f.text)) ?? s.id;
            const when = localDay(f.at) === today ? hhmm(f.at) : shortDate(f.at);
            return h('div.rm-fi', { style: { '--c': color } },
              h('div.rm-fi-rail', null, h('span.d'), i < items.length - 1 ? h('span.l') : null),
              h('div.rm-fi-body', null,
                h('div.rm-fi-head', null, h('span.who', null, `${displayName(f.from)} · ${ref}`), h('span.t', null, when)),
                h('div.rm-fi-text', { class: i >= 3 && 'old' }, f.text)));
          }))
        : h('div.rm-panel-empty', null, 'Nothing yet. Activity on this stage\'s tasks shows up here.'));
  }

  return {
    el,
    update(s) {
      snap = s;
      if (visible) refetch();
      render();
    },
    params(p) {
      const next = p.get('stage');
      if (next !== stageId) dmain.scrollTop = 0;
      stageId = next;
      render();
    },
    show() {
      visible = true;
      void load();
    },
    hide() {
      visible = false;
      clearTimeout(timer);
    },
  };
}
