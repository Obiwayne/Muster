import { describe, expect, it } from 'vitest';
import type { CapabilityCell, IntelCapability, IntelClaim, IntelJob, IntelSample, IntelSource, IntelStore, IntelTheme, ResearchIdea } from '../../src/types';
import {
  cellPill, claimMeta, companyColour, compact, complaintThemes, filterCapabilities, fmtDate, ideaRoadmapStatus, isThin, jobEstimate, jobLine,
  labelDotClass, matrixCounts, matrixSummary, parseTab, sampleLine, shareOfSample, sourceLine, themeTag, themesFor, trackedCompanies, verdictChip,
} from './intelmodel';
import { browseFootnote, browseOptions, initialBrowseMode } from './browsechoice';
import { normaliseUrl, sameCompany } from './intel/addcompetitor';

const src = (over: Partial<IntelSource> = {}): IntelSource => ({ kind: 'site', title: 'Padlet pricing page', url: 'https://padlet.com/premium', seenAt: '2026-10-02', ...over });
const claim = (over: Partial<IntelClaim> = {}): IntelClaim => ({ label: 'fact', confidence: 'high', sources: [src()], asOf: '2026-10-02', ...over });
const cell = (status: CapabilityCell['status'], over: Partial<CapabilityCell> = {}): CapabilityCell => ({ ...claim(), status, ...over });
const cap = (over: Partial<IntelCapability>): IntelCapability => ({
  id: 'F1', name: 'Approve posts', cells: {}, verdict: 'parity', verdictVs: [], updatedAt: '2026-10-02T10:00:00Z', ...over,
});
const store = {
  competitors: [
    { id: 'padlet', name: 'Padlet', url: 'https://padlet.com', colour: 0, sources: [], areas: [], watch: 'weekly', browse: 'profile', addedAt: '' },
    { id: 'us', name: 'wall-education', url: '', isUs: true, colour: 0, sources: [], areas: [], watch: 'off', browse: 'profile', addedAt: '' },
    { id: 'wakelet', name: 'Wakelet', url: 'https://wakelet.com', colour: 1, sources: [], areas: [], watch: 'weekly', browse: 'profile', addedAt: '' },
    { id: 'gone', name: 'Gone', url: 'https://gone.io', colour: 2, sources: [], areas: [], watch: 'off', browse: 'profile', addedAt: '', removed: true },
  ],
} as Pick<IntelStore, 'competitors'>;
const theme = (over: Partial<IntelTheme>): IntelTheme => ({
  ...claim({ label: 'opinion' }), id: 'TH1', title: 'No control', mentions: 104, sampleSize: 475, independentSources: 12, byCompetitor: { padlet: 80, wakelet: 24 },
  severity: 'severe', trend: 'rising', quotes: [], ...over,
});

describe('tabs', () => {
  it('parses #/intel/<tab>, falling back to overview', () => {
    expect(parseTab('reviews')).toBe('reviews');
    expect(parseTab('opportunities')).toBe('opportunities');
    expect(parseTab(null)).toBe('overview');
    expect(parseTab('nope')).toBe('overview');
  });
});

describe('claim formatting', () => {
  it('label dot classes', () => {
    expect(labelDotClass('fact')).toBe('ld-fact');
    expect(labelDotClass('opinion')).toBe('ld-opinion');
    expect(labelDotClass('prediction')).toBe('ld-prediction');
  });
  it('formats dates', () => {
    expect(fmtDate('2026-10-02')).toBe('2 Oct 2026');
    expect(fmtDate('2026-09-29T10:00:00Z', true)).toBe('29 Sep');
    expect(fmtDate(undefined)).toBe('');
    expect(fmtDate('Q1 2027')).toBe('Q1 2027');
  });
  it('every claim line says label, confidence, sources and date', () => {
    expect(claimMeta(claim())).toBe('Fact · high confidence · 1 source · 2 Oct 2026');
    expect(claimMeta(claim({ label: 'opinion', confidence: 'medium', sources: [src(), src({ url: 'https://x.com/a' }), src()] })))
      .toBe('Customer opinion · medium confidence · 2 sources · 2 Oct 2026');
    expect(claimMeta(claim({ label: 'prediction', confidence: 'low' }))).toMatch(/^Prediction · low confidence/);
  });
  it('a source line prefers the date the source carries', () => {
    expect(sourceLine(src({ title: 'App Store · Padlet · 2★', publishedAt: '2026-09-14' }))).toBe('App Store · Padlet · 2★ · 14 Sep 2026');
    expect(sourceLine(src())).toBe('Padlet pricing page · 2 Oct 2026');
  });
  it('compacts follower counts', () => {
    expect(compact(96000)).toBe('96k');
    expect(compact(1200)).toBe('1.2k');
    expect(compact(400)).toBe('400');
    expect(compact(2_400_000)).toBe('2.4M');
    expect(compact(undefined)).toBe('—');
  });
});

describe('companies', () => {
  it('us first, removed hidden', () => {
    expect(trackedCompanies(store).map((c) => c.id)).toEqual(['us', 'padlet', 'wakelet']);
  });
  it('us is always teal; others by colour slot', () => {
    expect(companyColour({ isUs: true, colour: 3 })).toBe('var(--color-crew)');
    expect(companyColour({ colour: 0 })).toBe('#F27BA0');
    expect(companyColour({ colour: 9 })).toBe('#7FA0FF');
  });
});

describe('feature matrix', () => {
  const caps = [
    cap({ id: 'F1', verdict: 'gap', verdictVs: ['padlet', 'wakelet'], ideaId: 'R10' }),
    cap({ id: 'F2', verdict: 'gap', verdictVs: ['padlet'], verdictStage: 'M5' }),
    cap({ id: 'F3', verdict: 'edge', verdictVs: ['padlet'] }),
    cap({ id: 'F4', verdict: 'edge', verdictVs: ['padlet', 'wakelet'] }),
    cap({ id: 'F5', verdict: 'edge', verdictVs: ['padlet', 'wakelet'], verdictStage: 'M3' }),
    cap({ id: 'F6', verdict: 'open' }),
    cap({ id: 'F7', verdict: 'parity' }),
  ];
  it('verdict chip text uses the idea id (R#), never G#', () => {
    const t = (c: IntelCapability, ideas: Pick<ResearchIdea, 'id' | 'opportunity'>[] = []) => verdictChip(c, store, ideas).text;
    expect(t(caps[0]!)).toBe('Gap · R10');
    expect(t(caps[1]!)).toBe('Gap · closing M5');
    expect(t(caps[2]!)).toBe('Edge vs Padlet');
    expect(t(caps[3]!)).toBe('Edge vs 2');
    expect(t(caps[4]!)).toBe('Edge at M3');
    expect(t(caps[5]!)).toBe('Open · be first');
    expect(t(caps[6]!)).toBe('Parity');
    expect(t(cap({ verdict: 'gap', verdictVs: ['wakelet'] }))).toBe('Gap vs Wakelet');
    expect(t(cap({ verdict: 'gap', verdictVs: ['padlet'], ideaId: 'R12' }), [{ id: 'R12', opportunity: { testFirst: true } as ResearchIdea['opportunity'] }])).toBe('Gap · R12 test');
    for (const c of caps) expect(t(c)).not.toMatch(/\bG\d/);
  });
  it('planned verdicts are pending (dashed)', () => {
    expect(verdictChip(caps[1]!, store).pending).toBe(true);
    expect(verdictChip(caps[4]!, store).pending).toBe(true);
    expect(verdictChip(caps[0]!, store).pending).toBe(false);
  });
  it('counts and filters for All / Gaps / Edges / Open', () => {
    expect(matrixCounts(caps)).toEqual({ all: 7, gap: 2, edge: 3, open: 1, parity: 1 });
    expect(filterCapabilities(caps, 'all')).toHaveLength(7);
    expect(filterCapabilities(caps, 'gap').map((c) => c.id)).toEqual(['F1', 'F2']);
    expect(filterCapabilities(caps, 'edge').map((c) => c.id)).toEqual(['F3', 'F4', 'F5']);
    expect(filterCapabilities(caps, 'open').map((c) => c.id)).toEqual(['F6']);
    expect(matrixSummary(caps)).toBe('2 gaps · 3 edges · 1 open');
    expect(matrixSummary([caps[0]!, caps[2]!])).toBe('1 gap · 1 edge · 0 open');
  });
  it('cell pills', () => {
    expect(cellPill(cell('yes'))).toEqual({ text: 'Yes', cls: 'yes' });
    expect(cellPill(cell('paid'))).toEqual({ text: 'Paid tier', cls: 'paid' });
    expect(cellPill(cell('paid', { note: '3 walls' }))).toEqual({ text: '3 walls', cls: 'paid' });
    expect(cellPill(cell('planned', { stageId: 'M3' }), true)).toEqual({ text: 'Plan M3', cls: 'planned' });
    expect(cellPill(cell('planned', { planNote: 'Q1' }), false).text).toBe('Planned');
    expect(cellPill(cell('missing'), true)).toEqual({ text: 'Missing', cls: 'missing' });
    expect(cellPill(cell('missing'), false).cls).toBe('none');
    expect(cellPill(cell('none'))).toEqual({ text: 'None', cls: 'none' });
    expect(cellPill(undefined).cls).toBe('unknown');
  });
});

describe('themes', () => {
  it('share of the reviewed sample', () => {
    expect(shareOfSample({ mentions: 104, sampleSize: 475 })).toBe(22);
    expect(shareOfSample({ mentions: 3, sampleSize: 0 })).toBe(0);
  });
  it('under 5 independent sources is thin, never a finding', () => {
    expect(isThin({ independentSources: 4 })).toBe(true);
    expect(isThin({ independentSources: 5 })).toBe(false);
    const list = complaintThemes([theme({ id: 'A', mentions: 50 }), theme({ id: 'B', independentSources: 3, mentions: 200 }), theme({ id: 'C', love: true }), theme({ id: 'D', mentions: 90 })]);
    expect(list.map((t) => t.id)).toEqual(['D', 'A']);
  });
  it('per-competitor view uses their mentions', () => {
    const t = themesFor([theme({}), theme({ id: 'TH2', byCompetitor: { wakelet: 3 } })], 'padlet');
    expect(t).toHaveLength(1);
    expect(t[0]!.mentions).toBe(80);
  });
  it('sample line', () => {
    const s: IntelSample = { window: 'last 12 months', total: 569, asOf: '2026-10-03', counts: [
      { kind: 'app_store', label: 'App Store', n: 188 }, { kind: 'google_play', label: 'Google Play', n: 121 }, { kind: 'g2', label: 'G2', n: 103 },
      { kind: 'reddit', label: 'Reddit', n: 63 }, { kind: 'social_comments', label: 'Social comments', n: 94 },
    ] };
    expect(sampleLine(s)).toBe('412 reviews + 63 threads, last 12 months');
    expect(sampleLine(s, ' · ')).toBe('412 reviews · 63 threads · last 12 months');
    expect(sampleLine(undefined)).toBe('no reviewed sample yet');
  });
  it('theme tags', () => {
    expect(themeTag({ ourAnswer: { kind: 'edge', text: '' } })?.text).toBe('Our edge');
    expect(themeTag({ ourAnswer: { kind: 'opportunity', text: '', ideaId: 'R7' } })?.text).toBe('Opportunity R7');
    expect(themeTag({ ourAnswer: { kind: 'watch', text: '' } })?.text).toBe('Watch');
    expect(themeTag({ ourAnswer: { kind: 'win_over', text: '' } })?.text).toBe('Win them over');
    expect(themeTag({})).toBeNull();
  });
});

describe('intel ideas on the roadmap', () => {
  const roadmap = { goals: [{ id: 'G15', stageId: 'M3', title: '', description: '', status: 'planned' as const }] };
  const idea = (over: Partial<ResearchIdea>): Pick<ResearchIdea, 'goalId' | 'thread' | 'status' | 'opportunity'> => ({ thread: [], status: 'new', ...over });
  it('On Mx / Talking / Test first / Parked / Not yet', () => {
    expect(ideaRoadmapStatus(idea({ goalId: 'G15', status: 'approved' }), roadmap)).toEqual({ text: 'On M3', cls: 'on' });
    expect(ideaRoadmapStatus(idea({ thread: [{ at: '', from: 'you', text: '?' }] }), roadmap).text).toBe('Talking');
    expect(ideaRoadmapStatus(idea({ opportunity: { testFirst: true } as ResearchIdea['opportunity'] }), roadmap).text).toBe('Test first');
    expect(ideaRoadmapStatus(idea({ opportunity: { priority: 'parked' } as ResearchIdea['opportunity'] }), roadmap).text).toBe('Parked');
    expect(ideaRoadmapStatus(idea({}), roadmap).text).toBe('Not yet');
  });
});

describe('jobs', () => {
  it('estimate line', () => {
    expect(jobEstimate(9)).toBe('≈ 30 min · 9% of 5-hour');
    expect(jobEstimate(9, 3)).toBe('≈ 1 h 30 min · 27% of 5-hour');
    expect(jobEstimate(2, 1, 'quick')).toBe('≈ 5 min · 1% of 5-hour');
    expect(jobEstimate(0)).toBe('pick at least one area');
  });
  it('job line', () => {
    const job: IntelJob = { id: 'IJ2', kind: 'competitor', status: 'running', competitorIds: ['padlet'], areas: ['features', 'pricing'], browse: 'profile', depth: 'thorough', by: 'you', queuedAt: '', pagesBrowsed: 12 };
    expect(jobLine(job, store)).toBe('scout is researching Padlet · 2 areas · 12 pages read');
    expect(jobLine({ ...job, kind: 'check', ideaId: 'R7', competitorIds: [] }, store)).toBe('scout is checking R7 · 12 pages read');
  });
});

describe('browse choice', () => {
  const status = (over = {}) => ({ available: true, channel: 'chrome' as const, profileDir: '', state: 'idle' as const, sites: [], tools: [], opera: { found: true, allow: [] }, ...over });
  it('Opera is disabled until Settings has an allowlist', () => {
    const opts = browseOptions([], status());
    expect(opts.map((o) => o.mode)).toEqual(['profile', 'public', 'opera']);
    expect(opts[0]!.recommended).toBe(true);
    expect(opts[2]!.disabled).toMatch(/allowlist/);
    expect(browseOptions(['reddit.com'], status())[2]!.disabled).toBeUndefined();
    expect(browseOptions(['reddit.com'], status())[2]!.sub).toContain('reddit.com');
  });
  it('without a research browser only public pages are usable', () => {
    const opts = browseOptions(['reddit.com'], status({ available: false, problem: 'playwright-core is not installed' }));
    expect(opts.filter((o) => !o.disabled).map((o) => o.mode)).toEqual(['public']);
    expect(initialBrowseMode({ researchBrowser: { mode: 'profile', channel: 'chrome', operaAllow: [], minDelayMs: 0, maxPagesPerJob: 1 } }, status({ available: false }))).toBe('public');
  });
  it('starts from the config default, falling back when it is unusable', () => {
    const cfg = (mode: 'profile' | 'public' | 'opera', operaAllow: string[] = []) => ({ researchBrowser: { mode, channel: 'chrome' as const, operaAllow, minDelayMs: 0, maxPagesPerJob: 1 } });
    expect(initialBrowseMode(cfg('public'))).toBe('public');
    expect(initialBrowseMode(cfg('opera'))).toBe('profile');
    expect(initialBrowseMode(cfg('opera', ['reddit.com']))).toBe('opera');
    expect(initialBrowseMode(null)).toBe('profile');
  });
  it('footnote says what the mode does', () => {
    expect(browseFootnote('public')).toMatch(/Public pages only/);
    expect(browseFootnote('profile')).toMatch(/Read-only/);
    expect(browseFootnote('opera')).toMatch(/Opera/);
  });
});

describe('add competitor helpers', () => {
  it('normalises pasted URLs', () => {
    expect(normaliseUrl('padlet.com')).toBe('https://padlet.com');
    expect(normaliseUrl(' https://boardly.app/ ')).toBe('https://boardly.app');
    expect(normaliseUrl('not a site')).toBeNull();
    expect(normaliseUrl('')).toBeNull();
  });
  it('matches the site legal name to the Companies House name', () => {
    expect(sameCompany('Boardly Learning Ltd', 'BOARDLY LEARNING LTD')).toBe(true);
    expect(sameCompany('Wakelet Limited', 'WAKELET LTD')).toBe(true);
    expect(sameCompany('Boardly Learning Ltd', 'BOARDLY LIMITED')).toBe(false);
  });
});
