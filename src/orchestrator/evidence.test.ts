// Evidence through the HTTP API: attach from a worktree, serve the file, and the review gate.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Agent, Evidence, MusterState, Task } from '../types.js';
import { commitFile, gitSync, tempRepo } from '../core/testutil.js';
import { startOrchestrator, type Orchestrator } from './server.js';
import type { PtyLauncher, PtyProcess } from './terminal.js';

class FakePty implements PtyProcess {
  static nextPid = 5000;
  pid = FakePty.nextPid++;
  private exitCbs: ((e: { exitCode: number }) => void)[] = [];
  onData() {}
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCbs.push(cb);
  }
  write() {}
  resize() {}
  kill() {
    setImmediate(() => this.exitCbs.splice(0).forEach((cb) => cb({ exitCode: 1 })));
  }
}
const launcher: PtyLauncher = () => new FakePty();

let repo: string;
let orch: Orchestrator;

const tokenFor = (body: unknown) => {
  const actor = body && typeof body === 'object' ? (body as { actor?: unknown }).actor : undefined;
  return typeof actor === 'string' && actor !== 'you' ? orch.agentToken(actor) : orch.token;
};
async function call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T; res: Response }> {
  const res = await fetch(orch.url + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-muster-token': tokenFor(body) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  const data = type.startsWith('application/json') ? await res.json() : null;
  return { status: res.status, data, res };
}
const ok = async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
  const r = await call<T>(method, path, body);
  if (r.status !== 200) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};

beforeAll(async () => {
  process.env.MUSTER_NO_NOTIFY = '1';
  repo = tempRepo();
  const ui = mkdtempSync(join(tmpdir(), 'muster-ui-'));
  writeFileSync(join(ui, 'index.html'), '<html><head><meta name="muster-token" content=""></head></html>');
  mkdirSync(join(repo, '.muster'), { recursive: true });
  writeFileSync(join(repo, '.muster', 'config.json'), JSON.stringify({ requireEvidence: true, lines: { feature: { label: 'Feature', stations: ['build'] } }, claudePath: 'C:/fake/claude.exe' }));
  orch = await startOrchestrator({ repoRoot: repo, port: 0, launcher, uiDir: ui, log: () => {}, timings: { enterDelayMs: 5, firstPromptDelayMs: 5, nudgeDebounceMs: 10 } });
});

afterAll(async () => {
  await orch?.shutdown();
  rmSync(repo, { recursive: true, force: true });
});

describe('evidence API', () => {
  it('ignores .muster-evidence/ in git from startup', () => {
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('.muster-evidence/');
  });

  it('lists the plugin skills and saves a station with skills', async () => {
    const skills = await ok<{ name: string }[]>('GET', '/api/skills');
    expect(skills.map((s) => s.name)).toContain('evidence-driven-testing');
    expect(await ok('PUT', '/api/stations/build', { skills: ['code-structure', 'unslop'] })).toMatchObject({ skills: ['code-structure', 'unslop'] });
    expect((await call('PUT', '/api/stations/build', { skills: ['made-up'] })).status).toBe(400);
  });

  it('asks the last station for evidence, attaches it, serves it, and gates the review on it', async () => {
    await ok<Agent>('POST', '/api/agents', { actor: 'you' }); // crew-2
    await ok<Task>('POST', '/api/tasks', { title: 'Share dialog', description: 'add it', actor: 'captain' });
    await ok<Task>('POST', '/api/tasks/claim', { actor: 'crew-2' });
    const brief = await ok<{ text: string }>('GET', '/api/tasks/T1/brief');
    expect(brief.text).toContain('## Evidence (required at build)');
    expect(brief.text).toContain('`muster:unslop`'); // the skills saved above

    const crew = (await ok<{ state: MusterState }>('GET', '/api/state')).state.agents.find((a) => a.id === 'crew-2')!;
    commitFile(crew.worktree, 'share.ts', 'export const share = true;\n');
    const dir = join(crew.worktree, '.muster-evidence', 'T1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '01-after-dialog.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(gitSync(crew.worktree, 'status', '--porcelain')).toBe(''); // ignored, so the worktree stays clean
    await ok('POST', '/api/tasks/T1/done', { actor: 'crew-2', summary: 'dialog works' });

    const refused = await call('POST', '/api/tasks/T1/review', { actor: 'captain', summary: 'tested' });
    expect(refused.status).toBe(409);
    expect(refused.data.error).toMatch(/T1 has no evidence yet/);

    // crew-2 still owns the branch; another crew agent may not attach to T1
    await ok<Agent>('POST', '/api/agents', { actor: 'you' }); // crew-3
    expect((await call('POST', '/api/tasks/T1/evidence', { actor: 'crew-3', files: [], text: 'x', summary: 'x' })).status).toBe(403);

    const e = await ok<Evidence>('POST', '/api/tasks/T1/evidence', { actor: 'crew-2', files: ['.muster-evidence/T1'], summary: 'Dialog after the change' });
    expect(e).toMatchObject({ id: 'E1', station: 'review', by: 'crew-2', files: [{ name: '01-after-dialog.png', kind: 'image', bytes: 4 }] });
    expect(e.sha).toBe(gitSync(crew.worktree, 'rev-parse', 'HEAD'));
    const file = await call('GET', '/api/tasks/T1/evidence/E1/01-after-dialog.png');
    expect(file.status).toBe(200);
    expect(file.res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await file.res.arrayBuffer())).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect((await call('GET', '/api/tasks/T1/evidence/E1/..%2F..%2Fstate.json')).status).toBe(404);

    const captainNote = await ok<Evidence>('POST', '/api/tasks/T1/evidence', { actor: 'captain', text: 'npm test: 42', summary: 'Tests pass' });
    expect(captainNote.files).toEqual([{ name: 'notes.md', kind: 'text', bytes: 13 }]);
    expect((await ok<Task>('POST', '/api/tasks/T1/review', { actor: 'captain', summary: 'tested' })).status).toBe('ready_for_merge');
  });
});
