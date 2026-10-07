import { beforeEach, describe, expect, it } from 'vitest';
import type { MusterState } from '../types.js';
import { addJot, deleteJot, editJot, formatJots, jotGoal, jotTitle, listJots, markJotSent, pinJot, requireJot } from './jots.js';
import { emptyState, migrate } from './store.js';

let s: MusterState;
const status = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { status?: number }).status;
  }
  return 200;
};

beforeEach(() => {
  s = emptyState('/repo');
});

describe('notes', () => {
  it('adds notes as you or via Claude, with J ids, tags cleaned and the title optional', () => {
    const a = addJot(s, 'you', { text: '  Teleprompter idea\nmirror mode for glass rigs  ', tags: ['#Ideas', 'ideas', 'UX'] });
    expect(a).toMatchObject({ id: 'J1', from: 'you', text: 'Teleprompter idea\nmirror mode for glass rigs', tags: ['ideas', 'ux'] });
    expect(a.title).toBeUndefined();
    expect(jotTitle(a)).toBe('Teleprompter idea');
    const b = addJot(s, 'you', { text: 'Voice scroll speed', title: 'Scrolling' }, 'Claude');
    expect(b).toMatchObject({ id: 'J2', from: 'claude', client: 'Claude', title: 'Scrolling' });
  });

  it('refuses agents, empty text, long text, too many tags', () => {
    expect(status(() => addJot(s, 'captain', { text: 'x' }))).toBe(403);
    expect(status(() => addJot(s, 'you', { text: '   ' }))).toBe(400);
    expect(status(() => addJot(s, 'you', { text: 'x'.repeat(8001) }))).toBe(400);
    expect(status(() => addJot(s, 'you', { text: 'x', tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }))).toBe(400);
    expect(status(() => addJot(s, 'you', { text: 'x', title: 't'.repeat(121) }))).toBe(400);
  });

  it('edits, pins, lists pinned first then newest, searches, deletes', () => {
    const a = addJot(s, 'you', { text: 'First idea about scripts' });
    const b = addJot(s, 'you', { text: 'Second idea', tags: ['mobile'] });
    b.createdAt = '2099-01-01T00:00:00.000Z';
    expect(listJots(s).map((j) => j.id)).toEqual([b.id, a.id]);
    pinJot(s, 'you', a.id, true);
    expect(listJots(s).map((j) => j.id)).toEqual([a.id, b.id]);
    expect(listJots(s, 'MOBILE').map((j) => j.id)).toEqual([b.id]);
    editJot(s, 'you', a.id, { title: 'Scripts', text: 'Edited' });
    expect(requireJot(s, 'j1')).toMatchObject({ title: 'Scripts', text: 'Edited' });
    editJot(s, 'you', a.id, { title: '' });
    expect(requireJot(s, a.id).title).toBeUndefined();
    pinJot(s, 'you', a.id, false);
    expect(requireJot(s, a.id).pinned).toBeUndefined();
    expect(status(() => pinJot(s, 'you', a.id, 'yes'))).toBe(400);
    deleteJot(s, 'you', a.id);
    expect(status(() => requireJot(s, a.id))).toBe(404);
    expect(status(() => editJot(s, 'crew-2', b.id, { text: 'x' }))).toBe(403);
  });

  it('turns a note into a goal and marks it sent', () => {
    const a = addJot(s, 'you', { text: 'Add a mirror mode', title: 'Mirror' });
    expect(jotGoal(a)).toBe('Mirror\n\nAdd a mirror mode');
    expect(jotGoal(addJot(s, 'you', { text: 'Mirror mode please', title: 'Mirror' }))).toBe('Mirror mode please');
    expect(markJotSent(s, a.id).sentAt).toBeTruthy();
  });

  it('formats notes for the Captain and the connector', () => {
    expect(formatJots([])).toBe('No notes yet.');
    addJot(s, 'you', { text: 'Voice scroll', tags: ['ux'] }, 'Claude');
    expect(formatJots(listJots(s))).toMatch(/^J1 Voice scroll \(via Claude · \d{4}-\d{2}-\d{2} · #ux\)\nVoice scroll$/);
  });

  it('keeps ids counting after a reload, even when nextIds lost the counter', () => {
    addJot(s, 'you', { text: 'a' });
    addJot(s, 'you', { text: 'b' });
    const raw = JSON.parse(JSON.stringify(s));
    delete raw.nextIds.jot;
    const back = migrate(raw, '/repo');
    expect(addJot(back, 'you', { text: 'c' }).id).toBe('J3');
  });
});
