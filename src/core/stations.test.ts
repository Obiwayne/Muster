import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteStation, getStation, listStations, readGuideline, roleOfStation, saveStation } from './stations.js';

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'muster-stations-'));
  process.env.MUSTER_SECRETS_DIR = base;
});
afterEach(() => {
  delete process.env.MUSTER_SECRETS_DIR;
});

describe('stations', () => {
  it('lists the built-ins by default', () => {
    expect(listStations().map((s) => [s.name, s.role, s.builtin, s.guideline])).toEqual([
      ['build', 'crew', true, ''],
      ['test', 'crew', true, ''],
      ['design', 'design', true, ''],
      ['review', 'captain', true, ''],
    ]);
  });

  it('saves a guideline file and a role per machine', () => {
    saveStation('Test', { role: 'design', guideline: '# Test\nRun everything.' });
    expect(readFileSync(join(base, 'stations', 'test.md'), 'utf8')).toBe('# Test\nRun everything.');
    expect(roleOfStation('test')).toBe('design');
    expect(getStation('test')).toMatchObject({ role: 'design', guideline: '# Test\nRun everything.' });
    saveStation('test', { guideline: 'Only text' }); // role kept
    expect(roleOfStation('test')).toBe('design');
  });

  it('adds custom stations (default role crew) and removes them', () => {
    saveStation('docs', { guideline: 'Write docs' });
    expect(listStations().at(-1)).toMatchObject({ name: 'docs', role: 'crew', builtin: false, guideline: 'Write docs' });
    deleteStation('docs');
    expect(getStation('docs')).toBeUndefined();
    expect(existsSync(join(base, 'stations', 'docs.md'))).toBe(false);
    expect(roleOfStation('docs')).toBe('crew');
  });

  it('resets a built-in on delete, and an empty guideline removes the file', () => {
    saveStation('build', { role: 'design', guideline: 'x' });
    saveStation('build', { guideline: '  ' });
    expect(readGuideline('build')).toBe('');
    deleteStation('build');
    expect(roleOfStation('build')).toBe('crew');
  });

  it('keeps review with the captain and rejects bad input', () => {
    expect(() => saveStation('review', { role: 'crew' })).toThrow(/captain/);
    expect(() => saveStation('../x', {})).toThrow(/Station names/);
    expect(() => saveStation('a', { role: 'boss' })).toThrow(/role/);
    expect(() => saveStation('a', { guideline: 'x'.repeat(20_001) })).toThrow(/longer/);
    expect(() => deleteStation('nope')).toThrow(/No station/);
  });
});
