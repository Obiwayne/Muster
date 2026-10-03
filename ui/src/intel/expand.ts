// Inline details for Intel rows: clicking a row (or a matrix cell, quote, claim line, intel check row) opens its label,
// "for us", prediction and sources inside the list, directly under it, pushing the rows below down. Click it again or
// press Esc to close; opening another row in the same list closes the previous one.
import type { IntelClaim, IntelSource } from '../../../src/types';
import { h } from '../dom';
import { LABEL_TEXT, fmtDate, safeHref } from '../intelmodel';
import { labelDot, predictionBlock } from './common';
import { ExpandState } from './expandstate';
import './expand.css';

export const expandState = new ExpandState();

export interface DetailsOpts {
  /** The list: one open row per group. */
  group: string;
  /** The row: a claim/source id, stable across re-renders. */
  key: string;
  sources: IntelSource[];
  claim?: IntelClaim;
  /** Context heading, only when the clicked element isn't the row whose text says what this is (a matrix cell, a quote…). */
  heading?: string;
  /** Left accent colour (CSS), matching the row's own accent. */
  accent?: string;
  /** Parts the row already shows, left out of the details. */
  omit?: ('implication' | 'prediction')[];
  /** Variant class: "xp-attach" (hangs off a bordered row), "xp-wide" (under a matrix row), "xp-card" (last in a card), "xp-loose" (no inset). */
  cls?: string;
  /**
   * Where a click puts the details block (default: straight after the anchor). Callers put the block `details()` returns
   * (when the row is already open on render) at the same spot.
   */
  place?: (anchor: HTMLElement, panel: HTMLElement) => void;
}

const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Make `anchor` (a button) toggle its details. Returns the details block when the row is open right now (a re-render
 * while open), for the caller to put where `place` would; null otherwise.
 */
export function details(anchor: HTMLElement, o: DetailsOpts): HTMLElement | null {
  const open = expandState.isOpen(o.group, o.key);
  anchor.dataset.xpGroup = o.group;
  anchor.dataset.xpKey = o.key;
  anchor.setAttribute('aria-expanded', String(open));
  anchor.classList.toggle('xp-open', open);
  if (anchor.title === 'Show sources' || anchor.title === 'Open the source') anchor.removeAttribute('title');
  anchor.addEventListener('click', (e) => { e.stopPropagation(); toggleDetails(anchor, o); });
  anchor.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && expandState.isOpen(o.group, o.key)) { e.stopPropagation(); toggleDetails(anchor, o); }
  });
  return open ? detailsBlock(anchor, o, true) : null;
}

/** Open or close `anchor`'s details (closing any other open row in its group). */
export function toggleDetails(anchor: HTMLElement, o: DetailsOpts): void {
  const nowOpen = expandState.toggle(o.group, o.key);
  const doc = anchor.ownerDocument;
  doc.querySelectorAll<HTMLElement>('.xp').forEach((p) => { if (p.dataset.xpGroup === o.group && !p.classList.contains('closing')) closeBlock(p); });
  doc.querySelectorAll<HTMLElement>('.xp-open').forEach((a) => {
    if (a.dataset.xpGroup === o.group) { a.classList.remove('xp-open'); a.setAttribute('aria-expanded', 'false'); }
  });
  if (!nowOpen) return;
  const panel = detailsBlock(anchor, o, false);
  (o.place ?? ((a, p) => a.after(p)))(anchor, panel);
  anchor.classList.add('xp-open');
  anchor.setAttribute('aria-expanded', 'true');
  void panel.offsetHeight; // start the open transition from collapsed
  panel.classList.add('shown');
}

function closeBlock(p: HTMLElement): void {
  if (reducedMotion() || !p.isConnected) { p.remove(); return; }
  p.classList.add('closing');
  p.classList.remove('shown');
  const done = () => p.remove();
  p.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 260);
}

let seq = 0;

function detailsBlock(anchor: HTMLElement, o: DetailsOpts, shown: boolean): HTMLElement {
  const c = o.claim;
  const omit = o.omit ?? [];
  const id = `xp-${++seq}`;
  anchor.setAttribute('aria-controls', id);
  const panel = h('div.xp', { id, class: [shown && 'shown', o.cls], role: 'region', 'aria-label': o.heading ?? 'Details', style: o.accent ? { '--xp-accent': o.accent } : undefined },
    h('div.xp-clip', null,
      h('div.xp-body', null,
        o.heading ? h('div.xp-h', null, o.heading) : null,
        c ? h('div.xp-meta', null, labelDot(c.label), [LABEL_TEXT[c.label], `${c.confidence} confidence`, fmtDate(c.asOf)].filter(Boolean).join(' · ')) : null,
        c?.implication && !omit.includes('implication') ? h('div.xp-impl', null, h('span.faint', null, 'For us: '), c.implication) : null,
        c?.prediction && !omit.includes('prediction') ? predictionBlock(c.prediction) : null,
        o.sources.length
          ? h('div.xp-srcs', null,
              h('div.xp-srcs-h', null, `SOURCES · ${o.sources.length}`),
              o.sources.map((s) => sourceItem(s)))
          : h('div.xp-srcs', null, h('div.xp-srcs-h', null, 'NO SOURCES RECORDED')))));
  panel.dataset.xpGroup = o.group;
  panel.dataset.xpKey = o.key;
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && expandState.isOpen(o.group, o.key)) { e.stopPropagation(); toggleDetails(anchor, o); anchor.focus(); }
  });
  panel.addEventListener('click', (e) => e.stopPropagation());
  return panel;
}

function sourceItem(s: IntelSource): HTMLElement {
  const href = safeHref(s.url);
  const meta = [s.publishedAt ? `published ${fmtDate(s.publishedAt)}` : '', `read ${fmtDate(s.seenAt)}`, s.via && s.via !== 'public' ? 'signed in' : ''].filter(Boolean).join(' · ');
  return h('div.xp-src', null,
    href
      ? h('a.xp-src-t', { href, target: '_blank', rel: 'noreferrer', title: href }, h('span.xp-arrow', null, '↗'), h('span', null, s.title))
      : h('span.xp-src-t', null, h('span.xp-arrow', null, '·'), h('span', null, s.title)),
    h('span.xp-src-m', null, meta));
}

/** Place the details block as the last child of the anchor's closest `selector` (cards). */
export function appendTo(selector: string): (anchor: HTMLElement, panel: HTMLElement) => void {
  return (a, p) => { (a.closest<HTMLElement>(selector) ?? a.parentElement ?? a).append(p); };
}

/** Place the details block straight after the anchor's closest `selector` (the matrix row of a cell). */
export function after(selector: string): (anchor: HTMLElement, panel: HTMLElement) => void {
  return (a, p) => { (a.closest<HTMLElement>(selector) ?? a).after(p); };
}
