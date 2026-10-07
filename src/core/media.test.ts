import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MediaStore, MusterState, Task } from '../types.js';
import {
  acceptSuggestion,
  aboutTasks,
  approvePiece,
  askPiece,
  confirmClaim,
  createPiece,
  deletePiece,
  dismissAllSuggestions,
  dismissSuggestion,
  editPiece,
  emptyMedia,
  failCurrent,
  finishDraft,
  isoWeek,
  markUsed,
  MediaFile,
  mediaBrief,
  mediaSummary,
  migrateMedia,
  requirePiece,
  resolveAbout,
  retryPiece,
  saveDraft,
  setHouseStyle,
  startNext,
  suggestFeature,
  syncStageSuggestions,
  weeklyCheck,
} from './media.js';
import { approveRoadmap, setRoadmap } from './roadmap.js';
import { emptyState } from './store.js';
import { makeAgent } from './testutil.js';

let s: MusterState;
let m: MediaStore;
const status = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { status?: number }).status;
  }
  return 200;
};

function addTask(id: string, over: Partial<Task> = {}): Task {
  const at = '2026-10-01T10:00:00.000Z';
  const t: Task = { id, title: `Task ${id}`, description: `Does ${id}`, dependsOn: [], stations: ['review'], stationIndex: 0, status: 'merged', createdBy: 'captain', createdAt: at, updatedAt: at, history: [{ at, agentId: 'captain', kind: 'merged' }], ...over };
  s.tasks.push(t);
  return t;
}

const social = () => createPiece(m, s, 'you', { kind: 'social', about: [{ kind: 'stage', ref: 'm1' }] });

beforeEach(() => {
  s = emptyState('/repo');
  s.agents.push(makeAgent('captain', 'captain'), makeAgent('crew-2', 'crew'), makeAgent('herald', 'media', { branch: 'main', worktree: '/repo' }));
  setRoadmap(s, { title: 'wall v1', summary: 'A wall for classes.', stages: [{ title: 'Moderation', goals: [{ title: 'Approve posts' }] }, { title: 'Export', goals: [{ title: 'PDF' }] }] }, 'captain');
  approveRoadmap(s, 'you');
  m = emptyMedia();
  addTask('T38', { goalId: 'G1', title: 'Approval queue', evidence: [{ id: 'E2', station: 'build', by: 'crew-2', at: '2026-10-01T10:00:00.000Z', summary: 'queue screenshot', files: [{ name: 'queue.png', kind: 'image', bytes: 10 }] }] });
});

describe('store', () => {
  it('migrates partial files and keeps id counters above ids in use', () => {
    const raw = { pieces: [{ id: 'MP7' }], suggestions: [{ id: 'MS3' }] } as unknown as Partial<MediaStore>;
    const x = migrateMedia(raw);
    expect(x.nextIds).toEqual({ piece: 8, suggestion: 4 });
    expect(x.houseStyle).toMatch(/Plain words/);
    expect(x.pieces[0].claims).toEqual([]);
  });

  it('loads, commits (rev + 1, change event) and sets a corrupt file aside', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muster-media-'));
    const file = join(dir, 'media.json');
    const f = new MediaFile(file, { log: () => {} });
    let seen = 0;
    f.on('change', (rev) => (seen = rev));
    f.store.houseStyle = 'Short.';
    f.commit();
    expect(seen).toBe(1);
    expect(new MediaFile(file).store).toMatchObject({ rev: 1, houseStyle: 'Short.' });
    writeFileSync(file, '{oops');
    const logs: string[] = [];
    expect(new MediaFile(file, { log: (l) => logs.push(l) }).store.rev).toBe(0);
    expect(logs[0]).toMatch(/could not be read/);
    expect(readdirSync(dir).some((n) => n.startsWith('media.json.corrupt-'))).toBe(true);
  });
});

describe('pieces', () => {
  it('creates queued pieces for you only, resolving labels and default platforms', () => {
    expect(status(() => createPiece(m, s, 'captain', { kind: 'social', about: [{ kind: 'stage', ref: 'M1' }] }))).toBe(403);
    expect(status(() => createPiece(m, s, 'you', { kind: 'poem', about: [{ kind: 'stage', ref: 'M1' }] }))).toBe(400);
    expect(status(() => createPiece(m, s, 'you', { kind: 'social', about: [] }))).toBe(400);
    expect(status(() => createPiece(m, s, 'you', { kind: 'social', about: [{ kind: 'stage', ref: 'M9' }] }))).toBe(400);
    expect(status(() => createPiece(m, s, 'you', { kind: 'social', about: [{ kind: 'range', ref: '2026-10-07..2026-10-01' }] }))).toBe(400);
    const p = createPiece(m, s, 'you', { kind: 'social', about: [{ kind: 'stage', ref: 'm1' }, { kind: 'task', ref: 't38' }], note: ' for teachers ' });
    expect(p).toMatchObject({ id: 'MP1', status: 'queued', platforms: ['x', 'linkedin', 'bluesky'], note: 'for teachers', title: 'Social post: Stage M1 · Moderation, T38 Approval queue' });
    expect(p.about[1]).toEqual({ kind: 'task', ref: 'T38', label: 'T38 Approval queue' });
    const a = createPiece(m, s, 'you', { kind: 'article', about: [{ kind: 'range', ref: '2026-10-01..2026-10-07' }], platforms: ['x'] });
    expect(a.platforms).toBeUndefined();
    expect(a.about[0].label).toBe('Merged 1 Oct – 7 Oct');
    expect(createPiece(m, s, 'you', { kind: 'social', about: [{ kind: 'goal', ref: 'G1' }], platforms: ['threads', 'threads'] }).platforms).toEqual(['threads']);
    expect(mediaSummary(m)).toMatchObject({ review: 0, drafting: 3, openSuggestions: 0 });
  });

  it('runs one draft at a time: queue → drafting → review, with a board note', () => {
    const p = social();
    const q = createPiece(m, s, 'you', { kind: 'video', about: [{ kind: 'task', ref: 'T38' }] });
    expect(startNext(m)?.id).toBe(p.id);
    expect(startNext(m)).toBeUndefined();
    expect(requirePiece(m, 'current').id).toBe(p.id);
    expect(mediaSummary(m).working).toMatchObject({ id: 'MP1', progress: 'starting' });
    expect(status(() => saveDraft(m, s, 'crew-2', p.id, { title: 'x' }))).toBe(403);
    expect(status(() => saveDraft(m, s, 'herald', q.id, { title: 'x' }))).toBe(409);
    expect(status(() => saveDraft(m, s, 'herald', p.id, { sections: [] }))).toBe(400);
    expect(status(() => finishDraft(m, s, 'herald', p.id))).toBe(409); // no posts yet
    saveDraft(m, s, 'herald', 'current', {
      title: 'Teachers approve posts first',
      progress: 'writing X',
      posts: [
        { platform: 'x', versions: ['A', 'B', 'C'], chosen: 1 },
        { platform: 'linkedin', versions: ['L'] },
      ],
      images: [{ taskId: 't38', evidenceId: 'e2', name: 'queue.png', caption: 'After' }],
      claims: [{ quote: 'teachers approve', sources: [{ kind: 'task', ref: 'T38', label: 'T38 merged' }] }, { quote: 'thirty classmates', sources: [] }],
    });
    expect(status(() => saveDraft(m, s, 'herald', p.id, { images: [{ taskId: 'T38', evidenceId: 'E2', name: 'nope.png' }] }))).toBe(400);
    expect(status(() => saveDraft(m, s, 'herald', p.id, { posts: [{ platform: 'x', versions: ['a', 'b', 'c', 'd'] }] }))).toBe(400);
    expect(p.claims.map((c) => c.id)).toEqual(['C1', 'C2']);
    expect(status(() => finishDraft(m, s, 'herald', p.id))).toBe(409); // bluesky missing
    saveDraft(m, s, 'herald', p.id, { posts: [...p.posts!, { platform: 'bluesky', versions: ['B'] }] });
    finishDraft(m, s, 'herald', p.id, 'Three versions per platform.');
    expect(p).toMatchObject({ status: 'review' });
    expect(p.progress).toBeUndefined();
    const note = s.notes.at(-1)!;
    expect(note).toMatchObject({ topic: 'media', type: 'system', to: 'you', open: true, from: 'herald' });
    expect(note.text).toBe('herald finished MP1 · Teachers approve posts first\nThree versions per platform. 1 claim needs a source or your OK.');
    expect(startNext(m)?.id).toBe(q.id);
    expect(mediaSummary(m)).toMatchObject({ review: 1, drafting: 1 });
  });

  it('blocks approval on unsourced claims until you confirm them, then settles the note', () => {
    const p = social();
    startNext(m);
    saveDraft(m, s, 'herald', p.id, { posts: ['x', 'linkedin', 'bluesky'].map((platform) => ({ platform, versions: ['hi'] })), claims: [{ quote: 'no source', sources: [] }] });
    finishDraft(m, s, 'herald', p.id);
    expect(status(() => approvePiece(m, s, 'herald', p.id))).toBe(403);
    expect(status(() => approvePiece(m, s, 'you', p.id))).toBe(409);
    expect(status(() => confirmClaim(m, 'you', p.id, 'C9'))).toBe(404);
    confirmClaim(m, 'you', p.id, 'c1');
    confirmClaim(m, 'you', p.id, 'C1');
    expect(p.claims[0].sources).toEqual([{ kind: 'opinion', ref: '', label: 'opinion · your voice' }]);
    approvePiece(m, s, 'you', p.id);
    expect(p.status).toBe('approved');
    expect(s.notes.at(-1)).toMatchObject({ open: false, dismissed: true });
    expect(status(() => approvePiece(m, s, 'you', p.id))).toBe(409);
    // An edit after approval needs a fresh look.
    editPiece(m, s, 'you', p.id, { posts: [{ platform: 'x', versions: ['edited'] }] });
    expect(p).toMatchObject({ status: 'review' });
    expect(p.approvedAt).toBeUndefined();
    expect(p.editedAt).toBeTruthy();
    approvePiece(m, s, 'you', p.id);
    markUsed(m, s, 'you', p.id);
    expect(p.status).toBe('used');
    expect(status(() => markUsed(m, s, 'you', p.id))).toBe(409);
  });

  it('edits: you only, never while drafting, never claims or status, fields per kind', () => {
    const p = createPiece(m, s, 'you', { kind: 'article', about: [{ kind: 'stage', ref: 'M1' }] });
    expect(status(() => editPiece(m, s, 'captain', p.id, { title: 'x' }))).toBe(403);
    expect(status(() => editPiece(m, s, 'you', p.id, { claims: [] }))).toBe(400);
    expect(status(() => editPiece(m, s, 'you', p.id, { posts: [] }))).toBe(400);
    editPiece(m, s, 'you', p.id, { title: 'My title', sections: [{ heading: 'The ask', text: 'Teachers asked.' }] });
    expect(p.sections).toEqual([{ id: 'S1', heading: 'The ask', text: 'Teachers asked.', status: 'done' }]);
    startNext(m);
    expect(status(() => editPiece(m, s, 'you', p.id, { title: 'x' }))).toBe(409);
    const v = createPiece(m, s, 'you', { kind: 'video', about: [{ kind: 'task', ref: 'T38' }] });
    editPiece(m, s, 'you', v.id, { hooks: ['One', 'Two'], hookChosen: 1, shots: [{ at: '0:00', shot: 'Empty wall', voiceover: 'Monday.', record: true }] });
    expect(v).toMatchObject({ hookChosen: 1, shots: [{ at: '0:00', shot: 'Empty wall', voiceover: 'Monday.', record: true }] });
    expect(status(() => editPiece(m, s, 'you', v.id, { hookChosen: 2 }))).toBe(400);
    expect(status(() => editPiece(m, s, 'you', v.id, { shots: [{ at: 'soon', shot: 'x' }] }))).toBe(400);
    const w = createPiece(m, s, 'you', { kind: 'website', about: [{ kind: 'stage', ref: 'M1' }] });
    editPiece(m, s, 'you', w.id, { target: '/features/moderation' });
    expect(w.target).toBe('/features/moderation');
  });

  it('asks for changes: a finished piece goes back to the queue; finishing marks requests done', () => {
    const p = social();
    startNext(m);
    saveDraft(m, s, 'herald', p.id, { posts: ['x', 'linkedin', 'bluesky'].map((platform) => ({ platform, versions: ['hi'] })) });
    askPiece(m, 'you', p.id, 'Shorter'); // while drafting: stays drafting
    expect(p.status).toBe('drafting');
    finishDraft(m, s, 'herald', p.id);
    expect(p.requests[0].doneAt).toBeTruthy();
    expect(status(() => askPiece(m, 'you', p.id, ''))).toBe(400);
    askPiece(m, 'you', p.id, 'End with a question');
    expect(p.status).toBe('queued');
    expect(p.requests.filter((r) => !r.doneAt).map((r) => r.text)).toEqual(['End with a question']);
  });

  it('fails the current draft when herald dies, and retries', () => {
    const p = social();
    expect(failCurrent(m, 'x')).toBeUndefined();
    startNext(m);
    expect(failCurrent(m, 'herald exited')?.id).toBe(p.id);
    expect(p).toMatchObject({ status: 'failed', error: 'herald exited' });
    expect(status(() => retryPiece(m, 'you', 'MP9'))).toBe(404);
    retryPiece(m, 'you', p.id);
    expect(p.status).toBe('queued');
    expect(p.error).toBeUndefined();
    expect(status(() => retryPiece(m, 'you', p.id))).toBe(409);
  });

  it('deletes and sets the house style (you only)', () => {
    const p = social();
    expect(status(() => deletePiece(m, s, 'herald', p.id))).toBe(403);
    deletePiece(m, s, 'you', p.id);
    expect(m.pieces).toEqual([]);
    expect(status(() => setHouseStyle(m, 'herald', 'x'))).toBe(403);
    expect(setHouseStyle(m, 'you', ' Short and warm. ')).toBe('Short and warm.');
  });
});

describe('suggestions', () => {
  it('suggests each recently done stage once', () => {
    expect(syncStageSuggestions(m, s)).toEqual([]);
    const stage = s.roadmap!.stages[0];
    stage.status = 'done';
    stage.completedAt = new Date().toISOString();
    s.roadmap!.stages[1].status = 'done';
    s.roadmap!.stages[1].completedAt = new Date(Date.now() - 30 * 24 * 3600_000).toISOString(); // too old
    const [made] = syncStageSuggestions(m, s);
    expect(made).toMatchObject({ id: 'MS1', trigger: 'stage', ref: 'M1', status: 'open', title: 'Moderation is done', summary: 'Article + social post + a changelog entry. Built from 1 merged task and 1 screenshot.' });
    expect(made.plan.map((p) => p.kind)).toEqual(['article', 'social', 'website']);
    expect(syncStageSuggestions(m, s)).toEqual([]);
  });

  it('accepts (one piece per plan item), dismisses, dismisses all', () => {
    s.roadmap!.stages[0].status = 'done';
    s.roadmap!.stages[0].completedAt = new Date().toISOString();
    const [sg] = syncStageSuggestions(m, s);
    expect(status(() => acceptSuggestion(m, s, 'captain', sg.id))).toBe(403);
    const pieces = acceptSuggestion(m, s, 'you', sg.id);
    expect(pieces.map((p) => [p.id, p.kind, p.status, p.suggestionId])).toEqual([
      ['MP1', 'article', 'queued', 'MS1'],
      ['MP2', 'social', 'queued', 'MS1'],
      ['MP3', 'website', 'queued', 'MS1'],
    ]);
    expect(sg).toMatchObject({ status: 'accepted', pieceIds: ['MP1', 'MP2', 'MP3'] });
    expect(status(() => acceptSuggestion(m, s, 'you', sg.id))).toBe(409);
    expect(status(() => suggestFeature(m, s, 'crew-2', { task: 'T38', title: 't', why: 'w' }))).toBe(403);
    addTask('T41', { status: 'in_progress', history: [] });
    expect(status(() => suggestFeature(m, s, 'captain', { task: 'T41', title: 'PDF', why: 'w' }))).toBe(409);
    const f = suggestFeature(m, s, 'captain', { task: 't38', title: 'Approve before publish', why: 'Teachers asked.' });
    expect(f).toMatchObject({ trigger: 'feature', ref: 'T38', about: [{ kind: 'task', ref: 'T38' }] });
    expect(status(() => suggestFeature(m, s, 'captain', { task: 'T38', title: 'again', why: 'w' }))).toBe(409);
    // Change the plan: a new piece with suggestionId accepts it.
    const p = createPiece(m, s, 'you', { kind: 'social', about: [{ kind: 'task', ref: 'T38' }], suggestionId: f.id, platforms: ['x'] });
    expect(f).toMatchObject({ status: 'accepted', pieceIds: [p.id] });
    s.roadmap!.stages[1].status = 'done';
    s.roadmap!.stages[1].completedAt = new Date().toISOString();
    const [two] = syncStageSuggestions(m, s);
    dismissSuggestion(m, 'you', two.id);
    expect(status(() => dismissSuggestion(m, 'you', two.id))).toBe(409);
    expect(status(() => createPiece(m, s, 'you', { kind: 'social', about: [{ kind: 'stage', ref: 'M2' }], suggestionId: two.id }))).toBe(409);
    expect(dismissAllSuggestions(m, 'you')).toBe(0);
  });

  it('suggests a weekly roundup once per week with five or more merged tasks', () => {
    // Wed 7 Oct 2026 → last week is Mon 28 Sep – Sun 4 Oct (2026-W40).
    const now = new Date(2026, 9, 7, 12);
    expect(isoWeek(new Date(2026, 9, 1)).label).toBe('2026-W40');
    expect(isoWeek(new Date(2027, 0, 1)).label).toBe('2026-W53');
    const merged = (id: string, d: Date) => addTask(id, { history: [{ at: d.toISOString(), agentId: 'captain', kind: 'merged' }] });
    for (let i = 0; i < 3; i++) merged(`T${50 + i}`, new Date(2026, 8, 29 + i, 12)); // + T38 on 1 Oct = 4
    expect(weeklyCheck(m, s, now)).toBeUndefined();
    expect(m.lastWeekly).toBe('2026-W40');
    merged('T60', new Date(2026, 9, 4, 20));
    expect(weeklyCheck(m, s, now)).toBeUndefined(); // already considered
    m.lastWeekly = undefined;
    const w = weeklyCheck(m, s, now)!;
    expect(w).toMatchObject({ trigger: 'weekly', ref: '2026-W40', title: 'Week 40: 5 tasks merged', about: [{ kind: 'range', ref: '2026-09-28..2026-10-04' }] });
    expect(w.plan.map((p) => p.kind)).toEqual(['article', 'video']);
    expect(aboutTasks(s, w.about).map((t) => t.id).sort()).toEqual(['T38', 'T50', 'T51', 'T52', 'T60']);
  });
});

describe('brief', () => {
  it('says what herald writes from: piece, requests, style, tasks with evidence paths, chat, rules', () => {
    expect(mediaBrief(m, s)).toMatch(/No piece is being drafted/);
    const p = createPiece(m, s, 'you', { kind: 'social', about: [{ kind: 'stage', ref: 'M1' }], note: 'For teachers' });
    askPiece(m, 'you', p.id, 'Mention the free plan');
    s.feed.push({ id: 'F9', at: '2026-10-01T09:00:00.000Z', kind: 'message', from: 'crew-2', text: 'T38 queue hides held posts from students' });
    startNext(m);
    const text = mediaBrief(m, s, { evidenceFile: (t, e, n) => `/repo/.muster/evidence/${t.id}/${e}/${n}`, userName: 'Wayne', projectName: 'wall-education' });
    expect(text).toContain('# MP1 · Social post for wall-education');
    expect(text).toContain('x (≤ 280 chars), linkedin (≤ 3000 chars), bluesky (≤ 300 chars)');
    expect(text).toContain('Note from Wayne: For teachers');
    expect(text).toContain('- Mention the free plan');
    expect(text).toContain('Task T38 Approval queue (merged, merged 2026-10-01)');
    expect(text).toContain('T38/E2 · queue.png (image) · /repo/.muster/evidence/T38/E2/queue.png');
    expect(text).toContain('F9 2026-10-01 crew-2: T38 queue hides held posts from students');
    expect(text).toContain('## House style');
    expect(text).toMatch(/Plain text only/);
  });

  it('resolves about items of every kind', () => {
    expect(resolveAbout(s, { kind: 'goal', ref: 'g2' })).toEqual({ kind: 'goal', ref: 'G2', label: 'G2 PDF' });
    expect(status(() => resolveAbout(s, { kind: 'idea', ref: 'R1' }))).toBe(400);
    expect(status(() => resolveAbout(s, 'M1'))).toBe(400);
  });
});

it('keeps the store JSON-serialisable', () => {
  social();
  expect(JSON.parse(JSON.stringify(m)).pieces[0].id).toBe('MP1');
});
