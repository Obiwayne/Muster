// Actions shared by several pages: add agent, diff modal, merge, role changes, caches.
import type { Agent, MusterState, Role, Task } from '../../src/types';
import { api, type DiffResult } from './api';
import { confirmDialog, promptDialog, h, icon, showModal, showPopover, toast, select } from './dom';
import { events } from './events';
import { branchOwnerId, summarizeTests } from './util';

export function errToast(e: unknown): void {
  toast(e instanceof Error ? e.message : String(e), 'error');
}

/** Run an API call; show errors as toasts. Returns undefined on failure. */
export async function run<T>(p: Promise<T>, ok?: string): Promise<T | undefined> {
  try {
    const r = await p;
    if (ok) toast(ok);
    return r;
  } catch (e) {
    errToast(e);
    return undefined;
  }
}

// ---- diff cache (per agent, 30 s) ----
const diffCache = new Map<string, { at: number; p: Promise<DiffResult> }>();
function cached(key: string, fresh: boolean, make: () => Promise<DiffResult>): Promise<DiffResult> {
  const c = diffCache.get(key);
  if (!fresh && c && Date.now() - c.at < 30_000) return c.p;
  const p = make();
  diffCache.set(key, { at: Date.now(), p });
  p.catch(() => diffCache.delete(key));
  return p;
}
export class BranchMismatch extends Error {
  constructor(public agentId: string, public want: string, public got: string) {
    super(`${agentId} is on ${got} now; Muster can only diff an agent's current branch, not ${want}.`);
  }
}
/** Full diff of `agentId`'s branch vs base. With `branch`, rejects with BranchMismatch if the agent moved on. */
export function getDiff(agentId: string, branch?: string, fresh = false): Promise<DiffResult> {
  return cached(`d:${agentId}:${branch ?? ''}`, fresh, () => api.diff(agentId, false, branch)).then((d) => check(d, agentId, branch));
}
export function getDiffStat(agentId: string, branch?: string): Promise<DiffResult> {
  return cached(`s:${agentId}:${branch ?? ''}`, false, () => api.diff(agentId, true, branch)).then((d) => check(d, agentId, branch));
}
function check(d: DiffResult, agentId: string, branch?: string): DiffResult {
  if (branch && d.branch && d.branch !== branch) throw new BranchMismatch(agentId, branch, d.branch);
  return d;
}

// ---- last test results (kept in this browser; the API has no "last run" endpoint) ----
export interface TestRecord { text: string; ok: boolean; at: string; command: string; output: string }
const TESTS_KEY = 'muster.tests';
const tests: Record<string, TestRecord> = (() => {
  try { return JSON.parse(localStorage.getItem(TESTS_KEY) ?? '{}'); } catch { return {}; }
})();
export function lastTests(branch?: string): TestRecord | undefined {
  return branch ? tests[branch] : undefined;
}
const running = new Set<string>();
export function testsRunning(branch?: string): boolean { return !!branch && running.has(branch); }
export async function runTests(agentId: string, branch: string, onChange: () => void): Promise<void> {
  running.add(branch);
  onChange();
  try {
    const r = await api.runTests(agentId);
    const s = summarizeTests(r);
    tests[branch] = { ...s, at: new Date().toISOString(), command: r.command, output: r.output.slice(-4000) };
    try { localStorage.setItem(TESTS_KEY, JSON.stringify(tests)); } catch { /* ignore */ }
    toast(`${r.command} on ${branch}: ${s.text}`, s.ok ? 'info' : 'warn');
  } catch (e) {
    errToast(e);
  } finally {
    running.delete(branch);
    onChange();
  }
}

// ---- diff modal ----
export function renderDiff(diff: string): HTMLElement {
  const pre = h('div.diff');
  const lines = diff.split('\n');
  const max = 20000;
  for (const line of lines.slice(0, max)) {
    let cls = '';
    if (line.startsWith('diff --git')) cls = 'file';
    else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) cls = 'meta';
    else if (line.startsWith('@@')) cls = 'hunk';
    else if (line.startsWith('+')) cls = 'add';
    else if (line.startsWith('-')) cls = 'del';
    pre.appendChild(h('div.ln', { class: cls }, line || ' '));
  }
  if (lines.length > max) pre.appendChild(h('div.ln.meta', null, `… ${lines.length - max} more lines`));
  return pre;
}

export async function showDiffModal(agentId: string, branch?: string): Promise<void> {
  const body = h('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column' },
    h('div.empty', null, 'Loading diff…'));
  const title = h('span.mono', null, agentId);
  showModal({ title, body, wide: true, cancelLabel: null });
  try {
    const d = await getDiff(agentId, branch, true);
    title.textContent = `${d.branch}  vs  ${d.base}`;
    body.replaceChildren(d.diff.trim() ? renderDiff(d.diff) : h('div.empty', null, `No changes on ${d.branch} against ${d.base}.`));
  } catch (e) {
    body.replaceChildren(h('div.empty', null, e instanceof Error ? e.message : String(e)));
  }
}

// ---- merge ----
export async function mergeTask(state: MusterState, task: Task): Promise<boolean> {
  // The route needs an agent id, but the task id decides what is merged; any agent will do.
  const owner = [branchOwnerId(state, task), state.agents.find((a) => a.role === 'captain')?.id].find((id) => id && state.agents.some((a) => a.id === id));
  if (!owner) { toast(`No agent found for ${task.branch ?? task.id}`, 'error'); return false; }
  const ok = await confirmDialog(
    `Merge ${task.branch ?? task.id} into ${events.snapshot?.config.baseBranch ?? 'main'}?`,
    `${task.id} ${task.title}. The Captain has reviewed it. Muster runs git merge --no-ff in the repo root; on a conflict the merge is aborted and nothing changes.`,
    'Merge into main', 'merge');
  if (!ok) return false;
  const r = await run(api.merge(owner, task.id));
  if (r) toast(`Merged ${task.branch ?? task.id}`);
  return !!r;
}

// ---- human approval ----
export async function approveTask(task: Task): Promise<void> {
  const note = await promptDialog(`Approve ${task.id}?`, `${task.id} ${task.title}. The task moves on to the next station. Add a note for the next agent if you like.`, 'Approve', 'Optional note…', true);
  if (note === null) return;
  await run(api.approve(task.id, note || undefined), `Approved ${task.id}`);
}

export async function sendBackApproval(task: Task): Promise<void> {
  const note = await promptDialog(`Send ${task.id} back?`, 'Say what needs to change. The note goes to the agent who did the work.', 'Send back', 'What needs to change?');
  if (!note) return;
  await run(api.reject(task.id, note), `Sent ${task.id} back`);
}

// ---- roles and closing ----
export async function setRole(a: Agent, role: Role): Promise<void> {
  if (a.role === role) return;
  if (role === 'captain') {
    const ok = await confirmDialog(`Make ${a.id} the Captain?`, 'The current Captain becomes Crew and gets its own worktree. The agent restarts with the new role and keeps its session.', 'Set as Captain');
    if (!ok) return;
  }
  await run(api.setRole(a.id, role), `${a.id} is now ${role === 'design' ? 'the Vellum design crew' : role}`);
}

export async function closeAgent(a: Agent): Promise<void> {
  const ok = await confirmDialog(`Close ${a.id}?`, `Stops ${a.id} and removes it from the crew. Its worktree and branch ${a.branch} are kept.`, 'Close agent', 'danger');
  if (!ok) return;
  await run(api.removeAgent(a.id), `Closed ${a.id}`);
}

// ---- add agent popover ----
export function openAddAgent(anchor: HTMLElement, align: 'left' | 'right' = 'right'): void {
  const snap = events.snapshot;
  let role: Role = 'crew';
  const name = h('input.input-sm', { placeholder: 'crew-4 (optional)', maxlength: 40 }) as HTMLInputElement;
  const readyTasks = snap?.state.tasks.filter((t) => t.status === 'ready' || t.status === 'blocked') ?? [];
  let taskId = '';
  const taskSel = select([{ value: '', label: 'No task: claims the next one' }, ...readyTasks.map((t) => ({ value: t.id, label: `${t.id} ${t.title}` }))], '', (v) => { taskId = v; });
  const hasDesign = !!snap?.state.agents.some((a) => a.role === 'design');
  const crewRunning = snap?.state.agents.filter((a) => a.role === 'crew' && a.status !== 'stopped').length ?? 0;
  const maxCrew = snap?.config.maxCrew ?? 3;
  const hint = h('div.form-hint');
  const segBtns: HTMLElement[] = [];
  const updateHint = () => {
    segBtns.forEach((b) => b.classList.toggle('on', b.dataset.role === role));
    if (snap?.state.usage.paused) { hint.className = 'form-hint warn'; hint.textContent = 'Paused: the 5-hour window is over the limit, so new agents are refused until it resets.'; }
    else if (role === 'design' && hasDesign) { hint.className = 'form-hint warn'; hint.textContent = 'There is already a design crew. Only one is allowed.'; }
    else if (role === 'crew' && crewRunning >= maxCrew) { hint.className = 'form-hint warn'; hint.textContent = `${crewRunning} of ${maxCrew} crew already running. Raise "Crew running at once" in Settings.`; }
    else { hint.className = 'form-hint'; hint.textContent = role === 'design' ? 'Gets its own worktree and the Vellum MCP; checks UI work against the design framework.' : 'Gets its own worktree and branch, then joins the task board.'; }
  };
  for (const r of ['crew', 'design'] as Role[]) {
    const b = h('button', { class: `r-${r}`, dataset: { role: r }, onclick: () => { role = r; updateHint(); } }, h('span.dot.sm'), r === 'crew' ? 'Crew' : 'Design crew');
    segBtns.push(b);
  }
  let close = () => {};
  const submit = async () => {
    const r = await run(api.addAgent({ name: name.value.trim() || undefined, role, taskId: taskId || undefined }));
    if (r) { toast(`Starting ${r.id}…`); close(); }
  };
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  const content = h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
    h('h3', null, 'Add agent'),
    h('div.form-row', null, h('label', null, 'Name'), name),
    h('div.form-row', null, h('label', null, 'Role'), h('div.seg', null, segBtns)),
    h('div.form-row', null, h('label', null, 'Task'), taskSel),
    hint,
    h('div.form-actions', null,
      h('button.btn', { onclick: () => close() }, 'Cancel'),
      h('button.btn.primary', { onclick: submit }, icon('plus', 14), 'Add agent')),
  );
  updateHint();
  close = showPopover(anchor, content, align);
  setTimeout(() => name.focus(), 0);
}
