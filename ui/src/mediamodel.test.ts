import { describe, expect, it } from 'vitest';
import type { MediaPiece, MediaShot, MediaStore, MediaSuggestion, MusterState } from '../../src/types';
import {
  EMPTY_MEDIA, charCount, evidenceImages, filterPieces, kindCounts, openSuggestions, pieceFor, pieceMeta, postText, reviewCount, scriptText,
  sectionsText, shotCounts, shotListCsv, sortPieces, sourceCounts, sourceTone, suggestionTag, unsourcedCount,
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
    expect(kindCounts(list)).toEqual({ all: 3, social: 1, article: 1, website: 0, video: 1 });
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
