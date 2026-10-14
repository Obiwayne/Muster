import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { boardHandoff, handoffHistory, latestHandoff, reloadPrompt, saveHandoff } from './handoff.js';
import { ensureDirs, musterPaths } from './paths.js';
import { Store } from './store.js';
import { createTask } from './tasks.js';
import { tempRepo } from './testutil.js';
import { DEFAULT_CONFIG } from '../types.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function paths() {
  const repo = tempRepo();
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  const p = musterPaths(repo);
  ensureDirs(p);
  return p;
}

describe('handoff notes', () => {
  it('the newest replaces the latest; every note stays in the history', () => {
    const p = paths();
    expect(latestHandoff(p)).toBeUndefined();
    saveHandoff(p, 'captain', 'first', new Date('2026-10-14T10:00:00Z'));
    saveHandoff(p, 'captain', 'second', new Date('2026-10-14T11:00:00Z'));
    expect(latestHandoff(p)).toMatchObject({ text: 'second', by: 'captain', at: '2026-10-14T11:00:00.000Z' });
    expect(handoffHistory(p)).toHaveLength(2);
  });

  it('refuses an empty or very long note', () => {
    const p = paths();
    expect(() => saveHandoff(p, 'captain', '  ')).toThrow(/empty/);
    expect(() => saveHandoff(p, 'captain', 'x'.repeat(9000))).toThrow(/under 8000/);
  });

  it('writes a fallback from the board and puts the note in the reload prompt', () => {
    const p = paths();
    const store = new Store(p);
    store.state.goal = { text: 'Build invites', at: '' };
    createTask(store.state, DEFAULT_CONFIG, { title: 'Invite API', actor: 'you' });
    const text = boardHandoff(store.state);
    expect(text).toContain('Last goal from the user: Build invites');
    expect(text).toMatch(/T1 \[ready\] Invite API/);
    const prompt = reloadPrompt('captain', { text: 'T1 next', by: 'captain', at: 'now' });
    expect(prompt).toContain('T1 next');
    expect(prompt).toContain('read_board, roadmap and read_inbox');
  });
});
