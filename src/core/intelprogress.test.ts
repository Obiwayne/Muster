import { describe, expect, it } from 'vitest';
import type { IntelJob, IntelStore, MusterState } from '../types.js';
import { emptyIntel } from './intel.js';
import { durationText, jobNoteData, jobNoteText, nameList, NOTE_KINDS, recordArea, siteName, trackClaim, trackPage } from './intelprogress.js';

const job = (over: Partial<IntelJob> = {}): IntelJob => ({
  id: 'IJ3', kind: 'competitor', status: 'running', competitorIds: ['figma'], areas: ['features', 'pricing', 'reviews'], browse: 'profile', depth: 'quick',
  by: 'you', queuedAt: '2026-10-03T10:00:00.000Z', startedAt: '2026-10-03T10:00:00.000Z', pagesBrowsed: 0, ...over,
});

describe('intel job progress', () => {
  it('maps record kinds to research areas; finding and change carry their own', () => {
    expect(recordArea('capability', {})).toBe('features');
    expect(recordArea('theme', {})).toBe('reviews');
    expect(recordArea('social_insight', {})).toBe('marketing');
    expect(recordArea('plan', {})).toBe('roadmap');
    expect(recordArea('filing', {})).toBe('financials');
    expect(recordArea('opportunity', {})).toBe('gaps');
    expect(recordArea('finding', { area: 'team' })).toBe('team');
    expect(recordArea('change', { area: 'pricing' })).toBe('pricing');
    expect(recordArea('profile', {})).toBeUndefined();
    expect(recordArea('sample', {})).toBeUndefined();
  });

  it('counts claims per area, the current area and the latest claim', () => {
    const j = job();
    trackClaim(j, 'capability', { name: 'Dev Mode' }, { name: 'Dev Mode', cells: { figma: { label: 'fact' } } });
    trackClaim(j, 'finding', { area: 'pricing', title: 'Figma Dev Mode moved to paid seats' }, { area: 'pricing', title: 'Figma Dev Mode moved to paid seats', label: 'fact' });
    trackClaim(j, 'sample', { total: 400 }); // not a claim
    trackClaim(j, 'theme', { title: 'Slow on big files' }, { title: 'Slow on big files', label: 'opinion' });
    expect(j.progress).toMatchObject({ claims: 3, areas: { features: 1, pricing: 1, reviews: 1 }, current: 'reviews', latest: { text: 'Slow on big files', label: 'opinion' } });
    trackClaim(undefined, 'theme', { title: 'x' }); // a research run: nothing to count
  });

  it('pages: counter, what it reads, blocked domains and missing sign-ins (once each)', () => {
    const j = job();
    trackPage(j, { url: 'https://apps.apple.com/us/app/figma/id1', loggedIn: false, mode: 'profile' });
    trackPage(j, { url: 'https://www.g2.com/products/figma/reviews', blocked: 'bot check (Cloudflare)', mode: 'profile' });
    trackPage(j, { url: 'https://www.g2.com/products/figma/pricing', blocked: 'bot check (Cloudflare)', mode: 'profile' });
    trackPage(j, { url: 'https://www.reddit.com/r/FigmaDesign', loggedIn: false, mode: 'profile' });
    trackPage(j, { url: 'https://www.reddit.com/r/UXDesign', loggedIn: false, mode: 'public' });
    trackPage(j);
    expect(j.pagesBrowsed).toBe(6);
    expect(j.progress).toMatchObject({ reading: { site: 'Reddit' }, blocked: ['g2.com'], notSignedIn: ['Reddit'] });
    expect(siteName('https://apps.apple.com/x')).toBe('App Store');
    expect(siteName('https://www.figma.com/pricing')).toBe('figma.com');
  });
});

describe('intel job note', () => {
  const store = (): IntelStore => {
    const s = emptyIntel('wall');
    s.competitors.push({ id: 'figma', name: 'Figma', url: 'https://figma.com', colour: 1, sources: [], areas: [], watch: 'off', browse: 'profile', addedAt: '' });
    s.competitors.push({ id: 'canva', name: 'Canva', url: 'https://canva.com', colour: 2, sources: [], areas: [], watch: 'off', browse: 'profile', addedAt: '' });
    const cap = (id: string, verdict: 'gap' | 'edge' | 'open', vs: string[], cells: string[]) => ({ id, name: id, cells: Object.fromEntries(cells.map((c) => [c, {} as never])), verdict, verdictVs: vs, updatedAt: '' });
    s.capabilities.push(cap('F1', 'gap', ['figma'], ['us', 'figma']), cap('F2', 'gap', ['canva'], ['us', 'canva']), cap('F3', 'edge', ['figma', 'canva'], ['us', 'figma']), cap('F4', 'open', [], ['us', 'figma']));
    return s;
  };
  const state = { research: { runs: [], ideas: [{ id: 'R1', origin: 'intel', runId: 'IJ3' }, { id: 'R2', origin: 'intel', runId: 'IJ1' }] } } as unknown as MusterState;

  it('ready: sources, duration, claims, areas and verdicts vs this job\'s competitors', () => {
    const j = job({ status: 'done', finishedAt: '2026-10-03T10:09:12.000Z', sourcesRead: 41, progress: { claims: 38, areas: { features: 20, pricing: 10, reviews: 8 } } });
    const d = jobNoteData(store(), state, j, 'ready');
    expect(d).toMatchObject({ jobId: 'IJ3', outcome: 'ready', names: ['Figma'], sources: 41, durationMs: 552_000, claims: 38, areas: 3, gaps: 1, edges: 1, open: 1, ideas: 1 });
    expect(d.reasons).toBeUndefined();
    expect(jobNoteText(d)).toEqual({ title: 'Figma research is ready', body: 'Read 41 sources in 9m 12s. 38 claims across 3 areas.' });
  });

  it('stopped: what was kept and honest reasons; sweeps name every competitor; watches are re-checks', () => {
    const j = job({ status: 'failed', error: 'scout exited', pagesBrowsed: 9, progress: { claims: 12, areas: { features: 12 }, blocked: ['g2.com'], notSignedIn: ['Reddit'] } });
    const d = jobNoteData(store(), state, j, 'stopped');
    expect(jobNoteText(d)).toEqual({ title: 'Figma research stopped early', body: 'Kept 12 claims. scout stopped: scout exited. g2.com blocked the research browser; read its public page instead. Reddit not signed in.' });
    const sweep = jobNoteData(store(), state, job({ kind: 'sweep', competitorIds: ['figma', 'canva'], status: 'cancelled' }), 'stopped');
    expect(jobNoteText(sweep)).toEqual({ title: 'Figma and Canva research stopped early', body: 'Nothing was recorded. The Captain cancelled it.' });
    expect(jobNoteText(jobNoteData(store(), state, job({ kind: 'watch', status: 'done', finishedAt: '2026-10-03T10:00:45.000Z' }), 'ready')).title).toBe('Figma re-check is ready');
    expect(NOTE_KINDS).not.toContain('check');
    expect(NOTE_KINDS).not.toContain('recheck');
  });

  it('formats names and durations', () => {
    expect(nameList(['Padlet', 'Wakelet', 'Linoit'])).toBe('Padlet, Wakelet and Linoit');
    expect(durationText(45_000)).toBe('45s');
    expect(durationText(3_840_000)).toBe('1h 4m');
  });
});
