// Which renderer draws which Intel tab. Opportunities belongs to package D (pages/intelgaps.ts).
import type { IntelTab } from '../intelmodel';
import { renderOpportunities } from '../pages/intelgaps';
import type { IntelCtx } from './common';
import { renderOverview } from './overview';
import { renderReviews } from './reviews';
import { renderAi, renderAudience, renderChanges, renderFeatures, renderFinancials, renderMarketing, renderPricing, renderRoadmaps, renderTeam } from './areas';

export type TabRenderer = (host: HTMLElement, ctx: IntelCtx) => void;

export const TAB_RENDERERS: Record<IntelTab, TabRenderer> = {
  overview: renderOverview,
  features: renderFeatures,
  roadmaps: renderRoadmaps,
  reviews: renderReviews,
  opportunities: (host, ctx) => renderOpportunities(host, { intel: ctx.intel, research: ctx.research, snapshot: ctx.snapshot, refresh: ctx.refresh }),
  audience: renderAudience,
  pricing: renderPricing,
  marketing: renderMarketing,
  team: renderTeam,
  ai: renderAi,
  financials: renderFinancials,
  changes: renderChanges,
};
