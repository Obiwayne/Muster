// Tiny DOM helpers: h() builds elements, icon() returns an inline SVG, plus menus,
// popovers, modals and toasts. No framework.
import logoSvg from './assets/logo-ember.svg?raw';

export type Child = Node | string | number | null | undefined | false | Child[];
type Handler = (ev: any) => void;
export interface Props {
  class?: string | false | null | (string | false | null | undefined)[];
  style?: string | Record<string, string | number | undefined>;
  [key: string]: unknown;
}

/** h('div.a.b', { onclick, title }, ...children) */
export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') {
        const extra = Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v);
        if (extra) el.className = el.className ? `${el.className} ${extra}` : extra;
      } else if (k === 'style') {
        if (typeof v === 'string') el.style.cssText = v;
        else for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
          if (sv !== undefined) el.style.setProperty(sk.startsWith('--') ? sk : sk.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()), String(sv));
        }
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as Handler);
      } else if (k === 'dataset') {
        Object.assign(el.dataset, v);
      } else if (k in el && k !== 'list' && typeof v !== 'string') {
        (el as any)[k] = v;
      } else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden') {
        (el as any)[k] = v;
      } else {
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

export function setChildren(el: Element, ...children: Child[]): void {
  const frag = document.createDocumentFragment();
  append(frag, children);
  // Snapshots arrive often; leave the DOM alone when the new content renders identically,
  // so lists don't flash, lose hover state or restart transitions.
  const next = Array.from(frag.childNodes);
  const prev = Array.from(el.childNodes);
  if (next.length === prev.length && next.every((n, i) => sameNode(n, prev[i]))) return;
  el.replaceChildren(frag);
}

function sameNode(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  return a instanceof Element ? a.outerHTML === (b as Element).outerHTML : a.textContent === b.textContent;
}

// ---- icons (paths from the design exports; stroke = currentColor) ----
const ICONS: Record<string, string> = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  tasks: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  branch: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="8" r="3"/><path d="M6 9v6M18 11c0 4-6 3-12 4"/>',
  pen: '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><circle cx="11" cy="11" r="2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 7 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 3.6 15a1.65 1.65 0 0 0-1.51-1H2a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 3.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  circle: '<circle cx="12" cy="12" r="9"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  terminal: '<path d="M4 17l6-6-6-6M12 19h8"/>',
  down: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  'chevron-right': '<path d="M9 6l6 6-6 6"/>',
  'chevron-left': '<path d="M15 6l-6 6 6 6"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  tick: '<path d="M5 12l5 5L20 7"/>',
  ticks: '<path d="M2 12l5 5L18 6"/><path d="M9 17l2 2L22 8"/>',
  reply: '<path d="M9 17l-5-5 5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01M15 9h.01"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  'search-plus': '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><path d="M11 8v6M8 11h6"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  external: '<path d="M7 17L17 7M9 7h8v8"/>',
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12l6-6"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  phone: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M9.9 4.2A10 10 0 0 1 12 4c6.4 0 10 8 10 8a17 17 0 0 1-2.2 3.2M6.6 6.6C3.9 8.3 2 12 2 12s3.6 8 10 8a9.7 9.7 0 0 0 5.4-1.6"/><path d="M14.1 14.1a3 3 0 0 1-4.2-4.2"/><path d="m2 2 20 20"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>',
  warning: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>',
};

export function icon(name: string, size = 16, strokeWidth = 2): SVGSVGElement {
  const t = document.createElement('template');
  if (name === 'more') {
    t.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="${size}" height="${size}"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>`;
  } else {
    t.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" width="${size}" height="${size}">${ICONS[name] ?? ''}</svg>`;
  }
  return t.content.firstElementChild as SVGSVGElement;
}

/** The Ember particle-swoosh mark (small version), `height` px tall; it is about twice as wide. */
export function logo(height = 22): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = logoSvg;
  const svg = t.content.firstElementChild as SVGSVGElement;
  svg.setAttribute('height', String(height));
  svg.setAttribute('width', String(Math.round(height * 2)));
  svg.style.flexShrink = '0';
  return svg;
}

// ---- floating layers (one menu/popover at a time) ----
let floating: { el: HTMLElement; close: () => void } | null = null;

export function closeFloating(): void {
  if (floating) {
    const f = floating;
    floating = null;
    f.close();
  }
}

function placeFloating(el: HTMLElement, x: number, y: number, align: 'left' | 'right' = 'left'): void {
  el.style.visibility = 'hidden';
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  let left = align === 'right' ? x - r.width : x;
  let top = y;
  left = Math.max(8, Math.min(left, window.innerWidth - r.width - 8));
  if (top + r.height > window.innerHeight - 8) top = Math.max(8, y - r.height - 8);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.visibility = '';
}

function openFloating(el: HTMLElement, x: number, y: number, align: 'left' | 'right'): () => void {
  closeFloating();
  placeFloating(el, x, y, align);
  const onDown = (e: MouseEvent) => { if (!el.contains(e.target as Node)) closeFloating(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeFloating(); };
  const close = () => {
    el.remove();
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', closeFloating);
    window.removeEventListener('hashchange', closeFloating);
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', closeFloating);
    window.addEventListener('hashchange', closeFloating);
  });
  floating = { el, close };
  return closeFloating;
}

export interface MenuItem {
  label: string;
  role?: string; // role colour dot
  current?: boolean;
  tone?: 'muted' | 'danger';
  disabled?: boolean;
  onClick: () => void;
}

export function showMenu(items: (MenuItem | 'sep')[], x: number, y: number, align: 'left' | 'right' = 'left'): void {
  const el = h('div.menu', { role: 'menu' },
    items.map((it) => it === 'sep'
      ? h('div.menu-sep')
      : h('button.menu-item', {
          class: [it.role && `r-${it.role}`, it.current && 'current', it.tone],
          disabled: it.disabled,
          onclick: () => { closeFloating(); it.onClick(); },
        },
        it.role ? h('span.dot') : h('span.pad'),
        h('span.flex1', { style: 'text-align:left' }, it.label),
        it.current ? h('span.check', null, icon('check', 14, 2.5)) : null,
      )),
  );
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  openFloating(el, x, y, align);
}

/** A popover anchored under an element. Returns a close function. */
export function showPopover(anchor: HTMLElement, content: HTMLElement, align: 'left' | 'right' = 'right'): () => void {
  const r = anchor.getBoundingClientRect();
  const el = h('div.popover', null, content);
  return openFloating(el, align === 'right' ? r.right : r.left, r.bottom + 8, align);
}

export interface ModalOpts {
  title: string | Node;
  body?: Child;
  wide?: boolean;
  actions?: { label: string; kind?: string; onClick: (close: () => void) => void | Promise<void>; disabled?: boolean }[];
  cancelLabel?: string | null;
  onClose?: () => void;
  /** Return false to keep the modal open (e.g. unsaved edits); call the `close` returned by showModal to force it. */
  beforeClose?: () => boolean;
}

export function showModal(opts: ModalOpts): () => void {
  closeFloating();
  let closed = false;
  const tryClose = () => { if (opts.beforeClose?.() !== false) close(); };
  const close = () => {
    if (closed) return;
    closed = true;
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('hashchange', close);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); tryClose(); } };
  const actions = opts.actions ?? [];
  const foot = (actions.length || opts.cancelLabel !== null)
    ? h('div.modal-foot', null,
        opts.cancelLabel !== null ? h('button.btn.lg', { onclick: tryClose }, opts.cancelLabel ?? 'Cancel') : null,
        actions.map((a) => {
          const b = h('button.btn.lg', { class: a.kind, disabled: a.disabled }, a.label) as HTMLButtonElement;
          b.onclick = async () => {
            b.disabled = true;
            try { await a.onClick(close); } finally { b.disabled = false; }
          };
          return b;
        }))
    : null;
  const modal = h('div.modal', { class: opts.wide && 'wide', role: 'dialog' },
    h('div.modal-head', null,
      h('div.modal-title', null, opts.title),
      h('button.icon-btn', { onclick: tryClose, title: 'Close' }, icon('x', 14)),
    ),
    opts.body !== undefined ? (opts.wide ? opts.body : h('div.modal-body', null, opts.body)) : null,
    foot,
  );
  const back = h('div.modal-back', { onmousedown: (e: MouseEvent) => { if (e.target === back) tryClose(); } }, modal);
  document.body.appendChild(back);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('hashchange', close);
  const first = modal.querySelector<HTMLElement>('input, textarea, select');
  first?.focus();
  return close;
}

export function confirmDialog(title: string, text: string, okLabel: string, kind = 'primary'): Promise<boolean> {
  return new Promise((resolve) => {
    let ok = false;
    showModal({
      title,
      body: h('p', null, text),
      actions: [{ label: okLabel, kind, onClick: (close) => { ok = true; close(); } }],
      onClose: () => resolve(ok),
    });
  });
}

export function promptDialog(title: string, text: string, okLabel: string, placeholder = '', optional = false): Promise<string | null> {
  return new Promise((resolve) => {
    let val: string | null = null;
    const input = h('textarea.field', { rows: 3, placeholder }) as HTMLTextAreaElement;
    showModal({
      title,
      body: [h('p', null, text), input],
      actions: [{ label: okLabel, kind: 'primary', onClick: (close) => { if (!optional && !input.value.trim()) return; val = input.value.trim(); close(); } }],
      onClose: () => resolve(val),
    });
  });
}

// ---- toasts ----
let toastHost: HTMLElement | null = null;
export function toast(text: string, level: 'info' | 'warn' | 'error' = 'info', ms = 4000): void {
  if (!toastHost) {
    toastHost = h('div.toasts');
    document.body.appendChild(toastHost);
  }
  const el = h('div.toast', { class: level }, h('span.dot'), h('div', null, text));
  toastHost.appendChild(el);
  while (toastHost.children.length > 5) toastHost.firstElementChild?.remove();
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  }, level === 'info' ? ms : ms + 3000);
}

export function toggle(on: boolean, onChange: (v: boolean) => void, small = false): HTMLElement {
  const el = h('button.toggle', { class: [on && 'on', small && 'sm'], role: 'switch', 'aria-checked': String(on) }, h('span.knob'));
  el.onclick = () => {
    const v = !el.classList.contains('on');
    el.classList.toggle('on', v);
    el.setAttribute('aria-checked', String(v));
    onChange(v);
  };
  return el;
}

export function select(options: { value: string; label: string }[], value: string, onChange: (v: string) => void): HTMLElement {
  const sel = h('select', { onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) },
    options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label))) as HTMLSelectElement;
  sel.value = value;
  return h('div.select-wrap', null, sel, icon('chevron', 12, 2.5));
}
