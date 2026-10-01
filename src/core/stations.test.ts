import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { musterPaths, ensureDirs, type MusterPaths } from './paths.js';
import { deleteStation, getStation, listStations, readGuideline, saveStation, seedStations, stationRoles } from './stations.js';
import { stationRole } from './tasks.js';

let p: MusterPaths;
const cfg = { defaultStations: ['build', 'test'] };
beforeEach(() => {
  p = musterPaths(mkdtempSync(join(tmpdir(), 'muster-stations-')));
  ensureDirs(p);
});

describe('stations', () => {
  it('seeds the four built-ins without overwriting existing files', () => {
    mkdirSync(join(p.dir, 'stations'));
    writeFileSync(join(p.dir, 'stations', 'build.md'), '---\nrole: design\n---\nMine\n');
    seedStations(p);
    expect(listStations(p, cfg).map((s) => [s.name, s.role, s.builtIn])).toEqual([
      ['build', 'design', true],
      ['test', 'crew', true],
      ['review', 'captain', true],
      ['design', 'design', true],
    ]);
    expect(readGuideline(p, 'build')).toBe('Mine\n');
    expect(readFileSync(join(p.dir, 'stations', 'review.md'), 'utf8')).toMatch(/^---\nrole: captain\n---\n/);
  });

  it('works with no files: built-in defaults', () => {
    expect(getStation(p, 'design')).toMatchObject({ role: 'design', builtIn: true });
    expect(stationRoles(p)).toEqual({ review: 'captain' });
  });

  it('saves role and guideline, keeping omitted fields', () => {
    saveStation(p, 'Docs', { role: 'design', guideline: '# Docs\nWrite.' });
    expect(getStation(p, 'docs')).toEqual({ name: 'docs', role: 'design', guideline: '# Docs\nWrite.', builtIn: false });
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
