import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MusterConfig } from '../types.js';
import { createVellumChecker, parseFiles, VellumToolError, type VellumCall } from './vellum.js';

const cfg = (vellum?: MusterConfig['vellum']) => ({ vellum }) as MusterConfig;
const configured = cfg({ command: 'x', args: [] });
const fake = fileURLToPath(new URL('./fixtures/fake-vellum.mjs', import.meta.url));
const missingEntry = join(tmpdir(), 'no-such-vellum-entry.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('parseFiles', () => {
  it('maps pages (array or count) and updatedAt (epoch ms or ISO), dropping unknown fields', () => {
    const files = parseFiles(
      JSON.stringify([
        { id: 'A', name: 'Wall', pages: [{}, {}, {}], updatedAt: 1700000000000, extra: 1 },
        { id: 'B', name: 'Two', pageCount: 4, updatedAt: '2024-01-02T03:04:05.000Z' },
        { id: 'C' },
        { name: 'no id' },
      ]),
    );
    expect(files).toEqual([
      { id: 'A', name: 'Wall', pages: 3, updated: '2023-11-14T22:13:20.000Z' },
      { id: 'B', name: 'Two', pages: 4, updated: '2024-01-02T03:04:05.000Z' },
      { id: 'C', name: 'C', pages: 0 },
    ]);
  });
  it('accepts { files: [...] } and rejects non-JSON', () => {
    expect(parseFiles('{"files":[{"id":"A","name":"a","pages":2}]}')).toEqual([{ id: 'A', name: 'a', pages: 2 }]);
    expect(parseFiles('hello')).toBeUndefined();
    expect(parseFiles('{"x":1}')).toBeUndefined();
  });
});

describe('createVellumChecker', () => {
  const ok: VellumCall = async () => '[{"id":"A","name":"Wall","pages":[{}]}]';

  it('maps a good answer to connected', async () => {
    const s = await createVellumChecker({ call: ok, defaultEntry: missingEntry }).check(configured);
    expect(s).toMatchObject({ status: 'connected', files: [{ id: 'A', name: 'Wall', pages: 1 }] });
    expect(Number.isNaN(Date.parse(s.checkedAt))).toBe(false);
    expect(s.message).toBeUndefined();
  });

  it('is not_configured with no vellum config and no default entry (and never calls)', async () => {
    let calls = 0;
    const c = createVellumChecker({ call: async () => (calls++, '[]'), defaultEntry: missingEntry });
    expect(await c.check(cfg())).toMatchObject({ status: 'not_configured', files: [] });
    expect(calls).toBe(0);
  });

  it('is error for unparseable text and for a tool error, unreachable for a thrown failure', async () => {
    expect(await createVellumChecker({ call: async () => 'hello' }).check(configured)).toMatchObject({ status: 'error', files: [] });
    const toolErr = createVellumChecker({ call: async () => { throw new VellumToolError('Vellum app is not running'); } });
    expect(await toolErr.check(configured)).toMatchObject({ status: 'error', message: 'Vellum app is not running' });
    const spawnErr = createVellumChecker({ call: async () => { throw new Error('spawn x ENOENT'); } });
    expect(await spawnErr.check(configured)).toMatchObject({ status: 'unreachable', message: 'spawn x ENOENT' });
  });

  it('caches for the window, refresh bypasses it, a config change invalidates it', async () => {
    let calls = 0;
    let t = 1000;
    const c = createVellumChecker({ call: async () => (calls++, '[]'), cacheMs: 30_000, now: () => t });
    const a = await c.check(configured);
    expect(await c.check(configured)).toBe(a);
    expect(calls).toBe(1);
    t += 29_000;
    await c.check(configured);
    expect(calls).toBe(1);
    await c.check(configured, true);
    expect(calls).toBe(2);
    await c.check(configured);
    expect(calls).toBe(2); // refresh result is cached again
    t += 31_000;
    await c.check(configured);
    expect(calls).toBe(3);
    await c.check(cfg({ command: 'y', args: [] }));
    expect(calls).toBe(4);
  });

  it('shares one in-flight check between concurrent requests', async () => {
    let calls = 0;
    const c = createVellumChecker({ call: async () => (calls++, await sleep(30), '[]') });
    const all = await Promise.all([c.check(configured), c.check(configured), c.check(configured)]);
    expect(calls).toBe(1);
    expect(all[1]).toBe(all[0]);
  });

  it('gives up at the overall deadline', async () => {
    let aborted = false;
    const hang: VellumCall = (_s, _t, signal) => new Promise(() => signal.addEventListener('abort', () => (aborted = true)));
    const started = Date.now();
    const s = await createVellumChecker({ call: hang, deadlineMs: 80 }).check(configured);
    expect(s).toMatchObject({ status: 'unreachable' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(aborted).toBe(true);
  });

  it('talks to a real MCP server over stdio', async () => {
    const s = await createVellumChecker().check(cfg({ command: process.execPath, args: [fake] }));
    expect(s).toMatchObject({ status: 'connected', files: [{ id: 'F1', name: 'Wall', pages: 2, updated: '2023-11-14T22:13:20.000Z' }] });
  });

  it('kills a hanging server at the deadline', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'muster-vellum-')), 'pid');
    const started = Date.now();
    const s = await createVellumChecker({ deadlineMs: 2500 }).check(
      cfg({ command: process.execPath, args: [fake], env: { FAKE_HANG: '1', FAKE_PID_FILE: pidFile } }),
    );
    expect(s.status).toBe('unreachable');
    expect(Date.now() - started).toBeLessThan(4000);
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
    expect(alive(pid)).toBe(false);
  });
});
