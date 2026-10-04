// Settings → Phone: link an Android phone (QR + code), pick how it reaches this PC, list linked phones,
// choose what is sent. Talks to the orchestrator's /api/phone/* (forwarded to the phone gateway, docs/PHONE.md).
import '../phone.css';
import { confirmDialog, h, icon, setChildren, toast, toggle, type Child } from '../dom';
import { api, ApiError } from '../api';
import { errToast } from '../actions';
import {
  SEND_ROWS, deviceLine, expiryLine, manualHost, msLeft, networkRows, sendTarget, withNotify,
  type PhoneNetworkMode, type PhonePairCode, type PhoneSendPrefs, type PhoneStatus, maskAddress, shortFingerprint, shownDetail } from '../phonemodel';

const STATUS_POLL_MS = 4000;
const SHOW_ADDRESSES_KEY = 'muster.phone.showAddresses';

/**
 * Parses the gateway's QR code SVG as XML and returns a clean <svg> element: no scripts, no foreign content,
 * no event handlers or links. Never goes through innerHTML. Null when the text isn't an SVG document.
 */
export function qrElement(svgText: string, size = 188): SVGSVGElement | null {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.localName !== 'svg' || doc.getElementsByTagName('parsererror').length) return null;
  root.querySelectorAll('script, foreignObject, iframe, object, embed, a, use, image, style, animate, set').forEach((n) => n.remove());
  for (const n of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const a of Array.from(n.attributes)) {
      if (/^on/i.test(a.name) || /href$/i.test(a.name) || /^style$/i.test(a.name)) n.removeAttribute(a.name);
    }
  }
  const svg = document.importNode(root, true) as unknown as SVGSVGElement;
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  return svg;
}

export interface PhoneSection { el: HTMLElement; show(): void; hide(): void }

export function createPhoneSection(): PhoneSection {
  let status: PhoneStatus | null = null;
  // The PC's addresses stay hidden (e.g. on screen shares) until you press an eye; remembered in this browser.
  let showAddresses = (() => { try { return localStorage.getItem(SHOW_ADDRESSES_KEY) === '1'; } catch { return false; } })();
  // A span, not a button: it also sits inside the network option, which is a button itself.
  const eyeBtn = () => h('span.icon-btn.ph-eye', {
    role: 'button', tabindex: '0',
    onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); (e.currentTarget as HTMLElement).click(); } },
    title: showAddresses ? 'Hide addresses' : 'Show addresses', 'aria-pressed': String(showAddresses),
    onclick: (e: Event) => {
      e.stopPropagation();
      showAddresses = !showAddresses;
      try { localStorage.setItem(SHOW_ADDRESSES_KEY, showAddresses ? '1' : '0'); } catch { /* ignore */ }
      render();
    },
  }, icon(showAddresses ? 'eye-off' : 'eye', 13));
  let statusErr = '';
  let code: PhonePairCode | null = null;
  let codeErr = '';
  let qr: SVGSVGElement | null = null;
  let prefs: PhoneSendPrefs | null = null;
  let loadingCode = false;
  let starting = false;
  let visible = false;
  let pollTimer: number | undefined;
  let tickTimer: number | undefined;

  const el = h('div.ph');
  const expEl = h('div.ph-exp');

  const errText = (e: unknown) =>
    e instanceof ApiError && e.status === 404
      ? 'This Muster orchestrator has no phone routes yet. Restart it on the latest build.'
      : e instanceof Error ? e.message : String(e);

  async function loadStatus(): Promise<void> {
    try {
      const next = await api.phoneStatus();
      const before = status?.devices.map((d) => d.id) ?? null;
      status = next;
      statusErr = '';
      // A phone just linked with the current code: it is used up, so show a fresh one.
      const added = before ? next.devices.filter((d) => !before.includes(d.id)) : [];
      if (added.length) {
        toast(`Linked ${added.map((d) => d.name).join(', ')}`);
        void newCode();
      }
    } catch (e) {
      statusErr = errText(e);
    }
    render();
  }

  async function loadPrefs(): Promise<void> {
    try { prefs = await api.phoneSendPrefs(); render(); } catch { /* the status banner already says why */ }
  }

  async function newCode(): Promise<void> {
    if (loadingCode) return;
    loadingCode = true;
    render();
    try {
      code = await api.phonePairCode();
      qr = qrElement(code.qrSvg);
      codeErr = qr ? '' : 'The phone service sent a QR code this page cannot show. Type the code instead.';
    } catch (e) {
      code = null;
      qr = null;
      codeErr = errText(e);
    } finally {
      loadingCode = false;
      tick();
      render();
    }
  }

  /** Every second: the countdown text; a new code when this one ran out and you can see the page. */
  function tick(): void {
    if (!code) { expEl.textContent = loadingCode ? 'Getting a code…' : ''; return; }
    const line = expiryLine(code.expiresAt, Date.now());
    expEl.textContent = line.text;
    expEl.classList.toggle('expired', line.expired);
    if (line.expired && visible && document.visibilityState === 'visible' && !loadingCode && !statusErr) void newCode();
  }

  async function startService(): Promise<void> {
    starting = true;
    render();
    // Any /api/phone call makes the orchestrator start the gateway when it isn't running.
    await loadStatus();
    starting = false;
    if (!statusErr) {
      void loadPrefs();
      if (!code || msLeft(code.expiresAt, Date.now()) <= 0) void newCode();
      toast('Phone service is running');
    } else toast(statusErr, 'error');
    render();
  }

  async function setNetwork(mode: PhoneNetworkMode): Promise<void> {
    if (!status || status.network.mode === mode) return;
    const prev = status.network.mode;
    status = { ...status, network: { ...status.network, mode } };
    render();
    try {
      await api.phoneSetNetwork(mode);
      await loadStatus();
      void newCode(); // the QR code carries the addresses, which depend on the mode
    } catch (e) {
      if (status) status = { ...status, network: { ...status.network, mode: prev } };
      errToast(e);
      render();
    }
  }

  async function unlink(id: string, name: string): Promise<void> {
    if (!(await confirmDialog(`Unlink ${name}?`, 'Its key stops working at once. To use Muster on it again, scan a new code.', 'Unlink', 'danger'))) return;
    try {
      await api.phoneUnlink(id);
      toast(`Unlinked ${name}`);
    } catch (e) { errToast(e); }
    await loadStatus();
  }

  async function setNotify(key: (typeof SEND_ROWS)[number]['key'], on: boolean): Promise<void> {
    const next = withNotify(prefs, key, on);
    try {
      prefs = await api.phoneSetSendPrefs(next) ?? next;
      toast('Saved');
    } catch (e) { errToast(e); }
    render();
  }

  async function sendTest(btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    try {
      const r = await api.phoneTest() as { sent?: number } | null;
      const n = typeof r?.sent === 'number' ? r.sent : status?.devices.filter((d) => d.online).length;
      toast(n === 0 ? 'No linked phone is connected right now. It gets the test when it next connects.' : 'Test notification sent. Check your phone.');
    } catch (e) { errToast(e); }
    btn.disabled = false;
  }

  // ---------------------------------------------------------------- view
  const card = (label: string, ...rows: Child[]) => h('div.panel', null, h('div.section-label.panel-label', null, label), rows);

  function linkCard(): HTMLElement {
    const host = manualHost(status);
    const qrBox = h('div.ph-qr', { class: !qr && 'empty' },
      qr ?? h('div.ph-qr-msg', null, loadingCode ? 'Getting a code…' : statusErr ? 'Start the phone service to get a code' : codeErr || 'No code yet'));
    const steps = ['Install Muster on your Android phone', 'Open it and tap Scan', 'Point it at this code'];
    const newBtn = h('button.btn.sm.ph-new', { disabled: loadingCode || !!statusErr, onclick: () => void newCode() }, icon('refresh', 12), 'New code');
    return card('Link a phone',
      h('div.ph-link', null,
        qrBox,
        h('div.ph-link-side', null,
          h('div.ph-code-block', null,
            h('div.ph-hint', null, "Can't scan? Type this code instead"),
            h('div.ph-code-row', null,
              h('div.ph-code', null, code?.display ?? '———'),
              host ? h('div.ph-host', { title: 'Type this address on the phone too' }, h('span.ph-host-l', null, 'PC address'), h('span.ph-host-v', null, showAddresses ? host : maskAddress(host), eyeBtn()),
                shortFingerprint(status?.fingerprint) ? h('span.ph-host-l', { title: 'The phone shows these characters when you type the code: they must match' }, `check ${shortFingerprint(status?.fingerprint)}`) : null) : null),
            h('div.ph-exp-row', null, expEl, newBtn)),
          h('div.ph-steps', null, steps.map((t, i) => h('div.ph-step', null, h('span.ph-num', null, String(i + 1)), h('span', null, t)))))));
  }

  function linkedCard(): HTMLElement {
    const devices = status?.devices ?? [];
    const now = Date.now();
    if (!status) return card('Linked phones', h('div.ph-net-none', null, statusErr ? 'Unknown until the phone service runs.' : 'Loading…'));
    return card(`Linked phones · ${devices.length}`,
      devices.length
        ? devices.map((d) => h('div.ph-dev', null,
            h('div.ph-dev-ic', null, icon('phone', 16), h('span.ph-online', { class: d.online && 'on', title: d.online ? 'Connected now' : 'Not connected' })),
            h('div.ph-dev-body', null,
              h('div.ph-dev-t', null, d.name),
              h('div.ph-dev-s', null, deviceLine(d, now))),
            h('button.ph-unlink', { onclick: () => void unlink(d.id, d.name) }, 'Unlink')))
        : h('div.ph-empty', null,
            h('div.ph-empty-t', null, 'No phone linked yet'),
            h('div.ph-empty-s', null, 'Scan the code above with the Muster app to link your first phone.')),
      h('div.ph-foot', null, devices.length
        ? 'Scan the code above to link another phone. Unlinking revokes its key at once.'
        : 'Each phone gets its own key. You can unlink it here any time.'));
  }

  function networkCard(): HTMLElement {
    const rows = status ? networkRows(status) : [];
    return card('How your phone reaches this PC',
      rows.map((r) => h('button.ph-net', {
          class: [r.selected && 'on', r.disabled && 'disabled'],
          role: 'radio', 'aria-checked': String(r.selected), disabled: r.disabled,
          onclick: () => void setNetwork(r.mode),
        },
        h('span.ph-radio', null, r.selected ? h('span.ph-radio-dot') : null),
        h('span.ph-net-body', null,
          h('span.ph-net-t', null, r.title),
          h('span.ph-net-s', null, r.sub)),
        h('span.ph-net-d', null,
          r.dot ? h('span.ph-ndot', { class: r.dot }) : null,
          h('span.ph-net-dt', { class: r.link && 'faint' }, shownDetail(r, showAddresses)),
          r.secret ? eyeBtn() : null,
          r.link ? h('a.ph-net-link', { href: r.link.href, target: '_blank', rel: 'noopener noreferrer', onclick: (e: Event) => e.stopPropagation() }, r.link.text) : null))),
      status ? null : h('div.ph-net-none', null, statusErr ? 'Unknown until the phone service runs.' : 'Loading…'),
      h('div.ph-foot.ph-shield', null, icon('shield', 13), h('span', null, 'Muster only listens to linked phones. Each phone has its own key you can revoke.')));
  }

  function sendCard(): HTMLElement {
    const notify = prefs?.notify;
    const devices = status?.devices ?? [];
    const testBtn = h('button.btn.sm.ph-test', { disabled: !devices.length || !!statusErr, title: devices.length ? '' : 'Link a phone first' },
      icon('bell', 13), 'Send test notification') as HTMLButtonElement;
    testBtn.onclick = () => void sendTest(testBtn);
    return card('Send to phone',
      SEND_ROWS.map((r) => h('div.srow', null,
        h('div.lbl', null, h('div.t', null, r.title), h('div.s', null, r.sub)),
        notify ? toggle(!!notify[r.key], (v) => void setNotify(r.key, v)) : h('span.faint', { style: 'font-size:12px' }, '—'))),
      h('div.srow.ph-test-row', null, h('div.ph-target', null, sendTarget(devices)), testBtn));
  }

  function banner(): HTMLElement | null {
    if (!statusErr) return null;
    return h('div.ph-banner', null,
      icon('alert', 16),
      h('div.ph-banner-body', null,
        h('div.ph-banner-t', null, 'The phone service is not running'),
        h('div.ph-banner-s', null, statusErr)),
      h('button.btn.sm.secondary', { disabled: starting, onclick: () => void startService() }, starting ? 'Starting…' : 'Start phone service'));
  }

  function render(): void {
    setChildren(el,
      banner(),
      h('div.settings-cols', null,
        h('div.settings-col', null, linkCard(), linkedCard()),
        h('div.settings-col', null, networkCard(), sendCard())));
  }

  function onVisibility(): void { if (document.visibilityState === 'visible') tick(); }

  render();
  return {
    el,
    show() {
      if (visible) return;
      visible = true;
      void loadStatus().then(() => { if (!statusErr && (!code || msLeft(code.expiresAt, Date.now()) <= 0)) void newCode(); });
      void loadPrefs();
      clearInterval(tickTimer);
      clearInterval(pollTimer);
      tickTimer = window.setInterval(tick, 1000);
      pollTimer = window.setInterval(() => { if (document.visibilityState === 'visible') void loadStatus(); }, STATUS_POLL_MS);
      document.addEventListener('visibilitychange', onVisibility);
    },
    hide() {
      visible = false;
      clearInterval(tickTimer);
      clearInterval(pollTimer);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
