// Intel → Opportunities (#/intel/opportunities). Stub from package C; package D builds the tab (5547-0):
// value-vs-effort matrix, gap list with roadmap status, open spaces, edges to protect, gap detail and the Captain rail.
import type { IntelStore, ResearchState } from '../../../src/types';
import { h, setChildren } from '../dom';
import type { Snapshot } from '../events';

export interface OpportunitiesCtx {
  intel: IntelStore;
  research: ResearchState;
  snapshot: Snapshot;
  /** Refetch the intel store and research state, then re-render. */
  refresh(): void;
}

export function renderOpportunities(host: HTMLElement, ctx: OpportunitiesCtx): void {
  const ideas = ctx.research.ideas.filter((i) => i.origin === 'intel').length;
  setChildren(host, h('div.it-empty', null,
    h('div.it-empty-t', null, 'Opportunities coming'),
    h('div.it-empty-s', null, ideas
      ? `${ideas} intel idea${ideas === 1 ? '' : 's'} so far. They are on Roadmap → Research until this tab lands.`
      : 'Gaps and open spaces scout raises will be listed here.')));
}
