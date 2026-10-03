// Which renderer draws which Intel tab. Opportunities belongs to package D (pages/intelgaps.ts).
import type { IntelTab } from '../intelmodel';
import { renderOpportunities } from '../pages/intelgaps';
import type { IntelCtx } from './common';
import { emptyState } from './common';
import { TAB_LABELS } from '../intelmodel';
import { setChildren } from '../dom';

export type TabRenderer = (host: HTMLElement, ctx: IntelCtx) => void;

const placeholder = (t: IntelTab): TabRenderer => (host) =>
  setChildren(host, emptyState(TAB_LABELS[t], 'This tab is being built.'));

export const TAB_RENDERERS: Record<IntelTab, TabRenderer> = {
  overview: placeholder('overview'),
  features: placeholder('features'),
  roadmaps: placeholder('roadmaps'),
  reviews: placeholder('reviews'),
  opportunities: (host, ctx) => renderOpportunities(host, { intel: ctx.intel, research: ctx.research, snapshot: ctx.snapshot, refresh: ctx.refresh }),
  audience: placeholder('audience'),
  pricing: placeholder('pricing'),
  marketing: placeholder('marketing'),
  team: placeholder('team'),
  ai: placeholder('ai'),
  financials: placeholder('financials'),
  changes: placeholder('changes'),
};
