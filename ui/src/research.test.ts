import { describe, expect, it } from 'vitest';
import type { FeedItem, ResearchIdea, ResearchRun, Roadmap } from '../../src/types';
import {
  addChip, agoText, draftFromLastRun, draftToRun, evidenceChips, evidenceCountLabel, filterIdeas, fitsLabel, ideaCounts, ideaFooter,
  impactPill, lastRun, newCount, parsePlanItem, roadmapWhat, runStrip, runningRun, safeUrl, sourceChips, splitAdvice, updatedLine,
} from './research';

const idea = (id: string, over: Partial<ResearchIdea> = {}): ResearchIdea => ({
  id, runId: 'RR1', title: `Idea ${id}`, summary: '', impact: 'medium', effort: 'M', evidence: [], status: 'new', thread: [],
  createdAt: '2026-10-02T10:00:00Z', ...over,
});

const run = (over: Partial<ResearchRun> = {}): ResearchRun => ({
  id: 'RR1', status: 'done', sources: { competitors: ['Padlet', 'Wakelet'], reviews: true, forums: ['r/Teachers'], ownApp: false },
  depth: 'quick', agentId: 'scout', startedAt: '2026-10-02T10:00:00Z', ideaIds: [], ...over,
});

const roadmap = {
  title: 'v1', summary: '', status: 'approved', revision: 1, createdBy: 'captain', updatedAt: '2026-10-02T09:00:00Z',
  stages: [
    { id: 'M3', title: 'Sharing & invites', description: '', status: 'active', exitCriteria: [], goalIds: ['G7'] },
    { id: 'M5', title: 'Launch v1.0', description: '', status: 'planned', exitCriteria: [], goalIds: ['G14'] },
  ],
  goals: [{ id: 'G14', stageId: 'M5', title: 'PDF export', description: '', status: 'planned' }],
} as Roadmap;

describe('idea filters', () => {
  const ideas = [idea('R1', { status: 'approved' }), idea('R2', { impact: 'low' }), idea('R3', { impact: 'high' }), idea('R4', { status: 'rejected' }), idea('R5', { impact: 'business' })];
  it('counts by filter', () => {
    expect(ideaCounts(ideas)).toEqual({ new: 3, roadmap: 1, rejected: 1 });
    expect(newCount({ runs: [], ideas })).toBe(3);
    expect(newCount(null)).toBe(0);
  });
  it('sorts new ideas by impact', () => {
    expect(filterIdeas(ideas, 'new').map((i) => i.id)).toEqual(['R3', 'R5', 'R2']);
    expect(filterIdeas(ideas, 'roadmap').map((i) => i.id)).toEqual(['R1']);
    expect(filterIdeas(ideas, 'rejected').map((i) => i.id)).toEqual(['R4']);
  });
});

describe('runs', () => {
  it('finds the last and the running run', () => {
    const r = { runs: [run(), run({ id: 'RR2', status: 'running', startedAt: '2026-10-02T11:00:00Z' })], ideas: [] };
    expect(lastRun(r)?.id).toBe('RR2');
    expect(runningRun(r)?.id).toBe('RR2');
    expect(lastRun({ runs: [], ideas: [] })).toBeUndefined();
  });
  it('describes the strip', () => {
    const ideas = [idea('R1'), idea('R2', { status: 'rejected' })];
    const done = runStrip(run({ finishedAt: '2026-10-02T10:18:00Z', sourcesRead: 47, ideaIds: ['R1', 'R2'], summary: 'Padlet roadmaps' }), ideas);
    expect(done).toEqual({ tone: 'blue', title: 'Research finished · 2 ideas, 1 new', sub: 'Read 47 sources in 18 min · Padlet roadmaps' });
    const now = Date.parse('2026-10-02T10:04:00Z');
    const running = runStrip(run({ status: 'running', ideaIds: ['R1'] }), ideas, now);
    expect(running.title).toBe('researching… 2 ideas so far');
    expect(running.sub).toBe('Started 4 min ago · quick · Padlet, Wakelet');
    expect(runStrip(run({ status: 'failed', finishedAt: '2026-10-02T10:02:00Z' }), []).tone).toBe('stuck');
    expect(runStrip(run({ status: 'cancelled', finishedAt: '2026-10-02T10:02:00Z' }), []).title).toBe('Research cancelled · 0 ideas found');
  });
  it('names the sources', () => {
    expect(sourceChips(run().sources)).toEqual(['Competitors', 'Reviews', 'Reddit']);
    expect(sourceChips({ competitors: [], reviews: false, forums: ['Edutopia forum'], ownApp: true })).toEqual(['Forums', 'Our app']);
  });
});

describe('cards', () => {
  it('labels impact, overlaps and fit', () => {
    expect(impactPill({ impact: 'high' })).toEqual({ label: 'HIGH IMPACT', tone: 'success' });
    expect(impactPill({ impact: 'business' }).tone).toBe('captain');
    expect(impactPill({ impact: 'high', overlapsGoalId: 'G3' }).label).toBe('OVERLAPS G3');
    expect(fitsLabel(roadmap, 'M3')).toBe('M3 Sharing');
    expect(fitsLabel(roadmap, 'M5')).toBe('M5 Launch');
    expect(fitsLabel(roadmap, 'M9')).toBe('M9');
    expect(fitsLabel(roadmap)).toBeUndefined();
  });
  it('sums evidence into chips', () => {
    const chips = evidenceChips([
      { kind: 'review', source: 'App Store · Padlet · 2★', count: 37 },
      { kind: 'forum', source: 'r/Teachers · 412 upvotes', count: 5 },
      { kind: 'competitor', source: "On Wakelet's roadmap" },
      { kind: 'web', source: 'Blog' },
    ]);
    expect(chips).toEqual([
      { tone: 'review', label: '38 reviews' },
      { tone: 'forum', label: '6 Reddit threads' },
      { tone: 'competitor', label: "On Wakelet's roadmap" },
    ]);
    expect(evidenceChips([{ kind: 'forum', source: 'Teachers forum' }])).toEqual([{ tone: 'forum', label: '1 forum thread' }]);
    expect(evidenceCountLabel({ kind: 'review', count: 37 })).toBe('+37 similar');
    expect(evidenceCountLabel({ kind: 'forum', count: 5 })).toBe('+5 threads');
    expect(evidenceCountLabel({ kind: 'web' })).toBe('');
  });
  it('only opens web links', () => {
    expect(safeUrl('https://padlet.com/x')).toBe('https://padlet.com/x');
    expect(safeUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeUrl('not a url')).toBeUndefined();
  });
  it('says where the advice stands', () => {
    expect(ideaFooter(idea('R1')).text).toBe('No advice yet');
    expect(ideaFooter(idea('R1', { thread: [{ at: '', from: 'you', text: 'q' }] })).text).toBe('Asked the Captain · answering');
    expect(ideaFooter(idea('R1', { thread: [{ at: '', from: 'you', text: 'q' }, { at: '', from: 'captain', text: 'a' }] })).tone).toBe('captain');
    expect(ideaFooter(idea('R8', { status: 'approved', goalId: 'G14' }), roadmap)).toEqual({ tone: 'success', text: 'Approved · Captain added it to M5 Launch as G14', goalStage: 'M5' });
    expect(ideaFooter(idea('R8', { status: 'approved' }), roadmap).text).toBe('Approved · Captain is adding it to the roadmap');
  });
  it('parses plan lines and advice', () => {
    expect(parsePlanItem('+ Add goal Moderation queue to M3 (Oct 13–17)')).toEqual({ sign: '+', text: 'Add goal Moderation queue to M3', meta: 'Oct 13–17' });
    expect(parsePlanItem('~ Move M3 due date (Oct 17 → 20)')).toEqual({ sign: '~', text: 'Move M3 due date', meta: 'Oct 17 → 20' });
    expect(parsePlanItem('- Drop G9')).toEqual({ sign: '−', text: 'Drop G9' });
    expect(parsePlanItem('Tell crew')).toEqual({ sign: '•', text: 'Tell crew' });
    expect(splitAdvice('Yes.\n\nM3 moves.')).toEqual({ lead: 'Yes.', rest: 'M3 moves.' });
  });
});

describe('new research draft', () => {
  it('defaults to the last run', () => {
    const d = draftFromLastRun(run());
    expect(d.competitors).toEqual(['Padlet', 'Wakelet']);
    expect(d.fromLastRun).toBe(true);
    expect(draftFromLastRun().competitors).toEqual([]);
  });
  it('adds chips without duplicates', () => {
    expect(addChip(['Padlet'], ' padlet ')).toEqual(['Padlet']);
    expect(addChip(['Padlet'], 'Linoit')).toEqual(['Padlet', 'Linoit']);
    expect(addChip([], '  ')).toEqual([]);
  });
  it('builds the request or an error', () => {
    const d = draftFromLastRun(run());
    expect(draftToRun({ ...d, focus: ' why? ' }).body).toEqual({ sources: run().sources, focus: 'why?', depth: 'quick' });
    expect(draftToRun({ ...d, competitors: [] }).error).toMatch(/similar app/);
    expect(draftToRun({ ...d, useCompetitors: false, reviews: false, useForums: false, ownApp: false }).error).toBe('Pick at least one source.');
    expect(draftToRun({ ...d, useForums: false }).body?.sources.forums).toEqual([]);
  });
});

describe('"Captain updated it" line', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const f = (id: string, from: string, text: string, at: string, kind: FeedItem['kind'] = 'event'): FeedItem => ({ id, from, text, at, kind });
  it('summarises the newest roadmap event by the Captain', () => {
    const feed = [
      f('F1', 'captain', 'added goal G14 PDF export to M5 Launch', '2026-10-02T11:00:00Z'),
      f('F2', 'captain', 'captain ticked M3 exit criterion 1: share by link', '2026-10-02T11:48:00Z'),
      f('F3', 'you', 'unticked M3 exit criterion 1', '2026-10-02T11:59:00Z'),
      f('F4', 'captain', 'M3 looks good', '2026-10-02T11:59:00Z', 'message'),
      f('F5', 'captain', 'Roadmap: M3 is 40%, G8 next.', '2026-10-02T11:58:00Z'), // roadmap_status: shown on its own
    ];
    expect(updatedLine(feed, roadmap, new Set(['captain']), now)).toBe('Captain updated it 12 min ago (ticked an M3 criterion)');
  });
  it('falls back to updatedAt', () => {
    expect(updatedLine([], roadmap, new Set(['captain']), now)).toBe('Updated 3h ago');
  });
  it('shortens the change', () => {
    expect(roadmapWhat('added goal G14 PDF export to M5 Launch')).toBe('added G14 to M5');
    expect(roadmapWhat('put T3, T4 on G7 Invite flow')).toBe('linked T3, T4 to G7');
    expect(roadmapWhat('set G8 Share permissions to active')).toBe('set G8 to active');
    expect(roadmapWhat('updated the roadmap: v1 (5 stages, 12 goals)')).toBe('revised the plan');
    expect(roadmapWhat('completed M2 Accounts')).toBe('completed M2');
    expect(agoText('2026-10-02T11:59:50Z', now)).toBe('just now');
  });
});

describe('research ideas vs intel ideas, browse and the estimate', () => {
  it('Roadmap → Research leaves intel ideas to Intel → Opportunities', async () => {
    const { researchIdeas } = await import('./research');
    const list = [idea('R1'), idea('R2', { origin: 'research' }), idea('R3', { origin: 'intel' })];
    expect(researchIdeas(list).map((i) => i.id)).toEqual(['R1', 'R2']);
  });

  it('draftToRun sends the browse mode when one is picked', () => {
    const d = { ...draftFromLastRun(run()), browse: 'public' as const };
    expect(draftToRun(d).body?.browse).toBe('public');
    expect('browse' in (draftToRun({ ...d, browse: undefined }).body ?? {})).toBe(false);
  });

  it('the estimate is estimateResearch from the server, with intel checks when competitors are tracked', async () => {
    const { researchEstimate } = await import('./research');
    const { estimateResearch } = await import('../../src/core/intelestimate');
    expect(researchEstimate('quick', 0)).toEqual({ usage: estimateResearch('quick', 0).text, checks: 'No intel checks: no competitors tracked' });
    const t = researchEstimate('thorough', 3);
    expect(t.usage).toBe(estimateResearch('thorough', 3).text);
    expect(t.usage).toMatch(/incl\. 9 intel checks/);
    expect(t.checks).toBe('each idea is checked against 3 competitors');
  });
});
