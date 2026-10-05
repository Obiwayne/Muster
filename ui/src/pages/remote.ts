// Settings → Remote access: the remote connector's status, public address, tunnel type, the app allow-list (approve
// or deny apps waiting to sign in, remove approved ones), the hold and approve switches, the sign-in code, and the audit log. Talks to the gateway's /admin/remote/* through this
// orchestrator as /api/phone/remote/* (docs/REMOTE.md, "UI" and "Milestone 4 API contract").
// The sign-in code is shown only from the POST .../code reply, kept in memory only, and dropped when it runs out,
// is used (codeActiveUntil goes null) or is cancelled.
import '../remote.css';
import { h, icon, select, setChildren, toast, toggle, type Child } from '../dom';
import { api, ApiError } from '../api';
import { errToast } from '../actions';
import {
  TUNNEL_OPTIONS, activityLines, appIcon, appsHeader, approvedLine, codeCountdown, codeStillShown, configOf, connectionLine, connectionView, holdLine, hhmm,
  isLocked, lockView, normalizeHost, publicUrl, refusedLine, splitApps, testLine, validHost, waitingCount, waitingLine,
  type RemoteApp, type RemoteCode, type RemoteConfig, type RemoteLogEntry, type RemoteStatus, type RemoteTestResult, type RemoteTunnel,
} from '../remotemodel';

const POLL_MS = 10_000;
const LOG_LIMIT = 50;

export interface RemoteSection {
  el: HTMLElement;
  show(): void;
  hide(): void;
  /** Loads the status once (for the hold-off banner on the other Settings tabs). */
  refresh(): Promise<void>;
  /** The red "hold is off" banner, or null while the hold is on (or unknown). */
  banner(): HTMLElement | null;
  /** True while the hold is known to be off. */
  holdOff(): boolean;
  /** How many connector apps wait for approval (for the badge on the tab). */
  appsWaiting(): number;
}

/** The "Turn off the hold?" dialog. Resolves true only when the box was ticked and "Turn it off" pressed. */
function confirmHoldOff(): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      back.remove();
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('hashchange', cancel);
      resolve(v);
    };
    const cancel = () => finish(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } };
    const off = h('button.ra-off-btn', { disabled: true, onclick: () => finish(true) }, 'Turn it off') as HTMLButtonElement;
    const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
    box.addEventListener('change', () => { off.disabled = !box.checked; });
    const keep = h('button.btn.primary.ra-keep', { onclick: cancel }, 'Keep the hold on');
    const dlg = h('div.ra-dialog', { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'ra-dlg-t' },
      h('div.ra-dialog-ic', null, icon('warning', 20)),
      h('div.ra-dialog-txt', null,
        h('div.ra-dialog-t', { id: 'ra-dlg-t' }, 'Turn off the hold?'),
        h('p', null, "Claude's goals, replies and answers will reach the crew straight away, without your tap."),
        h('p', null, "Bulletin notes are written by agents. A poisoned note could talk Claude into sending a reply, and nothing would stop it. The wording in Claude's tools is not a safeguard. The hold is.")),
      h('label.ra-understand', null, box, h('span', null, 'I understand. Only this PC can turn it off, and it is logged.')),
      h('div.ra-dialog-foot', null, keep, off));
    const back = h('div.modal-back', { onmousedown: (e: MouseEvent) => { if (e.target === back) cancel(); } }, dlg);
    document.body.appendChild(back);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('hashchange', cancel);
    keep.focus();
  });
}

/** `onChange` runs when the hold flips or the number of apps waiting for approval changes (banner, tab badge). */
export function createRemoteSection(onChange: () => void): RemoteSection {
  let status: RemoteStatus | null = null;
  let statusErr = '';
  let polledAt = 0; // when the request behind `status` started
  let apps: RemoteApp[] | null = null; // null: a gateway from before the allow-list (the old connections card shows)
  let log: RemoteLogEntry[] = [];
  let logErr = '';
  let code: RemoteCode | null = null; // from our own POST .../code reply only; never stored anywhere else
  let issuedAt = 0;
  let codeBusy = false;
  let testing = false;
  let test: RemoteTestResult | null = null;
  let editingHost = false;
  let busy = '';
  let visible = false;
  let pollTimer: number | undefined;
  let tickTimer: number | undefined;
  let lastHoldOff: boolean | null = null;
  let lastWaiting = 0;

  const el = h('div.ra');
  const countEl = h('div.ra-count');
  const barFill = h('div.ra-bar-fill');

  const errText = (e: unknown) =>
    e instanceof ApiError && e.status === 404
      ? 'This Muster orchestrator or phone service has no remote access routes yet. Restart it on the latest build.'
      : e instanceof Error ? e.message : String(e);

  function noteChange(): void {
    const off = status?.hold ? status.hold.on === false : null;
    const waiting = waitingCount(status, apps);
    if (off !== lastHoldOff || waiting !== lastWaiting) { lastHoldOff = off; lastWaiting = waiting; onChange(); }
  }

  /** The allow-list: from the status, or GET .../apps when the status doesn't carry it; null when neither has it. */
  async function loadApps(s: RemoteStatus): Promise<RemoteApp[] | null> {
    if (!s.enabled) return [];
    if (Array.isArray(s.apps)) return s.apps;
    try {
      const r = await api.remoteApps();
      return Array.isArray(r) ? r : null;
    } catch {
      return null;
    }
  }

  async function loadStatus(): Promise<void> {
    const started = Date.now();
    try {
      const next = await api.remoteStatus();
      if (!next.settings && next.enabled) {
        try { next.settings = await api.remoteSettings(); } catch { /* older gateway: switches stay unknown */ }
      }
      apps = await loadApps(next);
      status = next;
      polledAt = started;
      statusErr = '';
    } catch (e) {
      statusErr = errText(e);
    }
    const wasShown = !!code;
    if (code && !codeStillShown(code, issuedAt, status, polledAt, Date.now())) {
      const used = status?.codeActiveUntil === null && Date.now() < Date.parse(code.expiresAt);
      code = null;
      if (wasShown && used && !isLocked(status, Date.now())) toast('The sign-in code was used. It is gone now.');
    }
    noteChange();
  }

  async function loadLog(): Promise<void> {
    try {
      const r = await api.remoteLog(LOG_LIMIT);
      log = Array.isArray(r) ? r : [];
      logErr = '';
    } catch (e) {
      logErr = errText(e);
    }
  }

  async function load(): Promise<void> {
    await Promise.all([loadStatus(), visible ? loadLog() : Promise.resolve()]);
    render();
  }

  /** Every second: the code countdown, and dropping the code once it ran out. */
  function tick(): void {
    const now = Date.now();
    if (code && !codeStillShown(code, issuedAt, status, polledAt, now)) { code = null; render(); return; }
    if (code) {
      const c = codeCountdown(code.expiresAt, now);
      countEl.textContent = c.text;
      barFill.style.width = `${Math.round(c.frac * 100)}%`;
    }
  }

  async function act(key: string, fn: () => Promise<unknown>, ok?: string): Promise<boolean> {
    busy = key;
    render();
    let done = false;
    try {
      await fn();
      if (ok) toast(ok);
      done = true;
    } catch (e) {
      errToast(e);
    } finally {
      busy = '';
    }
    await load();
    return done;
  }

  const setConfig = (patch: Partial<RemoteConfig>, ok?: string) => act('config', () => api.remoteSetConfig(patch), ok);

  async function runTest(): Promise<void> {
    testing = true;
    render();
    try { test = await api.remoteTest(); } catch (e) { test = { ok: false, error: errText(e), at: new Date().toISOString() }; }
    testing = false;
    await load();
  }

  async function newCode(): Promise<void> {
    if (codeBusy) return;
    codeBusy = true;
    render();
    try {
      const c = await api.remoteNewCode();
      code = { code: c.code, display: c.display, expiresAt: c.expiresAt };
      issuedAt = Date.now();
    } catch (e) {
      code = null;
      errToast(e);
    } finally {
      codeBusy = false;
    }
    tick();
    await load();
  }

  async function cancelCode(): Promise<void> {
    code = null;
    await act('code', () => api.remoteCancelCode(), 'Code cancelled');
  }

  async function setHold(on: boolean): Promise<void> {
    if (!on) {
      render(); // the switch stays on behind the dialog until you confirm
      if (!(await confirmHoldOff())) return;
    }
    await act('hold', () => api.remoteSetSettings(on ? { confirmWrites: true } : { confirmWrites: false, confirm: true }),
      on ? 'The hold is back on' : 'The hold is off');
  }

  function copy(text: string): void {
    void navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Could not copy', 'warn'));
  }

  // ---------------------------------------------------------------- view
  const card = (cls: string, ...children: Child[]) => h(`div.panel.ra-card${cls}`, null, children);
  const head = (label: string, right?: Child) => h('div.ra-head', null, h('div.section-label', null, label), right ?? null);
  const foot = (ic: string, text: Child, tone = '') => h('div.ra-foot', { class: tone }, icon(ic, 13), h('div', null, text));
  const row = (title: string, sub: Child, ctl: Child, cls = '') =>
    h(`div.ra-row${cls}`, null, h('div.ra-lbl', null, h('div.ra-t', null, title), h('div.ra-s', null, sub)), ctl);

  function hostControl(cfg: RemoteConfig): HTMLElement {
    const url = publicUrl(cfg.publicHost);
    if (url && !editingHost) {
      return h('div.ra-url', null,
        h('button.ra-url-t', { title: 'Change the public address', onclick: () => { editingHost = true; render(); el.querySelector<HTMLInputElement>('.ra-host-input')?.focus(); } }, url),
        h('button.ra-copy', { title: 'Copy', 'aria-label': 'Copy the address', onclick: () => copy(url) }, icon('copy', 13)));
    }
    const input = h('input.input-sm.mono-input.ra-host-input', { value: cfg.publicHost ?? '', placeholder: 'muster.example.com', spellcheck: 'false' }) as HTMLInputElement;
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const host = normalizeHost(input.value);
      editingHost = false;
      if (host === (cfg.publicHost ?? '')) { render(); return; }
      if (host && !validHost(host)) { toast('Enter a hostname like muster.example.com', 'warn'); render(); return; }
      void setConfig({ publicHost: host || null }, host ? 'Public address saved' : 'Public address cleared');
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') { done = true; editingHost = false; render(); }
    });
    input.addEventListener('blur', commit);
    return input;
  }

  function connectionCard(): HTMLElement {
    const now = Date.now();
    const cfg = configOf(status);
    const view = connectionView(status, log, now);
    const t = testLine(test ?? status?.lastTest, now);
    const on = view.state !== 'off';
    const action = on
      ? h('button.btn.ra-btn', {
          disabled: testing || !cfg.publicHost,
          title: cfg.publicHost ? 'Calls the public address from this PC, through the internet' : 'Set the public address first',
          onclick: () => void runTest(),
        }, testing ? 'Testing…' : 'Test')
      : h('button.btn.primary.ra-btn', { disabled: busy === 'config' || !status, onclick: () => void setConfig({ enabled: true }, 'Remote access is on') }, 'Turn on');
    const refused = refusedLine(status, log, now);
    const local = status?.enabled && status.lastLocalOkAt ? `Last local test ${hhmm(status.lastLocalOkAt)} (from this PC, doesn't count as connected)` : '';
    const tunnelSet = !!cfg.tunnel;
    return card('',
      h('div.ra-conn', { class: `s-${view.state}` },
        h('div.ra-conn-dot', null, h('span')),
        h('div.ra-conn-body', null,
          h('div.ra-conn-t', null, view.title),
          h('div.ra-conn-s', null, view.sub),
          t ? h('div.ra-test', { class: t.ok ? 'ok' : 'bad' }, t.text) : null),
        action),
      row('Public address', 'Paste this into Claude › Settings › Connectors › Add custom connector', hostControl(cfg)),
      row('Tunnel',
        tunnelSet ? 'Tells Muster whose header carries the real caller IP for the log' : "Not set: every failed sign-in will log as 127.0.0.1, the tunnel's own address",
        h('div.ra-select', { class: !tunnelSet && 'warn' },
          select(TUNNEL_OPTIONS, cfg.tunnel ?? '', (v) => void setConfig({ tunnel: (v || null) as RemoteTunnel | null }, 'Tunnel saved')))),
      on || refused || local
        ? h('div.ra-foot.ra-foot-conn', null, icon('alert', 13),
            h('div.ra-foot-lines', null,
              h('div', null, refused ?? (on ? 'No refused call through the tunnel since the phone service started' : 'Remote access is off')),
              local ? h('div', null, local) : null),
            on ? h('button.ra-link', { disabled: busy === 'config', title: 'Stop the /mcp listener. Signed-in apps stay signed in.', onclick: () => void setConfig({ enabled: false }, 'Remote access is off') }, 'Turn off') : null)
        : null);
  }

  /** The old "Signed-in apps" card, for a gateway from before the allow-list. */
  function connectionsCard(): HTMLElement {
    const list = status?.enabled ? status.connections ?? [] : [];
    const now = Date.now();
    return card('',
      head(`Signed-in apps · ${list.length}`,
        list.length ? h('button.ra-danger-link', { disabled: !!busy, onclick: () => void act('disc', () => api.remoteDisconnect(), 'Disconnected every app') }, 'Disconnect all') : null),
      list.length
        ? list.map((c) => h('div.ra-app', null,
            h('div.ra-app-ic', null, icon(appIcon(c.clientName), 16)),
            h('div.ra-lbl', null, h('div.ra-t', null, c.clientName), h('div.ra-s', null, connectionLine(c, now))),
            h('button.ra-disc', { disabled: !!busy, onclick: () => void act(`disc:${c.id}`, () => api.remoteDisconnect(c.id), `Disconnected ${c.clientName}`) }, 'Disconnect')))
        : h('div.ra-empty', null, status?.enabled
            ? 'No app is signed in. Make a sign-in code below, then add Muster as a custom connector in Claude.'
            : 'Turn remote access on to sign in an app.'));
  }

  function appsCard(): HTMLElement {
    if (status?.enabled && apps === null) return connectionsCard();
    const list = status?.enabled ? apps ?? [] : [];
    const { waiting, approved } = splitApps(list);
    const now = Date.now();
    const ic = (name: string) => h('div.ra-app-ic', null, icon(appIcon(name), 16));
    return card(waiting.length ? '.ra-apps-waiting' : '',
      head(appsHeader(list),
        approved.length ? h('button.ra-danger-link', { disabled: !!busy, onclick: () => void act('apps', () => api.remoteRemoveApp(), 'Removed every app') }, 'Remove all') : null),
      waiting.length
        ? h('div.ra-wait', null,
            h('div.ra-wait-label', null, icon('bell', 12), 'Waiting for approval'),
            waiting.map((a) => h('div.ra-app.ra-app-wait', null,
              ic(a.name),
              h('div.ra-lbl', null, h('div.ra-t', null, a.name), h('div.ra-s', null, waitingLine(a))),
              h('button.btn.ra-btn', { disabled: !!busy, onclick: () => void act(`app:${a.id}`, () => api.remoteRemoveApp(a.id), `Denied ${a.name}`) }, 'Deny'),
              h('button.btn.primary.ra-btn', { disabled: !!busy, onclick: () => void act(`app:${a.id}`, () => api.remoteApproveApp(a.id), `Approved ${a.name}`) }, 'Approve'))))
        : null,
      approved.map((a) => h('div.ra-app', null,
        ic(a.name),
        h('div.ra-lbl', null, h('div.ra-t', null, a.name), h('div.ra-s', null, approvedLine(a, now))),
        h('button.ra-disc', { disabled: !!busy, onclick: () => void act(`app:${a.id}`, () => api.remoteRemoveApp(a.id), `Removed ${a.name}`) }, 'Remove'))),
      list.length
        ? null
        : h('div.ra-empty', null, status?.enabled
            ? "No apps yet. Make a code below and sign in from Claude; you'll approve the app here."
            : 'Turn remote access on to sign in an app.'),
      foot('shield', 'Only approved apps can sign in or use the connector, even with a correct code.'));
  }

  function mayDoCard(): HTMLElement {
    const hold = status?.hold;
    const holdOn = status?.settings?.confirmWrites ?? hold?.on ?? true;
    const known = !!(status?.settings || hold);
    const approve = status?.settings?.allowApprove ?? false;
    const holdToggle = toggle(holdOn, (v) => void setHold(v));
    const approveToggle = toggle(approve, (v) => void act('approve', () => api.remoteSetSettings({ allowApprove: v }), v ? 'Claude may ask to approve merges' : 'Approving merges is off'));
    for (const t of [holdToggle, approveToggle]) if (!known || busy) (t as HTMLButtonElement).disabled = true;
    return card('',
      head('What Claude may do'),
      h('div.ra-sw', { class: holdOn ? 'hold-on' : 'hold-off' },
        h('div.ra-lbl', null,
          h('div.ra-t-row', null, h('div.ra-t', null, 'Hold everything Claude sends for my tap'), h('span.ra-rec', null, 'RECOMMENDED')),
          h('div.ra-s', null, holdLine(holdOn ? undefined : hold ?? { on: false, offSince: null, sentWithoutTap: 0 }))),
        holdToggle),
      h('div.ra-sw', null,
        h('div.ra-lbl', null,
          h('div.ra-t', null, 'Let Claude ask to approve merges'),
          h('div.ra-s', null, 'A merge pushes to origin. Even when on, each approval waits for your tap.')),
        approveToggle));
  }

  function signInCard(): HTMLElement {
    const now = Date.now();
    if (status && isLocked(status, now)) {
      const v = lockView(status, log);
      return card('',
        head('Sign in a new app'),
        h('div.ra-code', null,
          h('div.ra-code-body', null,
            h('div.ra-s', null, 'Sign-ins are locked'),
            h('div.ra-lock-t', null, v.title),
            v.sub ? h('div.ra-lock-s', null, v.sub) : null),
          h('button.btn.ra-btn', { disabled: true, title: `Sign-ins are locked until ${v.until}` }, icon('refresh', 13), 'New code')),
        foot('shield', `If you are pairing, make a new code after ${v.until}. If you are not, someone is guessing at your tunnel's sign-in page.`));
    }
    if (code) {
      const c = codeCountdown(code.expiresAt, now);
      countEl.textContent = c.text;
      barFill.style.width = `${Math.round(c.frac * 100)}%`;
      return card('.ra-code-live',
        head('Sign in a new app'),
        h('div.ra-code', null,
          h('div.ra-code-body', null,
            h('div.ra-s', null, "Type this on Claude's sign-in page now"),
            h('div.ra-code-v', null, code.display),
            h('div.ra-count-row', null, h('div.ra-bar', null, barFill), countEl)),
          h('button.btn.ra-btn.lg', { disabled: busy === 'code', onclick: () => void cancelCode() }, 'Cancel code')),
        foot('eye', 'Disappears as soon as Claude uses it or the 2 minutes run out. The tab goes back to "No code is active".'));
    }
    const on = !!status?.enabled;
    // A code made elsewhere (another window, before a reload) is live but never shown again.
    const other = on && status?.codeActiveUntil && Date.parse(status.codeActiveUntil) > now ? status.codeActiveUntil : null;
    return card('',
      head('Sign in a new app'),
      h('div.ra-code', null,
        h('div.ra-code-body', null,
          h('div.ra-idle-t', null, other ? `A code is active until ${hhmm(other)}` : 'No code is active'),
          h('div.ra-s', null, other
            ? 'It was made earlier and is not shown again. Cancel it, or make a new one (that kills the old one).'
            : on ? "Make one only when Claude's sign-in page asks for it. It shows here for 2 minutes, works once, then disappears."
              : 'Turn remote access on first.')),
        other ? h('button.btn.ra-btn.lg', { disabled: busy === 'code', onclick: () => void cancelCode() }, 'Cancel code') : null,
        h('button.btn.primary.ra-btn.lg', { disabled: !on || codeBusy, onclick: () => void newCode() }, icon('plus', 13, 2.2), codeBusy ? 'Making…' : 'New code')),
      foot('shield', '5 wrong codes in a minute lock sign-ins for 10 minutes. You get a notification if that happens.'));
  }

  function activityCard(): HTMLElement {
    const lines = activityLines(log);
    return card('',
      head('Activity', h('span.ra-head-r', null, `remote.log · last ${LOG_LIMIT}`)),
      h('div.ra-log', null,
        lines.length
          ? lines.map((l) => h('div.ra-log-l', null, h('span.ra-log-time', { title: l.title }, l.time), h('span.ra-log-x', { class: `t-${l.tone}` }, l.text)))
          : h('div.ra-log-empty', null, logErr || 'Nothing yet. Every call, sign-in and held message is logged here.')));
  }

  function errBanner(): HTMLElement | null {
    if (!statusErr) return null;
    return h('div.ph-banner', null,
      icon('alert', 16),
      h('div.ph-banner-body', null,
        h('div.ph-banner-t', null, 'Remote access status is not available'),
        h('div.ph-banner-s', null, statusErr)),
      h('button.btn.sm.secondary', { onclick: () => void load() }, 'Try again'));
  }

  function render(): void {
    // don't rebuild under the cursor while the public address is being typed
    if (editingHost && el.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT') return;
    setChildren(el,
      errBanner(),
      h('div.settings-cols', null,
        h('div.settings-col', null, connectionCard(), appsCard()),
        h('div.settings-col', null, mayDoCard(), signInCard(), activityCard())));
  }

  function banner(): HTMLElement | null {
    if (status?.hold?.on !== false) return null;
    const btn = h('button.btn.primary.ra-banner-btn', { disabled: busy === 'hold' }, 'Turn the hold back on') as HTMLButtonElement;
    btn.onclick = () => { btn.disabled = true; void setHold(true); };
    const n = status.hold.sentWithoutTap;
    return h('div.ra-banner', { role: 'alert' },
      icon('warning', 18),
      h('div.ra-banner-body', null,
        h('div.ra-banner-t', null, "The hold is off. Claude's messages reach the crew without your tap."),
        h('div.ra-banner-s', null, `A poisoned bulletin note can now get a reply sent.${n ? ` ${n} sent without your tap so far.` : ''} This banner stays on every Settings tab until you turn the hold back on.`)),
      btn);
  }

  function onVisibility(): void {
    if (document.visibilityState === 'visible' && visible) { tick(); void load(); }
  }

  render();
  return {
    el,
    banner,
    holdOff: () => status?.hold?.on === false,
    appsWaiting: () => waitingCount(status, apps),
    refresh: async () => { await loadStatus(); if (visible) render(); },
    show() {
      if (visible) return;
      visible = true;
      void load();
      clearInterval(tickTimer);
      clearInterval(pollTimer);
      tickTimer = window.setInterval(tick, 1000);
      pollTimer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, POLL_MS);
      document.addEventListener('visibilitychange', onVisibility);
    },
    hide() {
      visible = false;
      editingHost = false;
      clearInterval(tickTimer);
      clearInterval(pollTimer);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
