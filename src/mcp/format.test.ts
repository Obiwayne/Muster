import { describe, expect, it } from 'vitest';
import type { Agent, InboxItem, Note, ResearchIdea, Task } from '../types.js';
import { boardQuery, clip, formatAgentLine, formatBoard, formatDiff, formatIdeaDetail, formatIdeaLine, formatIdeas, formatInbox, formatNoteLine, formatRoadmap, formatTaskLine, formatTests, isTaskId, NO_ROADMAP, relTime } from './format.js';
import { PROGRESS, ROADMAP } from './roadmap.fixture.js';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60000).toISOString();

const note = (p: Partial<Note>): Note => ({
  id: 'N14', type: 'stuck', from: 'crew-3', text: 'Which token format?', createdAt: ago(4), open: true, replies: [], ...p,
});

describe('relTime / clip', () => {
  it('formats relative times', () => {
    expect(relTime(ago(0.2), NOW)).toBe('just now');
    expect(relTime(ago(4), NOW)).toBe('4m ago');
    expect(relTime(ago(180), NOW)).toBe('3h ago');
    expect(relTime(ago(60 * 72), NOW)).toBe('3d ago');
    expect(relTime(undefined, NOW)).toBe('?');
  });
  it('clips to one line', () => {
    expect(clip('a\n  b', 10)).toBe('a b');
    expect(clip('abcdefghij', 5)).toBe('abcd…');
  });
});

describe('notes and board', () => {
  it('formats a note line like the spec', () => {
    const n = note({ taskId: 'T4', text: 'Which token format should the share dialog use for the avatar radius?', replies: [{ at: ago(1), from: 'captain', text: 'Use radius-md' }] });
    expect(formatNoteLine(n, NOW, 20)).toBe('N14 [stuck] crew-3 · T4 · 4m ago · "Which token format…" (1 reply)');
  });
  it('shows recipients, reply counts and closed state', () => {
    const n = note({ type: 'waiting', to: 'crew-2', open: false, replies: [{ at: ago(1), from: 'a', text: 'x' }, { at: ago(1), from: 'b', text: 'y' }] });
    expect(formatNoteLine(n, NOW)).toBe('N14 [waiting] crew-3 → crew-2 · 4m ago · "Which token format?" (2 replies) [closed]');
    expect(formatNoteLine(note({ type: 'progress', open: false }), NOW)).not.toContain('[closed]');
  });
  it('lists the board with latest replies of open notes', () => {
    const out = formatBoard([note({ replies: [{ at: ago(2), from: 'crew-2', text: 'Use tokens.json' }] }), note({ id: 'N15', type: 'progress', open: false })], NOW);
    expect(out.split('\n')).toEqual([
      'N14 [stuck] crew-3 · 4m ago · "Which token format?" (1 reply)',
      '    ↳ crew-2 · 2m ago: Use tokens.json',
      'N15 [progress] crew-3 · 4m ago · "Which token format?"',
    ]);
    expect(formatBoard([], NOW)).toMatch(/clear/);
    expect(formatBoard(Array.from({ length: 5 }, (_, i) => note({ id: `N${i}` })), NOW, { limit: 2 })).toContain('… 3 more');
  });
  it('maps filters to query strings', () => {
    expect(boardQuery(undefined, 'crew-2')).toBe('?open=1');
    expect(boardQuery('all', 'crew-2')).toBe('');
    expect(boardQuery('mine', 'crew-2')).toBe('?from=crew-2');
    expect(boardQuery('to-me', 'crew-2')).toBe('?to=crew-2');
    expect(boardQuery('needs-you', 'captain')).toBe('?needsYou=1');
    expect(boardQuery('stuck', 'captain')).toBe('?type=stuck');
  });
});

describe('agents, tasks, inbox', () => {
  it('formats agents and tasks', () => {
    const a = { id: 'crew-2', role: 'crew', status: 'working', branch: 'crew-2/share', taskId: 'T3', costUsd: 1.234 } as Agent;
    expect(formatAgentLine(a)).toBe('crew-2 (crew) · working · crew-2/share · task T3 · $1.23');
    const t = { id: 'T3', title: 'Share dialog', status: 'in_progress', stations: ['build', 'test', 'review'], stationIndex: 1, assignee: 'crew-2', dependsOn: ['T1'] } as unknown as Task;
    expect(formatTaskLine(t)).toBe('T3 [in_progress] Share dialog · station test 2/3 · @crew-2 · needs T1');
    expect(formatTaskLine({ ...t, goalId: 'G3' })).toBe('T3 [in_progress] Share dialog · station test 2/3 · goal G3 · @crew-2 · needs T1');
  });
  it('formats the inbox', () => {
    const i = { id: 'I3', at: ago(1), agentId: 'crew-2', from: 'captain', kind: 'reply', text: 'Use radius-md', noteId: 'N14', read: false, delivered: true } as InboxItem;
    expect(formatInbox([i], NOW)).toBe('I3 reply from captain (N14) · 1m ago: Use radius-md');
    expect(formatInbox([], NOW)).toBe('Inbox empty.');
    const m = { ...i, kind: 'message', noteId: undefined, text: 'message from captain: check T3', feedId: 'F12' } as InboxItem;
    expect(formatInbox([m], NOW)).toBe('I3 message from captain · 1m ago: [F12] message from captain: check T3');
    expect(formatInbox([m], NOW, false)).toBe('I3 message from captain · 1m ago: message from captain: check T3');
  });
});

describe('diff and tests', () => {
  it('formats and truncates diffs', () => {
    expect(formatDiff({ branch: 'b', base: 'main', stat: '', diff: '' })).toBe('b vs main: no changes.');
    const out = formatDiff({ branch: 'b', base: 'main', stat: ' a.ts | 2 +-', diff: 'x'.repeat(100) }, 10);
    expect(out).toContain('b vs main');
    expect(out).toContain('a.ts | 2 +-');
    expect(out).toContain('90 more chars');
  });
  it('formats test results keeping the tail', () => {
    expect(formatTests({ command: 'npm test', exitCode: 0, output: 'ok' })).toBe('PASS (exit 0) · npm test\nok');
    const f = formatTests({ command: 'npm test', exitCode: 1, output: 'a'.repeat(50) + 'END' }, 5);
    expect(f.startsWith('FAIL (exit 1)')).toBe(true);
    expect(f.endsWith('aaEND')).toBe(true);
  });
  it('recognises task ids', () => {
    expect(isTaskId('T12')).toBe(true);
    expect(isTaskId('Build the API')).toBe(false);
  });
});

describe('roadmap', () => {
  it('says clearly when there is no roadmap', () => {
    expect(formatRoadmap({ roadmap: null, progress: null })).toBe(NO_ROADMAP);
    expect(formatRoadmap(null)).toBe('No roadmap yet — draft one with set_roadmap before posting build tasks.');
  });
  it('renders a compact outline with the current stage expanded', () => {
    expect(formatRoadmap({ roadmap: ROADMAP, progress: PROGRESS }).split('\n')).toEqual([
      'Roadmap: wall-education v1.0 · approved rev 2 · 42% (5/12 tasks) · at risk · launch 2026-11-15 (44 days to go)',
      '  M1 Foundations · 2026-09-01 → 2026-09-14 · done · 100% done · criteria 1/1',
      '▶ M2 Core wall · 2026-09-15 → 2026-10-10 · active · 25% at risk · criteria 1/3',
      '      G2 [active] ◀ current Posting · 40% (2/5 tasks) · crew-2, crew-3',
      '      G3 [planned] Reactions · 0% (0/3 tasks) · ? → 2026-10-08',
      '    Exit criteria left (check_criterion M2 <n>):',
      '      2. Students can react',
      '      3. Load test passes',
      '  M3 Launch · no dates · planned · 0% not started · criteria 0/0',
    ]);
  });
  it('flags drafts and works without progress', () => {
    const draft = { ...ROADMAP, status: 'draft' as const, noteId: 'N40', launchDate: undefined };
    const out = formatRoadmap({ roadmap: draft, progress: null });
    expect(out.split('\n')[0]).toBe("Roadmap: wall-education v1.0 · DRAFT rev 2, waiting for the user's approval (N40) · no launch date");
    expect(out).toContain('  M2 Core wall · 2026-09-15 → 2026-10-10 · active · criteria 1/3');
  });
  it('points at complete_stage once every criterion is ticked', () => {
    const r = structuredClone(ROADMAP);
    r.stages[1].exitCriteria.forEach((c) => (c.done = true));
    expect(formatRoadmap({ roadmap: r, progress: { ...PROGRESS, daysToLaunch: -2 } })).toContain('    All exit criteria ticked: complete_stage M2.');
    expect(formatRoadmap({ roadmap: r, progress: { ...PROGRESS, daysToLaunch: -2 } })).toContain('(2 days past)');
  });
});

describe('research ideas', () => {
  const idea = (p: Partial<ResearchIdea> = {}): ResearchIdea => ({
    id: 'R7', runId: 'RR1', title: 'Moderation queue', summary: ' Teachers want to hold posts for review. ', impact: 'high', effort: 'M',
    evidence: [], status: 'new', thread: [], createdAt: ago(60), ...p,
  });
  it('formats one compact line per idea', () => {
    expect(formatIdeaLine(idea({ stageId: 'M3' }))).toBe('R7 [new] Moderation queue · impact high · effort M · fits M3 · 0 evidence');
    expect(formatIdeaLine(idea({ status: 'approved' }))).toContain('[approved, not on the roadmap yet]');
    expect(formatIdeaLine(idea({ status: 'approved', goalId: 'G14' }))).toContain('[approved → G14]');
    expect(formatIdeaLine(idea({ thread: [{ at: ago(5), from: 'you', text: 'q' }] }))).toMatch(/· question waiting for your advice$/);
    expect(formatIdeaLine(idea({ thread: [{ at: ago(5), from: 'you', text: 'q' }, { at: ago(1), from: 'captain', text: 'a' }] }))).toMatch(/· advised$/);
    expect(formatIdeas([])).toBe('No research ideas match.');
    expect(formatIdeas([idea(), idea({ id: 'R8' })]).split('\n')).toHaveLength(2);
  });
  it('formats the full idea with evidence, thread and plan', () => {
    const text = formatIdeaDetail(
      idea({
        evidence: [
          { kind: 'review', source: 'App Store · Padlet · 2★', text: 'x'.repeat(400), url: 'https://apps.apple.com/x', count: 12 },
          { kind: 'competitor', source: 'Wakelet public roadmap' },
        ],
        thread: [{ at: ago(5), from: 'you', text: 'How big is it?' }],
        plan: ['+ Add goal Moderation queue to M3'],
      }),
      NOW,
    ).split('\n');
    expect(text[2]).toBe('Teachers want to hold posts for review.');
    expect(text).toContain('Evidence:');
    expect(text.find((l) => l.startsWith('- [review]'))).toMatch(/^- \[review\] App Store · Padlet · 2★ \(\+12 similar\): "x+…" <https:\/\/apps\.apple\.com\/x>$/);
    expect(text).toContain('- [competitor] Wakelet public roadmap');
    expect(text).toContain('- you · 5m ago: How big is it?');
    expect(text.slice(-2)).toEqual(['Plan on approval:', '- + Add goal Moderation queue to M3']);
  });
});
