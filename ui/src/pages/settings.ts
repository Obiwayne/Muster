// Settings: bound to GET/PATCH /api/config, saved on every change. "Research browser" and "Intel" read
// GET /api/browser and use the human browser writes in browserapi.ts (login window, Opera import, forget).
// Tabs (#/settings?tab=usage|line|phone|remote): General, Usage guard, Factory line, Phone (pages/phone.ts, /api/phone/*)
// and Remote access (pages/remote.ts, /api/phone/remote/*). While the remote hold is off, a red banner tops every tab.
import '../intelcheck.css';
import type { BrowseMode, IntelConfig, MusterConfig, ResearchBrowserConfig, ResearchBrowserStatus, WatchCadence } from '../../../src/types';
import { h, icon, select, setChildren, toast, toggle } from '../dom';
import { events, type Snapshot } from '../events';
import type { Page } from '../page';
import { api, type ProjectInfo } from '../api';
import { errToast, openGithubBackup } from '../actions';
import { stationRole } from '../util';
import { showStationEditor } from '../stationeditor';
import { weeklyStatus } from '../usagealert';
import { getBrowserStatus } from '../intelapi';
import { closeLogin, forgetSite, openLogin, operaImport, setSiteVisible } from '../browserapi';
import { addAllowed, availabilityLine, blockedHint, honestLimits, operaSummary, siteLine } from '../browsermodel';
import { SETTINGS_TABS, parseSettingsTab, type SettingsTab } from '../phonemodel';
import { createPhoneSection } from './phone';
import { createRemoteSection } from './remote';

const BROWSE_MODES = [
  { value: 'profile', label: 'Research profile' },
  { value: 'public', label: 'Public pages only' },
  { value: 'opera', label: 'My Opera sign-ins' },
];
const RECHECK = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'daily', label: 'Daily' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'off', label: 'Off' },
];

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

const CREW_NAMES = [
  { value: 'names', label: 'Names' },
  { value: 'numbers', label: 'Numbers' },
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
  let browser: ResearchBrowserStatus | null = null; // GET /api/browser
  let browserBusy = '';
  const visiblePending = new Map<string, boolean>(); // domain → the checkbox state while POST /api/browser/visible runs
  let visible = false;
  let pollTimer: number | undefined;
  let tab: SettingsTab = 'general';
  const phone = createPhoneSection();
  const remote = createRemoteSection(() => { if (cfg) render(cfg); });
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
  const panel = (label: string, ...rows: (HTMLElement | null)[]) => h('div.panel', null, h('div.section-label.panel-label', null, label), rows);

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
    return panel('Project', ...rows);
  }

  function githubPanel(c: MusterConfig): HTMLElement | null {
    const remoteUrl = project ? project.remoteUrl ?? null : undefined; // undefined: not loaded yet; null: no GitHub remote
    if (remoteUrl === undefined) return null;
    const backUp = h('button.btn.sm', { onclick: async () => { if (await openGithubBackup()) void loadProject(); } }, 'Back up…');
    return panel('GitHub',
      row('Backup', remoteUrl ?? 'Only on this computer so far', remoteUrl ? null : backUp, !!remoteUrl),
      remoteUrl ? null : row('Offer a backup', 'Ask once the first piece of work is merged',
        toggle(c.githubOffer !== 'never', (v) => save({ githubOffer: v ? 'ask' : 'never' }))));
  }

  // ---------------------------------------------------------------- research browser + intel
  const saveRB = (patch: Partial<ResearchBrowserConfig>) => save({ researchBrowser: patch } as unknown as Partial<MusterConfig>);
  const saveIntel = (patch: Partial<IntelConfig>) => save({ intel: patch } as unknown as Partial<MusterConfig>);

  async function loadBrowser(): Promise<void> {
    try {
      const next = await getBrowserStatus();
      if (JSON.stringify(next) !== JSON.stringify(browser)) { browser = next; if (cfg) render(cfg); }
    } catch { /* unreachable: keep what we had */ }
    // while a login window is open, its status changes when you close it: look again every few seconds
    clearTimeout(pollTimer);
    if (visible && browser?.state === 'login_open') pollTimer = window.setTimeout(() => void loadBrowser(), 3000);
  }

  async function browserAct(key: string, p: Promise<ResearchBrowserStatus>, ok?: string): Promise<void> {
    browserBusy = key;
    if (cfg) render(cfg);
    try {
      browser = await p;
      if (ok) toast(ok);
    } catch (e) {
      errToast(e);
    } finally {
      browserBusy = '';
      if (cfg) render(cfg);
      void loadBrowser();
    }
  }

  /** The visible-window checkbox: shared by every project on this PC, so it goes to the research browser, not this project's config. */
  async function toggleVisible(domain: string, on: boolean): Promise<void> {
    visiblePending.set(domain, on);
    if (cfg) render(cfg);
    try {
      browser = await setSiteVisible(domain, on);
    } catch (e) {
      errToast(e);
    } finally {
      visiblePending.delete(domain);
      if (cfg) render(cfg);
    }
  }

  function numInput(value: number, min: number, max: number, onSave: (v: number) => void, unit = ''): HTMLElement {
    const input = h('input', { type: 'text', inputmode: 'numeric', value: String(value) }) as HTMLInputElement;
    input.addEventListener('change', () => {
      const v = Math.round(Number(input.value));
      if (!Number.isFinite(v) || v < min || v > max) { toast(`Enter a number from ${min} to ${max}`, 'warn'); input.value = String(value); return; }
      if (v !== value) { value = v; onSave(v); }
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    return h('label.pct', null, input, unit ? h('span.u', null, unit) : null);
  }

  function allowlistEditor(c: MusterConfig): HTMLElement {
    const list = [...(c.researchBrowser?.operaAllow ?? [])];
    const wrap = h('div.rb-chips');
    const saveList = (next: string[]) => saveRB({ operaAllow: next });
    const draw = () => {
      const add = h('button.rb-add', null, '+ Add site');
      add.onclick = () => {
        const input = h('input.rb-input', { placeholder: 'reddit.com' }) as HTMLInputElement;
        let done = false;
        const finish = (commit: boolean) => {
          if (done) return;
          done = true;
          if (commit && input.value.trim()) {
            const r = addAllowed(list, input.value);
            if (r.error) toast(r.error, 'warn');
            else if (r.list.length !== list.length) { list.splice(0, list.length, ...r.list); saveList(list); }
          }
          draw();
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
        input.addEventListener('blur', () => finish(true));
        add.replaceWith(input);
        input.focus();
      };
      setChildren(wrap,
        list.length ? null : h('span.faint', { style: 'font-size:12px' }, 'No sites allowed. Opera mode imports nothing.'),
        list.map((d, i) => h('span.rb-chip', null, d,
          h('button.x', { title: `Remove ${d}`, onclick: () => { list.splice(i, 1); draw(); saveList(list); } }, '×'))),
        add);
    };
    draw();
    return wrap;
  }

  function researchBrowserPanel(c: MusterConfig): HTMLElement {
    const rb = c.researchBrowser ?? { mode: 'profile', channel: 'chrome', operaAllow: [], minDelayMs: 3000, maxPagesPerJob: 150, visibleSites: [] };
    const st = browser;
    const avail = availabilityLine(st);
    const loginOpen = st?.state === 'login_open';
    const usable = !!st?.available;
    const opera = st?.opera;
    const allow = rb.operaAllow ?? [];

    const sites = st?.sites ?? [];
    const sitesEl = sites.length
      ? h('div.rb-sites', null, sites.map((s) => {
        // The shared list (every project on this PC) is the truth; while a change is being saved, show what you clicked.
        const shown = visiblePending.get(s.domain) ?? !!s.visible;
        const blocked = blockedHint({ ...s, visible: shown });
        const red = blocked?.tone === 'blocked';
        const vis = h('input', { type: 'checkbox', checked: shown, disabled: visiblePending.has(s.domain) }) as HTMLInputElement;
        vis.addEventListener('change', () => void toggleVisible(s.domain, vis.checked));
        return h('div.rb-site', null,
          h('span.rb-sdot', { class: [s.connected && 'on', red && 'blocked'] }),
          h('div.rb-site-body', null,
            h('div.rb-site-t', null, s.label, h('span.rb-dom', null, s.domain), blocked && red ? h('span.rb-blocked', { title: blocked.text }, blocked.tag) : null),
            h('div.rb-site-s', null, siteLine(s)),
            blocked ? h(red ? 'div.rb-site-b' : 'div.rb-site-p', red ? null : { title: `The last hidden read was blocked (${s.blocked?.reason ?? 'bot check'})` }, blocked.text) : null,
            s.warning ? h('div.rb-site-w', null, icon('alert', 11), s.warning) : null,
            s.limits && !s.connected ? h('div.rb-site-l', null, s.limits) : null,
            h('label.rb-vis', { title: 'scout reads this site in a normal Chrome window on the research profile (you will see it open), instead of a hidden one. Applies to every project on this PC.' },
              vis, 'Use a visible browser window for this site', h('span.rb-vis-n', null, '· every project on this PC'))),
          s.connected
            ? h('button.btn.sm', { disabled: !!browserBusy, onclick: () => void browserAct(`forget:${s.site}`, forgetSite(s.site), `Forgot ${s.label}: its cookies are gone from the research profile`) }, 'Forget')
            : h('button.btn.sm', { disabled: !usable || !!browserBusy, title: usable ? (loginOpen ? `Open ${s.label}'s login page as a new tab in the open login window` : `Open ${s.label}'s login page in a normal Chrome window on the research profile`) : avail.text, onclick: () => void browserAct(`login:${s.site}`, openLogin({ site: s.site }), `A normal Chrome window opens. Sign in to ${s.label}, then close the window.`) }, 'Connect'));
      }))
      : h('div.faint', { style: 'font-size:12px' }, st ? 'No known sites reported.' : 'Loading…');

    const limits = honestLimits(st, c);
    return panel('Research browser',
      row('Status', h('div', null,
          h('div.s', { class: avail.ok ? 'rb-ok' : 'rb-bad' }, avail.text),
          st?.profileDir ? h('div.s.mono', { title: 'Muster\'s own Chrome profile, never your everyday one. Agents are not allowed to read it.' }, st.profileDir) : null),
        loginOpen ? h('button.btn.sm', { disabled: !!browserBusy, onclick: () => void browserAct('close', closeLogin(), 'Login window closed') }, 'Close login window') : null),
      row('Open login window', "A normal Chrome window opens on Muster's research profile, with no automation attached. Sign in, then close the window: Muster reads which sites are signed in once it has closed, and scout browses read-only with those sign-ins. Google may still ask you to verify it's you later, when scout uses the profile.",
        h('button.btn.sm', {
          disabled: !usable || !!browserBusy || loginOpen,
          title: usable ? '' : avail.text,
          onclick: () => void browserAct('login', openLogin({}), 'A normal Chrome window opens. Sign in, then close the window.'),
        }, loginOpen ? 'Window open…' : 'Open login window')),
      row('Default browse mode', 'The answer pre-picked in "How should scout browse?"',
        ctl(select(BROWSE_MODES, rb.mode, (v) => {
          if (v === 'opera' && !allow.length) { toast('Add sites to the Opera allowlist first', 'warn'); render(c); return; }
          void saveRB({ mode: v as BrowseMode });
        }), 180)),
      h('div.srow.col', null,
        h('div.lbl', null, h('div.t', null, 'Connected sites'), h('div.s', null, 'A site counts as connected when its login cookie is in the research profile.')),
        sitesEl),
      h('div.srow.col', null,
        h('div.lbl', null, h('div.t', null, 'Import sign-ins from Opera'),
          h('div.s', null, opera ? (opera.found ? `Opera profile found${opera.profileDir ? ` · ${opera.profileDir}` : ''}` : 'Opera profile not found on this PC') : 'Checking…')),
        h('div.rb-warn', null, icon('alert', 13), h('span', null,
          'This copies your own Opera cookies for the sites you list (and only those) into the research profile. scout can only read, never post, but those sites see your account visit. Values are never shown, logged or sent anywhere else.')),
        h('div.rb-sub', null, 'ALLOWED SITES'),
        allowlistEditor(c),
        h('div.rb-import', null,
          h('span.rb-isum', null, operaSummary(opera)),
          h('button.btn.sm', {
            disabled: !allow.length || !opera?.found || !usable || !!browserBusy,
            title: !allow.length ? 'Add a site first' : !opera?.found ? 'Opera profile not found' : '',
            onclick: () => void browserAct('opera', operaImport(), 'Imported Opera sign-ins for the allowed sites'),
          }, browserBusy === 'opera' ? 'Importing…' : 'Import now'))),
      h('div.srow.col', null,
        h('div.lbl', null, h('div.t', null, 'What scout can and can\'t read')),
        h('div.rb-limits', null, limits.map((l) => h('div.rb-limit', { class: l.tone },
          h('span.rb-ltag', null, l.tone === 'ok' ? 'on' : l.tone === 'off' ? 'off' : l.tone === 'warn' ? 'note' : 'info'),
          h('span.rb-lt', null, l.title),
          h('span.rb-lx', null, l.text)))),
        st?.tools.length ? h('div.rb-tools', null, st.tools.map((t) => h('span.rb-tool', { class: t.ok ? 'ok' : 'bad', title: t.note ?? '' }, h('span.d'), t.name, t.note ? h('span.faint', null, ` · ${t.note}`) : null))) : null),
      row('Pause between pages on one site', 'Waits, never fails. Keeps scout polite.',
        ctl(numInput(Math.round((rb.minDelayMs ?? 3000) / 1000), 1, 60, (v) => void saveRB({ minDelayMs: v * 1000 }), 's'), 120)),
      row('Page budget per job', 'Browse calls one intel job or research run may make',
        ctl(numInput(rb.maxPagesPerJob ?? 150, 10, 1000, (v) => void saveRB({ maxPagesPerJob: v })), 120)));
  }

  function intelPanel(c: MusterConfig): HTMLElement {
    const ic = c.intel ?? { recheck: 'weekly', checkMaxAgeDays: 14 };
    return panel('Intel',
      row('Re-check approved ideas', ic.recheck === 'off' ? 'Off: approved ideas are not watched' : 'scout re-runs the intel check and tells you when the verdict changes',
        ctl(select(RECHECK, ic.recheck ?? 'weekly', (v) => void saveIntel({ recheck: v as WatchCadence }))),
      ),
      row('Intel check expires after', 'Approving an idea needs a check younger than this',
        ctl(numInput(ic.checkMaxAgeDays ?? 14, 1, 90, (v) => void saveIntel({ checkMaxAgeDays: v }), 'days'), 120)),
      row('Companies House API key', ic.companiesHouseKey ? 'Set: filings come from the official API' : 'Optional. Without it scout reads the public search pages',
        ctl(textInput(ic.companiesHouseKey ? '••••••••' : '', (v) => {
          if (v === '••••••••') return;
          void saveIntel({ companiesHouseKey: v || (null as unknown as undefined) });
        }, { mono: true, width: 200, placeholder: 'paste a key' }), 200)));
  }

  let usageKey = ''; // the weekly alert state shown under "Weekly alerts"
  const usageOf = (s: Snapshot | null) => {
    const u = s?.state.usage;
    return { weeklyRemindAt: u?.weeklyRemindAt, weeklySnoozedUntil: u?.weeklySnoozedUntil };
  };

  function syncPhone(): void {
    if (visible && tab === 'phone') phone.show(); else phone.hide();
    if (visible && tab === 'remote') remote.show();
    else {
      remote.hide();
      if (visible) void remote.refresh(); // the hold-off banner shows on every tab
    }
  }

  function tabs(): HTMLElement {
    return h('div.set-tabs', { role: 'tablist' }, SETTINGS_TABS.map((t) => h('a.set-tab', {
      class: [t.id === tab && 'on', `t-${t.id}`], role: 'tab', 'aria-selected': String(t.id === tab),
      href: t.id === 'general' ? '#/settings' : `#/settings?tab=${t.id}`,
    }, t.id === 'phone' ? icon('phone', 14) : t.id === 'remote' ? icon('globe', 14) : null, t.label,
    t.id === 'remote' && remote.appsWaiting() > 0
      ? h('span.set-tab-badge', { title: `${remote.appsWaiting()} app${remote.appsWaiting() === 1 ? '' : 's'} waiting for approval` }, String(remote.appsWaiting()))
      : null)));
  }

  const cols = (left: (HTMLElement | null)[], right: (HTMLElement | null)[] = []) =>
    h('div.settings-cols', null, h('div.settings-col', null, left), h('div.settings-col', null, right));

  function usageTab(c: MusterConfig): HTMLElement {
    const weeklyOn = c.weeklyAlerts !== false;
    return cols([
      panel('Usage guard · Max 5x',
        row('Pause new work at', '5-hour window. No spawning or assigning until it resets',
          ctl(pctInput(c.pauseAtFiveHourPct, (v) => save({ pauseAtFiveHourPct: v })), 120)),
        row('Weekly alerts', weeklyStatus(usageOf(events.snapshot), c),
          toggle(weeklyOn, (v) => save({ weeklyAlerts: v }))),
        row('Weekly alert at', weeklyOn ? 'One note on the board when the weekly window reaches this' : 'Turn weekly alerts on to use it',
          h('div.ctl', { style: { width: '120px', opacity: weeklyOn ? '' : '.5' } }, pctInput(c.warnAtWeeklyPct, (v) => save({ warnAtWeeklyPct: v })))))]);
  }

  function lineTab(c: MusterConfig): HTMLElement {
    return cols([
      h('div.panel', null,
        h('div.panel-head', null, h('div.section-label', null, 'Factory line and review'),
          h('button.btn.sm', { onclick: editLine, title: 'Reorder stations and edit the role and guideline of each station' }, 'Edit line')),
        h('div.srow.col', null, h('div.lbl', null, h('div.t', null, 'Default stations')), stationsEditor(c)),
        row('Test command', 'Run by the Captain in each worktree',
          ctl(textInput(c.testCommand, (v) => save({ testCommand: v }), { mono: true }))),
        row('Require evidence', c.requireEvidence === false ? 'Off: the Captain can pass a task without proof' : 'The last station attaches proof (screenshots, test output) before the Captain can pass a task',
          toggle(c.requireEvidence !== false, (v) => save({ requireEvidence: v }))),
        row('Notify me', 'Windows notification for escalations and branches ready to merge',
          toggle(c.notify, (v) => save({ notify: v }))))]);
  }

  function render(c: MusterConfig): void {
    const content = tab === 'phone' ? phone.el : tab === 'remote' ? remote.el : tab === 'usage' ? usageTab(c) : tab === 'line' ? lineTab(c) : generalTab(c);
    setChildren(body,
      remote.banner(),
      h('div', { style: 'display:flex;flex-direction:column;gap:4px' },
        h('div.settings-title', null, 'Settings'),
        h('div.muted', { style: 'font-size:13px' }, tab === 'phone'
          ? 'Link your Android phone to approve, answer and get pinged when the crew needs you.'
          : tab === 'remote'
            ? `Control the Captain from the Claude app, through your own tunnel.${remote.holdOff() ? '' : ' Everything Claude sends waits for your tap.'}`
            : 'Saved to .muster/config.json in this repo. The CLI reads the same file.')),
      tabs(),
      content);
  }

  function generalTab(c: MusterConfig): HTMLElement {
    return h('div.settings-cols', null,
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
            row('Crew names', c.crewNames === 'numbers' ? 'New crew are called crew-18, crew-19…' : 'New crew get names: ada, bea, cleo…',
              ctl(select(CREW_NAMES, c.crewNames ?? 'names', (v) => save({ crewNames: v as MusterConfig['crewNames'] })))),
            row('Crew running at once', 'Not counting the Captain and the design crew. Stopped crew that still hold a task count too',
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
              ctl(textInput(c.vellumFile ?? '', (v) => save({ vellumFile: v.trim() || (null as unknown as undefined) }), { mono: true, width: 260, placeholder: 'e.g. 28BUsqILtGqq' }), 260))),
          intelPanel(c)),
        h('div.settings-col', null,
          githubPanel(c),
          researchBrowserPanel(c)));
  }

  return {
    el,
    update(s: Snapshot) {
      const json = JSON.stringify(s.config);
      const uk = JSON.stringify(usageOf(s));
      if (json === lastJson && uk === usageKey) return;
      // don't rebuild under the user's cursor
      if (cfg && body.contains(document.activeElement) && document.activeElement !== document.body && (document.activeElement as HTMLElement).tagName === 'INPUT') return;
      lastJson = json;
      usageKey = uk;
      cfg = s.config;
      render(s.config);
      void loadRoles();
      void loadProject();
      if (!browser) void loadBrowser();
    },
    params(p: URLSearchParams) {
      const next = parseSettingsTab(p.get('tab'));
      if (next !== tab) {
        tab = next;
        if (cfg) render(cfg);
        body.scrollTop = 0;
      }
      syncPhone();
    },
    show() { visible = true; void loadBrowser(); syncPhone(); },
    hide() { visible = false; clearTimeout(pollTimer); syncPhone(); },
  };
}
