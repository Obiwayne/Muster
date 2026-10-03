import { describe, expect, it } from 'vitest';
import type { IntelSummary } from '../../src/types';
import { areaChips, etaLeftMs, fmtElapsed, namesText, overlayModel, PeekMemory } from './intelprogress';
import { intelNoteView, isIntelJobNote, runAgainBody } from './intelnote';

const NOW = Date.parse('2026-10-03T10:03:40.000Z');
const base: IntelSummary = { rev: 5, competitors: 1, sources: 0, gaps: 0, edges: 0, open: 0, newIdeas: 0, alerts: 0, queuedJobs: 0 };
const running = (over: Partial<NonNullable<IntelSummary['runningJob']>> = {}): IntelSummary => ({
  ...base,
  runningJob: {
    id: 'IJ3', kind: 'competitor', label: 'Researching Figma', startedAt: '2026-10-03T10:00:00.000Z', competitorIds: ['figma'], names: ['Figma'],
    areas: ['features', 'pricing', 'roadmap', 'ai', 'reviews', 'marketing', 'audience', 'team', 'financials'], depth: 'quick', by: 'you', pages: 23,
    progress: {
      claims: 9, areas: { features: 3, pricing: 2, roadmap: 1, ai: 1, reviews: 2 }, current: 'reviews',
      latest: { text: 'Figma Dev Mode moved to paid seats', label: 'fact', at: '2026-10-03T10:03:30.000Z' },
      reading: { url: 'https://apps.apple.com/x', site: 'App Store', at: '2026-10-03T10:03:20.000Z' },
    },
    ...over,
  },
});

describe('research-in-progress overlay model', () => {
  it('derives done / current / pending chips from the requested areas and the claims so far', () => {
    const m = overlayModel(running(), NOW)!;
    expect(m).toMatchObject({ jobId: 'IJ3', mode: 'running', title: 'scout is researching Figma', done: 4, total: 9, pct: 44 });
    expect(m.chips.map((c) => `${c.label}:${c.state}`)).toEqual([
      'Features:done', 'Pricing:done', 'Roadmap:done', 'AI use:done', 'Reviews:current', 'Social:pending', 'Audience:pending', 'Team:pending', 'Financials:pending',
    ]);
    expect(m.chips.find((c) => c.state === 'current')!.reading).toBe('App Store');
    expect(m.latest).toBe('Latest: “Figma Dev Mode moved to paid seats” · fact');
    // 3m 40s for 4 areas → 55 s an area → 5 areas ≈ 4m 35s → "≈ 5 min left"
    expect(m.meta).toBe('23 pages · 3m 40s · ≈ 5 min left');
  });

  it('before the first claim: the first area is current, the left estimate comes from intelestimate', () => {
    const m = overlayModel(running({ pages: 1, progress: undefined, startedAt: '2026-10-03T10:03:00.000Z' }), NOW)!;
    expect(m.chips[0]).toMatchObject({ label: 'Features', state: 'current' });
    expect(m.chips[0].reading).toBeUndefined();
    expect(m.meta).toBe('1 page · 40s · ≈ 20 min left'); // quick competitor: 15 min + 2 checks → ~20 min, minus 40 s
    expect(m.latest).toBeUndefined();
  });

  it('omits "left" when overdue or done; stale reading is dropped', () => {
    expect(etaLeftMs('competitor', 'quick', 1, 60 * 60_000, 1, 9)).toBeUndefined();
    expect(etaLeftMs('competitor', 'quick', 1, 60_000, 9, 9)).toBeUndefined();
    const chips = areaChips(['features'], { claims: 0, areas: {}, reading: { url: 'x', site: 'G2', at: '2026-10-03T09:00:00.000Z' } }, NOW);
    expect(chips[0]).toEqual({ area: 'features', label: 'Features', state: 'current', count: 0 });
  });

  it('only competitor research and sweeps get the overlay; your queued job says what it waits behind', () => {
    expect(overlayModel(running({ kind: 'check' }), NOW)).toBeNull();
    expect(overlayModel(running({ kind: 'watch' }), NOW)).toBeNull();
    expect(overlayModel(base, NOW)).toBeNull();
    const queued: IntelSummary = {
      ...running({ kind: 'check', label: 'Intel check of R7' }),
      queuedJobs: 1,
      waitingOn: 'IJ3 Intel check of R7',
      queue: [{ id: 'IJ4', kind: 'competitor', label: 'Researching Canva', queuedAt: '', competitorIds: ['canva'], names: ['Canva'], areas: ['features', 'pricing'], depth: 'quick', by: 'you', pages: 0 }],
    };
    const m = overlayModel(queued, NOW)!;
    expect(m).toMatchObject({ jobId: 'IJ4', mode: 'queued', title: 'Canva research is queued', done: 0, total: 2 });
    expect(m.line).toMatch(/^Queued behind IJ3 Intel check of R7\./);
    expect(m.chips.every((c) => c.state === 'pending')).toBe(true);
    // the Captain's or the schedule's queued jobs don't take over the page
    expect(overlayModel({ ...queued, queue: [{ ...queued.queue![0], by: 'captain' }] }, NOW)).toBeNull();
  });

  it('formats', () => {
    expect(fmtElapsed(220_000)).toBe('3m 40s');
    expect(fmtElapsed(65_000)).toBe('1m 05s');
    expect(namesText(['Padlet', 'Wakelet', 'Linoit'])).toBe('Padlet, Wakelet and Linoit');
    expect(namesText(['a', 'b', 'c', 'd'])).toBe('4 competitors');
  });
});

describe('Peek memory', () => {
  it('peek hides a job until Show progress; survives a new instance; storage errors are ignored', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    const a = new PeekMemory(storage);
    expect(a.isPeeked('IJ3')).toBe(false);
    a.peek('IJ3');
    expect(a.isPeeked('IJ3')).toBe(true);
    expect(new PeekMemory(storage).isPeeked('IJ3')).toBe(true);
    expect(a.isPeeked('IJ4')).toBe(false); // a new job shows the overlay again
    a.show('IJ3');
    expect(new PeekMemory(storage).isPeeked('IJ3')).toBe(false);
    const broken = new PeekMemory({ getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    broken.peek('IJ5');
    expect(broken.isPeeked('IJ5')).toBe(true);
    expect(new PeekMemory(null).isPeeked('IJ5')).toBe(false);
  });
});

describe('intel job note on the board', () => {
  const intel = { jobId: 'IJ3', kind: 'competitor' as const, outcome: 'ready' as const, competitorIds: ['figma'], names: ['Figma'], sources: 41, durationMs: 552_000, claims: 38, areas: 9, gaps: 3, edges: 2, open: 1, ideas: 4 };
  it('ready: chips and Open Intel / See gaps / Dismiss', () => {
    const n = { topic: 'intel' as const, text: 'Figma research is ready\nRead 41 sources in 9m 12s. 38 claims across 9 areas.', intel };
    expect(isIntelJobNote(n)).toBe(true);
    expect(isIntelJobNote({ topic: 'intel' })).toBe(false);
    expect(intelNoteView(n)).toEqual({
      tone: 'ready', title: 'Figma research is ready', body: 'Read 41 sources in 9m 12s. 38 claims across 9 areas.',
      chips: [{ text: '3 gaps', tone: 'gap' }, { text: '2 edges', tone: 'edge' }, { text: '1 open', tone: 'open' }, { text: '4 ideas for the roadmap', tone: 'plain' }],
      actions: ['open', 'gaps', 'dismiss'],
    });
  });
  it('stopped: Open Intel / Run again, for the same competitors', () => {
    const v = intelNoteView({ text: 'Figma research stopped early\nKept 12 claims.', intel: { ...intel, outcome: 'stopped' } });
    expect(v).toMatchObject({ tone: 'stopped', chips: [], actions: ['open', 'again'] });
    expect(runAgainBody(intel)).toEqual({ kind: 'competitor', competitorIds: ['figma'] });
    expect(runAgainBody({ ...intel, kind: 'sweep', competitorIds: ['a', 'b'] })).toEqual({ kind: 'sweep', competitorIds: ['a', 'b'] });
  });
});
