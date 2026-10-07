import { describe, expect, it } from 'vitest';
import type { MediaConversation, MediaPiece, MediaPost, MediaPublishJob, MediaResearch, MediaStore } from '../../src/types';
import {
  DEFAULT_PLATFORMS, EMPTY_MEDIA, charCount, cleanTag, conversationsFor, conversationsLine, designSizesLine, fullPostText, hashtagHint, imagesFor,
  jobLine, postRows, postText, publishChip, repliesToday, replyBlock, researchLine, showPublishRail, themeTone,
} from './mediamodel';

const piece = (over: Partial<MediaPiece> = {}): MediaPiece => ({
  id: 'MP6', kind: 'social', title: 'Moderation is live', status: 'approved', about: [], claims: [], requests: [],
  createdAt: '2026-10-07T10:00:00Z', updatedAt: '2026-10-07T10:00:00Z', ...over,
});
const post = (platform: MediaPost['platform'], text: string, hashtags?: string[]): MediaPost => ({ platform, versions: [text, 'B'], chosen: 0, hashtags });
const job = (over: Partial<MediaPublishJob> = {}): MediaPublishJob => ({
  id: 'PJ1', pieceId: 'MP6', platform: 'x', kind: 'post', text: 't', images: [], status: 'queued', createdAt: '2026-10-07T10:00:00Z', updatedAt: '2026-10-07T10:00:00Z', ...over,
});
const conv = (over: Partial<MediaConversation> = {}): MediaConversation => ({
  id: 'MC1', pieceId: 'MP6', platform: 'x', kind: 'thread', url: 'https://x.com/a/1', who: 'EdTech account', quote: 'q', why: 'w', draft: 'A useful answer.',
  claims: [], mentionsProduct: false, status: 'draft', createdAt: '2026-10-07T10:00:00Z', ...over,
});
const withStore = (over: Partial<MediaStore>): MediaStore => ({ ...EMPTY_MEDIA, ...over });

describe('platforms and hashtags', () => {
  it('defaults new posts to X, LinkedIn and Facebook (Instagram never on by default)', () => {
    expect(DEFAULT_PLATFORMS).toEqual(['x', 'linkedin', 'facebook']);
  });

  it('appends the hashtags on their own line and counts them on X', () => {
    const p = post('x', 'Live today.  ', ['edtech', 'teachers']);
    expect(fullPostText(p)).toBe('Live today.\n\n#edtech #teachers');
    expect(fullPostText(post('x', 'No tags'))).toBe('No tags');
    expect(postText(piece({ posts: [p] }), 'x')).toBe('Live today.\n\n#edtech #teachers');
    expect(charCount('x', fullPostText(p)).text).toBe('30/280');
  });

  it('shows the limit only on the tight platforms, but still flags a too-long LinkedIn post', () => {
    expect(charCount('linkedin', 'abc').text).toBe('3');
    expect(charCount('bluesky', 'abc').text).toBe('3/300');
    expect(charCount('instagram', 'a'.repeat(2201)).over).toBe(true);
  });

  it('gives each platform its hashtag rule and warns outside it', () => {
    expect(hashtagHint('x', 2)).toEqual({ text: 'X: 1–2 hashtags · counted in the 280', warn: false });
    expect(hashtagHint('x', 3).warn).toBe(true);
    expect(hashtagHint('linkedin', 1)).toEqual({ text: 'LinkedIn: 3–5 hashtags at the end · add 2 more', warn: true });
    expect(hashtagHint('linkedin', 0).warn).toBe(false);
    expect(hashtagHint('instagram', 20).warn).toBe(false);
    expect(hashtagHint('instagram', 31).warn).toBe(true);
  });

  it('cleans typed hashtags', () => {
    expect(cleanTag(' #EdTech ')).toBe('EdTech');
    expect(cleanTag('##ukedchat')).toBe('ukedchat');
    expect(cleanTag('two words')).toBeNull();
    expect(cleanTag('#')).toBeNull();
  });
});

describe('post images', () => {
  const d = (platform: 'x' | 'instagram') => ({ id: 'D1', platform, file: `${platform}.png`, width: 1600, height: 900, style: 'headline' as const, caption: 'c', createdAt: 'x' });
  const img = { taskId: 'T38', evidenceId: 'E2', name: 'queue.png', caption: 'queue' };

  it('uses the platform\'s own design, else screenshots, else demo GIFs', () => {
    const p = piece({ designs: [d('x')], images: [img], gifIds: ['MP7'] });
    expect(imagesFor(p, 'x').map((i) => i.kind)).toEqual(['design']);
    expect(imagesFor(p, 'linkedin').map((i) => i.kind)).toEqual(['evidence']);
    expect(imagesFor(piece({ gifIds: ['MP7'] }), 'x')).toEqual([{ kind: 'gif', pieceId: 'MP7' }]);
    expect(imagesFor(piece(), 'x')).toEqual([]);
  });

  it('lists the sizes for the popover', () => {
    expect(designSizesLine(['x', 'linkedin', 'facebook', 'instagram'])).toBe('X 1600×900 · LinkedIn 1200×627 · Facebook 1200×630 · Instagram 1080×1080');
  });

  it('builds the "post it for you" rows: Instagram unticked, and off without an image', () => {
    const rows = postRows(piece({ posts: [post('x', 'Hi', ['edtech']), post('instagram', 'Hi')], images: [] }));
    expect(rows[0]).toEqual({ platform: 'x', line: 'Version A · 11/280 · #edtech · no image', checked: true });
    expect(rows[1]).toMatchObject({ platform: 'instagram', checked: false, disabled: 'needs an image' });
    const withImg = postRows(piece({ posts: [post('instagram', 'Hi', ['a', 'b', 'c', 'd', 'e'])], images: [img] }));
    expect(withImg[0]).toMatchObject({ checked: false, line: 'Version A · #a #b #c #d #e · 1 image' });
    expect(withImg[0].disabled).toBeUndefined();
  });
});

describe('posting rail', () => {
  it('says where each job is', () => {
    expect(jobLine(job({ status: 'filling' })).text).toBe('Filling in the post…');
    expect(jobLine(job({ status: 'ready' }))).toEqual({ text: 'Ready: check and post', tone: 'captain' });
    expect(jobLine(job({ status: 'signin', platform: 'linkedin' })).text).toBe('Sign in to LinkedIn in Chrome, then Retry');
    expect(jobLine(job({ status: 'failed', error: 'composer not found' })).text).toBe("Didn't work: composer not found");
  });

  it('shows the rail unless every post job was cancelled, and counts ready ones on the chip', () => {
    expect(showPublishRail([])).toBe(false);
    expect(showPublishRail([job({ status: 'cancelled' })])).toBe(false);
    expect(showPublishRail([job({ status: 'posted' })])).toBe(true);
    expect(publishChip([job({ status: 'ready' }), job({ status: 'filling' }), job({ status: 'queued' })])).toBe('Posting · 1 of 3 ready');
    expect(publishChip([job({ status: 'posted' }), job({ status: 'filling' })])).toBe('Posting · 1 of 2 posted');
    expect(publishChip([job({ status: 'posted' })])).toBeNull();
  });
});

describe('research', () => {
  it('sums up what herald read', () => {
    const r: MediaResearch = { at: 'x', platforms: ['x', 'linkedin', 'facebook'], query: [], read: { posts: 46, articles: 9 }, top: [], themes: [], hashtags: [], used: [] };
    expect(researchLine(r)).toBe('herald read 46 posts and 9 articles · X, LinkedIn, Facebook');
    expect(researchLine({ ...r, read: { posts: 1, articles: 0 } })).toBe('herald read 1 post · X, LinkedIn, Facebook');
    expect([0, 1, 2].map(themeTone)).toEqual(['stuck', 'captain', 'muted']);
  });
});

describe('conversations', () => {
  const now = new Date('2026-10-07T15:00:00');

  it('blocks a reply with an unsourced line, and at the daily limit', () => {
    const s = withStore({});
    expect(replyBlock(conv(), s, now)).toBeNull();
    expect(replyBlock(conv({ claims: [{ id: 'C1', quote: 'class code and a picture', sources: [] }] }), s, now)).toBe('"class code and a picture" has no source: confirm or cut it');
    expect(replyBlock(conv({ draft: '  ' }), s, now)).toBe('Write a reply first');
    const busy = withStore({ replyPolicy: { perDay: 2, watchOwn: true }, publish: [job({ kind: 'reply', status: 'posted', updatedAt: '2026-10-07T09:00:00' }), job({ kind: 'reply', status: 'ready' })] });
    expect(repliesToday(busy, now)).toBe(2);
    expect(replyBlock(conv(), busy, now)).toBe("Today's limit of 2 replies is reached");
    const yesterday = withStore({ replyPolicy: { perDay: 1, watchOwn: true }, publish: [job({ kind: 'reply', status: 'posted', updatedAt: '2026-10-06T09:00:00' })] });
    expect(replyBlock(conv(), yesterday, now)).toBeNull();
  });

  it('lists a piece\'s conversations: drafts first, comments on your posts before threads', () => {
    const s = withStore({
      conversations: [conv({ id: 'MC1', status: 'posted' }), conv({ id: 'MC2' }), conv({ id: 'MC3', kind: 'own' }), conv({ id: 'MC4', pieceId: 'MP2' }), conv({ id: 'MC5', status: 'skipped' })],
    });
    const list = conversationsFor(s, 'MP6');
    expect(list.map((c) => c.id)).toEqual(['MC3', 'MC2', 'MC1', 'MC5']);
    expect(conversationsLine(list, { perDay: 5, watchOwn: true })).toBe('1 place where a reply would help · 1 comment on your posts · max 5 replies a day');
  });
});
