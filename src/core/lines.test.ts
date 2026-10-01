import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type MusterConfig } from '../types.js';
import { loadConfig } from './config.js';
import { defaultLineName, getLine, lineEntry, lineStations, listLines } from './lines.js';
import { ensureDirs, musterPaths, type MusterPaths } from './paths.js';
import { createTask } from './tasks.js';
import { getStation, seedStations } from './stations.js';
import { emptyState } from './store.js';
import { makeAgent } from './testutil.js';

let p: MusterPaths;
beforeEach(() => {
  p = musterPaths(mkdtempSync(join(tmpdir(), 'muster-lines-')));
  ensureDirs(p);
  seedStations(p);
});

const cfg = (lines: MusterConfig['lines'] = {}) => ({ ...DEFAULT_CONFIG, lines });

describe('factory lines', () => {
  it('ships four built-in lines that end with review and use only stations that resolve', () => {
    const lines = listLines(cfg());
    expect(lines.map((l) => [l.name, l.label, l.stations.join(' ')])).toEqual([
      ['new-app', 'New app / big feature', 'discover concept design plan approval review'],
      ['feature', 'Feature', 'plan build test review'],
      ['ui', 'UI change', 'design build design-check review'],
      ['bugfix', 'Bug fix', 'reproduce fix test review'],
    ]);
    for (const l of lines) for (const s of l.stations) expect(getStation(p, s), `${l.name}/${s}`).toBeDefined();
    expect(defaultLineName(cfg())).toBe('feature');
  });

  it('merges your edits over the built-ins and adds custom lines after them', () => {
    const lines = listLines(cfg({ feature: { label: 'Feature', stations: ['build', 'test'] }, mine: { label: 'Mine', stations: ['plan'] } }));
    expect(lines.map((l) => l.name)).toEqual(['new-app', 'feature', 'ui', 'bugfix', 'mine']);
    expect(getLine(cfg({ feature: { label: 'F', stations: ['build'] } }), 'feature')).toEqual({ name: 'feature', label: 'F', stations: ['build', 'review'], builtin: true });
    expect(getLine(cfg({ mine: { label: 'Mine', stations: ['plan'] } }), 'mine')).toMatchObject({ builtin: false, stations: ['plan', 'review'] });
    expect(lineStations(cfg(), 'ui')).toEqual(['design', 'build', 'design-check']);
    expect(defaultLineName({ ...cfg(), defaultLine: 'gone' })).toBe('feature');
  });

  it('validates PUT bodies: known stations, review implied, a new line needs stations', () => {
    expect(lineEntry(p, cfg(), 'ui', { stations: ['design', 'build', 'review'] })).toEqual({ name: 'ui', entry: { label: 'UI change', stations: ['design', 'build'] } });
    expect(lineEntry(p, cfg(), 'ui', { label: ' Screens ' }).entry).toEqual({ label: 'Screens', stations: ['design', 'build', 'design-check'] });
    expect(() => lineEntry(p, cfg(), 'x', { stations: ['nope'] })).toThrow(/Unknown station/);
    expect(() => lineEntry(p, cfg(), 'x', { stations: [] })).toThrow(/at least one/);
    expect(() => lineEntry(p, cfg(), 'x', {})).toThrow(/needs stations/);
    expect(() => lineEntry(p, cfg(), 'ui', { label: ' ' })).toThrow(/label/);
  });

  it('gives every station of the built-in lines a role and a sectioned guideline; approval is human', () => {
    const roles: Record<string, string> = { discover: 'crew', concept: 'crew', plan: 'crew', reproduce: 'crew', fix: 'crew', build: 'crew', test: 'crew', design: 'design', 'design-check': 'design', approval: 'human' };
    for (const [name, role] of Object.entries(roles)) {
      const s = getStation(p, name)!;
      expect(s.role, name).toBe(role);
      for (const h of ['## Purpose', '## Read first', '## Produce', '## Done when', '## Hand on']) expect(s.guideline, `${name} ${h}`).toContain(h);
    }
    expect(getStation(p, 'plan')!.guideline).toContain('docs/factory/<T#>-plan.md');
    expect(getStation(p, 'plan')!.guideline).toContain('suggested line');
    expect(getStation(p, 'reproduce')!.guideline).toContain('failing test');
    expect(getStation(p, 'design-check')!.guideline).toContain('PASS');
    expect(getStation(p, 'design-check')!.guideline).toContain('DRIFT');
  });

  it('createTask records the line; defaultStations is an alias for the default line', () => {
    const s = emptyState('/repo');
    s.agents.push(makeAgent('captain', 'captain'));
    const t = createTask(s, DEFAULT_CONFIG, { title: 'T', stations: lineStations(cfg(), 'bugfix'), line: 'bugfix', actor: 'captain' });
    expect(t).toMatchObject({ line: 'bugfix', stations: ['reproduce', 'fix', 'test', 'review'] });

    expect(loadConfig(p).defaultStations).toEqual(['plan', 'build', 'test', 'review']);
    writeFileSync(p.config, JSON.stringify({ defaultLine: 'ui', lines: { ui: { label: 'UI', stations: ['design', 'build'] } } }));
    expect(loadConfig(p)).toMatchObject({ defaultLine: 'ui', defaultStations: ['design', 'build', 'review'] });
    // Migration: a config.json from before lines keeps its defaultStations as the default line's stations.
    writeFileSync(p.config, JSON.stringify({ defaultStations: ['build', 'review'] }));
    expect(loadConfig(p)).toMatchObject({ defaultLine: 'feature', defaultStations: ['build', 'review'] });
    expect(getLine(loadConfig(p), 'feature')!.stations).toEqual(['build', 'review']);
  });
});
