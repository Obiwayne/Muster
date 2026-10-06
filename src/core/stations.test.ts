import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { musterPaths, ensureDirs, type MusterPaths } from './paths.js';
import { deleteStation, getStation, listStations, readGuideline, saveStation, seedStations, stationRoles } from './stations.js';
import { stationRole } from './tasks.js';

const MINE = ['---', 'role: design', '---', 'Mine', ''].join(String.fromCharCode(10));
let p: MusterPaths;
const cfg = { defaultStations: ['build', 'test'] };
beforeEach(() => {
  p = musterPaths(mkdtempSync(join(tmpdir(), 'muster-stations-')));
  ensureDirs(p);
});

describe('stations', () => {
  it('seeds every missing built-in line station, even when the folder exists, and never overwrites', () => {
    mkdirSync(join(p.dir, 'stations'));
    writeFileSync(join(p.dir, 'stations', 'build.md'), MINE);
    seedStations(p);
    for (const n of ['test', 'plan', 'approval', 'design-check', 'reproduce', 'review']) expect(existsSync(join(p.dir, 'stations', n + '.md')), n).toBe(true);
    expect(readFileSync(join(p.dir, 'stations', 'review.md'), 'utf8')).toContain("Extra checks for the Captain's review.");
    expect(readGuideline(p, 'build')).toBe('Mine' + String.fromCharCode(10));
    expect(listStations(p, { defaultStations: ['build', 'test'] }).map((s) => [s.name, s.role]).slice(0, 3)).toEqual([['build', 'design'], ['test', 'crew'], ['approval', 'human']]);
    writeFileSync(join(p.dir, 'stations', 'test.md'), MINE);
    seedStations(p);
    expect(readGuideline(p, 'test')).toBe('Mine' + String.fromCharCode(10));
  });

  it('works with no files: built-in defaults', () => {
    expect(getStation(p, 'design')).toMatchObject({ role: 'design', builtin: true });
    expect(stationRoles(p)).toEqual({ qa: 'qa', review: 'captain' });
  });

  it('saves role and guideline, keeping omitted fields', () => {
    saveStation(p, 'Docs', { role: 'design', guideline: '# Docs\nWrite.' });
    expect(getStation(p, 'docs')).toEqual({ name: 'docs', role: 'design', guideline: '# Docs\nWrite.', skills: [], builtin: false });
    saveStation(p, 'docs', { guideline: 'Only text' });
    expect(getStation(p, 'docs')).toMatchObject({ role: 'design', guideline: 'Only text' });
    saveStation(p, 'docs', { role: 'crew' });
    expect(getStation(p, 'docs')).toMatchObject({ role: 'crew', guideline: 'Only text' });
    expect(stationRoles(p).docs).toBe('crew');
  });

  it('feeds task role resolution', () => {
    saveStation(p, 'test', { role: 'design' });
    expect(stationRole('test', stationRoles(p))).toBe('design');
    expect(stationRole('test')).toBe('crew');
    expect(stationRole('review', { review: 'crew' })).toBe('captain');
  });

  it('deletes stations but refuses review', () => {
    saveStation(p, 'docs', {});
    deleteStation(p, 'docs');
    expect(existsSync(join(p.dir, 'stations', 'docs.md'))).toBe(false);
    expect(() => deleteStation(p, 'docs')).toThrow(/No station/);
    expect(() => deleteStation(p, 'review')).toThrow(/cannot be removed/);
  });

  it('rejects bad input', () => {
    expect(() => saveStation(p, 'review', { role: 'crew' })).toThrow(/captain/);
    expect(() => saveStation(p, '../x', {})).toThrow(/Station names/);
    expect(() => saveStation(p, 'a', { role: 'boss' })).toThrow(/role/);
    expect(() => saveStation(p, 'a', { guideline: 'x'.repeat(20_001) })).toThrow(/longer/);
  });
});
