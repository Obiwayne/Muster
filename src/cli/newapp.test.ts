import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitSync } from '../core/testutil.js';
import type { Ctx } from './context.js';
import { colors } from './format.js';
import { newApp } from './newapp.js';
import { main } from './program.js';

// A fake orchestrator that records what is POSTed to /api/ask next to its repo.
const FAKE_ORCH = `
import { createServer } from 'node:http';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const repo = process.argv[process.argv.indexOf('--repo') + 1];
const file = join(repo, '.muster', 'server.json');
const token = 'b'.repeat(32);
const srv = createServer((req, res) => {
  if (req.url === '/api/health') return res.end('{"ok":true}');
  if (req.headers['x-muster-token'] !== token) { res.statusCode = 401; return res.end('{"error":"token"}'); }
  if (req.url === '/api/state') return res.end(JSON.stringify({ state: { agents: [] }, config: {}, paused: false }));
  if (req.url === '/api/ask') { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { writeFileSync(join(repo, '.muster', 'asked.json'), b); res.end('{"ok":true}'); }); return; }
  if (req.url === '/api/shutdown') { res.end('{"ok":true}'); rmSync(file, { force: true }); setTimeout(() => process.exit(0), 100); return; }
  res.statusCode = 404; res.end('{"error":"nope"}');
});
srv.listen(0, '127.0.0.1', () => writeFileSync(file, JSON.stringify({ port: srv.address().port, pid: process.pid, token, startedAt: new Date().toISOString() })));
`;

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ['MUSTER_AGENT', 'MUSTER_URL', 'MUSTER_TOKEN', 'MUSTER_REPO']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
const temps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'muster-newcli-'));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  for (const d of temps) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // the fake orchestrator may still hold its folder on Windows
    }
  }
});

function mkCtx(cwd: string, out: string[], opened: string[]): Ctx {
  return { cwd, out: (s) => out.push(s), c: colors(false), now: () => new Date('2026-05-06T00:00:00Z'), openUrl: (u) => void opened.push(u) };
}

describe('muster new', () => {
  it('creates the project, starts the orchestrator, posts the idea and prints the path', async () => {
    const parent = tmp();
    const entry = join(tmp(), 'fake.mjs');
    writeFileSync(entry, FAKE_ORCH);
    const out: string[] = [];
    const opened: string[] = [];
    await newApp(mkCtx(tmp(), out, opened), 'a habit tracker', { dir: parent, title: 'Habits', entry, waitMs: 10000 });
    const root = join(parent, 'habits');
    expect(out[out.length - 1]).toBe(root);
    expect(gitSync(root, 'log', '--format=%s')).toBe('Initial commit');
    expect(JSON.parse(readFileSync(join(root, '.muster', 'asked.json'), 'utf8'))).toEqual({ text: 'a habit tracker' });
    expect(opened).toHaveLength(1);

    const info = JSON.parse(readFileSync(join(root, '.muster', 'server.json'), 'utf8'));
    await fetch(`http://127.0.0.1:${info.port}/api/shutdown`, { method: 'POST', headers: { 'x-muster-token': info.token } });
  }, 30000);

  it('is wired as `muster new` and fails clearly on a missing --dir', async () => {
    const errs: string[] = [];
    const orig = process.stderr.write;
    process.stderr.write = ((s: string) => (errs.push(String(s)), true)) as typeof process.stderr.write;
    try {
      const code = await main(['node', 'muster', 'new', 'an', 'idea', '--dir', join(tmp(), 'missing'), '--no-open'], mkCtx(tmp(), [], []));
      expect(code).toBe(1);
    } finally {
      process.stderr.write = orig;
    }
    expect(errs.join('')).toMatch(/does not exist/);
  });
});
