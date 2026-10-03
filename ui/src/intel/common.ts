// Shared bits for the Intel tabs: the tab context, label dots, claim meta lines, source lists, captions, empty states.
import type { IntelClaim, IntelLabel, IntelSource, IntelStore, ResearchState } from '../../../src/types';
import { h, showPopover, type Child } from '../dom';
import type { Snapshot } from '../events';
import { LABEL_TEXT, claimMeta, labelDotClass, safeHref, sourceLine } from '../intelmodel';
import type { IntelTab } from '../intelmodel';

export interface IntelCtx {
  intel: IntelStore;
  research: ResearchState;
  snapshot: Snapshot;
  /** Refetch the intel store and re-render. */
  refresh(): void;
  /** Switch tab (#/intel/<tab>). */
  go(tab: IntelTab): void;
  /** Open the Add competitor modal. */
  addCompetitor(): void;
}

/** The Fact / Opinion / Prediction dot. */
export function labelDot(label: IntelLabel, size: 'sm' | 'md' = 'sm'): HTMLElement {
  return h('span.it-ld', { class: [labelDotClass(label), size], title: LABEL_TEXT[label] });
}

/** A source list popover anchored on `anchor`. */
export function openSources(anchor: HTMLElement, title: string, sources: IntelSource[], claim?: IntelClaim): void {
  showPopover(anchor, h('div.it-pop', null,
    h('div.it-pop-t', null, title),
    claim ? h('div.it-pop-meta', null, labelDot(claim.label), claimMeta(claim)) : null,
    claim?.implication ? h('div.it-pop-impl', null, h('span.faint', null, 'For us: '), claim.implication) : null,
    claim?.prediction ? predictionBlock(claim.prediction) : null,
    h('div.it-pop-list', null, sources.map((s) => {
      const href = safeHref(s.url);
      return h('div.it-pop-src', null,
        href ? h('a', { href, target: '_blank', rel: 'noreferrer' }, s.title) : h('span', null, s.title),
        h('span.faint', null, [s.publishedAt ? `published ${s.publishedAt}` : '', `read ${s.seenAt}`, s.via && s.via !== 'public' ? 'signed in' : ''].filter(Boolean).join(' · ')));
    }))), 'left');
}

/** Signals, timeframe and what would change a prediction. */
export function predictionBlock(p: NonNullable<IntelClaim['prediction']>): HTMLElement {
  return h('div.it-pred', null,
    h('div', null, h('span.faint', null, 'Signals: '), p.signals.join(' · ')),
    h('div', null, h('span.faint', null, 'Timeframe: '), p.timeframe),
    h('div', null, h('span.faint', null, 'Would change it: '), p.wouldChange));
}

/** "● Fact · high confidence · 3 sources · 2 Oct 2026" as a clickable line that lists the sources. */
export function claimLine(claim: IntelClaim, title = 'Sources'): HTMLElement {
  const el = h('button.it-claim', { title: 'Show sources' }, labelDot(claim.label), h('span', null, claimMeta(claim)));
  el.onclick = (e: MouseEvent) => { e.stopPropagation(); openSources(el, title, claim.sources, claim); };
  return el;
}

/** The first source as text ("App Store · Padlet · 2★ · 14 Sep 2026"). */
export function firstSource(sources: IntelSource[]): string {
  const s = sources[0];
  if (!s) return '';
  return `${sourceLine(s)}${sources.length > 1 ? ` · +${sources.length - 1}` : ''}`;
}

export function caption(...parts: Child[]): HTMLElement {
  return h('div.it-caption', null, ...parts);
}

export function emptyState(title: string, text: string, action?: { label: string; onClick: () => void }): HTMLElement {
  return h('div.it-empty', null,
    h('div.it-empty-t', null, title),
    h('div.it-empty-s', null, text),
    action ? h('button.btn.sm.secondary', { onclick: action.onClick }, action.label) : null);
}

export function sectionHead(title: string, sub?: Child, ...right: Child[]): HTMLElement {
  return h('div.it-sec-head', null,
    h('div.it-sec-titles', null, h('div.it-sec-t', null, title), sub ? h('div.it-sec-s', null, sub) : null),
    ...right);
}

/** A segmented filter ("All · Gaps 3 · …"). */
export function segmented<T extends string>(options: { value: T; label: Child; dot?: string }[], value: T, onPick: (v: T) => void, size: 'sm' | 'md' = 'sm'): HTMLElement {
  return h('div.it-seg', { class: size }, options.map((o) =>
    h('button', { class: o.value === value && 'on', onclick: () => onPick(o.value) },
      o.dot ? h('span.it-seg-dot', { style: { background: o.dot } }) : null, o.label)));
}
