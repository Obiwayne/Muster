// "Edit line" modal: the station list (order, add, remove) and, per station, its role, skills and Markdown guideline.
import type { SkillInfo } from '../../src/types';
import { ApiError, api, type LineDef, type StationDef } from './api';
import { confirmDialog, h, icon, showModal, toast } from './dom';
import { errToast } from './actions';
import { renderMarkdown } from './markdown';

type StationRole = StationDef['role'];
const ROLES: { value: StationRole; label: string }[] = [
  { value: 'crew', label: 'Crew' },
  { value: 'design', label: 'Vellum design crew' },
  { value: 'captain', label: 'Captain' },
  { value: 'human', label: 'You (approval)' },
  { value: 'qa', label: 'QA gate' },
];
const MAX_GUIDELINE = 20_000; // characters
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,29}$/;

export interface StationEditorOpts {
  /** Persist the new line order (names without 'review'; the caller appends it). */
  setOrder: (names: string[]) => Promise<void>;
  /** Make a preset the default line (PATCH /api/config {defaultLine}). */
  lineOrder: () => string[];
  setDefaultLine: (name: string, names: string[]) => Promise<void>;
  /** Called after the modal closes, so the caller can refresh role colours and chips. */
  onClose: () => void;
}

interface Draft { role: StationRole; guideline: string; skills: string[] }

const sameList = (a: string[] = [], b: string[] = []) => a.length === b.length && a.every((x, i) => x === b[i]);

export function showStationEditor(opts: StationEditorOpts): void {
  let saved: Record<string, StationDef> = {};
  let order: string[] = []; // editable stations, in line order, without 'review'
  const drafts: Record<string, Draft> = {};
  let current = '';
  let tab: 'edit' | 'preview' = 'edit';
  let error = '';
  let loading = true;
  let confirmDiscard = false;
  let adding = false;
  let lines: LineDef[] = [];
  let defaultLine = '';
  let viewLine = ''; // the preset the line was last applied from or matches
  let others: string[] = []; // saved stations that are not in the line
  let gates: string[] = []; // locked stations (qa) on the line: they always sit just before review and can't be moved or removed
  let presetsErr = false;
  let skills: SkillInfo[] = []; // Muster's plugin skills (GET /api/skills); empty on an older server

  const root = h('div.se');
  const isDirty = (n: string) => { const d = drafts[n], s = saved[n]; return !!d && !!s && (d.role !== s.role || d.guideline !== s.guideline || !sameList(d.skills, s.skills)); };
  const anyDirty = () => Object.keys(drafts).some(isDirty);

  const close = showModal({
    title: 'Edit line',
    body: root,
    wide: true,
    cancelLabel: null,
    beforeClose: () => { if (!anyDirty()) return true; confirmDiscard = true; draw(); return false; },
    onClose: opts.onClose,
  });

  async function load(select?: string): Promise<void> {
    try {
      try { const r = await api.lines(); lines = r.lines; defaultLine = r.defaultLine; presetsErr = false; } catch { lines = []; presetsErr = true; } // older server: no presets
      try { skills = await api.skills(); } catch { skills = []; }
      const list = await api.stations();
      saved = Object.fromEntries(list.map((s) => [s.name, s]));
      const onLine = opts.lineOrder().filter((n) => n !== 'review' && saved[n]);
      gates = onLine.filter((n) => saved[n].locked);
      order = onLine.filter((n) => !saved[n].locked);
      others = list.map((s) => s.name).filter((n) => n !== 'review' && !onLine.includes(n) && !saved[n].locked);
      for (const s of list) if (!isDirty(s.name)) drafts[s.name] = { role: s.role, guideline: s.guideline, skills: [...(s.skills ?? [])] };
      for (const n of Object.keys(drafts)) if (!saved[n]) delete drafts[n];
      current = select && saved[select] ? select : saved[current] ? current : order[0] ?? 'review';
      error = '';
    } catch (e) {
      error = e instanceof ApiError && e.status === 404 ? 'This Muster orchestrator has no station routes yet. Restart Muster on the latest build.' : e instanceof Error ? e.message : String(e);
    }
    loading = false;
    draw();
  }

  async function move(i: number, d: -1 | 1): Promise<void> {
    const j = i + d;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    const prev = order;
    order = next; draw();
    try { await persistOrder(next); } catch (e) { order = prev; draw(); errToast(e); }
  }

  async function addStation(raw: string): Promise<void> {
    adding = false;
    const name = raw.trim().toLowerCase().replace(/\s+/g, '-');
    if (!name) { draw(); return; }
    if (name === 'review' || saved[name]) { toast(`There is already a station called ${name}`, 'warn'); draw(); return; }
    if (!NAME_RE.test(name)) { toast('Station names are lowercase letters, digits and dashes, up to 30', 'warn'); draw(); return; }
    try {
      await api.saveStation(name, { role: 'crew', guideline: '' });
      await persistOrder([...order, name]);
      await load(name);
    } catch (e) { errToast(e); draw(); }
  }

  /** Persist a new line order, and the preset it was edited from. */
  async function persistOrder(next: string[]): Promise<void> {
    next = [...next, ...gates];
    await opts.setOrder(next);
    const l = lines.find((x) => x.name === viewLine);
    if (l) {
      try { l.stations = [...next, 'review']; await api.saveLine(l.name, { stations: l.stations, label: l.label }); } catch { /* older server */ }
    }
  }

  async function addToLine(name: string): Promise<void> {
    try { await persistOrder([...order, name]); await load(name); } catch (e) { errToast(e); }
  }

  async function removeFromLine(name: string): Promise<void> {
    try { await persistOrder(order.filter((n) => n !== name)); await load(name); } catch (e) { errToast(e); }
  }

  async function makeDefault(): Promise<void> {
    try { await opts.setDefaultLine(viewLine, order); defaultLine = viewLine; toast(`${lines.find((l) => l.name === viewLine)?.label ?? viewLine} is the default line`); draw(); } catch (e) { errToast(e); }
  }

  async function applyPreset(name: string): Promise<void> {
    const line = lines.find((l) => l.name === name);
    if (!line) return;
    const names = line.stations.filter((n) => n !== 'review');
    if (anyDirty() && !(await confirmDialog('Discard unsaved edits?', 'Applying a preset reloads the stations from this machine.', 'Apply', 'danger'))) { draw(); return; }
    if (!(await confirmDialog(`Use the ${line.label} line?`, `The line becomes ${[...names, 'review'].join(' → ')}. Tasks created from now on use it; existing tasks keep theirs. Station guidelines you already wrote are kept.`, 'Use this line'))) { draw(); return; }
    try {
      await opts.setOrder(names);
      viewLine = line.name;
      for (const k of Object.keys(drafts)) delete drafts[k];
      await load(names[0]);
    } catch (e) { errToast(e); draw(); }
  }

  function presetBar(): HTMLElement | null {
    if (!lines.length) return presetsErr ? h('div.se-presets.muted', null, 'Presets need the latest Muster build.') : null;
    const cur = [...order, ...gates, 'review'].join('>');
    const match = lines.find((l) => [...l.stations.filter((n) => n !== 'review'), 'review'].join('>') === cur);
    if (match && viewLine !== match.name) viewLine = match.name;
    if (!match) viewLine = '';
    const sel = h('select', { onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v) void applyPreset(v); } },
      h('option', { value: '', selected: !match }, match ? 'Custom…' : 'Custom'),
      lines.map((l) => h('option', { value: l.name, selected: match?.name === l.name }, l.label))) as HTMLSelectElement;
    const isDef = !!viewLine && viewLine === defaultLine;
    return h('div.se-presets', null, h('div.section-label', null, 'Preset'), h('div.select-wrap', null, sel, icon('chevron', 14)),
      viewLine ? (isDef ? h('div.muted', null, 'Default line for new tasks') : h('button.btn.sm', { onclick: () => void makeDefault() }, 'Make default')) : null);
  }

  async function removeStation(name: string): Promise<void> {
    const builtin = saved[name]?.builtin;
    const [title, text, ok] = builtin
      ? [`Reset ${name}?`, `${name} goes back to its default role and loses its guideline.`, 'Reset']
      : [`Delete ${name}?`, `The ${name} station is taken off every line and its guideline file is deleted from this machine.`, 'Delete'];
    if (!(await confirmDialog(title, text, ok, 'danger'))) return;
    try {
      await api.deleteStation(name);
      delete drafts[name];
      if (!builtin && order.includes(name)) await persistOrder(order.filter((n) => n !== name));
      await load();
    } catch (e) { errToast(e); }
  }

  async function save(): Promise<void> {
    const d = drafts[current];
    if (!d) return;
    if (d.guideline.length > MAX_GUIDELINE) { toast('A guideline can be at most 20,000 characters', 'warn'); return; }
    try {
      const s = await api.saveStation(current, { role: d.role, guideline: d.guideline, ...(skills.length ? { skills: d.skills } : {}) });
      saved[current] = { ...saved[current], ...s };
      drafts[current] = { role: saved[current].role, guideline: saved[current].guideline, skills: [...(saved[current].skills ?? [])] };
      toast('Saved');
      draw();
    } catch (e) { errToast(e); }
  }

  function importMd(): void {
    const input = h('input', { type: 'file', accept: '.md,.markdown,.txt,text/markdown,text/plain' }) as HTMLInputElement;
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const text = await f.text();
      if (text.length > MAX_GUIDELINE) { toast('That file is over 20,000 characters', 'warn'); return; }
      drafts[current].guideline = text;
      draw();
    };
    input.click();
  }

  function listCol(): HTMLElement {
    const items = order.map((n, i) => h('div.se-item', { class: [n === current && 'on', `r-${drafts[n]?.role ?? saved[n]?.role ?? 'crew'}`], onclick: () => { current = n; draw(); } },
      h('span.dot'), h('span.nm', null, n), isDirty(n) ? h('span.unsaved', { title: 'Unsaved changes' }) : null,
      h('span.mv', null,
        h('button.icon-btn', { title: 'Move up', disabled: i === 0, onclick: (e: Event) => { e.stopPropagation(); void move(i, -1); } }, '↑'),
        h('button.icon-btn', { title: 'Move down', disabled: i === order.length - 1, onclick: (e: Event) => { e.stopPropagation(); void move(i, 1); } }, '↓'))));
    const gateItems = gates.map((n) => h('div.se-item.r-qa.pinned', { class: n === current && 'on', onclick: () => { current = n; draw(); } },
      h('span.dot'), h('span.nm', null, n), isDirty(n) ? h('span.unsaved', { title: 'Unsaved changes' }) : null, h('span.se-lock', { title: 'Permanent QA gate: every code change needs 5/5' }, icon('lock', 12))));
    const review = h('div.se-item.r-captain.pinned', { class: current === 'review' && 'on', onclick: () => { current = 'review'; draw(); } },
      h('span.dot'), h('span.nm', null, 'review'), isDirty('review') ? h('span.unsaved', { title: 'Unsaved changes' }) : null, h('span.pin', { title: 'Always last' }, icon('pin', 12)));
    let add: HTMLElement;
    if (adding) {
      const input = h('input.st-input', { placeholder: 'e.g. security' }) as HTMLInputElement;
      let done = false;
      const finish = (commit: boolean) => { if (done) return; done = true; if (commit) void addStation(input.value); else { adding = false; draw(); } };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') { e.stopPropagation(); finish(false); } });
      input.addEventListener('blur', () => finish(true));
      add = input;
      queueMicrotask(() => input.focus());
    } else {
      add = h('button.st-add', { onclick: () => { adding = true; draw(); } }, '+ station');
    }
    return h('div.se-list', null, presetBar(), h('div.section-label', null, `Line${viewLine ? ' · ' + (lines.find((l) => l.name === viewLine)?.label ?? viewLine) : ''}`), items, gateItems, review,
      others.length ? h('div.section-label', null, 'Other stations') : null,
      others.map((n) => h('div.se-item', { class: [n === current && 'on', `r-${drafts[n]?.role ?? saved[n]?.role ?? 'crew'}`], onclick: () => { current = n; draw(); } },
        h('span.dot'), h('span.nm', null, n), isDirty(n) ? h('span.unsaved', { title: 'Unsaved changes' }) : null,
        h('button.btn.sm.add', { title: 'Add to line', onclick: (e: Event) => { e.stopPropagation(); void addToLine(n); } }, 'Add to line'))),
      add);
  }

  /** The last station before review that an agent works: it attaches the evidence. */
  function evidenceStationName(): string {
    const roleOf = (n: string) => drafts[n]?.role ?? saved[n]?.role ?? 'crew';
    return [...order].reverse().find((n) => roleOf(n) !== 'human') ?? 'review';
  }

  function skillsRow(d: Draft): HTMLElement | null {
    if (!skills.length) return null;
    const known = new Set(skills.map((k) => k.name));
    const chips = skills.map((k) => {
      const on = d.skills.includes(k.name);
      return h('button.se-skill', {
        class: on && 'on',
        title: k.description,
        'aria-pressed': on ? 'true' : 'false',
        onclick: () => { d.skills = on ? d.skills.filter((x) => x !== k.name) : [...d.skills, k.name]; draw(); },
      }, on ? icon('check', 12) : icon('plus', 12), k.name);
    });
    const missing = d.skills.filter((n) => !known.has(n)).map((n) => h('span.se-skill.missing', { title: "Not in Muster's plugin/skills folder" }, n));
    const evidence = current === evidenceStationName()
      ? h('div.se-evidence', null, icon('check', 12), current === 'review' ? 'No agent station before review: the Captain attaches the evidence.' : 'Last working station before review: it must attach evidence (add_evidence) before the Captain can pass the task.')
      : null;
    return h('div.se-skills', null, h('div.se-skills-row', null, h('span.muted', null, 'Skills'), chips, missing), evidence);
  }

  function editCol(): HTMLElement {
    const d = drafts[current];
    const s = saved[current];
    if (!d || !s) return h('div.se-edit', null, h('div.muted', null, 'No station selected.'));
    const locked = !!s.locked;
    const isReview = current === 'review';
    const ta = h('textarea.se-text', { value: d.guideline, spellcheck: false, placeholder: '# What this station does\n\nMarkdown the agent at this station reads before it starts.' }) as HTMLTextAreaElement;
    ta.addEventListener('input', () => { d.guideline = ta.value; counter.textContent = size(); counter.classList.toggle('over', d.guideline.length > MAX_GUIDELINE); refreshChrome(); });
    const size = () => `${d.guideline.length.toLocaleString()} of ${MAX_GUIDELINE.toLocaleString()}`;
    const counter = h('span.se-count', { class: d.guideline.length > MAX_GUIDELINE && 'over' }, size());
    const preview = h('div.se-preview.md');
    preview.innerHTML = d.guideline.trim() ? renderMarkdown(d.guideline) : '<p class="muted">Nothing to preview yet.</p>';
    const roleSel = h('select', { disabled: isReview || locked, onchange: (e: Event) => { d.role = (e.target as HTMLSelectElement).value as StationRole; draw(); } },
      ROLES.map((r) => h('option', { value: r.value, selected: r.value === d.role }, r.label))) as HTMLSelectElement;
    const canSave = () => isDirty(current) && d.guideline.length <= MAX_GUIDELINE;
    const saveBtn = h('button.btn.primary', { disabled: !canSave(), onclick: () => void save() }, 'Save') as HTMLButtonElement;
    const revertBtn = h('button.btn', { disabled: !isDirty(current), onclick: () => { drafts[current] = { role: s.role, guideline: s.guideline, skills: [...(s.skills ?? [])] }; draw(); } }, 'Revert');
    const refreshChrome = () => { saveBtn.disabled = !canSave(); (revertBtn as HTMLButtonElement).disabled = !isDirty(current); };
    return h('div.se-edit', null,
      h('div.se-head', null,
        h('div.se-title', null, current, isDirty(current) ? h('span.unsaved', { title: 'Unsaved changes' }) : null),
        h('label.se-role', null, h('span.muted', null, 'Role'), h('div.select-wrap', null, roleSel, icon('chevron', 14))),
        isReview || locked ? null : order.includes(current) ? h('button.btn', { title: 'Takes it off the line; the station and its guideline stay on this machine', onclick: () => void removeFromLine(current) }, 'Remove from line') : h('button.btn', { onclick: () => void addToLine(current) }, 'Add to line'),
        isReview || locked ? null : h('button.btn.danger', { onclick: () => void removeStation(current) }, s.builtin ? 'Reset' : 'Delete')),
      locked ? h('div.se-locked', null, icon('lock', 14), 'QA gate: every task is scored here before the Captain reviews it. It stays just before review, and only a QA agent works it. You can edit its guideline.') : null,
      skillsRow(d),
      h('div.se-tabs', null,
        h('button', { class: tab === 'edit' && 'on', onclick: () => { tab = 'edit'; draw(); } }, 'Edit'),
        h('button', { class: tab === 'preview' && 'on', onclick: () => { tab = 'preview'; draw(); } }, 'Preview'),
        h('span.sp'), counter,
        h('button.btn.sm', { onclick: importMd }, 'Import .md')),
      tab === 'edit' ? ta : preview,
      h('div.se-note', null, current !== 'review' && d.role === 'human' ? 'A human station pauses the task. The work shows on Tasks and the board as an approval note with Approve and Send back. No agent works it.' : 'Saved on this machine only (.muster/stations). Review guidelines add to the Captain\'s checks; they can\'t relax them.'),
      h('div.se-foot', null, revertBtn, saveBtn));
  }

  function draw(): void {
    const scroll = root.querySelector('.se-text')?.scrollTop;
    root.replaceChildren(...[
      confirmDiscard ? h('div.se-warn', null, h('span', null, 'You have unsaved edits.'),
        h('button.btn.sm', { onclick: () => { confirmDiscard = false; draw(); } }, 'Keep editing'),
        h('button.btn.sm.danger', { onclick: () => close() }, 'Discard and close')) : null,
      error ? h('div.se-error', null, error)
        : loading ? h('div.muted', { style: 'padding:22px' }, 'Loading…')
        : h('div.se-body', null, listCol(), editCol())].filter((n): n is HTMLElement => !!n));
    if (scroll) { const t = root.querySelector('.se-text'); if (t) t.scrollTop = scroll; }
  }

  draw();
  void load();
}
