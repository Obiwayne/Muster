import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDirs, musterPaths } from './paths.js';
import { Store } from './store.js';
import { tempRepo } from './testutil.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(rename: (from: string, to: string) => void) {
  const repo = tempRepo();
  dirs.push(repo);
  const paths = musterPaths(repo);
  ensureDirs(paths);
  const logs: string[] = [];
  const store = new Store(paths, { rename, log: (m) => logs.push(m), retryDelaysMs: [1, 2, 4, 8, 16] });
  return { store, paths, logs };
}

const errno = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

describe('Store.save on Windows', () => {
  it('retries the rename while the file is locked (EPERM/EBUSY/EACCES)', () => {
    const codes = ['EPERM', 'EBUSY', 'EACCES'];
    let calls = 0;
    const { store, paths, logs } = setup((from, to) => {
      if (calls++ < codes.length) throw errno(codes[calls - 1]);
      renameSync(from, to);
    });
    store.state.goal = { text: 'ship it', at: 'now' };
    expect(store.save()).toBe(true);
    expect(calls).toBe(4);
    expect(JSON.parse(readFileSync(paths.state, 'utf8')).goal.text).toBe('ship it');
    expect(logs).toEqual([]);
  });

  it('gives up after the last retry, logs, and still emits change', () => {
    let calls = 0;
    const { store, paths, logs } = setup(() => {
      calls++;
      throw errno('EPERM');
    });
    let changes = 0;
    store.on('change', () => changes++);
    expect(() => store.commit()).not.toThrow();
    expect(changes).toBe(1);
    expect(calls).toBe(6); // first try + 5 retries
    expect(existsSync(paths.state)).toBe(false);
    expect(logs[0]).toMatch(/could not save .*state\.json \(EPERM\) after 6 attempts/);
  });

  it('does not retry errors that are not locks', () => {
    let calls = 0;
    const { store, logs } = setup(() => {
      calls++;
      throw errno('ENOENT');
    });
    expect(store.save()).toBe(false);
    expect(calls).toBe(1);
    expect(logs).toHaveLength(1);
  });
});
