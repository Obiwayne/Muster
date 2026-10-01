import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GhResult, GhRunner } from '../core/github.js';
import { gitSync, tempRepo } from '../core/testutil.js';
import { startOrchestrator, type Orchestrator } from './server.js';

let repo: string;
let orch: Orchestrator;
let calls: string[][] = [];
let mode: 'ok' | 'missing' | 'unauthed' | 'fail' = 'ok';

const gh: GhRunner = async (args, cwd) => {
  calls.push(args);
  const r = (code: number, stdout = '', stderr = ''): GhResult => ({ code, stdout, stderr });
  if (mode === 'missing') return { code: -1, stdout: '', stderr: '', missing: true };
  if (args[0] === '--version') return r(0, 'gh version 2');
  if (args[0] === 'auth') return mode === 'unauthed' ? r(1, '', 'not logged in') : r(0);
  if (args[0] === 'api') return r(0, 'octocat\n');
  if (args[0] === 'repo') {
    if (mode === 'fail') return r(1, '', 'name already exists');
    gitSync(cwd, 'remote', 'add', 'origin', 'https://github.com/octocat/' + args[2] + '.git'); // what gh does
    return r(0, 'https://github.com/octocat/' + args[2] + '\n');
  }
  return r(1);
};

const call = async (method: string, path: string, body?: unknown, token = orch.token) => {
  const res = await fetch(orch.url + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-muster-token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
};

beforeAll(async () => {
  process.env.MUSTER_NO_NOTIFY = '1';
  repo = tempRepo();
  const ui = mkdtempSync(join(tmpdir(), 'muster-ui-'));
  writeFileSync(join(ui, 'index.html'), '<html></html>');
  mkdirSync(join(repo, '.muster'), { recursive: true });
  writeFileSync(join(repo, '.muster', 'config.json'), '{}');
  orch = await startOrchestrator({ repoRoot: repo, port: 0, uiDir: ui, ghRunner: gh, autoStart: false, log: () => {} });
});
afterAll(async () => {
  await orch?.shutdown();
  rmSync(repo, { recursive: true, force: true });
});

describe('project routes', () => {
  it('GET /api/project reports name, root and gh state', async () => {
    const r = await call('GET', '/api/project');
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ root: orch.store.state.repoRoot, gh: { installed: true, authed: true, user: 'octocat' } });
    expect(r.data.remoteUrl).toBeUndefined();
    expect(typeof r.data.name).toBe('string');
  });

  it('is human-only (403 for an agent)', async () => {
    orch.store.state.agents.push({ id: 'crew-1', role: 'crew', model: 'sonnet', branch: 'b', worktree: 'w', status: 'idle', sessionId: 's', startedAt: '', lastActivityAt: '', costUsd: 0 });
    const r = await call('POST', '/api/project/github', { name: 'x' }, orch.agentToken('crew-1'));
    expect(r.status).toBe(403);
  });

  it('rejects bad names (400), and 424 when gh is missing or unauthed', async () => {
    expect((await call('POST', '/api/project/github', { name: 'bad name!' })).status).toBe(400);
    expect((await call('POST', '/api/project/github', {})).status).toBe(400);
    mode = 'missing';
    expect((await call('POST', '/api/project/github', { name: 'demo' })).status).toBe(424);
    expect((await call('GET', '/api/project')).data.gh).toEqual({ installed: false, authed: false });
    mode = 'unauthed';
    const u = await call('POST', '/api/project/github', { name: 'demo' });
    expect(u.status).toBe(424);
    expect(u.data.error).toContain('gh auth login');
    mode = 'ok';
  });

  it('creates the repo through gh, defaults to private and returns the url', async () => {
    mode = 'fail';
    expect((await call('POST', '/api/project/github', { name: 'demo' })).status).toBe(502);
    mode = 'ok';
    calls = [];
    const r = await call('POST', '/api/project/github', { name: 'demo', description: 'My demo' });
    expect(r.status).toBe(200);
    expect(r.data.url).toBe('https://github.com/octocat/demo.git');
    const create = calls.find((c) => c[0] === 'repo')!;
    expect(create).toEqual(['repo', 'create', 'demo', '--private', '--source', orch.store.state.repoRoot, '--remote', 'origin', '--push', '--description', 'My demo']);
    expect((await call('GET', '/api/project')).data).toMatchObject({ name: 'demo', remoteUrl: 'https://github.com/octocat/demo.git' });
  });

  it('409s when origin already exists', async () => {
    calls = [];
    const r = await call('POST', '/api/project/github', { name: 'other', private: false });
    expect(r.status).toBe(409);
    expect(calls.some((c) => c[0] === 'repo')).toBe(false);
  });
});
