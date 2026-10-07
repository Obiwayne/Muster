import { describe, expect, it } from 'vitest';
import type { MediaGif, MediaGifFrame, MediaPiece, MediaShot, MediaStore, MediaSuggestion, MusterState } from '../../src/types';
import {
  EMPTY_MEDIA, charCount, evidenceImages, filterPieces, kindCounts, openSuggestions, pieceFor, pieceMeta, postText, reviewCount, scriptText,
  sectionsText, shotCounts, shotListCsv, sortPieces, sourceCounts, sourceTone, suggestionTag, unsourcedCount,
  attachableGifs, clampSeconds, formatBytes, frameStart, gifFile, gifFits, moveFrame, recordingLine, totalSeconds,
} from './mediamodel';

const piece = (id: string, over: Partial<MediaPiece> = {}): MediaPiece => ({
  id, kind: 'social', title: `Piece ${id}`, status: 'review', about: [], claims: [], requests: [],
  createdAt: '2026-10-07T10:00:00Z', updatedAt: '2026-10-07T10:00:00Z', ...over,
});

const sugg = (id: string, over: Partial<MediaSuggestion> = {}): MediaSuggestion => ({
  id, trigger: 'stage', ref: 'M3', title: 't', summary: 's', plan: [], about: [], status: 'open', createdAt: '2026-10-07T10:00:00Z', ...over,
});

describe('library', () => {
  it('sorts review first, then drafting, failed, approved, used; newest first inside a group', () => {
    const list = sortPieces([
      piece('MP1', { status: 'used' }),
      piece('MP2', { status: 'approved' }),
      piece('MP3', { status: 'drafting' }),
      piece('MP4', { status: 'review', updatedAt: '2026-10-07T09:00:00Z' }),
      piece('MP5', { status: 'review', updatedAt: '2026-10-07T11:00:00Z' }),
      piece('MP6', { status: 'failed' }),
      piece('MP7', { status: 'queued', updatedAt: '2026-10-07T12:00:00Z' }),
    ]);
    expect(list.map((p) => p.id)).toEqual(['MP5', 'MP4', 'MP7', 'MP3', 'MP6', 'MP2', 'MP1']);
  });

  it('counts kinds and review, and filters', () => {
    const list = [piece('MP1'), piece('MP2', { kind: 'article', status: 'approved' }), piece('MP3', { kind: 'video' })];
    expect(kindCounts(list)).toEqual({ all: 3, social: 1, article: 1, website: 0, video: 1, gif: 0 });
    expect(reviewCount(list)).toBe(2);
    expect(filterPieces(list, 'article').map((p) => p.id)).toEqual(['MP2']);
    expect(filterPieces(list, 'all')).toHaveLength(3);
  });

  it('lists open suggestions newest first and tags them', () => {
    const store: MediaStore = {
      ...EMPTY_MEDIA,
      suggestions: [sugg('MS1'), sugg('MS2', { status: 'dismissed' }), sugg('MS3', { createdAt: '2026-10-07T12:00:00Z', trigger: 'weekly', ref: '2026-W40' })],
    };
    expect(openSuggestions(store).map((s) => s.id)).toEqual(['MS3', 'MS1']);
    expect(suggestionTag(store.suggestions[0])).toBe('STAGE LANDED · M3');
    expect(suggestionTag(store.suggestions[2])).toBe('WEEKLY ROUNDUP · WEEK 40');
  });

  it('describes a piece in one line', () => {
    expect(pieceMeta(piece('MP1', { posts: [{ platform: 'x', versions: ['a', 'b', 'c'], chosen: 0 }], images: [{ taskId: 'T1', evidenceId: 'E1', name: 'a.png', caption: '' }] })))
      .toBe('Social post · 3 versions · 1 screenshot');
    expect(pieceMeta(piece('MP2', { kind: 'article', status: 'drafting', progress: 'writing section 3 of 5', sections: [{ id: 'S1', heading: 'h', text: 'one two three', status: 'done' }] })))
      .toBe('Article · ~3 words · writing section 3 of 5');
    expect(pieceFor(piece('MP1', { platforms: ['x', 'linkedin'] }))).toBe('X · LinkedIn');
    expect(pieceFor(piece('MP1', { kind: 'website', target: '/changelog' }))).toBe('/changelog');
  });
});

describe('character limits', () => {
  it('warns past the platform limit and counts emoji as one', () => {
    expect(charCount('x', 'a'.repeat(241))).toMatchObject({ text: '241/280', over: false });
    expect(charCount('x', 'a'.repeat(281)).over).toBe(true);
    expect(charCount('bluesky', '👋'.repeat(10)).n).toBe(10);
    expect(charCount('linkedin', 'abc')).toMatchObject({ text: '3', over: false, limit: undefined });
  });
});

describe('claims', () => {
  it('colours sources and counts unsourced claims', () => {
    expect(sourceTone({ kind: 'intel', ref: 'IC4', label: '' })).toBe('intel');
    expect(sourceTone({ kind: 'task', ref: 'T38', label: '' })).toBe('task');
    expect(sourceTone({ kind: 'opinion', ref: '', label: '' })).toBe('opinion');
    const p = piece('MP1', { claims: [{ id: 'C1', quote: 'a', sources: [] }, { id: 'C2', quote: 'b', sources: [{ kind: 'task', ref: 'T1', label: 'T1 merged' }] }] });
    expect(unsourcedCount(p)).toBe(1);
  });
});

describe('plain-text copy', () => {
  it('copies an article as plain text with headings on their own lines', () => {
    const p = piece('MP1', {
      kind: 'article', title: 'How we built it',
      sections: [
        { id: 'S1', heading: '', text: 'Intro para.', status: 'done' },
        { id: 'S2', heading: 'What we built', text: 'First.\n\nSecond.', status: 'done' },
        { id: 'S3', heading: 'Next', text: '', status: 'todo' },
      ],
    });
    expect(sectionsText(p)).toBe('How we built it\n\nIntro para.\n\nWhat we built\n\nFirst.\n\nSecond.\n\nNext\n');
  });

  it('copies the chosen version of one platform', () => {
    const p = piece('MP1', { posts: [{ platform: 'x', versions: ['A text', 'B text'], chosen: 1 }] });
    expect(postText(p, 'x')).toBe('B text');
    expect(postText(p, 'linkedin')).toBe('');
  });

  const shots: MediaShot[] = [
    { at: '0:00', shot: 'Empty wall', voiceover: 'This is a wall.', onScreen: 'Monday, 8:59', evidence: { taskId: 'T12', evidenceId: 'E1', name: 'wall.png' } },
    { at: '0:19', shot: 'Phone, real class', voiceover: 'One tap, "approved".', record: true },
  ];

  it('copies a video script with the chosen hook', () => {
    const p = piece('MP1', { kind: 'video', title: '60 seconds', hooks: ['H1', 'H2'], hookChosen: 1, shots });
    expect(scriptText(p)).toBe('60 seconds\n\nHook: H2\n\n[0:00] Empty wall\nVO: This is a wall.\nOn screen: Monday, 8:59\n\n[0:19] Phone, real class (record)\nVO: One tap, "approved".\n');
  });

  it('makes a CSV shot list with quoting', () => {
    expect(shotListCsv(shots)).toBe(
      'Time,Shot,Voiceover,On screen,Source\r\n0:00,Empty wall,This is a wall.,"Monday, 8:59",T12/E1/wall.png\r\n0:19,"Phone, real class","One tap, ""approved"".",,record\r\n',
    );
    expect(shotCounts(shots)).toEqual({ evidence: 1, record: 1 });
  });
});

describe('sources', () => {
  const state = {
    roadmap: { stages: [{ id: 'M1', status: 'done' }, { id: 'M2', status: 'active' }], goals: [{ id: 'G1', stageId: 'M2' }] },
    tasks: [
      { id: 'T1', status: 'merged', updatedAt: '2026-10-06T00:00:00Z', evidence: [{ id: 'E1', summary: 's', files: [{ name: 'a.png', kind: 'image' }, { name: 'log.txt', kind: 'text' }] }] },
      { id: 'T2', status: 'merged', goalId: 'G1', updatedAt: '2026-10-08T00:00:00Z', evidence: [{ id: 'E1', summary: 's2', files: [{ name: 'b.png', kind: 'image' }] }] },
      { id: 'T3', status: 'working', updatedAt: '2026-10-08T00:00:00Z' },
    ],
    feed: [{}, {}],
  } as unknown as MusterState;

  it('counts what herald writes from', () => {
    const c = sourceCounts(state, [piece('MP1', { usedAt: '2026-10-07T00:00:00Z' }), piece('MP2', { createdAt: '2026-10-09T00:00:00Z' })]);
    expect(c).toMatchObject({ stages: ['M1'], merged: 1, since: '2026-10-07T00:00:00Z', screenshots: 2, chat: 2 });
    expect(sourceCounts(state, []).merged).toBe(2);
  });

  it('picks evidence images of the stage the piece is about', () => {
    const imgs = evidenceImages(state, piece('MP1', { about: [{ kind: 'stage', ref: 'M2', label: '' }] }));
    expect(imgs.map((i) => `${i.taskId}/${i.name}`)).toEqual(['T2/b.png']);
    expect(evidenceImages(state, piece('MP2')).map((i) => i.name)).toEqual(['a.png', 'b.png']);
  });
});

describe('demo GIF', () => {
  const MB = 1024 * 1024;
  const frame = (caption: string, seconds: number): MediaGifFrame => ({ taskId: 'T38', evidenceId: 'E2', name: 'a.png', caption, seconds });
  const file = (name: string, bytes: number) => ({ name, bytes, width: 800, height: 500, seconds: 9.5, renderedAt: '2026-10-07T10:00:00Z' });

  it('checks the size against each platform: X 15 MB, LinkedIn 5 MB, Bluesky 1 MB', () => {
    expect(gifFits(1.8 * MB).map((f) => [f.label, f.ok])).toEqual([['X', true], ['LinkedIn', true], ['Bluesky', false]]);
    expect(gifFits(MB).find((f) => f.platform === 'bluesky')!.ok).toBe(true); // exactly at the limit fits
    expect(gifFits(6 * MB).filter((f) => f.ok).map((f) => f.platform)).toEqual(['x']);
    expect(gifFits(16 * MB).some((f) => f.ok)).toBe(false);
  });

  it('formats bytes', () => {
    expect(formatBytes(1.8 * MB)).toBe('1.8 MB');
    expect(formatBytes(640 * 1024)).toBe('640 KB');
    expect(formatBytes(900)).toBe('900 B');
  });

  it('adds up frame durations and times each frame', () => {
    const frames = [frame('a', 2), frame('b', 2.5), frame('c', 2.5), frame('d', 2.5)];
    expect(totalSeconds(frames)).toBe(9.5);
    expect(totalSeconds([])).toBe(0);
    expect(frameStart(frames, 0)).toBe('0:00.0');
    expect(frameStart(frames, 1)).toBe('0:02.0');
    expect(frameStart(frames, 3)).toBe('0:07.0');
  });

  it('moves a frame and keeps the others in order', () => {
    expect(moveFrame(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveFrame(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveFrame(['a', 'b', 'c'], 1, 99)).toEqual(['a', 'c', 'b']);
    expect(moveFrame(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
    const src = ['a', 'b'];
    moveFrame(src, 0, 1);
    expect(src).toEqual(['a', 'b']); // pure
  });

  it('clamps frame seconds to 0.5–8', () => {
    expect(clampSeconds(0.1)).toBe(0.5);
    expect(clampSeconds(12)).toBe(8);
    expect(clampSeconds(2.46)).toBe(2.5);
    expect(clampSeconds(NaN)).toBe(2.5);
  });

  it('picks the file for the source in use', () => {
    const g: MediaGif = { source: 'slideshow', frames: [], steps: [], altText: '', slideshow: file('slideshow.gif', 10) };
    expect(gifFile(g)?.name).toBe('slideshow.gif');
    expect(gifFile({ ...g, source: 'recording' })).toBeUndefined();
    expect(gifFile({ ...g, source: 'recording', recording: { status: 'done', requestedAt: '', file: file('recording.gif', 20) } })?.name).toBe('recording.gif');
  });

  it('describes the recording state', () => {
    const g: MediaGif = { source: 'slideshow', frames: [], steps: [], altText: '' };
    expect(recordingLine(g)).toMatch(/small task for the Captain/);
    expect(recordingLine({ ...g, recording: { status: 'recording', requestedAt: '', taskId: 'T52' } })).toMatch(/^T52 is recording/);
    expect(recordingLine({ ...g, recording: { status: 'failed', requestedAt: '', error: 'no video' } })).toMatch(/no video/);
  });

  it('lists GIFs a post can attach (review, approved, used) and shows them in the library', () => {
    const g = (id: string, status: MediaPiece['status'], updatedAt = '2026-10-07T10:00:00Z') => piece(id, { kind: 'gif', status, updatedAt });
    const list = [g('MP1', 'drafting'), g('MP2', 'approved', '2026-10-07T09:00:00Z'), g('MP3', 'review', '2026-10-07T11:00:00Z'), piece('MP4'), g('MP5', 'failed')];
    expect(attachableGifs(list).map((p) => p.id)).toEqual(['MP3', 'MP2']);
    const gp = piece('MP9', { kind: 'gif', gif: { source: 'slideshow', frames: [frame('a', 2), frame('b', 2)], steps: [], altText: '', slideshow: { ...file('slideshow.gif', 1.8 * MB), seconds: 4 } } });
    expect(pieceMeta(gp)).toBe('Demo GIF · 2 frames · 4 s · 1.8 MB');
    expect(pieceFor(gp)).toBe('Social · website');
    expect(kindCounts([gp]).gif).toBe(1);
  });
});
