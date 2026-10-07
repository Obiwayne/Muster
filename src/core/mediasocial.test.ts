import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MediaPiece, MediaStore, MusterState } from '../types.js';
import { approvePiece, createPiece, deletePiece, emptyMedia, finishDraft, fullText, hashtags, mediaSummary, migrateMedia, saveDraft, startNext } from './media.js';
import {
  addConversations,
  cancelJob,
  confirmConversationClaim,
  editConversation,
  failWork,
  goJob,
  hasWork,
  localDay,
  pickWork,
  pngSize,
  publishDecision,
  publishDone,
  publishFailed,
  publishNext,
  publishReady,
  readPngSize,
  repliesToday,
  replyConversation,
  requestDesign,
  requestResearch,
  saveDesigns,
  saveResearch,
  setReplyPolicy,
  skipConversation,
  startPublish,
  stopPublish,
  watchCheck,
  watchDone,
  workBrief,
  workLabel,
  workOpen,
} from './mediasocial.js';
import { setRoadmap, approveRoadmap } from './roadmap.js';
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

/** A minimal valid PNG header (signature + IHDR with the given size). */
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** An approved social piece on x and linkedin, with hashtags on x. */
function approved(): MediaPiece {
  const p = createPiece(m, s, 'you', { kind: 'social', about: [{ kind: 'stage', ref: 'M1' }], platforms: ['x', 'linkedin', 'instagram'] });
  pickWork(m);
  saveDraft(m, s, 'herald', p.id, {
    posts: [
      { platform: 'x', versions: ['Teachers approve posts first.'], hashtags: ['#edtech', 'Teachers'] },
      { platform: 'linkedin', versions: ['Longer post.'] },
      { platform: 'instagram', versions: ['Caption.'] },
    ],
  });
  finishDraft(m, s, 'herald', p.id);
  approvePiece(m, s, 'you', p.id);
  return p;
}

beforeEach(() => {
  s = emptyState('/repo');
  s.agents.push(makeAgent('captain', 'captain'), makeAgent('herald', 'media', { branch: 'main', worktree: '/repo' }));
  setRoadmap(s, { title: 'wall v1', summary: 'A wall.', stages: [{ title: 'Moderation', goals: [{ title: 'Approve posts' }] }] }, 'captain');
  approveRoadmap(s, 'you');
  m = emptyMedia();
});

describe('hashtags and full text', () => {
  it('stores hashtags without "#", rejects odd ones, drops repeats', () => {
    expect(hashtags(['#EdTech', 'teachers', 'edtech', 'UK_Ed'])).toEqual(['EdTech', 'teachers', 'UK_Ed']);
    expect(status(() => hashtags(['two words']))).toBe(400);
    expect(status(() => hashtags(['emoji🙂']))).toBe(400);
    expect(status(() => hashtags(Array.from({ length: 31 }, (_, i) => `t${i}`)))).toBe(400);
  });

  it('full text = chosen version + blank line + hashtags; drafts keep them per platform', () => {
    expect(fullText({ platform: 'x', versions: ['A', 'B'], chosen: 1, hashtags: ['edtech', 'teachers'] })).toBe('B\n\n#edtech #teachers');
    expect(fullText({ platform: 'x', versions: ['A'], chosen: 0 })).toBe('A');
    const p = approved();
    expect(p.posts!.find((x) => x.platform === 'x')!.hashtags).toEqual(['edtech', 'Teachers']);
    expect(p.posts!.find((x) => x.platform === 'linkedin')!.hashtags).toBeUndefined();
  });
});

describe('posting through your Chrome', () => {
  const images = (piece: MediaPiece, platform: string) => (platform === 'instagram' ? [] : [`/m/${piece.id}/${platform}.png`]);

  it('makes one job per platform with the full text and images; instagram needs an image; only approved pieces', () => {
    const p = approved();
    const draft = createPiece(m, s, 'you', { kind: 'social', about: [{ kind: 'stage', ref: 'M1' }] });
    expect(status(() => startPublish(m, 'you', draft.id, ['x'], images))).toBe(409);
    expect(status(() => startPublish(m, 'herald', p.id, ['x'], images))).toBe(403);
    expect(status(() => startPublish(m, 'you', p.id, ['instagram'], images))).toBe(400);
    expect(status(() => startPublish(m, 'you', p.id, ['facebook'], images))).toBe(400); // no facebook post
    const jobs = startPublish(m, 'you', p.id, ['x', 'linkedin'], images);
    expect(jobs.map((j) => [j.id, j.platform, j.status, j.kind])).toEqual([
      ['PJ1', 'x', 'queued', 'post'],
      ['PJ2', 'linkedin', 'queued', 'post'],
    ]);
    expect(jobs[0]).toMatchObject({ text: 'Teachers approve posts first.\n\n#edtech #Teachers', images: [`/m/${p.id}/x.png`], pieceId: p.id });
    expect(status(() => startPublish(m, 'you', p.id, ['x'], images))).toBe(409); // already going out
  });

  it('herald fills in, waits for your Post, posts once; the piece is used when nothing is left going out', () => {
    const p = approved();
    const [x, li] = startPublish(m, 'you', p.id, ['x', 'linkedin'], images);
    expect(pickWork(m)).toMatchObject({ kind: 'publish', id: x.id });
    expect(workLabel(m, m.current!)).toBe('Put post PJ1 into X');
    expect(pickWork(m)).toBeUndefined(); // busy
    expect(status(() => publishReady(m, s, 'herald', x.id, 'text', 1))).toBe(409); // still queued
    expect(publishNext(m, s, 'herald')).toMatchObject({ id: x.id, status: 'filling' });
    expect(status(() => goJob(m, 'you', x.id))).toBe(409); // not ready yet
    publishReady(m, s, 'herald', x.id, 'Teachers approve posts first. #edtech #Teachers', 1);
    expect(x).toMatchObject({ status: 'ready', composer: 'Teachers approve posts first. #edtech #Teachers', attached: 1 });
    expect(mediaSummary(m).publishReady).toBe(1);
    expect(publishDecision(m, x.id)).toBe('waiting');
    expect(status(() => publishDone(m, s, 'herald', x.id, 'https://x.com/a/1'))).toBe(409); // no go yet
    expect(status(() => goJob(m, 'herald', x.id))).toBe(403);
    goJob(m, 'you', x.id);
    expect(publishDecision(m, x.id)).toBe('go');
    expect(status(() => cancelJob(m, 'you', x.id))).toBe(409); // posting can't be stopped
    publishDone(m, s, 'herald', x.id, 'https://x.com/a/1');
    expect(x).toMatchObject({ status: 'posted', url: 'https://x.com/a/1' });
    expect(m.current).toBeUndefined();
    expect(p.status).toBe('approved'); // linkedin still queued
    expect(pickWork(m)).toMatchObject({ kind: 'publish', id: li.id });
    publishNext(m, s, 'herald');
    publishFailed(m, s, 'herald', li.id, 'not signed in', true);
    expect(li).toMatchObject({ status: 'signin', error: 'not signed in' });
    expect(p.status).toBe('approved'); // LinkedIn waits for a retry
    const [retry] = startPublish(m, 'you', p.id, ['linkedin'], images); // Retry after signing in
    expect(retry.id).toBe('PJ3');
    pickWork(m);
    publishNext(m, s, 'herald');
    publishReady(m, s, 'herald', retry.id, 'Longer post.', 0);
    goJob(m, 'you', retry.id);
    publishDone(m, s, 'herald', retry.id, 'https://linkedin.com/p/2');
    expect(p.status).toBe('used'); // nothing left going out
    expect(p.usedAt).toBeTruthy();
  });

  it('cancel and stop: herald hears cancel; stop leaves a post that is going out alone', () => {
    const p = approved();
    const [x, li] = startPublish(m, 'you', p.id, ['x', 'linkedin'], images);
    pickWork(m);
    publishNext(m, s, 'herald');
    publishReady(m, s, 'herald', x.id, 'text', 0);
    cancelJob(m, 'you', x.id);
    expect(publishDecision(m, x.id)).toBe('cancel');
    expect(workOpen(m)).toBe(false);
    expect(pickWork(m)).toMatchObject({ id: li.id });
    publishNext(m, s, 'herald');
    publishReady(m, s, 'herald', li.id, 'text', 0);
    goJob(m, 'you', li.id);
    const [again] = startPublish(m, 'you', p.id, ['x'], images);
    expect(stopPublish(m, 'you', p.id).map((j) => j.id)).toEqual([again.id]);
    expect(li.status).toBe('posting');
  });

  it('herald stopping mid-post: not yet sent → Retry; while posting → check first', () => {
    const p = approved();
    const [x, li] = startPublish(m, 'you', p.id, ['x', 'linkedin'], images);
    pickWork(m);
    publishNext(m, s, 'herald');
    publishReady(m, s, 'herald', x.id, 't', 0);
    expect(failWork(m, 'herald exited')).toMatch(/PJ1 \(X\) failed: herald stopped before it went out/);
    expect(x.status).toBe('failed');
    pickWork(m);
    publishNext(m, s, 'herald');
    publishReady(m, s, 'herald', li.id, 't', 0);
    goJob(m, 'you', li.id);
    failWork(m, 'herald exited');
    expect(li.error).toMatch(/while posting .*check LinkedIn before you retry/);
  });

  it('deleting a piece cancels its posts that haven\'t gone out', () => {
    const p = approved();
    const [x] = startPublish(m, 'you', p.id, ['x'], images);
    deletePiece(m, s, 'you', p.id);
    expect(x.status).toBe('cancelled');
  });
});

describe('conversations and replies', () => {
  const item = (url: string, over: Record<string, unknown> = {}) => ({ platform: 'x', url, who: 'EdTech account', quote: 'Does it hold comments too?', why: 'They asked', draft: 'Yes, held posts stay hidden.', claims: [{ quote: 'held posts stay hidden', sources: [{ kind: 'task', ref: 'T1', label: 'T1 merged' }] }], ...over });

  it('herald adds them once per thread URL; you edit, confirm, skip', () => {
    expect(status(() => addConversations(m, s, 'you', [item('https://x.com/a/1')]))).toBe(403);
    const added = addConversations(m, s, 'herald', [item('https://x.com/a/1'), item('https://x.com/a/1'), item('https://x.com/b/2', { kind: 'own', claims: [{ quote: 'class code', sources: [] }], mentionsProduct: true })]);
    expect(added.map((c) => [c.id, c.kind, c.status, c.mentionsProduct])).toEqual([
      ['MC1', 'thread', 'draft', false],
      ['MC2', 'own', 'draft', true],
    ]);
    expect(addConversations(m, s, 'herald', [item('https://x.com/a/1')])).toEqual([]);
    expect(status(() => addConversations(m, s, 'herald', [item('not a link')]))).toBe(400);
    expect(mediaSummary(m).conversations).toBe(2);
    editConversation(m, 'you', 'mc1', 'Shorter.');
    expect(m.conversations![0].draft).toBe('Shorter.');
    expect(status(() => replyConversation(m, 'you', 'MC2'))).toBe(409); // unsourced claim
    confirmConversationClaim(m, 'you', 'MC2', 'C1');
    skipConversation(m, 'you', 'MC2');
    expect(m.conversations![1].status).toBe('skipped');
    expect(status(() => editConversation(m, 'you', 'MC2', 'x'))).toBe(409);
  });

  it('a reply goes out like a post; posted marks the conversation; the daily limit counts your local day', () => {
    setReplyPolicy(m, 'you', { perDay: 2 });
    expect(status(() => setReplyPolicy(m, 'you', { perDay: 21 }))).toBe(400);
    addConversations(m, s, 'herald', [item('https://x.com/a/1'), item('https://x.com/a/2'), item('https://x.com/a/3')]);
    const job = replyConversation(m, 'you', 'MC1');
    expect(job).toMatchObject({ kind: 'reply', conversationId: 'MC1', text: 'Yes, held posts stay hidden.', images: [], status: 'queued' });
    expect(m.conversations![0].status).toBe('queued');
    replyConversation(m, 'you', 'MC2');
    expect(repliesToday(m)).toBe(2);
    expect(status(() => replyConversation(m, 'you', 'MC3'))).toBe(409); // limit
    expect(repliesToday(m, new Date(Date.now() + 2 * 86_400_000))).toBe(0); // another day
    pickWork(m);
    publishNext(m, s, 'herald');
    publishReady(m, s, 'herald', job.id, 'Yes, held posts stay hidden.', 0);
    goJob(m, 'you', job.id);
    publishDone(m, s, 'herald', job.id, 'https://x.com/me/9');
    expect(m.conversations![0]).toMatchObject({ status: 'posted', postedUrl: 'https://x.com/me/9' });
    const second = m.publish![1];
    cancelJob(m, 'you', second.id);
    expect(m.conversations![1].status).toBe('draft'); // back to a draft
    expect(localDay('2026-10-07T23:30:00')).toBe('2026-10-07');
  });
});

describe('research', () => {
  it('herald saves research for a social piece; your Refresh queues it again (not while drafting)', () => {
    const p = createPiece(m, s, 'you', { kind: 'social', about: [{ kind: 'stage', ref: 'M1' }] });
    pickWork(m);
    const body = {
      platforms: ['x', 'linkedin'],
      query: ['class wall', 'student posts'],
      read: { posts: 46, articles: 9 },
      top: [{ platform: 'linkedin', text: 'I stopped using class walls…', who: 'Primary teacher', engagement: '2.1k reactions', url: 'https://linkedin.com/p/1', at: '2026-10-02' }, { platform: 'article', text: '5 safe ways', who: 'Teach Primary' }],
      themes: [{ text: 'Worry about posts appearing live', count: 31 }],
      hashtags: [{ tag: '#edtech', platforms: ['x', 'linkedin'], note: 'busy' }],
      used: ['Opened with the worry teachers raise most'],
    };
    expect(status(() => saveResearch(m, s, 'you', p.id, body))).toBe(403);
    expect(status(() => saveResearch(m, s, 'herald', p.id, { ...body, top: [{ platform: 'myspace', text: 'x', who: 'y' }] }))).toBe(400);
    saveResearch(m, s, 'herald', p.id, body);
    expect(p.research).toMatchObject({ read: { posts: 46, articles: 9 }, hashtags: [{ tag: 'edtech', platforms: ['x', 'linkedin'] }], top: [{ platform: 'linkedin' }, { platform: 'article' }] });
    expect(status(() => requestResearch(m, 'you', p.id))).toBe(409); // drafting
    saveDraft(m, s, 'herald', p.id, { posts: ['x', 'linkedin', 'facebook'].map((platform) => ({ platform, versions: ['hi'], hashtags: ['edtech'] })) });
    finishDraft(m, s, 'herald', p.id);
    requestResearch(m, 'you', p.id);
    expect(pickWork(m)).toMatchObject({ kind: 'research', id: p.id });
    saveResearch(m, s, 'herald', p.id, body);
    expect(p.researchQueued).toBeUndefined();
    expect(workOpen(m)).toBe(false);
    const article = createPiece(m, s, 'you', { kind: 'article', about: [{ kind: 'stage', ref: 'M1' }] });
    expect(status(() => requestResearch(m, 'you', article.id))).toBe(400);
  });
});

describe('post images in Vellum', () => {
  it('reads PNG sizes from the header', () => {
    expect(pngSize(png(1600, 900))).toEqual({ width: 1600, height: 900 });
    expect(pngSize(Buffer.from('GIF89a not a png at all......'))).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), 'muster-png-'));
    writeFileSync(join(dir, 'a.png'), png(1080, 1080));
    expect(readPngSize(join(dir, 'a.png'))).toEqual({ width: 1080, height: 1080 });
    expect(readPngSize(join(dir, 'missing.png'))).toBeUndefined();
  });

  it('you ask (only with Vellum set up); herald attaches exported PNGs, replacing per platform', () => {
    const p = approved();
    expect(status(() => requestDesign(m, 'you', p.id, { style: 'headline' }, false))).toBe(409);
    expect(status(() => requestDesign(m, 'you', p.id, { style: 'poster' }, true))).toBe(400);
    requestDesign(m, 'you', p.id, { style: 'features', note: 'use the queue screenshot' }, true);
    expect(p.designRequest).toMatchObject({ style: 'features', note: 'use the queue screenshot', platforms: ['x', 'linkedin', 'instagram'] });
    expect(pickWork(m)).toMatchObject({ kind: 'design', id: p.id });
    const dir = mkdtempSync(join(tmpdir(), 'muster-images-'));
    writeFileSync(join(dir, 'MP1-x.png'), png(1600, 900));
    writeFileSync(join(dir, 'MP1-ig.png'), png(1080, 1080));
    const size = (f: string) => readPngSize(join(dir, f));
    expect(status(() => saveDesigns(m, s, 'herald', p.id, [{ platform: 'x', file: '../MP1-x.png', caption: 'c' }], dir, size))).toBe(400);
    expect(status(() => saveDesigns(m, s, 'herald', p.id, [{ platform: 'x', file: 'nope.png', caption: 'c' }], dir, size))).toBe(400);
    saveDesigns(m, s, 'herald', p.id, [{ platform: 'x', file: 'MP1-x.png', caption: 'See every post first', vellum: { fileId: 'F1', nodeId: '12-0' } }, { platform: 'instagram', file: 'MP1-ig.png', caption: 'Square' }], dir, size);
    expect(p.designs!.map((d) => [d.id, d.platform, d.width, d.height, d.style])).toEqual([
      ['D1', 'x', 1600, 900, 'features'],
      ['D2', 'instagram', 1080, 1080, 'features'],
    ]);
    expect(p.designRequest).toBeUndefined();
    expect(workOpen(m)).toBe(false);
    writeFileSync(join(dir, 'MP1-x2.png'), png(1600, 900));
    saveDesigns(m, s, 'herald', p.id, [{ platform: 'x', file: 'MP1-x2.png', caption: 'v2' }], dir, size);
    expect(p.designs!.map((d) => d.file)).toEqual(['MP1-ig.png', 'MP1-x2.png']);
  });
});

describe("herald's queue", () => {
  it('hands out one thing at a time: posts, then images, then drafts, then research, then the comment check', () => {
    const done = approved(); // MP1, approved
    const q = createPiece(m, s, 'you', { kind: 'article', about: [{ kind: 'stage', ref: 'M1' }] });
    requestDesign(m, 'you', done.id, {}, true);
    requestResearch(m, 'you', done.id);
    m.watchQueuedAt = new Date().toISOString();
    startPublish(m, 'you', done.id, ['x'], () => ['/a.png']);
    expect(hasWork(m)).toBe(true);
    expect(pickWork(m)).toMatchObject({ kind: 'publish', id: 'PJ1' });
    publishNext(m, s, 'herald');
    publishFailed(m, s, 'herald', 'PJ1', 'page changed', false);
    expect(pickWork(m)).toMatchObject({ kind: 'design', id: done.id });
    expect(failWork(m, 'herald exited')).toMatch(/post images for MP1 weren't made/);
    expect(pickWork(m)).toMatchObject({ kind: 'draft', id: q.id });
    expect(q.status).toBe('drafting');
    saveDraft(m, s, 'herald', q.id, { sections: [{ heading: 'H', text: 'Body' }] });
    finishDraft(m, s, 'herald', q.id);
    expect(pickWork(m)).toMatchObject({ kind: 'research', id: done.id });
    failWork(m, 'stopped');
    expect(pickWork(m)).toMatchObject({ kind: 'watch' });
    watchDone(m, s, 'herald');
    expect(pickWork(m)).toBeUndefined();
    expect(hasWork(m)).toBe(false);
    expect(m.lastWatch).toBeTruthy();
  });

  it('a draft from before the queue existed is picked up as current work', () => {
    const p = createPiece(m, s, 'you', { kind: 'article', about: [{ kind: 'stage', ref: 'M1' }] });
    startNext(m);
    expect(pickWork(m)).toMatchObject({ kind: 'draft', id: p.id });
  });

  it('the comment check: once a day, only when on and something was posted in the last 14 days', () => {
    const now = Date.now();
    expect(watchCheck(m, now)).toBe(false); // nothing posted
    const p = approved();
    const [x] = startPublish(m, 'you', p.id, ['x'], () => ['/a.png']);
    pickWork(m);
    publishNext(m, s, 'herald');
    publishReady(m, s, 'herald', x.id, 't', 1);
    goJob(m, 'you', x.id);
    publishDone(m, s, 'herald', x.id, 'https://x.com/me/1');
    expect(watchCheck(m, now)).toBe(true);
    expect(watchCheck(m, now)).toBe(false); // already queued
    expect(workBrief(m, s, { imagesDir: () => '/i' })).toMatch(/Nothing to do/); // not handed out yet
    expect(pickWork(m)).toMatchObject({ kind: 'watch' });
    expect(workBrief(m, s, { imagesDir: () => '/i', userName: 'Wayne' })).toMatch(/X https:\/\/x\.com\/me\/1/);
    watchDone(m, s, 'herald');
    expect(watchCheck(m, now + 3600_000)).toBe(false); // < 24 h
    expect(watchCheck(m, now + 25 * 3600_000)).toBe(true);
    delete m.watchQueuedAt;
    setReplyPolicy(m, 'you', { watchOwn: false });
    expect(watchCheck(m, now + 50 * 3600_000)).toBe(false);
    expect(watchCheck(m, now + 20 * 86_400_000)).toBe(false);
  });

  it('briefs say exactly what to post and how; design briefs name the sizes and export folder', () => {
    const p = approved();
    startPublish(m, 'you', p.id, ['x'], () => ['C:/m/MP1/images/x.png']);
    pickWork(m);
    const b = workBrief(m, s, { imagesDir: () => '/i', userName: 'Wayne' });
    expect(b).toContain('# Put post PJ1 into X');
    expect(b).toContain('<<<\nTeachers approve posts first.\n\n#edtech #Teachers\n>>>');
    expect(b).toContain('- C:/m/MP1/images/x.png');
    expect(b).toContain('Wayne checks the tab and presses Post in Muster');
    expect(b).toMatch(/Only when it says go: press Post \(or Reply\) once/);
    publishNext(m, s, 'herald');
    publishFailed(m, s, 'herald', 'PJ1', 'x', false);
    requestDesign(m, 'you', p.id, { platforms: ['x', 'instagram'] }, true);
    pickWork(m);
    const d = workBrief(m, s, { imagesDir: (id) => `C:/repo/.muster/media/${id}/images`, vellumFile: 'F9' });
    expect(d).toContain('X 1600×900, Instagram 1080×1080');
    expect(d).toContain('outputDir "C:/repo/.muster/media/MP1/images"');
    expect(d).toContain('Vellum file: F9');
  });

  it('keeps the new lists through a reload', () => {
    const p = approved();
    startPublish(m, 'you', p.id, ['x'], () => ['/a.png']);
    addConversations(m, s, 'herald', [{ platform: 'x', url: 'https://x.com/z/1', who: 'a', quote: 'q', why: 'w', draft: 'd' }]);
    const again = migrateMedia(JSON.parse(JSON.stringify(m)));
    expect(again.nextIds).toMatchObject({ publish: 2, conversation: 2 });
    expect(again.publish!.length).toBe(1);
  });
});
