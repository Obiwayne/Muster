// Settings: bound to GET/PATCH /api/config, saved on every change.
import type { MusterConfig } from '../../../src/types';
import { h, select, showModal, setChildren, toast, toggle } from '../dom';
import { events, type Snapshot } from '../events';
import type { Page } from '../page';
import { api, type ProjectInfo } from '../api';
import { errToast } from '../actions';
import { stationRole } from '../util';
import { showStationEditor } from '../stationeditor';

const MODELS = [
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];
const VELLUM_EDIT = [
  { value: 'ask', label: 'Only when asked' },
  { value: 'always', label: 'Always' },
  { value: 'never', label: 'Never' },
];

const MODES = [
  { value: 'auto', label: 'Auto (recommended)' },
  { value: 'default', label: 'Ask each time' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan only' },
  { value: 'bypassPermissions', label: 'Bypass all' },
];

interface MusterApp {
  renameProject?(name: string): Promise<{ ok: boolean; error?: string; canceled?: boolean }>;
  openProjectFolder?(): Promise<void>;
}
const desk = (window as unknown as { musterApp?: MusterApp }).musterApp;
// Same slug the desktop app uses for the folder name.
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;

function withCurrent(opts: { value: string; label: string }[], v: string) {
  return opts.some((o) => o.value === v) ? opts : [...opts, { value: v, label: v }];
}

export function createSettings(): Page {
  let cfg: MusterConfig | null = null;
  let lastJson = '';
  let apiRoles: Record<string, string> = {}; // station roles from GET /api/stations, when the server has it
  let shownLabel = '';
  let project: ProjectInfo | null = null; // GET /api/project, when the server has it
  let lineLabel = ''; // label of the default line preset, when the server has presets
  const body = h('div.settings');
  const el = h('div.page', null, body);

  async function save(patch: Partial<MusterConfig>): Promise<void> {
    try {
      const next = await api.patchConfig(patch);
      cfg = next;
      lastJson = JSON.stringify(next);
      if (events.snapshot) events.set({ state: events.snapshot.state, config: next });
      toast('Saved');
    } catch (e) {
      errToast(e);
      if (cfg) render(cfg);
    }
  }

  const row = (title: string, sub: string | HTMLElement, ctl: HTMLElement | null, subMono = false) =>
    h('div.srow', null,
      h('div.lbl', null, h('div.t', null, title), typeof sub === 'string' ? h('div.s', { class: subMono && 'mono' }, sub) : sub),
      ctl);
  const ctl = (child: HTMLElement, width = 160) => h('div.ctl', { style: { width: `${width}px` } }, child);
  const panel = (label: string, ...rows: HTMLElement[]) => h('div.panel', null, h('div.section-label.panel-label', null, label), rows);

  function pctInput(value: number, onSave: (v: number) => void): HTMLElement {
    const input = h('input', { type: 'text', inputmode: 'numeric', value: String(value) }) as HTMLInputElement;
    const commit = () => {
      const v = Math.round(Number(input.value));
      if (!Number.isFinite(v) || v < 1 || v > 100) { toast('Enter a percentage from 1 to 100', 'warn'); input.value = String(value); return; }
      if (v !== value) { value = v; onSave(v); }
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    return h('label.pct', null, input, h('span.u', null, '%'));
  }

  function textInput(value: string, onSave: (v: string) => void, opts: { mono?: boolean; width?: number; placeholder?: string } = {}): HTMLElement {
    const input = h('input.input-sm', { class: opts.mono && 'mono-input', value, placeholder: opts.placeholder ?? '', style: { width: `${opts.width ?? 160}px` } }) as HTMLInputElement;
    input.addEventListener('change', () => { const v = input.value.trim(); if (v !== value) { value = v; onSave(v); } });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    return input;
  }

  function stepper(value: number, min: number, max: number, onSave: (v: number) => void): HTMLElement {
    const v = h('span.v', null, String(value));
    let timer: number | undefined;
    const set = (n: number) => {
      value = Math.max(min, Math.min(max, n));
      v.textContent = String(value);
      clearTimeout(timer);
      timer = window.setTimeout(() => onSave(value), 350);
    };
    return h('div.stepper', null,
      h('button', { title: 'Fewer', onclick: () => set(value - 1) }, '−'), v,
      h('button', { title: 'More', onclick: () => set(value + 1) }, '+'));
  }

  function stationsEditor(c: MusterConfig): HTMLElement {
    const stations = c.defaultStations.filter((s) => s !== 'review');
    const parts0: HTMLElement[] = [];
    const wrap = h('div.station-chips');
    if (lineLabel) parts0.push(h('span.muted', { style: 'margin-right:8px' }, `${lineLabel} line`));
    const saveStations = (list: string[]) => save({ defaultStations: [...list, 'review'] });
    const draw = () => {
      const parts: HTMLElement[] = [...parts0];
      stations.forEach((s, i) => {
        parts.push(h('span.st-chip', { class: `r-${apiRoles[s] ?? stationRole(s)}` }, s,
          h('button.x', { title: `Remove ${s}`, onclick: () => { stations.splice(i, 1); draw(); saveStations(stations); } }, '×')));
        parts.push(h('span.st-arrow', null, '→'));
      });
      parts.push(h('span.st-chip.r-captain', { title: 'Every task ends with the Captain\'s review' }, 'review'));
      const add = h('button.st-add', null, '+ station');
      add.onclick = () => {
        const input = h('input.st-input', { placeholder: 'test' }) as HTMLInputElement;
        const done = (commit: boolean) => {
          const v = input.value.trim().toLowerCase().replace(/\s+/g, '-');
          if (commit && v && v !== 'review' && !stations.includes(v)) { stations.push(v); saveStations(stations); }
          draw();
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
        input.addEventListener('blur', () => done(true));
        add.replaceWith(input);
        input.focus();
      };
      parts.push(add);
      setChildren(wrap, parts);
    };
    draw();
    return wrap;
  }

  function vellumInput(c: MusterConfig): HTMLElement {
    const current = c.vellum ? [c.vellum.command, ...c.vellum.args].map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ') : '';
    return textInput(current, (v) => {
      if (!v) { save({ vellum: null as unknown as undefined }); return; } // null clears it (undefined would be dropped by JSON)
      const parts = (v.match(/"[^"]*"|\S+/g) ?? []).map((p) => p.replace(/^"|"$/g, ''));
      const [command, ...args] = parts;
      save({ vellum: { command, args, ...(c.vellum?.env ? { env: c.vellum.env } : {}) } });
    }, { mono: true, width: 260, placeholder: 'node F:/Vellum/mcp/dist/index.js' });
  }

  async function loadRoles(): Promise<void> {
    try {
      try {
        const r = await api.lines();
        const dl = (cfg as { defaultLine?: string } | null)?.defaultLine ?? r.defaultLine;
        const l = r.lines.find((x) => x.name === dl);
        lineLabel = l ? l.label : '';
      } catch { lineLabel = ''; }
      const list = await api.stations();
      const next = Object.fromEntries(list.map((s) => [s.name, s.role]));
      if (JSON.stringify(next) !== JSON.stringify(apiRoles) || lineLabel !== shownLabel) { apiRoles = next; shownLabel = lineLabel; if (cfg) render(cfg); }
    } catch { /* older server: chips keep their built-in colours */ }
  }

  function editLine(): void {
    showStationEditor({
      lineOrder: () => cfg?.defaultStations ?? [],
      setDefaultLine: async (name, names) => { await save({ defaultLine: name, defaultStations: [...names, 'review'] } as Partial<MusterConfig>); },
      setOrder: async (names) => { await save({ defaultStations: [...names, 'review'] }); },
      onClose: () => { void loadRoles(); },
    });
  }

  async function loadProject(): Promise<void> {
    try {
      const next = await api.project();
      if (JSON.stringify(next) !== JSON.stringify(project)) { project = next; if (cfg) render(cfg); }
    } catch { /* older server: no Project panel */ }
  }

  function createRepoDialog(p: ProjectInfo): void {
    const name = h('input.input-sm', { value: slugify(p.name) || baseName(p.root) }) as HTMLInputElement;
    const priv = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
    const desc = h('input.input-sm', { placeholder: 'Optional' }) as HTMLInputElement;
    const err = h('div', { style: 'color:var(--color-stuck);font-size:12px' });
    showModal({
      title: 'Create GitHub repo',
      body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
        h('label', { style: 'display:flex;flex-direction:column;gap:4px;font-size:12px' }, 'Repository name', name),
        h('label', { style: 'display:flex;flex-direction:column;gap:4px;font-size:12px' }, 'Description', desc),
        h('label', { style: 'display:flex;align-items:center;gap:8px;font-size:13px' }, priv, 'Private'),
        err),
      actions: [{
        label: 'Create repo', kind: 'primary',
        onClick: async (close) => {
          err.textContent = '';
          const n = name.value.trim();
          if (!n) { err.textContent = 'Enter a repository name.'; return; }
          try {
            const r = await api.createGithubRepo({ name: n, private: priv.checked, ...(desc.value.trim() ? { description: desc.value.trim() } : {}) });
            close();
            toast(`Created ${r.url}`);
            await loadProject();
          } catch (e) { err.textContent = e instanceof Error ? e.message : String(e); }
        },
      }],
    });
  }

  function projectPanel(c: MusterConfig): HTMLElement | null {
    const p = project;
    if (!p) return null;
    const name = c.projectName ?? p.name;
    const rows: HTMLElement[] = [
      row('Name', 'Shown in the dashboard and used by the crew. Pick the product name here',
        ctl(textInput(name, (v) => save({ projectName: v || (null as unknown as undefined) }), { width: 200 }), 200)),
    ];
    const slug = slugify(name);
    const folderBtns: HTMLElement[] = [];
    if (desk?.openProjectFolder) folderBtns.push(h('button.btn.sm', { onclick: () => void desk.openProjectFolder!() }, 'Open folder'));
    if (desk?.renameProject && slug && slug !== baseName(p.root).toLowerCase()) folderBtns.push(h('button.btn.sm', {
      title: `Rename the folder to ${slug}`,
      onclick: async () => {
        const r = await desk.renameProject!(name);
        if (!r.ok && !r.canceled && r.error) toast(r.error, 'error', 8000);
      },
    }, 'Rename folder to match name'));
    rows.push(row('Folder', p.root, folderBtns.length ? h('div.ctl', { style: 'width:auto;gap:8px' }, folderBtns) : null, true));
    let sub: string | HTMLElement = 'Not on GitHub yet';
    let act: HTMLElement | null = null;
    if (p.remoteUrl) sub = h('div.s.mono', null, h('a', { href: p.remoteUrl, target: '_blank', rel: 'noreferrer' }, p.remoteUrl));
    else if (!p.gh.installed) sub = 'Install GitHub CLI (cli.github.com), then run `gh auth login`';
    else if (!p.gh.authed) sub = 'Run `gh auth login` in a terminal, then reload';
    else act = h('button.btn.sm', { onclick: () => createRepoDialog(p) }, 'Create GitHub repo');
    rows.push(row('GitHub', sub, act));
    return panel('Project', ...rows);
  }

  function render(c: MusterConfig): void {
    setChildren(body,
      h('div', { style: 'display:flex;flex-direction:column;gap:4px' },
        h('div.settings-title', null, 'Settings'),
        h('div.muted', { style: 'font-size:13px' }, 'Saved to .muster/config.json in this repo. The CLI reads the same file.')),
      h('div.settings-cols', null,
        h('div.settings-col', null,
          projectPanel(c),
          panel('You',
            row('Your name', 'What the Captain and crew call you. Shared by every project on this PC',
              ctl(textInput(c.userName ?? '', (v) => save({ userName: v || (null as unknown as undefined) }), { placeholder: 'e.g. Wayne', width: 200 }), 200))),
          panel('Team and models',
            row('Captain model', 'Planning and review need the best judgement',
              ctl(select(withCurrent(MODELS, c.captainModel), c.captainModel, (v) => save({ captainModel: v })))),
            row('Crew and design crew model', 'Much cheaper per task',
              ctl(select(withCurrent(MODELS, c.crewModel), c.crewModel, (v) => save({ crewModel: v, designModel: v })))),
            row('Crew running at once', 'Not counting the Captain and the design crew',
              ctl(stepper(c.maxCrew, 1, 12, (v) => save({ maxCrew: v })))),
            row('Shut down idle crew', 'An idle agent still holds a session open',
              ctl(toggle(c.shutdownIdleCrew, (v) => save({ shutdownIdleCrew: v }))))),
          panel('Agents and permissions',
            row('Crew permission mode', 'Edits outside an agent\'s own worktree are always blocked',
              ctl(select(withCurrent(MODES, c.permissionMode), c.permissionMode, (v) => save({ permissionMode: v })))),
            row('Design crew can edit Vellum', c.vellumEdit === 'never' ? 'Never: its Vellum editing tools are switched off' : c.vellumEdit === 'always' ? 'Always: it changes designs when its task needs it' : 'Only when the Captain asks in a message or task',
              ctl(select(withCurrent(VELLUM_EDIT, c.vellumEdit ?? 'ask'), c.vellumEdit ?? 'ask', (v) => save({ vellumEdit: v as MusterConfig['vellumEdit'] })))),
            row('Vellum MCP for the design crew', c.vellum ? 'Starts the Vellum MCP server' : 'Not set: design crew runs without Vellum',
              ctl(vellumInput(c), 260)),
            row('Vellum design framework file', 'File id the design crew learns the framework from. Empty: it finds the file itself',
              ctl(textInput(c.vellumFile ?? '', (v) => save({ vellumFile: v.trim() || (null as unknown as undefined) }), { mono: true, width: 260, placeholder: 'e.g. 28BUsqILtGqq' }), 260)))),
        h('div.settings-col', null,
          panel('Usage guard · Max 5x',
            row('Pause new work at', '5-hour window. No spawning or assigning until it resets',
              ctl(pctInput(c.pauseAtFiveHourPct, (v) => save({ pauseAtFiveHourPct: v })), 120)),
            row('Warn me at', 'Weekly window',
              ctl(pctInput(c.warnAtWeeklyPct, (v) => save({ warnAtWeeklyPct: v })), 120))),
          h('div.panel', null,
            h('div.panel-head', null, h('div.section-label', null, 'Factory line and review'),
              h('button.btn.sm', { onclick: editLine, title: 'Reorder stations and edit the role and guideline of each station' }, 'Edit line')),
            h('div.srow.col', null, h('div.lbl', null, h('div.t', null, 'Default stations')), stationsEditor(c)),
            row('Test command', 'Run by the Captain in each worktree',
              ctl(textInput(c.testCommand, (v) => save({ testCommand: v }), { mono: true }))),
            row('Notify me', 'Windows notification for escalations and branches ready to merge',
              toggle(c.notify, (v) => save({ notify: v })))))),
    );
  }

  return {
    el,
    update(s: Snapshot) {
      const json = JSON.stringify(s.config);
      if (json === lastJson) return;
      // don't rebuild under the user's cursor
      if (cfg && body.contains(document.activeElement) && document.activeElement !== document.body && (document.activeElement as HTMLElement).tagName === 'INPUT') return;
      lastJson = json;
      cfg = s.config;
      render(s.config);
      void loadRoles();
      void loadProject();
    },
  };
}
