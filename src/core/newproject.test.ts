import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gitSync } from './testutil.js';
import { createNewProject } from './newproject.js';

const temps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'muster-new-'));
  temps.push(d);
  return d;
};
afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('createNewProject', () => {
  it('makes a git repo with README, .gitignore, a first commit and .muster', () => {
    const parent = tmp();
    const r = createNewProject({ parentDir: parent, idea: 'a todo app', title: 'Todo Zen!' });
    expect(r.slug).toBe('todo-zen');
    expect(r.root).toBe(join(parent, 'todo-zen'));
    expect(readFileSync(join(r.root, 'README.md'), 'utf8')).toBe('# Todo Zen!\n\na todo app\n');
    expect(readFileSync(join(r.root, '.gitignore'), 'utf8')).toContain('node_modules');
    expect(gitSync(r.root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(gitSync(r.root, 'log', '--format=%s')).toBe('Initial commit');
    expect(gitSync(r.root, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(r.root, '.muster', 'worktrees'))).toBe(true);
  });

  it('names untitled ideas idea-YYYY-MM-DD and numbers clashes', () => {
    const parent = tmp();
    const now = new Date('2026-03-04T10:00:00Z');
    const a = createNewProject({ parentDir: parent, idea: 'x', now });
    const b = createNewProject({ parentDir: parent, idea: 'y', now });
    const c = createNewProject({ parentDir: parent, idea: 'z', now });
    expect([a.slug, b.slug, c.slug]).toEqual(['idea-2026-03-04', 'idea-2026-03-04-2', 'idea-2026-03-04-3']);
    expect(readFileSync(join(a.root, 'README.md'), 'utf8')).toContain('# Untitled idea');
  });

  it('commits even without a git identity, without touching global config', () => {
    const parent = tmp();
    const empty = tmp();
    writeFileSync(join(empty, 'gitconfig'), '');
    const keys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'HOME', 'USERPROFILE'] as const;
    const saved = keys.map((k) => process.env[k]);
    process.env.GIT_CONFIG_GLOBAL = join(empty, 'gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.HOME = empty;
    process.env.USERPROFILE = empty;
    try {
      const r = createNewProject({ parentDir: parent, idea: 'x', title: 'noid' });
      expect(gitSync(r.root, 'log', '--format=%an <%ae>')).toBe('Muster <muster@localhost>');
      expect(readFileSync(join(empty, 'gitconfig'), 'utf8')).toBe('');
    } finally {
      keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
    }
  });

  it('has clear errors for a missing or unusable parent', () => {
    expect(() => createNewProject({ parentDir: join(tmp(), 'nope'), idea: 'x' })).toThrow(/does not exist/);
    const f = join(tmp(), 'file');
    writeFileSync(f, '');
    expect(() => createNewProject({ parentDir: f, idea: 'x' })).toThrow(/does not exist/);
    expect(() => createNewProject({ parentDir: tmp(), idea: '  ' })).toThrow(/idea/);
  });
});
