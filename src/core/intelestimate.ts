// Usage and time estimates for scout's work, shown in the New research and Add competitor modals. Pure and
// dependency-free so the dashboard can import it too. Rough by design: the 5-hour window share is what matters.
import type { IntelJobKind } from '../types.js';

export interface WorkEstimate {
  minutes: number; // wall-clock, rounded to 5
  usagePct: number; // share of the 5-hour window, rounded to 0.5
  checks: number; // intel checks included
  text: string; // "~20 min · ≈ 5% of 5-hour window (incl. 5 intel checks)"
}

/** Base cost of a research run without intel checks (the figures the modal showed before intel existed). */
export const RUN_BASE = { quick: { minutes: 10, usagePct: 3, ideas: 5 }, thorough: { minutes: 25, usagePct: 6, ideas: 9 } } as const;
/** One intel check of one idea against the tracked competitors (scout re-reads what the store holds, then a few pages). */
export const CHECK_COST = { minutes: 2, usagePct: 0.4 } as const;
/** First research of one competitor, per depth. */
export const COMPETITOR_COST = { quick: { minutes: 15, usagePct: 4 }, thorough: { minutes: 30, usagePct: 8 } } as const;

const r5 = (n: number) => Math.max(5, Math.round(n / 5) * 5);
const rHalf = (n: number) => Math.round(n * 2) / 2;

function finish(minutes: number, usagePct: number, checks: number): WorkEstimate {
  const m = r5(minutes);
  const u = rHalf(usagePct);
  return { minutes: m, usagePct: u, checks, text: `~${m} min · ≈ ${u}% of 5-hour window${checks ? ` (incl. ${checks} intel check${checks === 1 ? '' : 's'})` : ''}` };
}

/** A research run: with competitors tracked, every idea gets an intel check, so the estimate includes them. */
export function estimateResearch(depth: 'quick' | 'thorough', competitorsTracked: number): WorkEstimate {
  const base = RUN_BASE[depth];
  const checks = competitorsTracked > 0 ? base.ideas : 0;
  const scale = Math.max(1, Math.sqrt(competitorsTracked)); // more competitors → each check reads a little more
  return finish(base.minutes + checks * CHECK_COST.minutes * scale, base.usagePct + checks * CHECK_COST.usagePct * scale, checks);
}

/** An intel job: competitor research and sweeps scale with competitors; scout raises ~2 opportunities per competitor, each checked. */
export function estimateIntelJob(kind: IntelJobKind, depth: 'quick' | 'thorough', competitors: number): WorkEstimate {
  const n = Math.max(1, competitors);
  if (kind === 'check' || kind === 'recheck') return finish(CHECK_COST.minutes * Math.sqrt(n) + 3, CHECK_COST.usagePct * Math.sqrt(n) + 0.5, 1);
  const per = COMPETITOR_COST[depth];
  const share = kind === 'watch' ? 0.4 : 1; // a watch only looks for changes
  const checks = kind === 'watch' ? 0 : 2 * n;
  return finish(per.minutes * n * share + checks * CHECK_COST.minutes, per.usagePct * n * share + checks * CHECK_COST.usagePct, checks);
}
