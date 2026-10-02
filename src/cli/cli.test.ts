import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MusterState } from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';
import { NOT_RUNNING, type Ctx } from './context.js';
import { colors } from './format.js';
import { initMuster } from './init.js';
import { inspectFolder } from './setup.js';
import { main } from './program.js';

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ['MUSTER_URL', 'MUSTER_TOKEN', 'MUSTER_REPO']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
});

const temps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'muster-cli-'));
  temps.push(d);
  return d;
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' });

function repo(commit = true): string {
  const d = tmp();
  git(d, 'init', '-q', '-b', 'main');
  if (commit) {
    writeFileSync(join(d, 'README.md'), '# x\n');
    git(d, 'add', '.');
    git(d, 'commit', '-q', '-m', 'init');
  }
  return d;
}

describe('muster init', () => {
  it('creates .muster and ignores it, idempotently', () => {
    const d = repo();
    writeFileSync(join(d, '.gitignore'), 'node_modules');
    const r = initMuster(d);
    expect(r.created).toContain('.muster/config.json');
    for (const sub of ['logs', 'agents', 'worktrees']) expect(existsSync(join(d, '.muster', sub))).toBe(true);
    expect(JSON.parse(readFileSync(join(d, '.muster', 'config.json'), 'utf8'))).toEqual({});
    expect(readFileSync(join(d, '.gitignore'), 'utf8')).toBe('node_modules'); // tracked files stay untouched
    expect(readFileSync(join(d, '.git', 'info', 'exclude'), 'utf8')).toContain('.muster/');
    expect(initMuster(d).created).toEqual([]);
    // .muster/ is ignored by git
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: d, encoding: 'utf8' })).not.toContain('.muster');
  });

  it('leaves the tree clean and records a non-main base branch', () => {
    const d = tmp();
    git(d, 'init', '-q', '-b', 'master');
    writeFileSync(join(d, 'a.txt'), 'a');
    git(d, 'add', '.');
    git(d, 'commit', '-q', '-m', 'init');
    initMuster(d);
    expect(existsSync(join(d, '.gitignore'))).toBe(false);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: d, encoding: 'utf8' })).toBe('');
    expect(JSON.parse(readFileSync(join(d, '.muster', 'config.json'), 'utf8'))).toEqual({ baseBranch: 'master' });
  });

  it('works from a subfolder and refuses repos without commits or outside git', () => {
    const d = repo();
    mkdirSync(join(d, 'sub'));
    expect(existsSync(join(initMuster(join(d, 'sub')).root, '.muster'))).toBe(true);
    expect(() => initMuster(repo(false))).toThrow(/no commits yet/);
    expect(() => initMuster(tmp())).toThrow(/Not a git repository/);
  });
});

describe('muster init --create', () => {
  const log = (d: string) => execFileSync('git', ['log', '--format=%s|%an'], { cwd: d, encoding: 'utf8' }).trim();
  const clean = (d: string) => execFileSync('git', ['status', '--porcelain'], { cwd: d, encoding: 'utf8' });
  const noIdentity = { GIT_CONFIG_GLOBAL: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/nonexistent' };
  const savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const [k, v] of Object.entries(noIdentity)) (savedEnv[k] = process.env[k], (process.env[k] = v));
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });

  it('an empty folder gets README.md, .gitignore and a first commit (placeholder identity, no global config)', () => {
    const d = tmp();
    const r = initMuster(d, false, true);
    expect(readFileSync(join(d, 'README.md'), 'utf8')).toBe(`# ${basename(d)}\n`);
    expect(readFileSync(join(d, '.gitignore'), 'utf8')).toBe('node_modules\ndist\n.env\n.muster/\n');
    expect(log(d)).toBe('Initial commit (set up by Muster)|Muster');
    expect(clean(d)).toBe('');
    expect(existsSync(join(r.root, '.muster', 'config.json'))).toBe(true);
    expect(() => execFileSync('git', ['config', '--local', 'user.name'], { cwd: d, stdio: 'ignore' })).toThrow();
  });

  it('a folder with files commits them, leaving ignored ones out and an existing .gitignore alone', () => {
    const d = tmp();
    writeFileSync(join(d, 'app.js'), 'x');
    mkdirSync(join(d, 'node_modules'));
    writeFileSync(join(d, 'node_modules', 'big.js'), 'x');
    initMuster(d, false, true);
    const files = execFileSync('git', ['ls-files'], { cwd: d, encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(files.sort()).toEqual(['.gitignore', 'app.js']);
    const e = tmp();
    writeFileSync(join(e, '.gitignore'), 'secret.txt\n');
    writeFileSync(join(e, 'secret.txt'), 's');
    writeFileSync(join(e, 'a.txt'), 'a');
    initMuster(e, false, true);
    expect(readFileSync(join(e, '.gitignore'), 'utf8')).toBe('secret.txt\n');
    expect(execFileSync('git', ['ls-files'], { cwd: e, encoding: 'utf8' }).split('\n').filter(Boolean).sort()).toEqual(['.gitignore', 'a.txt']);
  });

  it('a repo with no commits just gets the first commit', () => {
    const d = repo(false);
    writeFileSync(join(d, 'a.txt'), 'a');
    initMuster(d, false, true);
    expect(log(d)).toMatch(/^Initial commit \(set up by Muster\)/);
    expect(existsSync(join(d, 'README.md'))).toBe(false);
  });

  it('a subfolder of a repo opens the parent and creates nothing', () => {
    const d = repo();
    mkdirSync(join(d, 'sub'));
    const r = initMuster(join(d, 'sub'), false, true);
    expect(r.root).toBe(d);
    expect(existsSync(join(d, 'sub', '.git'))).toBe(false);
    expect(existsSync(join(d, 'sub', 'README.md'))).toBe(false);
    expect(log(d)).toBe('init|t');
    // ...and a subfolder of a repo with no commits commits at the repo root, still no nesting
    const e = repo(false);
    mkdirSync(join(e, 'sub'));
    writeFileSync(join(e, 'sub', 'a.txt'), 'a');
    expect(initMuster(join(e, 'sub'), false, true).root).toBe(e);
    expect(existsSync(join(e, 'sub', '.git'))).toBe(false);
  });

  it('without the flag it still errors and changes nothing', () => {
    const d = tmp();
    expect(() => initMuster(d)).toThrow(/Not a git repository/);
    expect(existsSync(join(d, '.git'))).toBe(false);
    expect(existsSync(join(d, 'README.md'))).toBe(false);
    expect(() => initMuster(repo(false))).toThrow(/no commits yet/);
  });

  it('inspectFolder reports state and file count, honouring ignores', () => {
    const d = tmp();
    writeFileSync(join(d, 'a.txt'), '12345');
    mkdirSync(join(d, 'node_modules'));
    writeFileSync(join(d, 'node_modules', 'x'), 'x');
    expect(inspectFolder(d)).toMatchObject({ state: 'not-a-repo', files: 1, bytes: 5, large: false });
    expect(inspectFolder(repo())).toMatchObject({ state: 'ready', files: 0 });
    const e = repo(false);
    writeFileSync(join(e, 'b.txt'), 'b');
    expect(inspectFolder(e)).toMatchObject({ state: 'no-commits', files: 1 });
  });
});

// ------------------------------------------------------------ fake orchestrator

interface Req {
  method: string;
  url: string;
  token?: string;
  body: unknown;
}

let server: Server;
let reqs: Req[] = [];
let root: string;
const TOKEN = 'a'.repeat(32);
let respond: (r: Req) => { status?: number; body: unknown } = () => ({ body: {} });

const fakeState: MusterState = {
  version: 1,
  repoRoot: '/r',
  agents: [
    { id: 'captain', role: 'captain', model: 'opus', branch: 'main', worktree: '/r', status: 'idle', sessionId: 's', startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), costUsd: 0 },
    { id: 'crew-2', role: 'crew', model: 'sonnet', branch: 'crew-2/work', worktree: '/r/w', status: 'stuck', sessionId: 't', startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), costUsd: 0 },
  ],
  tasks: [],
  notes: [],
  feed: [],
  inbox: [],
  usage: { perAgentCostUsd: {}, paused: false, weeklyWarned: false },
  nextIds: { agent: 3, task: 1, note: 1, feed: 1, inbox: 1 },
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  let data = '';
  for await (const chunk of req) data += chunk;
  return data ? JSON.parse(data) : undefined;
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const r: Req = { method: req.method!, url: req.url!, token: req.headers['x-muster-token'] as string | undefined, body: await readBody(req) };
    reqs.push(r);
    if (r.url === '/api/health') {
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (r.token !== TOKEN) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'bad token' }));
      return;
    }
    const { status = 200, body } = respond(r);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  root = tmp();
  mkdirSync(join(root, '.muster'));
  const port = (server.address() as AddressInfo).port;
  writeFileSync(join(root, '.muster', 'server.json'), JSON.stringify({ port, pid: process.pid, token: TOKEN, startedAt: new Date().toISOString() }));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

let out: string[] = [];
let opened: string[] = [];
let errSpy: string[] = [];
const origErr = process.stderr.write.bind(process.stderr);
beforeEach(() => {
  reqs = [];
  out = [];
  opened = [];
  errSpy = [];
  process.stderr.write = ((s: string) => (errSpy.push(String(s)), true)) as typeof process.stderr.write;
});
afterEach(() => {
  process.stderr.write = origErr;
});

function ctx(repoRoot = root): Ctx {
  return { cwd: repoRoot, repoRoot, out: (s) => out.push(s), c: colors(false), now: () => new Date(), openUrl: (u) => opened.push(u) };
}
const run = (args: string[], c = ctx()) => main(['node', 'muster', ...args], c);

describe('command wiring (fake orchestrator)', () => {
  it('status GETs /api/state with the token and prints a table', async () => {
    respond = () => ({ body: { state: fakeState, config: DEFAULT_CONFIG, paused: false } });
    expect(await run(['status'])).toBe(0);
    expect(reqs[0]).toEqual({ method: 'GET', url: '/api/state', token: TOKEN, body: undefined });
    expect(reqs[1]).toMatchObject({ method: 'GET', url: '/api/health' }); // the stale-build check
    const text = out.join('\n');
    expect(text).toMatch(/AGENT\s+ROLE\s+STATUS/);
    expect(text).not.toMatch(/older build/);
    expect(text).toMatch(/crew-2\s+crew\s+stuck/);
  });

  it('ask POSTs the goal to /api/ask', async () => {
    respond = () => ({ body: { ok: true } });
    expect(await run(['ask', 'Add', 'a share dialog'])).toBe(0);
    expect(reqs).toEqual([{ method: 'POST', url: '/api/ask', token: TOKEN, body: { text: 'Add a share dialog' } }]);
  });

  it('add sends role, name and task as "you"; a title becomes a new task first', async () => {
    respond = (r) =>
      r.url === '/api/tasks'
        ? { body: { id: 'T7', title: 'Fix login' } }
        : { body: { ...fakeState.agents[1], id: 'design', role: 'design', branch: 'design/work' } };
    expect(await run(['add', 'design', '--role', 'design', '--task', 'Fix login'])).toBe(0);
    expect(reqs.map((r) => [r.method, r.url])).toEqual([['POST', '/api/tasks'], ['POST', '/api/agents']]);
    expect(reqs[1].body).toEqual({ name: 'design', role: 'design', taskId: 'T7', actor: 'you' });
    reqs = [];
    expect(await run(['add', '--task', 't3'])).toBe(0);
    expect(reqs[0].body).toEqual({ role: 'crew', taskId: 'T3', actor: 'you' });
  });

  it('role, stop, start, say, reply, board and diff hit the right routes', async () => {
    respond = (r) => {
      if (r.url.startsWith('/api/notes?')) return { body: [] };
      if (r.url.includes('/reply')) return { body: { id: 'N4', open: false } };
      if (r.url.includes('/diff')) return { body: { branch: 'crew-2/work', base: 'main', stat: ' a | 1 +', diff: '' } };
      if (r.url === '/api/messages') return { body: { id: 'F1' } };
      return { body: fakeState.agents[1] };
    };
    await run(['role', 'crew-2', 'design']);
    await run(['stop', 'crew-2']);
    await run(['start', 'crew-2']);
    await run(['say', 'everyone', 'hi', 'all']);
    await run(['reply', '4', 'use', 'v2', '--close']);
    await run(['board', '--needs-you']);
    await run(['diff', 'crew-2', '--stat']);
    expect(reqs.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST /api/agents/crew-2/role',
      'POST /api/agents/crew-2/stop',
      'POST /api/agents/crew-2/start',
      'POST /api/messages',
      'POST /api/notes/N4/reply',
      'GET /api/notes?open=1&needsYou=1',
      'GET /api/agents/crew-2/diff?stat=1',
    ]);
    expect(reqs[0].body).toEqual({ role: 'design', actor: 'you' });
    expect(reqs[3].body).toEqual({ actor: 'you', to: 'everyone', text: 'hi all' });
    expect(reqs[4].body).toEqual({ actor: 'you', text: 'use v2', close: true });
    expect(out.join('\n')).toContain('Nothing needs you.');
    expect(out.join('\n')).toContain('a | 1 +');
    expect(reqs.every((r) => r.token === TOKEN)).toBe(true);
  });

  it('merge prints the 409 reason and exits 1', async () => {
    respond = () => ({ status: 409, body: { error: 'Task T3 is not ready for merge' } });
    expect(await run(['merge', 'crew-2'])).toBe(1);
    expect(reqs[0]).toMatchObject({ method: 'POST', url: '/api/agents/crew-2/merge', body: { force: false, actor: 'you' } });
    expect(errSpy.join('')).toContain('Merge refused: Task T3 is not ready for merge');
  });

  it('rejects a bad role without calling the server', async () => {
    expect(await run(['role', 'crew-2', 'admiral'])).toBe(1);
    expect(reqs).toEqual([]);
    expect(errSpy.join('')).toContain('Unknown role');
  });

  it('ui opens the dashboard URL', async () => {
    expect(await run(['ui'])).toBe(0);
    expect(opened).toEqual([`http://127.0.0.1:${(server.address() as AddressInfo).port}/`]);
  });

  it('says Muster is not running when there is no server.json or nothing listens', async () => {
    const empty = tmp();
    expect(await run(['status'], ctx(empty))).toBe(1);
    expect(errSpy.join('')).toContain(NOT_RUNNING);
    errSpy = [];
    const stale = tmp();
    mkdirSync(join(stale, '.muster'));
    writeFileSync(join(stale, '.muster', 'server.json'), JSON.stringify({ port: 1, pid: 1, token: 'x' }));
    expect(await run(['tasks'], ctx(stale))).toBe(1);
    expect(errSpy.join('')).toContain(NOT_RUNNING);
  });
});

// ------------------------------------------------------------ up / down with a fake orchestrator process

const FAKE_ORCH = `
import { createServer } from 'node:http';
import { writeFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
const repo = process.argv[process.argv.indexOf('--repo') + 1];
const file = join(repo, '.muster', 'server.json');
const token = 'b'.repeat(32);
console.log('fake orchestrator for', repo);
const srv = createServer((req, res) => {
  if (req.url === '/api/health') return res.end(JSON.stringify({ ok: true }));
  if (req.headers['x-muster-token'] !== token) { res.statusCode = 401; return res.end('{"error":"token"}'); }
  if (req.url === '/api/state') return res.end(JSON.stringify({ state: { agents: [{ id: 'captain', role: 'captain', status: 'idle', branch: 'main' }] }, config: {}, paused: false }));
  if (req.url === '/api/shutdown') { res.end('{"ok":true}'); rmSync(file, { force: true }); setTimeout(() => process.exit(0), 100); return; }
  res.statusCode = 404; res.end('{"error":"nope"}');
});
srv.listen(0, '127.0.0.1', () => {
  setTimeout(() => writeFileSync(file, JSON.stringify({ port: srv.address().port, pid: process.pid, token, startedAt: new Date().toISOString() })), 300);
});
`;

describe('muster up / down', () => {
  it('spawns the orchestrator detached, waits for it, reports the captain, then shuts it down', async () => {
    const d = repo();
    const entry = join(tmp(), 'fake-orchestrator.mjs');
    writeFileSync(entry, FAKE_ORCH);
    const { up, down } = await import('./lifecycle.js');
    const c = ctx(d);
    await up(c, { entry, ui: true });
    const text = out.join('\n');
    expect(text).toContain('Muster is up.');
    expect(text).toMatch(/Dashboard: http:\/\/127\.0\.0\.1:\d+\//);
    expect(text).toContain('Captain: captain · idle · main');
    expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(readFileSync(join(d, '.git', 'info', 'exclude'), 'utf8')).toContain('.muster/');
    expect(readFileSync(join(d, '.muster', 'logs', 'orchestrator.log'), 'utf8')).toContain('fake orchestrator for');

    out = [];
    await up(c, { entry, ui: false });
    expect(out.join('\n')).toContain('already running');

    out = [];
    await down(c, { waitMs: 5000 });
    expect(out.join('\n')).toContain('Muster is down.');
    expect(existsSync(join(d, '.muster', 'server.json'))).toBe(false);
  }, 20000);
});
