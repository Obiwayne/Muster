// Branches: table of task branches vs main, tests and status, plus the merge panel.
import type { Agent, MusterState, Task } from '../../../src/types';
import { h, icon, promptDialog, setChildren } from '../dom';
import type { Snapshot } from '../events';
import type { Page } from '../page';
import { api } from '../api';
import { getDiff, getDiffStat, lastTests, mergeTask, run, runTests, showDiffModal, testsRunning } from '../actions';
import { ago, branchOwnerId, ms, parseDiffFiles, statTotals, taskIsStuck, type FileStat } from '../util';

interface Row { key: string; branch: string; task?: Task; agentId?: string; holder?: string }

const ORDER: Record<string, number> = { ready_for_merge: 0, review: 1, in_progress: 2, ready: 3, blocked: 4, merged: 6 };

export function createBranches(): Page {
  let snap: Snapshot | null = null;
  let selected: string | null = null;
  const stats = new Map<string, { add: number; del: number } | string>(); // branch → totals, or why not
  const files = new Map<string, FileStat[] | string>(); // branch → files, or error
  const pending = new Set<string>();

  const tbody = h('div.tbody');
  const table = h('div.table', null,
    h('div.thead', null,
      h('div.flex1', null, 'BRANCH'),
      h('div', { style: 'width:80px' }, 'AGENT'),
      h('div', { style: 'width:90px' }, 'VS MAIN'),
      h('div', { style: 'width:84px' }, 'TESTS'),
      h('div', { style: 'width:120px;text-align:right' }, 'STATUS')),
    tbody);
  const panel = h('div.merge-panel');
  const el = h('div.page', null, h('div.split', null, table, panel));

  function rows(state: MusterState): Row[] {
    const out: Row[] = [];
    const seen = new Set<string>();
    const tasks = state.tasks.filter((t) => t.branch && t.status !== 'cancelled')
      .sort((a, b) => (ORDER[a.status] ?? 5) - (ORDER[b.status] ?? 5) || ms(b.updatedAt) - ms(a.updatedAt));
    for (const t of tasks) {
      if (seen.has(t.branch!)) continue;
      seen.add(t.branch!);
      const agentId = branchOwnerId(state, t);
      const holder = t.status === 'in_progress' && t.assignee ? t.assignee : agentId;
      out.push({ key: t.branch!, branch: t.branch!, task: t, agentId, holder });
    }
    // crew branches with no task yet
    for (const a of state.agents) {
      if (a.role === 'captain' || seen.has(a.branch)) continue;
      seen.add(a.branch);
      out.push({ key: a.branch, branch: a.branch, agentId: a.id, holder: a.id });
    }
    return out;
  }

  function ensureStat(agentId: string, branch: string): void {
    if (stats.has(branch) || pending.has('s' + branch)) return;
    pending.add('s' + branch);
    getDiffStat(agentId, branch).then((d) => {
      stats.set(branch, statTotals(d.stat, d.diff) ?? 'Could not read the diff stat');
    }).catch((e) => stats.set(branch, e instanceof Error ? e.message : String(e)))
      .finally(() => { pending.delete('s' + branch); render(); });
  }

  function ensureFiles(agentId: string, branch: string): void {
    if (files.has(branch) || pending.has('f' + branch)) return;
    pending.add('f' + branch);
    getDiff(agentId, branch).then((d) => files.set(branch, parseDiffFiles(d.diff)))
      .catch((e) => files.set(branch, e instanceof Error ? e.message : String(e)))
      .finally(() => { pending.delete('f' + branch); render(); });
  }

  function statusPill(state: MusterState, r: Row): HTMLElement {
    const t = r.task;
    if (!t) {
      const a = state.agents.find((x) => x.id === r.agentId);
      return h('span.pill.grey', null, a?.status === 'stuck' ? 'Stuck' : 'No task');
    }
    switch (t.status) {
      case 'ready_for_merge': return h('span.pill.solid', { style: '--p:var(--color-crew)' }, 'Ready to merge');
      case 'review': return h('span.pill', { style: '--p:var(--color-captain)' }, 'In review');
      case 'merged': return h('span.pill.outline', null, 'Merged');
      case 'in_progress': {
        if (taskIsStuck(state, t)) return h('span.pill', { style: '--p:var(--color-stuck)' }, 'Stuck');
        const st = t.stations[t.stationIndex] ?? '';
        return h('span.pill.grey', null, `${st[0]?.toUpperCase() ?? ''}${st.slice(1)} station`);
      }
      default: return h('span.pill.grey', null, t.status === 'blocked' ? 'Blocked' : 'Ready');
    }
  }

  function testsCell(r: Row): HTMLElement {
    const rec = lastTests(r.branch);
    if (testsRunning(r.branch)) return h('div.c-tests.muted', null, 'running…');
    if (rec) return h('div.c-tests', { title: `${rec.command} · ${ago(rec.at)}` }, h('span', { class: rec.ok ? 'pass' : 'fail' }, rec.text));
    if (r.task?.status === 'merged' || !r.agentId) return h('div.c-tests.muted', null, '—');
    return h('div.c-tests', null, h('span.muted', null, '—'),
      h('button.run', { onclick: (e: MouseEvent) => { e.stopPropagation(); runTests(r.agentId!, r.branch, render); } }, 'Run'));
  }

  function vsCell(r: Row): HTMLElement {
    if (r.task?.status === 'merged') return h('div.c-vs', null, 'merged');
    if (!r.agentId) return h('div.c-vs', null, '—');
    ensureStat(r.agentId, r.branch);
    const s = stats.get(r.branch);
    if (!s) return h('div.c-vs.faint', null, '…');
    if (typeof s === 'string') return h('div.c-vs', { title: s }, '—');
    return h('div.c-vs', null, h('span.a', null, `+${s.add}`), s.del ? ` −${s.del}` : '');
  }

  function subtitle(state: MusterState, r: Row): string {
    const t = r.task;
    if (!t) return 'No task yet';
    if (t.status === 'merged') return `Merged ${ago(t.updatedAt)}`;
    let s = `${t.id} ${t.title}`;
    if (t.status === 'in_progress' && t.assignee && t.assignee !== r.agentId) s += ` · handed to ${t.assignee}`;
    void state;
    return s;
  }

  function renderPanel(state: MusterState, r: Row | undefined): void {
    if (!r) {
      setChildren(panel, h('div.empty', null, 'No branches yet. Crew branches show up here once agents pick up tasks.'));
      return;
    }
    const t = r.task;
    const reviewNote = t ? [...state.notes].reverse().find((n) => n.type === 'review' && n.taskId === t.id) : undefined;
    const doneNote = t ? [...state.notes].reverse().find((n) => n.type === 'done' && n.taskId === t.id) : undefined;
    const lastReview = t ? [...t.history].reverse().find((e) => e.kind === 'review_requested' && e.text) : undefined;
    let noteText = 'No review note yet.';
    if (reviewNote) noteText = `${reviewNote.from === 'captain' ? 'Captain' : reviewNote.from}: "${reviewNote.text}"`;
    else if (lastReview) noteText = `Captain: "${lastReview.text}"`;
    else if (doneNote) noteText = `${doneNote.from}: "${doneNote.text}"`;
    else if (t) noteText = `${t.id} ${t.title} · ${t.status === 'merged' ? 'merged' : `at the ${t.stations[t.stationIndex]} station`}`;

    const rec = lastTests(r.branch);
    const reviewed = !!t && (t.status === 'ready_for_merge' || t.status === 'merged' || !!reviewNote);
    const cfg = snap!.config;
    const check = (state: 'ok' | 'no' | 'bad', text: string, extra?: HTMLElement | null) =>
      h('div.check', { class: state !== 'ok' && state }, icon(state === 'ok' ? 'check' : state === 'bad' ? 'x' : 'circle', 14, state === 'no' ? 2 : 3), h('span.t.flex1', null, text), extra ?? null);
    const checks = h('div.checks', null,
      reviewed ? check('ok', 'Captain reviewed the diff') : check('no', 'Waiting for the Captain\'s review'),
      rec ? check(rec.ok ? 'ok' : 'bad', `${rec.command} · ${rec.text}`)
        : check('no', testsRunning(r.branch) ? `${cfg.testCommand} · running…` : `${cfg.testCommand} not run from here yet`,
          r.agentId && !testsRunning(r.branch) && t?.status !== 'merged' ? h('button.btn.sm', { onclick: () => runTests(r.agentId!, r.branch, render) }, 'Run tests') : null),
      check('no', `Conflicts with ${cfg.baseBranch} are checked when you merge`),
    );

    let fileList: HTMLElement;
    if (!r.agentId || t?.status === 'merged') fileList = h('div.files', null, h('div.faint', { style: 'font-size:12px;padding:0 8px' }, t?.status === 'merged' ? 'Already merged.' : 'No agent for this branch.'));
    else {
      ensureFiles(r.agentId, r.branch);
      const f = files.get(r.branch);
      fileList = h('div.files', null,
        f === undefined ? h('div.faint', { style: 'font-size:12px;padding:0 8px' }, 'Loading changed files…')
          : typeof f === 'string' ? h('div.faint', { style: 'font-size:12px;padding:0 8px' }, f)
            : f.length === 0 ? h('div.faint', { style: 'font-size:12px;padding:0 8px' }, `No changes against ${cfg.baseBranch}.`)
              : f.map((x) => h('div.file', { title: x.path }, h('span.p', null, x.path), x.add ? h('span.a', null, `+${x.add}`) : null, x.del ? h('span.d', null, `−${x.del}`) : null)));
    }

    const canSendBack = !!t && (t.status === 'review' || t.status === 'ready_for_merge');
    setChildren(panel,
      h('div.mp-head', null, h('div.b', null, r.branch), h('div.note', null, noteText)),
      checks,
      fileList,
      h('div.mp-foot', null,
        h('button.btn.lg', {
          disabled: !canSendBack,
          onclick: async () => {
            const note = await promptDialog(`Send back ${t!.id}?`, 'The task goes back to its build station with your note, and the builder gets it in their inbox.', 'Send back', 'What needs to change');
            if (note) await run(api.sendBack(t!.id, note), `Sent ${t!.id} back`);
          },
        }, 'Send back'),
        h('button.btn.lg', { disabled: !r.agentId || t?.status === 'merged', onclick: () => r.agentId && showDiffModal(r.agentId, r.branch) }, 'Full diff'),
        h('button.btn.lg.merge', { disabled: t?.status !== 'ready_for_merge', onclick: () => t && mergeTask(state, t) }, 'Merge into main')));
  }

  function render(): void {
    if (!snap) return;
    const state = snap.state;
    const list = rows(state);
    if (!selected || !list.some((r) => r.key === selected)) selected = list[0]?.key ?? null;
    setChildren(tbody, list.length ? list.map((r) => {
      const agent: Agent | undefined = state.agents.find((a) => a.id === r.holder);
      return h('button.trow', {
        class: [r.key === selected && 'sel', r.task?.status === 'merged' && 'merged'],
        onclick: () => { selected = r.key; render(); },
      },
      h('div.c-branch', null, h('div.b', { title: r.branch }, r.branch), h('div.s', null, subtitle(state, r))),
      h('div.c-agent', { class: agent && `r-${agent.role}` }, r.holder ?? '—'),
      vsCell(r),
      testsCell(r),
      h('div.c-status', null, statusPill(state, r)));
    }) : h('div.empty', null, 'No branches yet.'));
    renderPanel(state, list.find((r) => r.key === selected));
  }

  return {
    el,
    update(s) { snap = s; render(); },
    show() { stats.clear(); files.clear(); render(); },
  };
}
