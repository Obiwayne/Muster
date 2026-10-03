// Shared bits for the Intel tabs: the tab context, label dots, claim meta lines, source lists, captions, empty states.
import type { IntelClaim, IntelLabel, IntelSource, IntelStore, ResearchState } from '../../../src/types';
import { h, type Child } from '../dom';
import { appendTo, details, type DetailsOpts } from './expand';
import type { Snapshot } from '../events';
import { LABEL_TEXT, claimMeta, labelDotClass, sourceLine } from '../intelmodel';
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

/** Signals, timeframe and what would change a prediction. */
export function predictionBlock(p: NonNullable<IntelClaim['prediction']>): HTMLElement {
  return h('div.it-pred', null,
    h('div', null, h('span.faint', null, 'Signals: '), p.signals.join(' · ')),
    h('div', null, h('span.faint', null, 'Timeframe: '), p.timeframe),
    h('div', null, h('span.faint', null, 'Would change it: '), p.wouldChange));
}

/**
 * "● Fact · high confidence · 3 sources · 2 Oct 2026" as a button that opens the claim's sources inline, at the bottom
 * of the card it sits in, with `title` as their heading. Put `line` in the card's foot and `panel` (set when it is open
 * on this render) last in the card.
 */
// No heading: the claim line sits inside the card whose title it would repeat.
export function claimLine(claim: IntelClaim, _title: string, key: string, opts: { group?: string; omit?: DetailsOpts['omit'] } = {}): { line: HTMLElement; panel: HTMLElement | null } {
  const line = h('button.it-claim', null, labelDot(claim.label), h('span', null, claimMeta(claim)));
  const panel = details(line, { group: opts.group ?? 'claim', key, sources: claim.sources, claim, omit: opts.omit, cls: 'xp-card', place: appendTo('.it-card, .it-theme, .it-panel') });
  return { line, panel };
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
