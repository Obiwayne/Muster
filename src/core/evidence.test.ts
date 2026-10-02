import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '../types.js';
import { attachEvidence, ensureEvidenceIgnored, evidencePath, formatEvidence } from './evidence.js';
import { musterPaths } from './paths.js';
import {
  DEFAULT_SKILLS,
  evidenceStation,
  getStation,
  listSkills,
  PLUGIN_DIR,
  saveStation,
  seedStations,
  stationBrief,
} from './stations.js';

const dirs: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const task = (over: Partial<Task> = {}): Task => ({
  id: 'T3', title: 'Share dialog', description: '', dependsOn: [], stations: ['build', 'test', 'review'], stationIndex: 0,
  status: 'in_progress', createdBy: 'you', createdAt: '', updatedAt: '', history: [], ...over,
});

describe('station skills', () => {
  it('lists the skills shipped in plugin/skills with their descriptions', () => {
    const skills = listSkills(PLUGIN_DIR);
    expect(skills.map((s) => s.name)).toEqual(['before-and-after', 'code-structure', 'evidence-driven-testing', 'unslop']);
    expect(skills.find((s) => s.name === 'evidence-driven-testing')!.description).toMatch(/^Records visual proof/); // folded ">" block
    expect(skills.every((s) => s.description.length > 20)).toBe(true);
  });

  it('every default skill exists in the plugin', () => {
    const names = new Set(listSkills(PLUGIN_DIR).map((s) => s.name));
    for (const list of Object.values(DEFAULT_SKILLS)) for (const s of list) expect(names.has(s)).toBe(true);
  });

  it('uses the defaults until the file names skills, and an empty line means none', () => {
    const p = musterPaths(temp('muster-skills-'));
    seedStations(p);
    expect(getStation(p, 'test')!.skills).toEqual(['evidence-driven-testing']);
    expect(readFileSync(join(p.dir, 'stations', 'test.md'), 'utf8')).toMatch(/^---\nrole: crew\nskills: evidence-driven-testing\n---\n/);
    // a station file from before skills existed keeps getting the defaults
    writeFileSync(join(p.dir, 'stations', 'build.md'), '---\nrole: crew\n---\nBuild it.');
    expect(getStation(p, 'build')!.skills).toEqual(['code-structure']);
    saveStation(p, 'build', { skills: [] });
    expect(getStation(p, 'build')!.skills).toEqual([]);
    saveStation(p, 'build', { skills: ['unslop', 'unslop', 'code-structure'] });
    expect(getStation(p, 'build')).toMatchObject({ skills: ['unslop', 'code-structure'], guideline: 'Build it.' });
    expect(() => saveStation(p, 'build', { skills: ['Bad Name'] })).toThrow(/skills must be/);
  });

  it('puts the evidence ask on the last station an agent works, on every line', () => {
    expect(evidenceStation({ stations: ['plan', 'build', 'test', 'review'] })).toBe('test');
    expect(evidenceStation({ stations: ['design', 'build', 'design-check', 'review'] })).toBe('design-check');
    expect(evidenceStation({ stations: ['reproduce', 'fix', 'test', 'review'] })).toBe('test');
    expect(evidenceStation({ stations: ['discover', 'concept', 'design', 'plan', 'approval', 'review'] })).toBe('plan'); // approval is human
    expect(evidenceStation({ stations: ['approval', 'review'] })).toBe('review'); // nobody else: the Captain
    expect(evidenceStation({ stations: ['build', 'docs', 'review'] }, { docs: 'human' })).toBe('build');
  });

  it('briefs a station with its guideline, skills and, at the evidence station, the evidence ask', () => {
    const p = musterPaths(temp('muster-brief-'));
    seedStations(p);
    const atBuild = stationBrief(p, task());
    expect(atBuild).toContain('## Station: build guidelines');
    expect(atBuild).toContain('`muster:code-structure`');
    expect(atBuild).not.toContain('## Evidence');
    const atTest = stationBrief(p, task({ stationIndex: 1 }));
    expect(atTest).toContain('`muster:evidence-driven-testing`');
    expect(atTest).toContain('## Evidence (required at test)');
    expect(atTest).toContain('.muster-evidence/T3/');
    // once evidence is attached, a send-back to that station doesn't ask again
    const withProof = task({ stationIndex: 1, evidence: [{ id: 'E1', station: 'test', by: 'ada', at: '', summary: 'ok', files: [] }] });
    expect(stationBrief(p, withProof)).not.toContain('## Evidence');
    expect(stationBrief(p, task({ stationIndex: 2 }))).toContain('`muster:unslop`'); // the Captain's review
  });
});

describe('evidence files', () => {
  const setup = () => {
    const root = temp('muster-ev-');
    const p = musterPaths(root);
    const wt = join(root, 'wt');
    mkdirSync(join(wt, '.muster-evidence', 'T3'), { recursive: true });
    writeFileSync(join(wt, '.muster-evidence', 'T3', '01-before.png'), 'png-1');
    writeFileSync(join(wt, '.muster-evidence', 'T3', 'assertions.md'), '- saves: passed\n');
    return { p, wt };
  };
  const base = { summary: 'Dialog opens and saves', station: 'test', by: 'ada', at: '2026-10-02T00:00:00.000Z' };

  it('copies the files (folders expand) into .muster/evidence/<task>/<E#>/ and records them', () => {
    const { p, wt } = setup();
    const t = task();
    const e = attachEvidence(p, { ...base, task: t, worktree: wt, files: ['.muster-evidence/T3'], sha: 'abc123' });
    expect(e).toMatchObject({ id: 'E1', station: 'test', by: 'ada', sha: 'abc123', summary: 'Dialog opens and saves' });
    expect(e.files).toEqual([
      { name: '01-before.png', kind: 'image', bytes: 5 },
      { name: 'assertions.md', kind: 'text', bytes: 16 },
    ]);
    t.evidence = [e];
    expect(readFileSync(evidencePath(p, t, 'E1', '01-before.png'), 'utf8')).toBe('png-1');
    const next = attachEvidence(p, { ...base, task: t, worktree: wt, files: [], text: 'npm test: 12 passed' });
    expect(next).toMatchObject({ id: 'E2', files: [{ name: 'notes.md', kind: 'text' }] });
    t.evidence.push(next);
    expect(formatEvidence(t)).toMatch(/^Evidence:\n- E1 at test by ada @ abc123 · 2 files \(1 image\): Dialog opens and saves\n- E2/);
  });

  it('refuses files outside the worktree, missing files, and empty calls', () => {
    const { p, wt } = setup();
    writeFileSync(join(p.root, 'secret.txt'), 'x');
    expect(() => attachEvidence(p, { ...base, task: task(), worktree: wt, files: ['../secret.txt'] })).toThrow(/outside your worktree/);
    expect(() => attachEvidence(p, { ...base, task: task(), worktree: wt, files: ['nope.png'] })).toThrow(/no such file/);
    expect(() => attachEvidence(p, { ...base, task: task(), worktree: wt, files: [] })).toThrow(/Pass files/);
    expect(() => attachEvidence(p, { ...base, summary: ' ', task: task(), worktree: wt, files: ['.muster-evidence'] })).toThrow(/summary is required/);
    expect(() => evidencePath(p, task(), 'E1', 'x.png')).toThrow(/No evidence/);
  });

  it('ignores .muster-evidence/ for every worktree through info/exclude, once', () => {
    const common = temp('muster-git-');
    expect(ensureEvidenceIgnored(common)).toBe(true);
    expect(ensureEvidenceIgnored(common)).toBe(false);
    expect(readFileSync(join(common, 'info', 'exclude'), 'utf8')).toBe('.muster-evidence/\n');
    expect(existsSync(join(common, 'info'))).toBe(true);
  });
});
