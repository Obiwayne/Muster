import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultLineName, getLine, lineStations, listLines, saveLine } from './lines.js';
import { ensureDirs, musterPaths, type MusterPaths } from './paths.js';
import { getStation, saveStation, seedStations } from './stations.js';

let p: MusterPaths;
beforeEach(() => {
  p = musterPaths(mkdtempSync(join(tmpdir(), 'muster-lines-')));
  ensureDirs(p);
  seedStations(p);
});

describe('lines', () => {
  it('ships presets that end with review and use only stations that resolve', () => {
    const lines = listLines(p);
    expect(lines.map((l) => l.name)).toEqual(['standard', 'tested', 'designed', 'planning']);
    for (const l of lines) {
      expect(l).toMatchObject({ builtin: true });
      expect(l.stations.at(-1)).toBe('review');
      for (const s of l.stations) expect(getStation(p, s), `${l.name}/${s}`).toBeDefined();
    }
    expect(getLine(p, 'planning')!.stations).toEqual(['discover', 'concept', 'plan', 'approve', 'review']);
    expect(lineStations(p, 'tested')).toEqual(['build', 'test']);
    expect(defaultLineName(undefined)).toBe('standard');
  });

  it('gives every starter station a role and a guideline; approve is human', () => {
    for (const s of ['build', 'test', 'design', 'review', 'approve', 'discover', 'concept', 'plan']) expect(getStation(p, s)!.guideline.length, s).toBeGreaterThan(20);
    expect(getStation(p, 'approve')!.role).toBe('human');
  });

  it('saves edits and custom lines per machine, validating stations', () => {
    saveStation(p, 'lint', { role: 'crew', guideline: 'x' });
    expect(saveLine(p, 'tested', { stations: ['build', 'lint', 'test', 'review'], label: 'Lint first' })).toEqual({ name: 'tested', label: 'Lint first', stations: ['build', 'lint', 'test', 'review'], builtin: true });
    expect(saveLine(p, 'mine', { stations: ['plan', 'approve'] })).toMatchObject({ builtin: false, label: 'mine', stations: ['plan', 'approve', 'review'] });
    expect(listLines(p).map((l) => l.name)).toEqual(['standard', 'tested', 'designed', 'planning', 'mine']);
    expect(() => saveLine(p, 'x', { stations: ['nope'] })).toThrow(/Unknown station/);
    expect(() => saveLine(p, 'x', { stations: [] })).toThrow(/at least one/);
    expect(() => saveLine(p, 'x', {})).toThrow(/needs stations/);
    expect(() => saveLine(p, 'standard', { label: ' ' })).toThrow(/label/);
  });
});
