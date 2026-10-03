import { describe, expect, it } from 'vitest';
import type { IntelCapability, IntelCheck, IntelCheckRow, IntelCompetitor, IntelJob, IntelStore, ResearchIdea } from '../../src/types';
import { checkChip, checkStatus, checksFor, confidenceLine, coverage, recheckLine, rowsByArea } from './intelcheck';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const comp = (id: string, extra: Partial<IntelCompetitor> = {}): IntelCompetitor => ({
  id, name: id[0].toUpperCase() + id.slice(1), url: `https://${id}.com`, colour: 0, sources: [], areas: [], watch: 'off', browse: 'profile', addedAt: daysAgo(30), ...extra,
});
const US = comp('us', { isUs: true, name: 'wall-education', url: '' });
const row = (area: IntelCheckRow['area'], extra: Partial<IntelCheckRow> = {}): IntelCheckRow => ({
  area, finding: `${area} finding`, signal: 'supports', label: 'fact', confidence: 'high', sources: [{ kind: 'site', title: 's', url: 'https://x.com', seenAt: '2026-10-01' }], asOf: '2026-10-01', ...extra,
});
const check = (id: string, ideaId: string, extra: Partial<IntelCheck> = {}): IntelCheck => ({
  id, ideaId, revision: 1, status: 'done', rows: [row('features'), row('complaints')], verdict: 'gap', verdictText: 'match it', confidence: 'high',
  sourceCount: 12, capabilityIds: [], createdAt: daysAgo(2), doneAt: daysAgo(2), history: [], ...extra,
});
const cap = (id: string, extra: Partial<IntelCapability> = {}): IntelCapability => ({ id, name: id, cells: {}, verdict: 'gap', verdictVs: [], updatedAt: daysAgo(1), ...extra });
const store = (over: Partial<Pick<IntelStore, 'checks' | 'competitors' | 'jobs' | 'capabilities'>> = {}) => ({
  checks: [] as IntelCheck[], competitors: [US, comp('padlet'), comp('wakelet'), comp('linoit')], jobs: [] as IntelJob[], capabilities: [] as IntelCapability[], ...over,
});
const idea = (id: string, extra: Partial<ResearchIdea> = {}) => ({ id, ...extra });
const cfg = { intel: { recheck: 'weekly' as const, checkMaxAgeDays: 14 } };

describe('checkStatus (the approve gate)', () => {
  it('is missing without a check and blocks approve', () => {
    const st = checkStatus(idea('R1'), store(), cfg, NOW);
    expect(st.state).toBe('missing');
    expect(st.canApprove).toBe(false);
    expect(st.canRun).toBe(true);
  });

  it('is done and approvable with a fresh check', () => {
    const st = checkStatus(idea('R1', { checkId: 'IC1' }), store({ checks: [check('IC1', 'R1')] }), cfg, NOW);
    expect(st.state).toBe('done');
    expect(st.canApprove).toBe(true);
    expect(st.ageDays).toBe(2);
    expect(st.reason).toBe('Checked 2 days ago');
  });

  it('is stale at checkMaxAgeDays and older', () => {
    const s = store({ checks: [check('IC1', 'R1', { doneAt: daysAgo(14) })] });
    const st = checkStatus(idea('R1', { checkId: 'IC1' }), s, cfg, NOW);
    expect(st.state).toBe('stale');
    expect(st.canApprove).toBe(false);
    expect(st.reason).toMatch(/14 days ago.*older than 14 days/);
    expect(checkStatus(idea('R1', { checkId: 'IC1' }), s, { intel: { recheck: 'weekly', checkMaxAgeDays: 30 } }, NOW).state).toBe('done');
  });

  it('defaults to 14 days without config', () => {
    const s = store({ checks: [check('IC1', 'R1', { doneAt: daysAgo(15) })] });
    expect(checkStatus(idea('R1', { checkId: 'IC1' }), s, null, NOW).state).toBe('stale');
  });

  it('is queued or running while scout works on it, with no Run button', () => {
    const job: IntelJob = { id: 'IJ4', kind: 'check', status: 'running', competitorIds: [], areas: [], browse: 'profile', depth: 'quick', by: 'you', queuedAt: daysAgo(0), pagesBrowsed: 0 };
    const q = checkStatus(idea('R1'), store({ checks: [check('IC2', 'R1', { status: 'queued', rows: [], doneAt: undefined, jobId: 'IJ9' })] }), cfg, NOW);
    expect(q.state).toBe('queued');
    expect(q.canRun).toBe(false);
    expect(q.canApprove).toBe(false);
    const r = checkStatus(idea('R1'), store({ checks: [check('IC2', 'R1', { status: 'queued', rows: [], jobId: 'IJ4' })], jobs: [job] }), cfg, NOW);
    expect(r.state).toBe('running');
    expect(r.reason).toMatch(/against 3 competitors/);
  });

  it('a re-run on top of a fresh check keeps approve open', () => {
    const s = store({ checks: [check('IC1', 'R1'), check('IC2', 'R1', { status: 'running', rows: [] })] });
    const st = checkStatus(idea('R1', { checkId: 'IC1' }), s, cfg, NOW);
    expect(st.state).toBe('running');
    expect(st.canApprove).toBe(true);
    expect(st.gate?.id).toBe('IC1');
  });

  it('is skipped (approvable) when no competitors are tracked, with or without a skipped check', () => {
    const none = store({ competitors: [US] });
    const a = checkStatus(idea('R1'), none, cfg, NOW);
    expect(a.state).toBe('skipped');
    expect(a.canApprove).toBe(true);
    const b = checkStatus(idea('R1', { checkId: 'IC1' }), { ...none, checks: [check('IC1', 'R1', { status: 'skipped', rows: [], skippedReason: 'no competitors tracked' })] }, cfg, NOW);
    expect(b.state).toBe('skipped');
    expect(b.reason).toBe('Skipped: no competitors tracked.');
    expect(b.canApprove).toBe(true);
  });

  it('removed competitors do not count', () => {
    const s = store({ competitors: [US, comp('padlet', { removed: true })] });
    expect(checkStatus(idea('R1'), s, cfg, NOW).state).toBe('skipped');
  });

  it('a failed check blocks approve and offers a re-run', () => {
    const st = checkStatus(idea('R1', { checkId: 'IC1' }), store({ checks: [check('IC1', 'R1', { status: 'failed' })] }), cfg, NOW);
    expect(st.state).toBe('failed');
    expect(st.canApprove).toBe(false);
    expect(st.canRun).toBe(true);
  });

  it('checksFor lists the idea\'s checks newest first', () => {
    const s = store({ checks: [check('IC2', 'R1'), check('IC10', 'R1'), check('IC3', 'R2')] });
    expect(checksFor(idea('R1'), s).map((c) => c.id)).toEqual(['IC10', 'IC2']);
  });
});

describe('verdict chip', () => {
  it('says what is missing or running', () => {
    expect(checkChip(idea('R1'), store(), cfg, NOW)).toMatchObject({ text: 'No intel check', tone: 'none' });
    expect(checkChip(idea('R1'), store({ checks: [check('IC1', 'R1', { status: 'running', rows: [] })] }), cfg, NOW)).toMatchObject({ text: 'Checking…', tone: 'running' });
  });

  it('edge at risk, edge vs one, edge at a stage', () => {
    const caps = [cap('F1', { verdict: 'edge', verdictVs: ['padlet'] })];
    expect(checkChip(idea('R7', { checkId: 'IC1' }), store({ capabilities: caps, checks: [check('IC1', 'R7', { verdict: 'edge_at_risk', capabilityIds: ['F1'] })] }), cfg, NOW))
      .toMatchObject({ text: 'Edge · at risk', tone: 'edge', mark: 'up' });
    expect(checkChip(idea('R9', { checkId: 'IC1' }), store({ capabilities: caps, checks: [check('IC1', 'R9', { verdict: 'edge', capabilityIds: ['F1'] })] }), cfg, NOW).text).toBe('Edge vs Padlet');
    const staged = [cap('F1', { verdict: 'edge', verdictVs: ['padlet', 'wakelet'], verdictStage: 'M3' })];
    expect(checkChip(idea('R9', { checkId: 'IC1' }), store({ capabilities: staged, checks: [check('IC1', 'R9', { verdict: 'edge', capabilityIds: ['F1'] })] }), cfg, NOW))
      .toMatchObject({ text: 'Edge at M3', pending: true });
  });

  it('gap: n of m have it, or closing a stage', () => {
    const caps = [cap('F2', { verdict: 'gap', verdictVs: ['padlet', 'wakelet'] })];
    expect(checkChip(idea('R10', { checkId: 'IC1' }), store({ capabilities: caps, checks: [check('IC1', 'R10', { capabilityIds: ['F2'] })] }), cfg, NOW).text).toBe('Gap · 2 of 3 have it');
    const closing = [cap('F3', { verdict: 'gap', verdictVs: ['padlet'], verdictStage: 'M5' })];
    expect(checkChip(idea('R8', { checkId: 'IC1' }), store({ capabilities: closing, checks: [check('IC1', 'R8', { capabilityIds: ['F3'] })] }), cfg, NOW))
      .toMatchObject({ text: 'Gap · closing M5', pending: true, mark: 'ring' });
    expect(checkChip(idea('R14', { checkId: 'IC1' }), store({ checks: [check('IC1', 'R14')] }), cfg, NOW).text).toBe('Gap');
  });

  it('open and stale', () => {
    expect(checkChip(idea('R13', { checkId: 'IC1' }), store({ checks: [check('IC1', 'R13', { verdict: 'open' })] }), cfg, NOW).text).toBe('Open · be first');
    const stale = checkChip(idea('R12', { checkId: 'IC1' }), store({ checks: [check('IC1', 'R12', { doneAt: daysAgo(20) })] }), cfg, NOW);
    expect(stale).toMatchObject({ text: 'Gap · stale', stale: true });
  });
});

describe('rows, coverage and lines', () => {
  it('counts distinct areas of 7 and lists them in order', () => {
    const c = check('IC1', 'R1', { rows: [row('ai'), row('features'), row('features')] });
    expect(coverage(c)).toBe(2);
    expect(coverage(undefined)).toBe(0);
    const by = rowsByArea(c);
    expect(by.map((r) => r.area)).toEqual(['features', 'complaints', 'social', 'plans', 'pricing', 'audience', 'ai']);
    expect(by.filter((r) => r.row).map((r) => r.area)).toEqual(['features', 'ai']);
  });

  it('re-check line from config and watchFor; none when off', () => {
    const c = check('IC1', 'R1', { watchFor: 'Wakelet changes.' });
    expect(recheckLine(c, cfg)).toEqual({ text: 'Re-check weekly; alert if Wakelet changes', meta: 'intel 2/7' });
    expect(recheckLine(check('IC1', 'R1', { watchFor: 'Padlet redesigns its share dialog' }), { intel: { recheck: 'monthly', checkMaxAgeDays: 14 } })?.text)
      .toBe('Re-check monthly; alert if Padlet redesigns its share dialog');
    expect(recheckLine(c, { intel: { recheck: 'off', checkMaxAgeDays: 14 } })).toBeNull();
    expect(recheckLine(undefined, null)).toEqual({ text: 'Re-check weekly', meta: '' });
  });

  it('confidence line', () => {
    expect(confidenceLine({ confidence: 'high', sourceCount: 214 })).toBe('High · 214 sources');
    expect(confidenceLine({ confidence: 'low', sourceCount: 1 })).toBe('Low · 1 source');
  });
});
