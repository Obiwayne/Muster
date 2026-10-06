import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type MusterState } from '../types.js';
import { qaSkippable } from './qa.js';
import { musterPaths } from './paths.js';
import { deleteStation, getStation, listStations, saveStation, seedStations } from './stations.js';
import { claimTask, createTask, doneTask } from './tasks.js';
import { emptyState } from './store.js';
import { makeAgent } from './testutil.js';

describe('qaSkippable', () => {
  it('skips docs- and images-only diffs, not code, config or empty diffs of nothing', () => {
    expect(qaSkippable(['README.md', 'docs/a/b.md', 'docs\shot.PNG', 'LICENSE', 'img/logo.svg'])).toBe(true);
    expect(qaSkippable(['README.md', 'src/a.ts'])).toBe(false);
    expect(qaSkippable(['package.json'])).toBe(false);
    expect(qaSkippable(['notes.txt'])).toBe(false);
  });
});

describe('qa station', () => {
  const p = musterPaths(mkdtempSync(join(tmpdir(), 'muster-qa-')));

  it('is locked, worked by the qa role, listed just before review, and cannot be changed or removed', () => {
    seedStations(p);
    expect(listStations(p, DEFAULT_CONFIG).map((s) => s.name).slice(-2)).toEqual(['qa', 'review']);
    expect(getStation(p, 'qa')).toMatchObject({ role: 'qa', locked: true });
    expect(getStation(p, 'review')).toMatchObject({ locked: true });
    expect(getStation(p, 'build')?.locked).toBeUndefined();
    expect(() => saveStation(p, 'qa', { role: 'crew' })).toThrow(/QA agent/);
    expect(() => saveStation(p, 'build', { role: 'qa' })).toThrow(/Only the qa station/);
    expect(() => deleteStation(p, 'qa')).toThrow(/cannot be removed/);
  });
});

describe('qa gate in tasks', () => {
  let s: MusterState;
  beforeEach(() => {
    s = emptyState('/repo');
    s.agents.push(makeAgent('captain', 'captain'), makeAgent('crew-2', 'crew'), makeAgent('qa', 'qa'));
  });

  it('puts qa before review and tells the QA agent, not the Captain', () => {
    const t = createTask(s, { ...DEFAULT_CONFIG, defaultStations: ['build'] }, { title: 'X', actor: 'captain' });
    expect(t.stations).toEqual(['build', 'qa', 'review']);
    claimTask(s, 'crew-2');
    doneTask(s, t.id, 'crew-2', 'built');
    expect(t).toMatchObject({ status: 'ready', stationIndex: 1 });
    expect(s.inbox.some((i) => i.agentId === 'qa' && i.taskId === t.id && /qa station/.test(i.text))).toBe(true);
    expect(claimTask(s, 'crew-2')).toBeNull();
    expect(claimTask(s, 'qa')?.id).toBe(t.id);
  });

  it('skips qa for a docs/images-only diff', () => {
    const t = createTask(s, { ...DEFAULT_CONFIG, defaultStations: ['build'] }, { title: 'Docs', actor: 'captain' });
    claimTask(s, 'crew-2');
    doneTask(s, t.id, 'crew-2', 'readme', undefined, undefined, { skipQa: true });
    expect(t).toMatchObject({ status: 'review', assignee: 'captain', stationIndex: 2 });
    expect(t.history.some((e) => /qa skipped/.test(e.text ?? ''))).toBe(true);
  });
});
