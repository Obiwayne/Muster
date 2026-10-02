// Dashboard: grid of live agent terminals (1 full, 2 side by side, 3 = two + one wide, 4 = 2×2, >4 → pages).
import type { Agent, MusterState, Role } from '../../../src/types';
import { h, icon, setChildren, showMenu, type MenuItem } from '../dom';
import type { Snapshot } from '../events';
import type { Page } from '../page';
import { TermView } from '../terminal';
import { api } from '../api';
import { closeAgent, openAddAgent, run, setRole, showDiffModal } from '../actions';
import { agentStatusLong, openStuck, sortedAgents } from '../util';

const PER_PAGE = 4;

/** Assign an element property only when it differs; a same-value write still dirties the DOM (and textContent swaps the text node). */
function put<T extends HTMLElement, K extends keyof T>(el: T, prop: K, value: T[K]): void {
  if (el[prop] !== value) el[prop] = value;
}

function flag(el: HTMLElement, cls: string, on: boolean): void {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

class Tile {
  el: HTMLElement;
  private badge = h('span.badge');
  private name = h('span.tile-name');
  private branch = h('span.tile-branch');
  private openBadge = h('span.open-badge', { hidden: true });
  private statusDot = h('span.dot.sm');
  private statusTxt = h('span.txt');
  private status = h('span.tile-status', null, this.statusDot, this.statusTxt);
  private more = h('button.tile-more', { title: 'Agent menu' }, icon('more', 16));
  private host = h('div.term-host');
  private overlay = h('div.term-overlay', { hidden: true });
  private caret = h('span.caret', null, '›');
  private input = h('input', { spellcheck: false, autocomplete: 'off' }) as HTMLInputElement;
  private term: TermView | null = null;
  agent: Agent;

  constructor(agent: Agent, private getState: () => MusterState | null) {
    this.agent = agent;
    const head = h('div.tile-head', null, this.badge, this.name, this.branch, this.openBadge, this.status, this.more);
    const prompt = h('div.prompt', null, this.caret, this.input, h('span.hint', null, 'Enter'));
    this.el = h('section.tile', null, head, h('div', { style: 'flex:1;min-height:0;display:flex;position:relative' }, this.host, this.overlay), prompt);
    this.more.onclick = (e: MouseEvent) => {
      const r = this.more.getBoundingClientRect();
      e.stopPropagation();
      this.menu(r.right, r.bottom + 6, 'right');
    };
    this.el.addEventListener('contextmenu', (e) => {
      if (e.shiftKey) return; // Shift+right-click keeps the browser menu
      e.preventDefault();
      this.menu(e.clientX, e.clientY, 'left');
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      const text = this.input.value.trim();
      if (!text) return;
      this.input.value = '';
      const isCaptain = this.agent.role === 'captain';
      run(isCaptain ? api.ask(text) : api.input(this.agent.id, text, true)).then((r) => {
        if (!r) this.input.value = text;
      });
    });
    this.host.addEventListener('mousedown', () => setTimeout(() => this.term?.focus()));
    this.term = new TermView(this.host, agent.id);
  }

  update(state: MusterState, a: Agent): void {
    this.agent = a;
    // Not `className =`: that would wipe the transient `flash` class and cut its animation short on every snapshot.
    for (const c of Array.from(this.el.classList)) if (c.startsWith('r-') && c !== `r-${a.role}`) this.el.classList.remove(c);
    for (const c of ['tile', `r-${a.role}`]) if (!this.el.classList.contains(c)) this.el.classList.add(c);
    // Snapshots arrive every few seconds; only touch the DOM for values that changed.
    put(this.badge, 'className', `badge b-${a.role}`);
    put(this.badge, 'textContent', a.role);
    put(this.name, 'textContent', a.id);
    put(this.branch, 'textContent', a.branch);
    put(this.branch, 'title', a.branch);
    const stuck = openStuck(state, a.id);
    put(this.openBadge, 'hidden', stuck.length === 0);
    if (stuck.length) {
      setChildren(this.openBadge, icon('pin', 12, 2.5), `${stuck.length} open`);
      put(this.openBadge, 'title', stuck.map((n) => `${n.id}: ${n.text}`).join('\n'));
      this.openBadge.onclick = () => { location.hash = `#/board?note=${stuck[0].id}`; };
      this.openBadge.style.cursor = 'pointer';
    }
    const st = agentStatusLong(state, a);
    flag(this.el, 'stuck', st.stuck || stuck.length > 0);
    flag(this.el, 'stopped', a.status === 'stopped');
    put(this.status, 'className', `tile-status${st.stuck ? ' is-stuck' : ''}`);
    put(this.statusTxt, 'textContent', st.text);
    put(this.status, 'title', st.text);
    put(this.input, 'placeholder', a.role === 'captain' ? 'Tell the Captain what to build…' : `Message ${a.id}…`);
    put(this.input, 'disabled', a.status === 'stopped');
    put(this.overlay, 'hidden', a.status !== 'stopped');
    if (a.status === 'stopped') {
      setChildren(this.overlay, h('span', null, `${a.id} is stopped`),
        h('button.btn.sm.secondary', { onclick: () => run(api.startAgent(a.id), `Restarting ${a.id}…`) }, 'Restart'));
    }
  }

  private menu(x: number, y: number, align: 'left' | 'right'): void {
    const a = this.agent;
    const roleItem = (role: Role, label: string): MenuItem => ({ label, role, current: a.role === role, onClick: () => setRole(a, role) });
    const scout = a.role === 'research'; // the research agent has no worktree and keeps its role
    const items: (MenuItem | 'sep')[] = [
      ...(scout ? [] : [
        roleItem('captain', 'Set as Captain'),
        roleItem('crew', 'Set as Crew'),
        roleItem('design', 'Set as Vellum design crew'),
        'sep' as const,
      ]),
      scout
        ? { label: 'Open research', tone: 'muted', onClick: () => { location.hash = '#/roadmap/research'; } }
        : { label: 'View diff', tone: 'muted', disabled: a.role === 'captain', onClick: () => showDiffModal(a.id, a.branch) },
      a.status === 'stopped'
        ? { label: 'Restart', tone: 'muted', onClick: () => run(api.startAgent(a.id), `Restarting ${a.id}…`) }
        : { label: 'Stop', tone: 'muted', onClick: () => run(api.stopAgent(a.id), `Stopped ${a.id}`) },
      { label: 'Close', tone: 'danger', onClick: () => closeAgent(a) },
    ];
    showMenu(items, x, y, align);
    void this.getState;
  }

  flash(): void {
    this.el.classList.remove('flash');
    void this.el.offsetWidth;
    this.el.classList.add('flash');
    this.term?.focus();
  }

  refresh(): void { this.term?.refresh(); }

  dispose(): void {
    this.term?.dispose();
    this.term = null;
    this.el.remove();
  }
}

export function createDashboard(): Page {
  const grid = h('div.grid');
  const pager = h('div.pager', { hidden: true });
  const empty = h('div.hero-empty', { hidden: true });
  const el = h('div.page', null, grid, pager, empty);
  const tiles = new Map<string, Tile>();
  let pageIdx = 0;
  let snap: Snapshot | null = null;
  let focusAgent: string | null = null;
  let lastLayout = '';

  function render(): void {
    if (!snap) return;
    const state = snap.state;
    const agents = sortedAgents(state);
    const pageCount = Math.max(1, Math.ceil(agents.length / PER_PAGE));
    if (focusAgent) {
      const i = agents.findIndex((a) => a.id === focusAgent);
      if (i >= 0) pageIdx = Math.floor(i / PER_PAGE);
    }
    pageIdx = Math.min(pageIdx, pageCount - 1);
    const visible = agents.slice(pageIdx * PER_PAGE, pageIdx * PER_PAGE + PER_PAGE);

    // empty state
    put(empty, 'hidden', agents.length > 0);
    put(grid, 'hidden', agents.length === 0);
    if (!agents.length) {
      const add = h('button.btn.primary.lg', null, icon('plus', 14), 'Add agent');
      add.onclick = () => openAddAgent(add, 'left');
      setChildren(empty, h('div.hero-card', null,
        h('div.big', null, 'muster up'),
        h('p', null, 'No agents are running yet. Start the orchestrator and the Captain with ', h('code', null, 'muster up'),
          ', then give it a goal with ', h('code', null, 'muster ask "…"'), ', or add a crew agent here.'),
        add));
    }

    // tiles: keep the ones still visible, dispose the rest
    const ids = new Set(visible.map((a) => a.id));
    for (const [id, t] of tiles) if (!ids.has(id)) { t.dispose(); tiles.delete(id); }
    for (const a of visible) {
      let t = tiles.get(a.id);
      if (!t) { t = new Tile(a, () => snap?.state ?? null); tiles.set(a.id, t); }
      t.update(state, a);
    }
    const layout = visible.map((a) => a.id).join(',');
    if (layout !== lastLayout) {
      lastLayout = layout;
      grid.className = `grid n${visible.length}`;
      visible.forEach((a) => grid.appendChild(tiles.get(a.id)!.el));
      tiles.forEach((t) => t.refresh());
    }

    // pager
    put(pager, 'hidden', pageCount <= 1);
    if (pageCount > 1) {
      setChildren(pager, h('span.lbl', null, `${agents.length} agents`),
        Array.from({ length: pageCount }, (_, i) => h('button', {
          class: i === pageIdx && 'on',
          title: agents.slice(i * PER_PAGE, i * PER_PAGE + PER_PAGE).map((a) => a.id).join(', '),
          onclick: () => { focusAgent = null; pageIdx = i; render(); },
        }, String(i + 1))));
    }

    if (focusAgent) {
      const t = tiles.get(focusAgent);
      focusAgent = null;
      if (t) requestAnimationFrame(() => t.flash());
    }
  }

  return {
    el,
    update(s) { snap = s; render(); },
    params(p) {
      const a = p.get('agent');
      if (a) {
        focusAgent = a;
        render();
        history.replaceState(null, '', '#/dashboard');
      }
    },
    show() { tiles.forEach((t) => t.refresh()); },
  };
}
