// Muster dashboard: shell (sidebar, top bar), hash router, toasts.
import './styles.css';
import type { Agent } from '../../src/types';
import { h, icon, logo, setChildren, toast } from './dom';
import { events, type Snapshot } from './events';
import { openAddAgent } from './actions';
import { agentStatusWord, agoLong, resetsIn, sortedAgents } from './util';
import type { Page } from './page';
import { createDashboard } from './pages/dashboard';
import { createBoard } from './pages/board';
import { createChat } from './pages/chat';
import { createTasks } from './pages/tasks';
import { createBranches } from './pages/branches';
import { createVellum } from './pages/vellum';
import { createSettings } from './pages/settings';

type RouteId = 'dashboard' | 'board' | 'chat' | 'tasks' | 'branches' | 'vellum' | 'settings';
const ROUTES: { id: RouteId; label: string; icon: string; create: () => Page }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'grid', create: createDashboard },
  { id: 'board', label: 'Bulletin board', icon: 'pin', create: createBoard },
  { id: 'chat', label: 'Crew chat', icon: 'chat', create: createChat },
  { id: 'tasks', label: 'Tasks', icon: 'tasks', create: createTasks },
  { id: 'branches', label: 'Branches', icon: 'branch', create: createBranches },
  { id: 'vellum', label: 'Vellum boards', icon: 'pen', create: createVellum },
  { id: 'settings', label: 'Settings', icon: 'settings', create: createSettings },
];

export function parseHash(): { route: RouteId; params: URLSearchParams } {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query] = raw.split('?');
  const route = (ROUTES.find((r) => r.id === path)?.id ?? 'dashboard') as RouteId;
  return { route, params: new URLSearchParams(query ?? '') };
}

// ---------- shell ----------
const app = document.getElementById('app')!;
const projectEl = h('div.logo-project', null, '');
const navCounts = new Map<RouteId, HTMLElement>();
const navItems = new Map<RouteId, HTMLElement>();
const agentsLabel = h('div.section-label.flex1', null, 'AGENTS');
const agentList = h('div.agent-list');
const addSide = h('button.icon-btn', { title: 'Add agent' }, icon('plus', 14));
addSide.onclick = () => openAddAgent(addSide, 'left');

const sidebar = h('aside.sidebar', null,
  h('div.logo', null, logo(26), h('div', { style: 'display:flex;flex-direction:column;gap:1px;min-width:0' }, h('div.logo-name', null, 'Muster'), projectEl)),
  h('nav.nav', null, ROUTES.map((r) => {
    const count = h('span');
    navCounts.set(r.id, count);
    const item = h('a.nav-item', { href: `#/${r.id}` }, icon(r.icon, 16), h('span.label', null, r.label), count);
    navItems.set(r.id, item);
    return item;
  })),
  h('div.agents', null, h('div.agents-head', null, agentsLabel, addSide), agentList),
);

const goalTitle = h('div.goal-title');
const goalSub = h('div.goal-sub');
const fiveVal = h('div.usage-val');
const fiveFill = h('div.usage-fill');
const fiveLabel = h('div.usage-label', null, '5-HOUR');
const five = h('div.usage', null, h('div.usage-head', null, fiveLabel, fiveVal), h('div.usage-track', null, fiveFill));
const weekVal = h('div.usage-val');
const weekFill = h('div.usage-fill');
const week = h('div.usage.weekly', null, h('div.usage-head', null, h('div.usage-label', null, 'WEEKLY'), weekVal), h('div.usage-track', null, weekFill));
const addTop = h('button.btn.secondary', { style: 'height:32px' }, icon('plus', 14), 'Add agent');
addTop.onclick = () => openAddAgent(addTop, 'right');
const topbar = h('header.topbar', null, h('div.goal', null, goalTitle, goalSub), five, week, addTop);
const connBanner = h('div.conn-banner', { hidden: true }, 'Reconnecting to the Muster orchestrator…');
const pagesHost = h('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column' });
const main = h('main.main', null, topbar, connBanner, pagesHost);
app.appendChild(h('div.app', null, sidebar, main));

// ---------- pages ----------
const pages = new Map<RouteId, Page>();
let current: RouteId | null = null;

function show(route: RouteId, params: URLSearchParams): void {
  let page = pages.get(route);
  if (!page) {
    page = ROUTES.find((r) => r.id === route)!.create();
    pages.set(route, page);
    pagesHost.appendChild(page.el);
    if (events.snapshot) page.update(events.snapshot);
  }
  if (current !== route) {
    if (current) {
      const prev = pages.get(current)!;
      prev.el.hidden = true;
      prev.hide?.();
    }
    page.el.hidden = false;
    current = route;
    if (events.snapshot) page.update(events.snapshot);
    page.show?.();
  }
  page.params?.(params);
  navItems.forEach((el, id) => el.classList.toggle('active', id === route));
}

function onHash(): void {
  const { route, params } = parseHash();
  show(route, params);
}
window.addEventListener('hashchange', onHash);

// ---------- shell render ----------
function renderShell(s: Snapshot): void {
  const { state, config } = s;
  const project = config.projectName || state.repoRoot.split(/[\\/]/).filter(Boolean).pop() || '';
  projectEl.textContent = project;
  document.title = project ? `Muster · ${project}` : 'Muster';

  // nav counts
  const openNotes = state.notes.filter((n) => n.open).length;
  const needsYou = state.notes.some((n) => n.open && (n.type === 'escalation' || n.type === 'review' || n.to === 'you'));
  const setCount = (id: RouteId, n: number, badge = false) => {
    const el = navCounts.get(id)!;
    el.className = badge && n > 0 ? 'nav-badge' : 'nav-count';
    el.textContent = n ? String(n) : '';
    if (badge) el.title = needsYou ? 'Open notes · some need you' : 'Open notes';
  };
  setCount('board', openNotes, true);
  setCount('chat', state.feed.length);
  setCount('tasks', state.tasks.filter((t) => t.status !== 'cancelled').length);

  // agents
  const agents = sortedAgents(state);
  agentsLabel.textContent = `AGENTS · ${agents.length}`;
  setChildren(agentList, agents.map((a) => agentRow(s, a)));

  // goal
  const live = state.tasks.filter((t) => t.status !== 'cancelled');
  const done = live.filter((t) => t.status === 'merged' || t.status === 'ready_for_merge').length;
  if (state.goal) {
    goalTitle.textContent = state.goal.text;
    goalTitle.className = 'goal-title';
    goalTitle.title = state.goal.text;
    goalSub.textContent = `Goal set ${agoLong(state.goal.at)} · ${done} of ${live.length} tasks done`;
  } else {
    goalTitle.textContent = 'No goal yet';
    goalTitle.className = 'goal-title none';
    goalSub.textContent = live.length ? `${done} of ${live.length} tasks done` : 'Tell the Captain what to build from its terminal, or run muster ask';
  }

  // usage
  const u = state.usage;
  const f = u.fiveHour;
  const w = u.sevenDay;
  const fp = f ? Math.round(f.usedPercentage) : null;
  const wp = w ? Math.round(w.usedPercentage) : null;
  five.classList.toggle('hot', !!u.paused);
  fiveLabel.textContent = u.paused ? 'PAUSED' : '5-HOUR';
  fiveVal.textContent = fp === null ? '—' : `${fp}%${f?.resetsAt ? ` · resets ${resetsIn(f.resetsAt)}` : ''}`;
  fiveFill.style.width = `${Math.min(100, fp ?? 0)}%`;
  five.title = u.paused ? `New work is paused at ${config.pauseAtFiveHourPct}% until the 5-hour window resets` : `Pauses new work at ${config.pauseAtFiveHourPct}%`;
  week.classList.toggle('hot', wp !== null && wp >= config.warnAtWeeklyPct);
  weekVal.textContent = wp === null ? '—' : `${wp}%${w?.resetsAt ? ` · resets ${resetsIn(w.resetsAt)}` : ''}`;
  weekFill.style.width = `${Math.min(100, wp ?? 0)}%`;
  week.title = `Warns you at ${config.warnAtWeeklyPct}%`;
}

function agentRow(s: Snapshot, a: Agent): HTMLElement {
  const word = agentStatusWord(s.state, a);
  const row = h('button.agent-row', {
    class: [`r-${a.role}`, (a.status === 'idle' || a.status === 'stopped' || a.status === 'done') && 'dim'],
    title: `${a.id} · ${a.role} · ${a.branch} · ${a.status}`,
    onclick: () => { location.hash = `#/dashboard?agent=${encodeURIComponent(a.id)}`; },
  },
  h('span.dot'),
  h('span.names', null, h('span.name', null, a.id), h('span.branch', null, a.branch)),
  h('span.status', { class: a.status === 'stuck' && 'is-stuck' }, word));
  return row;
}

// ---------- boot ----------
events.onSnapshot((s) => {
  renderShell(s);
  if (current) pages.get(current)?.update(s);
});
events.onToast((t) => toast(t.text, t.level));
let everConnected = false;
events.onConnection((c) => {
  if (c) everConnected = true;
  connBanner.hidden = c;
  if (!c && everConnected) connBanner.textContent = 'Lost the connection to the Muster orchestrator. Reconnecting…';
});
setTimeout(() => { if (!events.connected) connBanner.hidden = false; }, 2500);
// keep relative times fresh
setInterval(() => { if (events.snapshot) renderShell(events.snapshot); }, 30_000);

onHash();
events.start();
