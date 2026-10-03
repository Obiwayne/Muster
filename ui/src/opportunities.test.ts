import { describe, expect, it } from 'vitest';
import type { IntelCapability, IntelCompetitor, IntelOpportunity, IntelPlan, ResearchIdea } from '../../src/types';
import {
  atRiskOf, detailKicker, detailRows, evidenceLines, groupOpportunities, matrixPoints, priorityOf, quadrant, scores, selectable,
} from './opportunities';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const comp = (id: string, extra: Partial<IntelCompetitor> = {}): IntelCompetitor => ({
  id, name: id[0].toUpperCase() + id.slice(1), url: `https://${id}.com`, colour: 0, sources: [], areas: [], watch: 'off', browse: 'profile', addedAt: '2026-09-01', ...extra,
});
const competitors = [comp('us', { isUs: true }), comp('padlet'), comp('wakelet'), comp('linoit')];
const claim = { label: 'opinion' as const, confidence: 'medium' as const, sources: [{ kind: 'app_store' as const, title: 'App Store · Padlet · 2★', url: 'https://apps.apple.com/x', publishedAt: '2026-09-14', seenAt: '2026-10-02' }], asOf: '2026-10-02' };
const opp = (kind: IntelOpportunity['kind'], extra: Partial<IntelOpportunity> = {}): IntelOpportunity => ({
  kind, capabilityIds: [], problem: '', alternatives: '', proposal: '', value: '', effortNote: '', priority: 'next', validation: '', valueScore: 3, effortScore: 3, claim, ...extra,
});
const idea = (id: string, extra: Partial<ResearchIdea> = {}): ResearchIdea => ({
  id, runId: 'IJ1', title: `Idea ${id}`, summary: `Summary ${id}`, impact: 'medium', effort: 'M', evidence: [], status: 'new', thread: [], createdAt: '2026-10-02', ...extra,
});
const cap = (id: string, extra: Partial<IntelCapability> = {}): IntelCapability => ({ id, name: `Cap ${id}`, cells: {}, verdict: 'gap', verdictVs: [], updatedAt: '2026-10-01', ...extra });
const plan = (extra: Partial<IntelPlan>): IntelPlan => ({ ...claim, label: 'fact', id: 'PL1', competitorId: 'wakelet', title: 'Post approval', kind: 'commitment', status: 'in_progress', capabilityIds: [], ...extra });
const roadmap = { goals: [{ id: 'G14', stageId: 'M5', title: 'PDF', status: 'planned' as const }] } as never;

describe('groupOpportunities', () => {
  const store = {
    competitors,
    checks: [],
    plans: [plan({ capabilityIds: ['F1'] })],
    capabilities: [
      cap('F1', { name: 'Approve posts before live', verdict: 'edge', verdictVs: ['padlet', 'wakelet', 'linoit'], verdictStage: 'M3', ideaId: 'R7' }),
      cap('F2', { name: 'Classroom sync', verdict: 'gap', verdictVs: ['padlet', 'wakelet'], ideaId: 'R10' }),
      cap('F4', { name: 'Unlimited free walls', verdict: 'edge', verdictVs: ['padlet'], cells: { padlet: { ...claim, label: 'fact', status: 'paid', note: '3 walls' } } }),
      cap('F6', { name: 'AI flags', verdict: 'open', ideaId: 'R13' }),
      cap('F9', { name: 'Nobody has it', verdict: 'open' }),
      cap('F8', { name: 'Everyone has it', verdict: 'parity' }),
      cap('F3', { name: 'LMS sync', verdict: 'gap', verdictVs: ['padlet'] }), // live run: a gap nobody raised an idea for
    ],
  };
  const ideas = [
    idea('R7', { origin: 'research' }), // linked to an edge row
    idea('R9'), // research idea, not linked: not an opportunity
    idea('R10'), // research idea linked to a gap row
    idea('R8', { origin: 'intel', status: 'approved', goalId: 'G14', opportunity: opp('gap') }),
    idea('R12', { origin: 'intel', opportunity: opp('gap', { testFirst: true, priority: 'later' }) }),
    idea('R13', { origin: 'intel', opportunity: opp('open', { capabilityIds: ['F6'] }) }),
    idea('R14', { origin: 'intel', opportunity: opp('gap', { priority: 'now', valueScore: 4, effortScore: 2 }) }),
    idea('R16', { origin: 'intel', opportunity: opp('gap', { priority: 'parked' }) }),
    idea('R18', { origin: 'intel', status: 'rejected', opportunity: opp('gap') }),
  ];
  const g = groupOpportunities(ideas, store, roadmap);

  it('puts each idea in its list by opportunity kind or matrix verdict, skipping rejected and unlinked research ideas', () => {
    expect(g.gaps.map((i) => i.id)).toEqual(['R14', 'R8', 'R10', 'R12', 'R16', 'F3']);
    expect(g.open.map((i) => i.id)).toEqual(['R13', 'F9']);
    expect(g.edges.map((i) => i.id)).toEqual(['R7', 'F4']);
  });

  it('orders gaps by priority, then value', () => {
    expect(g.gaps.map((i) => i.priority)).toEqual(['now', 'next', 'next', 'later', 'parked', 'next']);
  });

  it('gives gaps their roadmap status', () => {
    const st = Object.fromEntries(g.gaps.map((i) => [i.id, i.status?.text]));
    expect(st).toEqual({ R14: 'Not yet', R8: 'On M5', R10: 'Not yet', R12: 'Test first', R16: 'Parked', F3: 'No idea yet' });
  });

  it('flags edges at risk from a competitor commitment, and notes the rest', () => {
    expect(g.edges[0]).toMatchObject({ id: 'R7', atRisk: 'Wakelet building it', note: 'Wakelet building it' });
    expect(g.edges[1]).toMatchObject({ id: 'F4', note: 'Padlet: 3 walls' });
    expect(g.edges[1].atRisk).toBeUndefined();
    expect(g.open.find((i) => i.id === 'F9')?.note).toBe('0 of 3');
  });

  it('only ideas are selectable, gaps first', () => {
    expect(selectable(g).map((i) => i.id)).toEqual(['R14', 'R8', 'R10', 'R12', 'R16', 'R13', 'R7']);
  });

  it('matrix points: gaps and open ideas, selected one labelled with its id', () => {
    const pts = matrixPoints(g, 'R14');
    expect(pts.map((p) => p.item.id)).toEqual(['R14', 'R8', 'R10', 'R12', 'R16', 'R13']);
    const r14 = pts[0];
    expect(r14).toMatchObject({ label: 'R14', tone: 'sel' });
    expect(r14.x).toBeLessThan(0.5); // low effort
    expect(r14.y).toBeLessThan(0.5); // high value
    expect(pts.find((p) => p.item.id === 'R8')?.tone).toBe('on');
    expect(pts.find((p) => p.item.id === 'R16')?.tone).toBe('parked');
    expect(pts.find((p) => p.item.id === 'R10')?.label).toBe('10');
    // R10 and R12 share value 3 / effort 3: fanned apart
    const a = pts.find((p) => p.item.id === 'R10')!;
    const b = pts.find((p) => p.item.id === 'R12')!;
    expect(a.x !== b.x || a.y !== b.y).toBe(true);
  });
});

describe('scores, priority, quadrant, risk', () => {
  it('scores from the opportunity, else from impact and S/M/L', () => {
    expect(scores(idea('R1', { opportunity: opp('gap', { valueScore: 5, effortScore: 1 }) }))).toEqual({ value: 5, effort: 1 });
    expect(scores(idea('R1', { impact: 'high', effort: 'S' }))).toEqual({ value: 4, effort: 2 });
    expect(scores(idea('R1', { impact: 'low', effort: 'L' }))).toEqual({ value: 2, effort: 4 });
  });
  it('priority', () => {
    expect(priorityOf(idea('R1'))).toBe('next');
    expect(priorityOf(idea('R1', { status: 'approved' }))).toBe('now');
    expect(priorityOf(idea('R1', { opportunity: opp('gap', { priority: 'parked' }) }))).toBe('parked');
  });
  it('quadrant', () => {
    expect(quadrant(4, 2)).toBe('quick_win');
    expect(quadrant(4, 4)).toBe('big_bet');
    expect(quadrant(2, 2)).toBe('fill_in');
    expect(quadrant(2, 5)).toBe('money_pit');
  });
  it('at risk: commitments and medium+ predictions count; shipped or low ones do not', () => {
    const s = (p: IntelPlan) => ({ plans: [p], competitors });
    expect(atRiskOf([{ id: 'F1' }], s(plan({ capabilityIds: ['F1'], status: 'shipped' })))).toBeUndefined();
    expect(atRiskOf([{ id: 'F1' }], s(plan({ capabilityIds: ['F1'], kind: 'prediction', label: 'prediction', confidence: 'medium', competitorId: 'padlet' })))).toBe('Padlet likely building it');
    expect(atRiskOf([{ id: 'F1' }], s(plan({ capabilityIds: ['F1'], kind: 'prediction', label: 'prediction', confidence: 'low' })))).toBeUndefined();
    expect(atRiskOf([], s(plan({})), { atRisk: 'Linoit copying it' })).toBe('Linoit copying it');
  });
});

describe('gap detail', () => {
  it('rows in design order, skipping empty fields, effort split into main + dependency', () => {
    const rows = detailRows(idea('R1', { opportunity: opp('gap', { problem: 'P', alternatives: 'A', proposal: 'Pr', value: 'V', effortNote: 'Medium · ~5 tasks · needs Google OAuth review', priority: 'now', validation: 'Val' }) }));
    expect(rows.map((r) => r.label)).toEqual(['Customer problem', 'Evidence', 'Today they…', 'Proposed', 'Value', 'Effort', 'Priority', 'Validate by']);
    expect(rows.find((r) => r.key === 'effort')).toMatchObject({ text: 'Medium · ~5 tasks', sub: 'needs Google OAuth review' });
  });
  it('falls back to the summary for a research idea', () => {
    const rows = detailRows(idea('R10', { summary: 'Teachers re-type class lists.', effort: 'M' }));
    expect(rows.map((r) => [r.label, r.text])).toEqual([['Customer problem', 'Teachers re-type class lists.'], ['Evidence', undefined], ['Effort', 'Medium']]);
  });
  it('evidence lines carry label, source and date', () => {
    const lines = evidenceLines(idea('R1', {
      opportunity: opp('gap'),
      evidence: [{ kind: 'competitor', source: 'Wakelet roadmap', url: 'https://wakelet.com/roadmap' }, { kind: 'review', source: 'G2', text: 'Too hard', count: 4 }],
    }), NOW);
    expect(lines).toEqual([
      { text: 'App Store · Padlet · 2★', label: 'opinion', meta: 'opinion · Sep', url: 'https://apps.apple.com/x' },
      { text: 'Wakelet roadmap', label: 'fact', meta: 'fact', url: 'https://wakelet.com/roadmap' },
      { text: '“Too hard” · G2 (+4)', label: 'opinion', meta: 'opinion' },
    ]);
  });
  it('kicker', () => {
    expect(detailKicker({ kind: 'gap', value: 4, effort: 2 })).toBe('MATCH · QUICK WIN');
    expect(detailKicker({ kind: 'open', value: 4, effort: 4 })).toBe('BE FIRST · BIG BET');
    expect(detailKicker({ kind: 'gap', value: 3, effort: 3, idea: idea('R1', { opportunity: opp('gap', { testFirst: true }) }) })).toBe('TEST FIRST · COSTLY');
  });
});
