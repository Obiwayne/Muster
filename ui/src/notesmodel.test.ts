import { describe, expect, it } from 'vitest';
import type { Jot } from '../../src/types';
import { copyText, filterJots, isLong, jotBody, jotTitle, parseTags, sortJots, summaryLine } from './notesmodel';

const j = (id: string, over: Partial<Jot> = {}): Jot => ({ id, text: `Note ${id}`, tags: [], from: 'you', createdAt: '2026-10-07T10:00:00.000Z', updatedAt: '2026-10-07T10:00:00.000Z', ...over });

describe('notes model', () => {
  it('sorts pinned first, then newest, then higher id', () => {
    const list = [j('J1', { createdAt: '2026-10-01T00:00:00.000Z' }), j('J2', { createdAt: '2026-10-05T00:00:00.000Z' }), j('J3', { pinned: true, createdAt: '2026-09-01T00:00:00.000Z' }), j('J4', { createdAt: '2026-10-05T00:00:00.000Z' })];
    expect(sortJots(list).map((x) => x.id)).toEqual(['J3', 'J4', 'J2', 'J1']);
  });

  it('searches title, text and tags; every word must match', () => {
    const list = [j('J1', { title: 'Mirror mode', text: 'for glass rigs', tags: ['hardware'] }), j('J2', { text: 'Voice scroll speed', tags: ['ux'] })];
    expect(filterJots(list, 'MIRROR glass').map((x) => x.id)).toEqual(['J1']);
    expect(filterJots(list, '#ux').map((x) => x.id)).toEqual(['J2']);
    expect(filterJots(list, 'mirror voice')).toEqual([]);
    expect(filterJots(list, '  ')).toHaveLength(2);
  });

  it('titles a note by its title or first line, and folds that line out of the body', () => {
    expect(jotTitle(j('J1', { text: '\n  First line\nsecond' }))).toBe('First line');
    expect(jotBody(j('J1', { text: '\n  First line\nsecond' }))).toBe('second');
    expect(jotTitle(j('J1', { title: 'T', text: 'a\nb' }))).toBe('T');
    expect(jotBody(j('J1', { title: 'T', text: 'a\nb' }))).toBe('a\nb');
  });

  it('copies title, text and tags', () => {
    expect(copyText(j('J1', { title: 'Ideas', text: 'one\ntwo', tags: ['ux', 'mobile'] }))).toBe('Ideas\n\none\ntwo\n\n#ux #mobile');
    expect(copyText(j('J1', { title: 'Mirror', text: 'Mirror mode' }))).toBe('Mirror mode');
  });

  it('folds long notes, parses tags and sums up', () => {
    expect(isLong('a\nb\nc')).toBe(false);
    expect(isLong('1\n2\n3\n4\n5\n6\n7')).toBe(true);
    expect(isLong('x'.repeat(500))).toBe(true);
    expect(parseTags('ideas, Mobile #ux ux')).toEqual(['ideas', 'mobile', 'ux']);
    expect(summaryLine([j('J1', { from: 'claude' }), j('J2', { pinned: true })])).toBe('2 notes · 1 via Claude · 1 pinned');
    expect(summaryLine([])).toBe('0 notes');
  });
});
