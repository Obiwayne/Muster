// Tasks: five columns from Blocked to Ready to merge, with station bars.
import type { MusterState, Task, TaskStatus } from '../../../src/types';
import { h, setChildren, showModal, toast } from '../dom';
import type { Snapshot } from '../events';
import type { Page } from '../page';
import { api } from '../api';
import { approveTask, getDiffStat, mergeTask, run, sendBackApproval, showDiffModal } from '../actions';
import { evidenceStrip } from '../evidence';
import { branchOwnerId, ms, stationRole, statTotals, taskIsStuck } from '../util';

const COLUMNS: { status: TaskStatus | 'awaiting_approval'; label: string }[] = [
  { status: 'blocked', label: 'Blocked' },
  { status: 'ready', label: 'Ready' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'awaiting_approval', label: 'Awaiting you' },
  { status: 'review', label: 'Captain review' },
  { status: 'ready_for_merge', label: 'Ready to merge' },
];

const statCache = new Map<string, string>(); // task id → "+96 −0"

export function stationBar(task: Task, stuck: boolean): HTMLElement {
  const finished = task.status === 'ready_for_merge' || task.status === 'merged';
  return h('div.stations', null, task.stations.map((st, i) => {
    const color = `var(--color-${stationRole(st)})`;
    let bg = 'var(--color-surface-2)';
    if (finished || i < task.stationIndex) bg = color;
    else if (i === task.stationIndex) bg = stuck ? 'var(--color-stuck)' : `color-mix(in oklab, ${color} 45%, transparent)`;
    return h('div.seg', { style: { background: bg }, title: `${st}${i < task.stationIndex || finished ? ' · done' : i === task.stationIndex ? ' · current' : ''}` });
  }));
}

export function createTasks(): Page {
  let snap: Snapshot | null = null;
  const summary = h('div.summary');
  const graphBtn = h('button.btn.sm', null, 'Dependency graph');
  const newBtn = h('button.btn.sm.secondary', null, 'New task');
  const kanban = h('div.kanban');
  const el = h('div.page', null, h('div.toolbar', null, summary, graphBtn, newBtn), kanban);

  newBtn.onclick = () => newTaskModal();
  graphBtn.onclick = () => graphModal();

  function card(state: MusterState, t: Task): HTMLElement {
    const titleRow = h('div.title-row', null, h('span.tid', null, t.id), h('span.ttl', null, t.title));
    const tip = t.description ? `${t.id} ${t.title}\n\n${t.description}` : `${t.id} ${t.title}`;
    if (t.status === 'blocked') {
      const waits = t.dependsOn.filter((d) => {
        const dt = state.tasks.find((x) => x.id === d);
        return !dt || (dt.status !== 'ready_for_merge' && dt.status !== 'merged');
      });
      return h('div.card.plain', { title: tip }, titleRow, h('div.sub', null, waits.length ? `Waits on ${waits.join(', ')}` : 'Blocked'));
    }
    if (t.status === 'ready') {
      const role = stationRole(t.stations[t.stationIndex] ?? 'build');
      return h('div.card.dashed', { title: tip }, titleRow, h('div.sub', null, t.assignee ? `Assigned to ${t.assignee}` : `Next free ${role === 'design' ? 'design crew' : role} claims it`));
    }
    if (t.status === 'ready_for_merge') {
      const owner = branchOwnerId(state, t);
      const stat = h('div.mono-sub', null, `${t.branch ?? ''}${statCache.has(t.id) ? ` · ${statCache.get(t.id)}` : ''}`);
      if (owner && !statCache.has(t.id)) {
        getDiffStat(owner, t.branch).then((d) => {
          const tot = statTotals(d.stat, d.diff);
          if (tot) { statCache.set(t.id, `+${tot.add} −${tot.del}`); stat.textContent = `${t.branch ?? d.branch} · +${tot.add} −${tot.del}`; }
        }).catch(() => {});
      }
      return h('div.card.merge', { title: tip }, titleRow, stat, evidenceStrip(t),
        h('div.actions', null,
          h('button.btn.sm', { disabled: !owner, onclick: () => owner && showDiffModal(owner, t.branch) }, 'View diff'),
          h('button.btn.sm.merge', { onclick: () => mergeTask(state, t) }, 'Merge')));
    }
    if ((t.status as string) === 'awaiting_approval') {
      const owner = branchOwnerId(state, t);
      return h('div.card.merge', { title: tip }, titleRow, stationBar(t, false),
        h('div.mono-sub', null, `${t.branch ?? ''} · ${t.stations[t.stationIndex] ?? ''}`),
        h('div.actions', null,
          owner ? h('button.btn.sm', { onclick: () => showDiffModal(owner, t.branch) }, 'View diff') : null,
          h('button.btn.sm', { onclick: () => void sendBackApproval(t) }, 'Send back'),
          h('button.btn.sm.merge', { onclick: () => void approveTask(t) }, 'Approve')));
    }
    // in progress / review
    const stuckNote = taskIsStuck(state, t);
    const station = t.stations[t.stationIndex] ?? '';
    const who = t.assignee ?? 'unassigned';
    const whoRole = t.status === 'review' ? 'captain' : state.agents.find((a) => a.id === t.assignee)?.role ?? stationRole(station);
    return h('div.card', { class: stuckNote && 'stuck', title: tip }, titleRow, stationBar(t, !!stuckNote),
      h('div.who', null,
        h('span.dot.sm', { class: `r-${whoRole}`, style: stuckNote ? 'background:var(--color-stuck)' : '' }),
        h('span.w', null, `${who} · ${station}${stuckNote ? ` · stuck ${stuckNote.id}` : ''}`),
        h('span.nm', null, `${Math.min(t.stationIndex + 1, t.stations.length)}/${t.stations.length}`)));
  }

  function render(): void {
    if (!snap) return;
    const { state, config } = snap;
    const live = state.tasks.filter((t) => t.status !== 'cancelled');
    const merged = live.filter((t) => t.status === 'merged').length;
    summary.textContent = `${live.length} ${live.length === 1 ? 'task' : 'tasks'}${merged ? ` · ${merged} merged` : ''} · stations ${config.defaultStations.join(' → ')}`;
    setChildren(kanban, COLUMNS.filter((c) => c.status !== 'awaiting_approval' || live.some((t) => (t.status as string) === c.status)).map((c) => {
      const ts = live.filter((t) => (t.status as string) === c.status).sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
      return h('div.col', null,
        h('div.col-head', { class: c.status === 'ready_for_merge' && 'crew' }, h('span.section-label', null, c.label), h('span.n', null, String(ts.length))),
        ts.map((t) => card(state, t)),
        c.status === 'ready_for_merge' && merged ? h('div.done-foot', null, `${merged} merged into ${config.baseBranch}`) : null);
    }));
  }

  function newTaskModal(): void {
    const state = snap?.state;
    const cfg = snap?.config;
    const title = h('input.input-sm', { placeholder: 'Invite email template' }) as HTMLInputElement;
    const desc = h('textarea.field', { rows: 4, placeholder: 'What should be built, and how the crew knows it is done.' }) as HTMLTextAreaElement;
    const deps = new Set<string>();
    const depChips = h('div.station-chips', null, (state?.tasks ?? []).filter((t) => t.status !== 'merged' && t.status !== 'cancelled').map((t) => {
      const b = h('button.chip', { title: t.title, onclick: () => { deps.has(t.id) ? deps.delete(t.id) : deps.add(t.id); b.classList.toggle('active', deps.has(t.id)); } }, t.id);
      return b;
    }));
    const stations = h('input.input-sm.mono-input', { value: (cfg?.defaultStations ?? ['build', 'review']).join(', ') }) as HTMLInputElement;
    showModal({
      title: 'New task',
      body: [
        h('div.form-row', null, h('label', null, 'Title'), title),
        h('div.form-row', null, h('label', null, 'Description'), desc),
        h('div.form-row', null, h('label', null, 'Depends on'), depChips.childElementCount ? depChips : h('div.form-hint', null, 'No open tasks to depend on.')),
        h('div.form-row', null, h('label', null, 'Stations (in order; review is always last)'), stations),
      ],
      actions: [{
        label: 'Post task', kind: 'primary', onClick: async (close) => {
          if (!title.value.trim()) { toast('Give the task a title', 'warn'); return; }
          const st = stations.value.split(/[,→>\s]+/).map((s) => s.trim()).filter(Boolean);
          const r = await run(api.createTask({ title: title.value.trim(), description: desc.value.trim(), dependsOn: [...deps], stations: st.length ? st : undefined }));
          if (r) { toast(`Posted ${r.id} ${r.title}`); close(); }
        },
      }],
    });
  }

  function graphModal(): void {
    const state = snap?.state;
    if (!state) return;
    const live = state.tasks.filter((t) => t.status !== 'cancelled');
    const rows = live.map((t) => h('div', { style: 'display:flex;gap:12px;align-items:baseline;font-size:13px;padding:6px 0;border-bottom:1px solid var(--color-line)' },
      h('span.mono.faint', { style: 'width:36px;font-size:11px' }, t.id),
      h('span.flex1', null, t.title),
      h('span.mono', { style: 'font-size:11px;color:var(--color-muted)' }, t.dependsOn.length ? `needs ${t.dependsOn.join(', ')}` : 'no dependencies'),
      h('span.pill.grey', null, t.status.replace(/_/g, ' '))));
    showModal({ title: 'Dependencies', body: rows.length ? rows : h('p', null, 'No tasks yet.'), cancelLabel: 'Close' });
  }

  return { el, update(s) { snap = s; render(); } };
}
