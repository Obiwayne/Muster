// Muster dashboard: shell (sidebar, top bar), hash router, toasts.
import './styles.css';
import type { Agent } from '../../src/types';
import { h, icon, logo, setChildren, showMenu, showModal, toast, type MenuItem } from './dom';
import { events, type Snapshot } from './events';
import { openAddAgent, openGithubBackup, run } from './actions';
import { api } from './api';
import { agentStatusWord, agoLong, resetsIn, setUserName, sortedAgents } from './util';
import { needsYouCount } from './chatmodel';
import { reportNeedsYou } from './needsyou';
import type { Page } from './page';
import { createDashboard } from './pages/dashboard';
import { createRoadmap } from './pages/roadmap';
import { createResearch } from './pages/research';
import { createIntel } from './pages/intel';
import { getIntelSummary } from './intelapi';
import { currentStageId } from './roadmap';
import { createBoard } from './pages/board';
import { createChat } from './pages/chat';
import { createTasks } from './pages/tasks';
import { createBranches } from './pages/branches';
import { createVellum } from './pages/vellum';
import { createSettings } from './pages/settings';
import { projectId as heldProjectId } from './pages/heldcard';
import { forProject, isExpired } from './heldmodel';

type RouteId = 'dashboard' | 'roadmap' | 'research' | 'intel' | 'board' | 'chat' | 'tasks' | 'branches' | 'vellum' | 'settings';
type NavId = Exclude<RouteId, 'research'>;
const ROUTES: { id: NavId; label: string; icon: string; create: () => Page }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'grid', create: createDashboard },
  { id: 'roadmap', label: 'Roadmap', icon: 'route', create: createRoadmap },
  { id: 'intel', label: 'Intel', icon: 'radar', create: createIntel },
  { id: 'board', label: 'Bulletin board', icon: 'pin', create: createBoard },
  { id: 'chat', label: 'Crew chat', icon: 'chat', create: createChat },
  { id: 'tasks', label: 'Tasks', icon: 'tasks', create: createTasks },
  { id: 'branches', label: 'Branches', icon: 'branch', create: createBranches },
  { id: 'vellum', label: 'Vellum boards', icon: 'pen', create: createVellum },
  { id: 'settings', label: 'Settings', icon: 'settings', create: createSettings },
];
// Pages without a nav item of their own: [route, page factory, nav item it highlights]
const SUB_ROUTES: { id: RouteId; create: () => Page; nav: NavId }[] = [
  { id: 'research', create: createResearch, nav: 'roadmap' },
];

export function parseHash(): { route: RouteId; params: URLSearchParams } {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query] = raw.split('?');
  const [head, ...rest] = (path ?? '').split('/');
  let route = (ROUTES.find((r) => r.id === head)?.id ?? 'dashboard') as RouteId;
  const params = new URLSearchParams(query ?? '');
  // #/roadmap/research → the research page (not a stage); #/roadmap/M3 → route "roadmap", params.stage = "M3"
  if (route === 'roadmap' && rest[0] === 'research') route = 'research';
  else if (route === 'roadmap' && rest[0]) params.set('stage', decodeURIComponent(rest[0]));
  // #/intel/reviews → route "intel", params.tab = "reviews" (no tab = overview)
  else if (route === 'intel' && rest[0]) params.set('tab', decodeURIComponent(rest[0]));
  return { route, params };
}

// ---------- shell ----------
const app = document.getElementById('app')!;
const projectEl = h('div.logo-project', null, '');
const navCounts = new Map<NavId, HTMLElement>();
const navItems = new Map<NavId, HTMLElement>();
const boardBadge = h('span.nav-ic-badge', { hidden: true });
const agentsLabel = h('div.section-label.flex1', null, 'AGENTS');
const agentList = h('div.agent-list');
const addSide = h('button.icon-btn', { title: 'Add agent' }, icon('plus', 14));
addSide.onclick = () => openAddAgent(addSide, 'left');

// ---------- project switcher (desktop app only: window.musterApp comes from its preload) ----------
interface MusterApp {
  projects(): Promise<{ current: string | null; projects: { root: string; name: string; running: boolean }[] } | null>;
  switchTo(root: string): Promise<{ ok: boolean; error?: string }>;
  openFolder(): Promise<unknown>;
  stopCurrent(): Promise<void>;
  showPicker(): Promise<void>;
  /** Taskbar overlay badge + window title suffix; png is a 32×32 data URL, null clears it. Newer desktop builds only. */
  setNeedsYou?(count: number, png: string | null): unknown;
}
const desk = (window as unknown as { musterApp?: MusterApp }).musterApp;
const sameRoot = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

async function openProjectMenu(anchor: HTMLElement): Promise<void> {
  if (!desk) return;
  const data = await desk.projects();
  if (!data) return;
  const items: (MenuItem | 'sep')[] = data.projects.map((p) => ({
    label: p.running ? p.name : `${p.name}  ·  stopped`,
    role: p.running ? 'crew' : undefined,
    tone: p.running ? undefined : 'muted',
    current: !!data.current && sameRoot(p.root, data.current),
    onClick: () => void desk.switchTo(p.root),
  }));
  if (items.length) items.push('sep');
  items.push({ label: 'Open another project…', onClick: () => void desk.openFolder() });
  items.push({ label: 'All projects', tone: 'muted', onClick: () => void desk.showPicker() });
  items.push('sep');
  items.push({
    label: "Stop this project's crew",
    tone: 'danger',
    onClick: () =>
      showModal({
        title: "Stop this project's crew?",
        body: h('p', { style: 'margin:0;color:var(--color-muted);font-size:13px;line-height:20px' }, 'Every agent on this project stops. Their work stays on their branches, and opening the project again resumes them.'),
        actions: [{ label: 'Stop the crew', kind: 'danger', onClick: async (close) => { close(); await desk.stopCurrent(); } }],
      }),
  });
  const r = anchor.getBoundingClientRect();
  showMenu(items, r.left, r.bottom + 6);
}

const brand = desk
  ? h('button.logo.logo-switch', { title: 'Switch project' },
      logo(21),
      h('div', { style: 'display:flex;flex-direction:column;gap:1px;min-width:0;flex:1;text-align:left' }, h('div.logo-name', null, 'Muster'), projectEl),
      icon('chevron', 14, 2.5))
  : h('div.logo', null, logo(21), h('div', { style: 'display:flex;flex-direction:column;gap:1px;min-width:0' }, h('div.logo-name', null, 'Muster'), projectEl));
if (desk) brand.addEventListener('click', () => void openProjectMenu(brand));

const sidebar = h('aside.sidebar', null,
  brand,
  h('nav.nav', null, ROUTES.map((r) => {
    const count = h('span');
    navCounts.set(r.id, count);
    const ic = r.id === 'board' ? h('span.nav-ic', null, icon(r.icon, 16), boardBadge) : icon(r.icon, 16);
    const item = h('a.nav-item', { href: `#/${r.id}` }, ic, h('span.label', null, r.label), count);
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

// ---------- GitHub backup offer: shown once some work is merged and the project has no remote yet ----------
const SNOOZE_KEY = 'muster.githubSnoozed';
const ghText = h('span.flex1');
const ghBanner = h('div.banner.gh-offer', { hidden: true }, icon('cloud', 16), ghText,
  h('button.btn.sm.primary', { onclick: async () => { if (await openGithubBackup()) { ghRemote = true; ghBanner.hidden = true; } } }, 'Back up to GitHub'),
  h('button.btn.sm.secondary', { onclick: () => { ghSnoozed = true; try { sessionStorage.setItem(SNOOZE_KEY, '1'); } catch { /* ignore */ } ghBanner.hidden = true; } }, 'Not now'),
  h('button.btn.sm', { onclick: () => { ghBanner.hidden = true; void run(api.patchConfig({ githubOffer: 'never' }), 'Turned off. You can still back up from Settings'); } }, "Don't ask again"));
let ghRemote: boolean | null = null; // null: not checked yet
let ghChecking = false;
let ghSnoozed = false;
try { ghSnoozed = sessionStorage.getItem(SNOOZE_KEY) === '1'; } catch { /* ignore */ }

function renderGithubOffer(s: Snapshot, project: string): void {
  const want = s.config.githubOffer !== 'never' && !ghSnoozed && s.state.tasks.some((t) => t.status === 'merged');
  if (want && ghRemote === null && !ghChecking) {
    ghChecking = true;
    api.project()
      .then((p) => { ghRemote = !!p.remoteUrl; }, () => { ghRemote = true; }) // older orchestrator without /api/project: never offer
      .finally(() => { ghChecking = false; if (events.snapshot) renderShell(events.snapshot); });
  }
  ghText.textContent = `${project || 'This project'} only lives on this computer so far. Back it up to a private GitHub repo?`;
  ghBanner.hidden = !(want && ghRemote === false);
}

const main = h('main.main', null, topbar, connBanner, ghBanner, pagesHost);
app.appendChild(h('div.app', null, sidebar, main));

// ---------- pages ----------
const pages = new Map<RouteId, Page>();
let current: RouteId | null = null;

function show(route: RouteId, params: URLSearchParams): void {
  let page = pages.get(route);
  if (!page) {
    page = (ROUTES.find((r) => r.id === route) ?? SUB_ROUTES.find((r) => r.id === route))!.create();
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
  const nav = SUB_ROUTES.find((r) => r.id === route)?.nav ?? route;
  navItems.forEach((el, id) => el.classList.toggle('active', id === nav));
}

function onHash(): void {
  const { route, params } = parseHash();
  show(route, params);
}
window.addEventListener('hashchange', onHash);

// ---------- shell render ----------
function renderShell(s: Snapshot): void {
  setUserName(s.config.userName);
  const { state, config } = s;
  const project = config.projectName || state.repoRoot.split(/[\\/]/).filter(Boolean).pop() || '';
  projectEl.textContent = project;
  document.title = project ? `Muster · ${project}` : 'Muster';
  renderGithubOffer(s, project);

  // nav counts
  const openNotes = state.notes.filter((n) => n.open && !n.dismissed).length;
  const needsYou = needsYouCount(state.notes) + heldWaiting; // held remote writes wait on your tap too
  const setCount = (id: NavId, n: number, badge = false) => {
    const el = navCounts.get(id)!;
    el.className = badge && n > 0 ? 'nav-badge' : 'nav-count';
    el.textContent = n ? String(n) : '';
    if (badge) el.title = 'Open notes';
  };
  setCount('board', openNotes, true);
  // needs-you: red badge on the board icon, "N for you" instead of the open-notes pill, and the taskbar badge
  boardBadge.hidden = needsYou === 0;
  boardBadge.textContent = needsYou > 99 ? '99+' : String(needsYou);
  navItems.get('board')!.classList.toggle('needs', needsYou > 0);
  if (needsYou > 0) {
    const el = navCounts.get('board')!;
    el.className = 'nav-foryou';
    el.textContent = `${needsYou} for you`;
    el.title = `${needsYou} open note${needsYou === 1 ? '' : 's'} need${needsYou === 1 ? 's' : ''} you · ${openNotes} open in all`;
  }
  reportNeedsYou(needsYou);
  setCount('chat', state.feed.length);
  setCount('tasks', state.tasks.filter((t) => t.status !== 'cancelled').length);
  const rm = state.roadmap;
  const rmEl = navCounts.get('roadmap')!;
  rmEl.className = 'nav-count mono';
  rmEl.textContent = !rm ? '' : rm.status === 'draft' && !rm.approvedAt ? 'draft' : currentStageId(rm) ?? '';
  rmEl.title = rm?.status === 'draft' ? 'Roadmap draft waiting for your approval' : rm ? 'Current stage' : '';
  renderIntelBadge();

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

/** Intel nav badge: blue, unseen changes that need a response + re-checks whose verdict changed. */
function renderIntelBadge(): void {
  const el = navCounts.get('intel')!;
  const n = events.intel?.alerts ?? 0;
  const live = events.intel?.runningJob;
  if (live) {
    // scout is working on an intel job: a pulsing blue "live" badge on every page (alerts move to the tooltip)
    el.className = 'nav-live';
    setChildren(el, h('span.nav-live-dot'), 'live');
    el.title = `scout: ${live.label}${n > 0 ? ` · ${n} intel alert${n === 1 ? '' : 's'}` : ''}`;
    return;
  }
  el.className = n > 0 ? 'nav-badge intel' : 'nav-count';
  el.textContent = n > 0 ? String(n) : '';
  el.title = n > 0 ? `${n} intel alert${n === 1 ? '' : 's'}: changes that may need the plan to respond` : '';
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
events.onIntel(() => renderIntelBadge());
let everConnected = false;
events.onConnection((c) => {
  if (c) everConnected = true;
  connBanner.hidden = c;
  if (!c && everConnected) connBanner.textContent = 'Lost the connection to the Muster orchestrator. Reconnecting…';
});
setTimeout(() => { if (!events.connected) connBanner.hidden = false; }, 2500);
// keep relative times fresh
setInterval(() => { if (events.snapshot) renderShell(events.snapshot); }, 30_000);

// Held remote writes (docs/REMOTE.md) count in the needs-you badge and the taskbar. Every 15 s; 60 s while the
// gateway or remote access is off, quietly.
let heldWaiting = 0;
let heldProject: string | null | undefined;
async function pollHeld(): Promise<void> {
  let next = 15_000;
  const s = events.snapshot;
  try {
    if (s) {
      if (heldProject === undefined) heldProject = await heldProjectId(s.state.repoRoot);
      const name = s.config.projectName || s.state.repoRoot.split(/[\/]/).filter(Boolean).pop() || '';
      const n = forProject(await api.remotePending(), { id: heldProject, name }).filter((p) => !isExpired(p)).length;
      if (n !== heldWaiting) {
        heldWaiting = n;
        renderShell(s);
      }
    }
  } catch {
    next = 60_000;
  }
  setTimeout(() => void pollHeld(), next);
}
void pollHeld();

onHash();
events.start();
// Older orchestrators have no /api/intel: the badge just stays empty.
getIntelSummary().then((s) => events.setIntel(s), () => {});
