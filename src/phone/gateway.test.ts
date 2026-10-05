import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { MusterState } from '../types.js';
import { repoKey, writeHumanToken } from '../core/tokens.js';
import { startGateway, type Gateway } from './gateway.js';
import { adminRequest } from './link.js';
import { phoneFiles, readServerFile } from './store.js';
import { at, fakeNote, fakeState, fakeTask } from './testfakes.js';

// A stand-in orchestrator: /api/health, /api/state, /api/tasks and the routes the gateway forwards to.
interface Call {
  method: string;
  path: string;
  token: string | undefined;
  body: any;
}
const ORCH_TOKEN = 'human-token-for-tests';
let fake: Server;
let projectState: MusterState;
const calls: Call[] = [];
let askFails = false; // the fake orchestrator refuses POST /api/ask (a send that fails stays held)

function startFakeOrchestrator(): Promise<number> {
  fake = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const path = req.url ?? '/';
      const text = Buffer.concat(chunks).toString('utf8');
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (path === '/api/health') return json(200, { ok: true });
      if (req.headers['x-muster-token'] !== ORCH_TOKEN) return json(401, { error: 'Missing or wrong x-muster-token' });
      calls.push({ method: req.method ?? 'GET', path, token: req.headers['x-muster-token'] as string, body: text ? JSON.parse(text) : undefined });
      if (path === '/api/state') return json(200, { state: projectState, config: { projectName: 'Fake Project' }, paused: false });
      if (path === '/api/tasks') return json(200, projectState.tasks);
      if (path.startsWith('/api/agents/captain/diff')) return json(200, { stat: ' 2 files changed, 5 insertions(+), 1 deletion(-)', diff: '' });
      if (path === '/api/tasks/T1/evidence/E1/shot.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      }
      const t = /^\/api\/tasks\/(T\d+)\/(approve-merge|approve|sendback|reject)$/.exec(path);
      if (t) return json(200, { ...projectState.tasks.find((x) => x.id === t[1]), ...(t[2] === 'approve-merge' ? { mergeApproval: { at: 'now' } } : {}) });
      if (/^\/api\/notes\/N\d+\/answer$/.test(path)) return json(200, { id: 'N4', open: false, answers: JSON.parse(text).answers });
      if (/^\/api\/notes\/N\d+\/reply$/.test(path)) return json(200, { id: 'N5', replies: [{ from: 'you', text: JSON.parse(text).text }] });
      if (path === '/api/checkout/commit' || path === '/api/checkout/stash') return json(200, { ok: true, waiting: [] });
      if (path === '/api/remote/alert') return json(200, { ok: true, noteId: 'N99' });
      if (path === '/api/ask') return askFails ? json(409, { error: 'captain is not running' }) : json(200, { ok: true });
      json(404, { error: `No route ${path}` });
    });
  });
  return new Promise((ok) => fake.listen(0, '127.0.0.1', () => ok((fake.address() as { port: number }).port)));
}

let secrets: string;
let root: string;
let pid: string;
let gw: Gateway;
let cert: string;
let clock = 0; // ms added to the real time (expiry, rate limit)
const savedSecrets = process.env.MUSTER_SECRETS_DIR;

beforeAll(async () => {
  secrets = mkdtempSync(join(tmpdir(), 'muster-phone-'));
  process.env.MUSTER_SECRETS_DIR = secrets;
  root = mkdtempSync(join(tmpdir(), 'muster-phone-proj-'));
  mkdirSync(join(root, '.muster'), { recursive: true });
  const port = await startFakeOrchestrator();
  writeFileSync(join(root, '.muster', 'server.json'), JSON.stringify({ port, pid: process.pid }));
  writeHumanToken(root, ORCH_TOKEN);
  pid = repoKey(root);
  projectState = fakeState(
    [fakeNote('N1', { type: 'review', from: 'captain', to: undefined, taskId: 'T1', text: 'Ready: login works' }), fakeNote('N5', { text: 'Which colour?' })],
    [fakeTask('T1', { evidence: [{ id: 'E1', station: 'build', by: 'ada', at: 'x', summary: 'screenshot', files: [{ name: 'shot.png', kind: 'image', bytes: 4 }] }], history: [{ at: 'x', agentId: 'ada', kind: 'claimed' }] })],
  );
  gw = await startGateway({
    dir: join(secrets, 'phone'),
    port: 0,
    host: '127.0.0.1',
    recentFile: null,
    pollMs: 60_000, // the tests poll explicitly
    now: () => new Date(Date.now() + clock),
    log: () => {},
    lanHosts: () => ['192.168.1.20'],
    tailscale: async () => ({ installed: true, ip: '100.101.102.103', dnsName: 'pc.tail.ts.net', online: true }),
  });
  cert = readFileSync(phoneFiles(gw.dir).cert, 'utf8');
});

afterAll(async () => {
  await gw?.close();
  await new Promise<void>((r) => (fake ? fake.close(() => r()) : r()));
  if (savedSecrets === undefined) delete process.env.MUSTER_SECRETS_DIR;
  else process.env.MUSTER_SECRETS_DIR = savedSecrets;
  rmSync(secrets, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

/** HTTPS to the gateway, pinned like the phone does: only its certificate. */
function call(method: string, path: string, opts: { body?: unknown; key?: string; admin?: string } = {}): Promise<{ status: number; data: any; type: string; raw: Buffer }> {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (opts.key) headers.authorization = `Bearer ${opts.key}`;
    if (opts.admin) headers['x-muster-admin'] = opts.admin;
    const req = request({ host: '127.0.0.1', port: gw.port, method, path, headers, ca: cert, checkServerIdentity: () => undefined }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const type = String(res.headers['content-type'] ?? '');
        resolve({ status: res.statusCode!, data: type.includes('json') && raw.length ? JSON.parse(raw.toString('utf8')) : null, type, raw });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const admin = (method: string, path: string, body?: unknown) => call(method, path, { body, admin: gw.adminToken });
async function pairPhone(name = 'Pixel 9'): Promise<{ deviceId: string; key: string }> {
  const code = (await admin('POST', '/admin/pair-code')).data.code;
  const r = await call('POST', '/pair', { body: { code, deviceName: name } });
  expect(r.status).toBe(200);
  return r.data;
}

describe('phone gateway: state and pairing', () => {
  it('writes server.json with its port, pid and certificate fingerprint', () => {
    expect(readServerFile(gw.dir)).toMatchObject({ port: gw.port, pid: process.pid, fingerprint: gw.fingerprint });
    expect(gw.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const state = JSON.parse(readFileSync(phoneFiles(gw.dir).state, 'utf8'));
    expect(state).toMatchObject({ devices: [], network: { mode: 'lan' } });
  });

  it('keeps the remote connector off unless asked (docs/REMOTE.md)', async () => {
    expect(gw.remote).toBeNull();
    expect((await admin('GET', '/admin/remote')).data).toMatchObject({
      enabled: false,
      config: { enabled: false, port: 47911, publicHost: null, tunnel: null },
      hold: { on: true },
      settings: { confirmWrites: true, allowApprove: false },
      lastTest: null,
    });
  });

  it('makes a pair code with its QR code', async () => {
    const r = await admin('POST', '/admin/pair-code');
    expect(r.status).toBe(200);
    expect(r.data.display).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    expect(r.data.display.replace('-', '')).toBe(r.data.code);
    expect(r.data.qrText).toBe(`muster://pair?c=${r.data.code}&p=${gw.port}&f=${gw.fingerprint}&n=${encodeURIComponent(JSON.parse(readFileSync(phoneFiles(gw.dir).state, 'utf8')).pcName)}&h=192.168.1.20`);
    expect(r.data.qrSvg).toMatch(/^<svg/);
    expect(Date.parse(r.data.expiresAt) - Date.now()).toBeGreaterThan(100_000);
  });

  it('pairs with a good code, stores only the hash of the key, and refuses the code a second time', async () => {
    const code = (await admin('POST', '/admin/pair-code')).data.code;
    const ok = await call('POST', '/pair', { body: { code, deviceName: 'Pixel 9' } });
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ deviceId: expect.any(String), pcName: expect.any(String), hosts: ['192.168.1.20'] });
    expect(Buffer.from(ok.data.key, 'base64url').length).toBe(32);
    const saved = readFileSync(phoneFiles(gw.dir).state, 'utf8');
    expect(saved).not.toContain(ok.data.key);
    expect(saved).toContain('Pixel 9');
    const again = await call('POST', '/pair', { body: { code, deviceName: 'Other' } });
    expect(again.status).toBe(401);
    expect(again.data.error).toBeTruthy();
  });

  it('refuses an expired code', async () => {
    const code = (await admin('POST', '/admin/pair-code')).data.code;
    clock += 2 * 60_000 + 1000;
    const r = await call('POST', '/pair', { body: { code, deviceName: 'Late' } });
    expect(r.status).toBe(401);
    expect(r.data.error).toMatch(/expired/);
  });

  it('includes the Tailscale address in tailscale mode', async () => {
    expect((await admin('PUT', '/admin/network', { mode: 'tailscale' })).status).toBe(200);
    const r = await admin('POST', '/admin/pair-code');
    expect(r.data.qrText).toMatch(/&h=192\.168\.1\.20,100\.101\.102\.103,pc\.tail\.ts\.net$/);
    expect((await admin('PUT', '/admin/network', { mode: 'wifi' })).status).toBe(400);
    await admin('PUT', '/admin/network', { mode: 'lan' });
  });

  it('locks pairing after 5 wrong codes in a minute', async () => {
    clock += 61_000; // forget earlier failures
    const code = (await admin('POST', '/admin/pair-code')).data.code;
    const wrong = code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
    for (let i = 0; i < 5; i++) expect((await call('POST', '/pair', { body: { code: wrong } })).status).toBe(401);
    expect((await call('POST', '/pair', { body: { code } })).status).toBe(429);
    clock += 61_000;
    expect((await call('POST', '/pair', { body: { code, deviceName: 'Patient' } })).status).toBe(200);
  });
});

describe('phone gateway: auth', () => {
  it('answers 401 without a key, with an unknown key, and after unlinking', async () => {
    expect((await call('GET', '/api/needs')).status).toBe(401);
    expect((await call('GET', '/api/needs', { key: 'nope' })).status).toBe(401);
    const { key } = await pairPhone('Doomed');
    expect((await call('GET', '/api/prefs', { key })).status).toBe(200);
    expect((await call('DELETE', '/api/device', { key })).status).toBe(200);
    expect((await call('GET', '/api/needs', { key })).status).toBe(401);
  });

  it('the admin API refuses calls without the admin token, and phone keys', async () => {
    const { key } = await pairPhone('Sneaky');
    expect((await call('GET', '/admin/status')).status).toBe(401);
    expect((await call('GET', '/admin/status', { admin: 'wrong' })).status).toBe(401);
    expect((await call('POST', '/admin/pair-code', { key })).status).toBe(401);
    expect((await admin('GET', '/admin/status')).status).toBe(200);
  });

  it('lists devices, removes one, and sends a test event', async () => {
    const { deviceId, key } = await pairPhone('Listed');
    const status = await admin('GET', '/admin/status');
    expect(status.data).toMatchObject({ port: gw.port, fingerprint: gw.fingerprint, network: { mode: 'lan', lanHosts: ['192.168.1.20'], tailscale: { installed: true } } });
    expect(status.data.devices.find((d: any) => d.id === deviceId)).toMatchObject({ name: 'Listed', online: false });
    expect((await admin('DELETE', `/admin/devices/${deviceId}`)).status).toBe(200);
    expect((await call('GET', '/api/prefs', { key })).status).toBe(401);
    expect((await admin('DELETE', `/admin/devices/${deviceId}`)).status).toBe(404);
  });
});

describe('phone gateway: projects and actions', () => {
  let key: string;
  beforeAll(async () => {
    key = (await pairPhone('Worker')).key;
    expect((await admin('POST', '/admin/projects', { root })).data).toEqual({ ok: true, id: pid });
    expect((await admin('POST', '/admin/projects', { root: 'relative/path' })).status).toBe(400);
  });

  it('GET /api/needs maps the running project\'s notes', async () => {
    const r = await call('GET', '/api/needs', { key });
    expect(r.status).toBe(200);
    expect(r.data.projects).toEqual([{ id: pid, name: 'Fake Project', running: true }]);
    expect(r.data.items.map((i: any) => [i.id, i.kind, i.projectName])).toEqual([
      [`${pid}:N1`, 'review', 'Fake Project'],
      [`${pid}:N5`, 'question', 'Fake Project'],
    ]);
    expect(calls.at(-1)).toMatchObject({ path: '/api/state', token: ORCH_TOKEN });
  });

  it('task detail, evidence bytes and crew', async () => {
    const d = await call('GET', `/api/projects/${pid}/tasks/T1`, { key });
    expect(d.data).toMatchObject({
      task: { id: 'T1', title: 'Task T1', status: 'ready_for_merge', builder: 'ada', branch: 'ada/T1' },
      review: { from: 'captain', text: 'Ready: login works' },
      evidence: [{ id: 'E1', summary: 'screenshot', files: [{ name: 'shot.png', kind: 'image' }] }],
      diffStat: { files: 2, added: 5, removed: 1 },
    });
    const f = await call('GET', `/api/projects/${pid}/tasks/T1/evidence/E1/shot.png`, { key });
    expect(f.status).toBe(200);
    expect(f.type).toBe('image/png');
    expect([...f.raw]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const crew = await call('GET', `/api/projects/${pid}/crew`, { key });
    expect(crew.data).toMatchObject({ agents: [{ id: 'captain', role: 'captain' }, { id: 'ada', role: 'crew', taskId: 'T1', detail: 'Task T1' }], usage: { fiveHour: { pct: 42 }, weekly: null }, paused: false });
    expect((await call('GET', `/api/projects/nope/crew`, { key })).status).toBe(404);
    expect(crew.data.roadmap).toBeNull();
  });

  it('crew carries where we are on the roadmap', async () => {
    const saved = projectState;
    projectState = structuredClone(saved);
    projectState.tasks.push(fakeTask('T2', { status: 'merged', goalId: 'G1' }), fakeTask('T3', { status: 'claimed', goalId: 'G1' }));
    projectState.roadmap = {
      title: 'shop v1', summary: '', status: 'approved', revision: 1, createdBy: 'captain', updatedAt: at,
      stages: [{ id: 'M1', title: 'Foundations', description: '', status: 'active', goalIds: ['G1'], exitCriteria: [] }],
      goals: [{ id: 'G1', stageId: 'M1', title: 'Auth', description: '', status: 'active' }],
      statusLine: { text: 'M1 is 50%: Auth half done.', at, by: 'captain', taskId: 'T2' },
    };
    try {
      const crew = await call('GET', `/api/projects/${pid}/crew`, { key });
      expect(crew.data.roadmap).toEqual({ pct: 50, current: { id: 'G1', title: 'Auth' }, status: { text: 'M1 is 50%: Auth half done.', at } });
      delete projectState.roadmap!.statusLine;
      projectState.roadmap!.goals[0].status = 'done';
      expect((await call('GET', `/api/projects/${pid}/crew`, { key })).data.roadmap).toEqual({ pct: 50, current: null, status: null });
    } finally {
      projectState = saved;
    }
  });

  it('forwards approve, send-back, reply, answer, commit and stash as you', async () => {
    calls.length = 0;
    expect((await call('POST', `/api/projects/${pid}/tasks/T1/approve`, { key })).data).toMatchObject({ ok: true, task: { id: 'T1', mergeApproval: { at: 'now' } } });
    expect((await call('POST', `/api/projects/${pid}/tasks/T1/send-back`, { key, body: { text: 'Fix the colour' } })).status).toBe(200);
    expect((await call('POST', `/api/projects/${pid}/tasks/T1/send-back`, { key, body: {} })).status).toBe(400);
    expect((await call('POST', `/api/projects/${pid}/notes/N5/reply`, { key, body: { text: 'Blue' } })).status).toBe(200);
    expect((await call('POST', `/api/projects/${pid}/notes/N4/answer`, { key, body: { answers: [{ choices: ['Flux'] }] } })).data).toMatchObject({ id: 'N4', open: false });
    expect((await call('POST', `/api/projects/${pid}/notes/N4/answer`, { key, body: {} })).status).toBe(400);
    expect((await call('POST', `/api/projects/${pid}/checkout/commit`, { key })).status).toBe(200);
    expect((await call('POST', `/api/projects/${pid}/checkout/stash`, { key })).status).toBe(200);
    const posts = calls.filter((c) => c.method === 'POST').map((c) => [c.path, c.body]);
    expect(posts).toEqual([
      ['/api/tasks/T1/approve-merge', {}],
      ['/api/tasks/T1/sendback', { note: 'Fix the colour' }],
      ['/api/notes/N5/reply', { text: 'Blue' }],
      ['/api/notes/N4/answer', { answers: [{ choices: ['Flux'] }] }],
      ['/api/checkout/commit', {}],
      ['/api/checkout/stash', {}],
    ]);
    expect(calls.every((c) => c.token === ORCH_TOKEN)).toBe(true);
  });

  it('approves a task at a human station through approve, not approve-merge', async () => {
    projectState.tasks.push(fakeTask('T9', { status: 'awaiting_approval' }));
    calls.length = 0;
    expect((await call('POST', `/api/projects/${pid}/tasks/T9/approve`, { key })).status).toBe(200);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/api/tasks/T9/approve']);
    projectState.tasks.pop();
  });

  it('GET/PUT /api/prefs, and new devices start from /admin/send', async () => {
    const before = await call('GET', '/api/prefs', { key });
    expect(before.data).toEqual({ notify: { review: true, question: true, blocked: true, usage: false, stuck: false }, quiet: { on: true, from: '22:00', to: '07:00' }, projects: {} });
    const put = await call('PUT', '/api/prefs', { key, body: { notify: { usage: true }, projects: { [pid]: false } } });
    expect(put.data).toMatchObject({ notify: { usage: true }, projects: { [pid]: false } });
    expect((await call('PUT', '/api/prefs', { key, body: { quiet: { from: 'late' } } })).status).toBe(400);
    expect((await admin('PUT', '/admin/send', { notify: { stuck: true } })).data.notify.stuck).toBe(true);
    const other = await pairPhone('Second');
    expect((await call('GET', '/api/prefs', { key: other.key })).data.notify.stuck).toBe(true);
    await admin('PUT', '/admin/send', { notify: { stuck: false } });
    await call('PUT', '/api/prefs', { key, body: { notify: { usage: false }, projects: { [pid]: true } } });
  });
});

describe('phone gateway: events websocket', () => {
  const connect = (key?: string): Promise<{ ws: WebSocket; messages: any[] }> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${gw.port}/api/events`, { headers: key ? { authorization: `Bearer ${key}` } : {}, ca: cert, checkServerIdentity: () => undefined });
      const messages: any[] = [];
      ws.on('message', (m) => messages.push(JSON.parse(String(m))));
      ws.on('open', () => resolve({ ws, messages }));
      ws.on('error', reject);
    });
  const until = async (check: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('refuses a socket without a known key', async () => {
    await expect(connect()).rejects.toThrow(/401/);
    await expect(connect('nope')).rejects.toThrow(/401/);
  });

  it('sends a new item, honours prefs, and reports resolved ones', async () => {
    clock = 0;
    const realHour = new Date().getHours();
    const { key } = await pairPhone('Listener');
    // Quiet hours that never cover "now", so the test passes at any time of day.
    const from = `${String((realHour + 2) % 24).padStart(2, '0')}:00`;
    const to = `${String((realHour + 3) % 24).padStart(2, '0')}:00`;
    await call('PUT', '/api/prefs', { key, body: { quiet: { from, to } } });
    const { ws, messages } = await connect(key);
    await until(() => gw.readyClients() > 0);
    await gw.pollNow(); // the baseline (N1, N5) is never pushed
    expect(messages.filter((m) => m.type === 'need')).toEqual([]);

    projectState.notes.push(fakeNote('N20', { type: 'question', from: 'bea', text: 'Ship it on Friday?' }));
    projectState.notes.push(fakeNote('N21', { type: 'system', from: 'muster', topic: 'weekly_usage', text: 'Weekly usage at 80%' })); // usage is off by default
    await gw.pollNow();
    await until(() => messages.some((m) => m.type === 'need'));
    const needs = messages.filter((m) => m.type === 'need');
    expect(needs).toHaveLength(1);
    expect(needs[0].item).toMatchObject({ id: `${pid}:N20`, kind: 'question', summary: 'Ship it on Friday?', projectName: 'Fake Project' });

    projectState.notes.find((n) => n.id === 'N20')!.open = false;
    await gw.pollNow();
    await until(() => messages.some((m) => m.type === 'resolved'));
    expect(messages.filter((m) => m.type === 'resolved')).toEqual([{ type: 'resolved', id: `${pid}:N20` }]);

    expect((await admin('POST', '/admin/test')).data.sent).toBeGreaterThanOrEqual(1);
    await until(() => messages.some((m) => m.type === 'test'));
    const status = await admin('GET', '/admin/status');
    expect(status.data.devices.find((d: any) => d.name === 'Listener').online).toBe(true);

    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    await call('DELETE', '/api/device', { key });
    expect(await closed).toBe(4001);
  });
});

describe('phone gateway: admin client', () => {
  it('adminRequest pins the certificate on disk', async () => {
    const r = await adminRequest(gw.dir, 'GET', '/admin/status');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).fingerprint).toBe(gw.fingerprint);
  });
});

describe('phone gateway: remote connector lockout alert', () => {
  it('5 wrong login codes post one alert to the running project, with the Windows toast', async () => {
    const dir2 = join(secrets, 'phone-remote');
    const gw2 = await startGateway({ dir: dir2, port: 0, host: '127.0.0.1', recentFile: null, pollMs: 60_000, log: () => {}, remote: { port: 0, tunnel: 'cloudflare' } });
    try {
      expect((await adminRequest(dir2, 'POST', '/admin/projects', JSON.stringify({ root }))).status).toBe(200);
      const port = gw2.remote!.port;
      const post = (path: string, body: string, type: string) =>
        fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body, headers: { 'content-type': type }, redirect: 'manual' });
      const reg = await (await post('/register', JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }), 'application/json')).json();
      const form = new URLSearchParams({
        client_id: reg.client_id,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        response_type: 'code',
        code_challenge: 'A'.repeat(43),
        code_challenge_method: 'S256',
        code: 'AAAAAA',
        decision: 'allow',
      }).toString();
      const before = calls.length;
      for (let i = 0; i < 6; i++) await post('/authorize', form, 'application/x-www-form-urlencoded');
      for (let i = 0; i < 50 && !calls.slice(before).some((c) => c.path === '/api/remote/alert'); i++) await new Promise((r) => setTimeout(r, 20));
      const alerts = calls.slice(before).filter((c) => c.path === '/api/remote/alert');
      expect(alerts).toHaveLength(1); // the 6th try hits the lock and raises nothing new
      expect(alerts[0].token).toBe(ORCH_TOKEN); // sent as you
      expect(alerts[0].body.toast).toBe(true);
      expect(alerts[0].body.text).toMatch(/^Remote access: 5 wrong login codes in a minute, so connector logins are locked until \d\d:\d\d\. Last try came from 127\.0\.0\.1 \(socket\) via "Claude"/);
      expect((await adminRequest(dir2, 'GET', '/admin/remote')).body).toContain('"loginLocked":true');
    } finally {
      await gw2.close();
    }
  });
});

describe('phone gateway: held remote writes (docs/REMOTE.md, confirmation gate)', () => {
  let dir3: string;
  let gw3: Gateway;
  let cert3: string;
  let key: string;
  let t3 = Date.parse('2026-10-05T12:00:00.000Z');

  /** HTTPS to gw3 as the paired phone. */
  const phone3 = (method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> =>
    new Promise((ok, fail) => {
      const text = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        { host: '127.0.0.1', port: gw3.port, method, path, ca: cert3, checkServerIdentity: () => undefined, headers: { authorization: `Bearer ${key}`, ...(text ? { 'content-type': 'application/json' } : {}) } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            ok({ status: res.statusCode!, data: raw ? JSON.parse(raw) : null });
          });
        },
      );
      req.on('error', fail);
      req.end(text);
    });
  const admin3 = async (method: string, path: string, body?: unknown) => {
    const r = await adminRequest(dir3, method, path, body === undefined ? undefined : JSON.stringify(body));
    return { status: r.status, data: r.body ? JSON.parse(r.body) : null };
  };
  const mcp = async (method: string, params: unknown) => {
    const r = await fetch(`http://127.0.0.1:${gw3.remote!.port}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return (await r.json()).result;
  };
  /** An MCP tool call through the connector (dev token). */
  const tool = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
    const res = await mcp('tools/call', { name, arguments: args });
    return { text: res.content[0].text, isError: !!res.isError };
  };
  const toolNames = async () => ((await mcp('tools/list', {})).tools as { name: string }[]).map((t) => t.name);
  const audit3 = () => readFileSync(phoneFiles(dir3).remoteLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const orchCalls = (path: string, since: number) => calls.slice(since).filter((c) => c.path === path);
  const remoteItems = async () => ((await phone3('GET', '/api/needs')).data.items as any[]).filter((i) => i.kind === 'remote_write');
  /** The digest on the card for a held write, as the phone/desktop would send it back with Send. */
  const dig = async (id: string): Promise<string> => (await remoteItems()).find((i) => i.remote.pendingId === id)?.remote.digest ?? 'gone';
  const start3 = async () => {
    gw3 = await startGateway({ dir: dir3, port: 0, host: '127.0.0.1', recentFile: null, pollMs: 60_000, log: () => {}, now: () => new Date(t3), remote: { port: 0, devToken: 'dev' } });
    cert3 = readFileSync(phoneFiles(dir3).cert, 'utf8');
  };

  beforeAll(async () => {
    dir3 = join(secrets, 'phone-writes');
    await start3();
    await admin3('POST', '/admin/projects', { root });
    const code = (await admin3('POST', '/admin/pair-code')).data.code;
    const paired = await new Promise<any>((ok, fail) => {
      const req = request({ host: '127.0.0.1', port: gw3.port, method: 'POST', path: '/pair', ca: cert3, checkServerIdentity: () => undefined, headers: { 'content-type': 'application/json' } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      });
      req.on('error', fail);
      req.end(JSON.stringify({ code, deviceName: 'A55' }));
    });
    key = paired.key;
  });

  afterAll(async () => {
    await gw3?.close();
  });

  it('a goal is held, shows in Needs you with Send/Discard, and nothing reaches the Captain', async () => {
    const before = calls.length;
    const r = await tool('muster_send_goal', { text: 'Add an export button' });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^Held for your OK as P1 \(Fake Project\)\. Nothing has been sent/);
    expect(orchCalls('/api/ask', before)).toHaveLength(0);
    const [item] = await remoteItems();
    expect(item).toMatchObject({ id: `${pid}:P1`, kind: 'remote_write', title: 'dev token wants to set a goal', summary: 'Add an export button', from: 'dev token', actions: ['send', 'discard'] });
    expect(audit3().some((l) => l.event === 'write_held' && l.id === 'P1')).toBe(true);
  });

  it('your tap on Send (phone) runs it as you, marked via the connector, and clears it', async () => {
    const before = calls.length;
    const r = await phone3('POST', `/api/projects/${pid}/pending/P1/send`, { digest: await dig('P1') });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ ok: true, id: 'P1', summary: 'goal sent to the Captain' });
    const [ask] = orchCalls('/api/ask', before);
    expect(ask.token).toBe(ORCH_TOKEN);
    expect(ask.body).toMatchObject({ text: 'Add an export button', via: { client: 'dev token', approvedOn: 'phone', approvedAt: new Date(t3).toISOString(), pendingId: 'P1' } });
    expect(await remoteItems()).toHaveLength(0);
    expect((await phone3('POST', `/api/projects/${pid}/pending/P1/send`, { digest: 'x' })).status).toBe(404); // only once
    expect(audit3().some((l) => l.event === 'write_sent' && l.id === 'P1' && l.approvedOn === 'phone')).toBe(true);
  });

  it('a reply is held and sent from the desktop; Discard drops one without sending', async () => {
    expect((await tool('muster_reply', { noteId: 'n5', text: 'Blue' })).text).toContain('as P2');
    expect((await tool('muster_reply', { noteId: 'N5', text: 'Red' })).text).toContain('as P3');
    const listed = (await admin3('GET', '/admin/remote/pending')).data;
    expect(listed.map((w: any) => [w.id, w.noteId, w.title])).toEqual([
      ['P2', 'N5', 'dev token wants to reply on N5'],
      ['P3', 'N5', 'dev token wants to reply on N5'],
    ]);
    const before = calls.length;
    expect((await admin3('POST', '/admin/remote/pending/P3/discard')).status).toBe(200);
    expect((await admin3('POST', '/admin/remote/pending/P2/send', { digest: listed[0].digest })).status).toBe(200);
    const sent = orchCalls('/api/notes/N5/reply', before);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({ text: 'Blue', via: { approvedOn: 'desktop' } });
    expect(audit3().some((l) => l.event === 'write_discarded' && l.id === 'P3' && l.on === 'desktop')).toBe(true);
  });

  it('refuses writes that could not run, before holding anything', async () => {
    const unknown = await tool('muster_reply', { noteId: 'N404', text: 'hi' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('No note "N404"');
    expect((await tool('muster_answer', { noteId: 'N5', answers: [{ choices: ['x'] }] })).text).toContain('not a question menu');
    expect((await tool('muster_send_goal', { project: 'Nope', text: 'x' })).text).toContain('No project "Nope"');
    expect(await remoteItems()).toHaveLength(0);
  });

  it('a send that fails stays held, so you can retry or discard', async () => {
    await tool('muster_send_goal', { text: 'Retry me' });
    askFails = true;
    try {
      const r = await phone3('POST', `/api/projects/${pid}/pending/P4/send`, { digest: await dig('P4') });
      expect(r.status).toBe(409);
      expect((await remoteItems()).map((i) => i.id)).toEqual([`${pid}:P4`]);
    } finally {
      askFails = false;
    }
    expect((await phone3('POST', `/api/projects/${pid}/pending/P4/send`, { digest: await dig('P4') })).status).toBe(200);
  });

  it('the card carries the write in full: untruncated text, the project, the note it replies to, and when it expires', async () => {
    const long = 'Rework the export dialog. '.repeat(120).trim(); // ~3100 characters
    const g = await tool('muster_send_goal', { text: long });
    const r = await tool('muster_reply', { noteId: 'N5', text: 'Teal, like the logo' });
    const gid = /as (P\d+)/.exec(g.text)![1];
    const rid = /as (P\d+)/.exec(r.text)![1];
    const items = await remoteItems();
    const goal = items.find((i) => i.remote.pendingId === gid);
    const reply = items.find((i) => i.remote.pendingId === rid);
    expect(goal.remote).toMatchObject({ kind: 'goal', projectName: 'Fake Project', client: 'dev token', text: long, expiresAt: new Date(t3 + 15 * 60_000).toISOString() });
    expect(goal.summary.length).toBeLessThanOrEqual(140); // the short line is for notifications only
    expect(reply.remote).toMatchObject({ kind: 'reply', text: 'Teal, like the logo', replyTo: { id: 'N5', from: 'ada', type: 'question', text: 'Which colour?' } });
    expect(reply.remote.replyTo.questions).toBeUndefined();
    expect(goal.remote.digest).toMatch(/^[0-9a-f]{64}$/);
    for (const id of [gid, rid]) await phone3('POST', `/api/projects/${pid}/pending/${id}/discard`);
  });

  it('a held answer carries the question menu it answers, so the card can show each answer under its question', async () => {
    projectState.notes.push(
      fakeNote('N7', {
        type: 'escalation',
        from: 'captain',
        text: 'Two quick choices',
        ask: [
          { header: 'Formats', question: 'Which export formats?', multiSelect: true, options: [{ label: 'MP4' }, { label: 'WebM' }] },
          { header: 'Default', question: 'Default resolution?', multiSelect: false, options: [{ label: '1080p' }, { label: '4K' }] },
        ],
      }),
    );
    try {
      const r = await tool('muster_answer', { noteId: 'N7', answers: [{ choices: ['MP4', 'WebM'] }, { choices: ['1080p'] }] });
      const id = /as (P\d+)/.exec(r.text)![1];
      const item = (await remoteItems()).find((i) => i.remote.pendingId === id);
      expect(item.remote.replyTo).toMatchObject({
        id: 'N7',
        from: 'captain',
        type: 'escalation',
        questions: [
          { header: 'Formats', question: 'Which export formats?', multiSelect: true, options: ['MP4', 'WebM'] },
          { header: 'Default', question: 'Default resolution?', multiSelect: false, options: ['1080p', '4K'] },
        ],
      });
      expect(item.remote.answers).toEqual([{ choices: ['MP4', 'WebM'] }, { choices: ['1080p'] }]);
      await phone3('POST', `/api/projects/${pid}/pending/${id}/discard`);
    } finally {
      projectState.notes = projectState.notes.filter((n) => n.id !== 'N7');
    }
  });

  it('Send sends exactly what the card showed: no digest is 400, a different one is 409, and nothing is sent', async () => {
    const a = /as (P\d+)/.exec((await tool('muster_send_goal', { text: 'First' })).text)![1];
    const b = /as (P\d+)/.exec((await tool('muster_send_goal', { text: 'Second' })).text)![1];
    const before = calls.length;
    expect((await phone3('POST', `/api/projects/${pid}/pending/${a}/send`)).status).toBe(400);
    const wrong = await phone3('POST', `/api/projects/${pid}/pending/${a}/send`, { digest: await dig(b) }); // another card's digest
    expect(wrong.status).toBe(409);
    expect(wrong.data.error).toContain('not what your screen showed');
    expect((await admin3('POST', `/admin/remote/pending/${a}/send`, { digest: 'f'.repeat(64) })).status).toBe(409);
    expect(orchCalls('/api/ask', before)).toHaveLength(0);
    expect(audit3().some((l) => l.event === 'write_send_refused' && l.id === a && l.reason === 'digest_mismatch')).toBe(true);
    // two calls with the same text still get different digests (the id is part of it)
    const c = /as (P\d+)/.exec((await tool('muster_send_goal', { text: 'First' })).text)![1];
    expect(await dig(c)).not.toBe(await dig(a));
    for (const id of [a, b, c]) await phone3('POST', `/api/projects/${pid}/pending/${id}/discard`);
  });

  it('a held write edited on disk is refused even with the digest the card showed', async () => {
    const id = /as (P\d+)/.exec((await tool('muster_send_goal', { text: 'Original' })).text)![1];
    const shown = await dig(id);
    await gw3.close();
    const file = join(dir3, 'state.json');
    const st = JSON.parse(readFileSync(file, 'utf8'));
    st.remote.pending.find((w: any) => w.id === id).text = 'Swapped';
    writeFileSync(file, JSON.stringify(st));
    await start3();
    const before = calls.length;
    expect((await phone3('POST', `/api/projects/${pid}/pending/${id}/send`, { digest: shown })).status).toBe(409);
    expect(orchCalls('/api/ask', before)).toHaveLength(0);
    expect(audit3().some((l) => l.event === 'write_send_refused' && l.reason === 'changed_on_disk')).toBe(true);
    await phone3('POST', `/api/projects/${pid}/pending/${id}/discard`);
  });

  it('held writes expire after 15 minutes unsent', async () => {
    const id = /as (P\d+)/.exec((await tool('muster_send_goal', { text: 'Too late' })).text)![1];
    expect(await remoteItems()).toHaveLength(1);
    t3 += 15 * 60_000 + 1;
    expect(await remoteItems()).toHaveLength(0);
    expect((await phone3('POST', `/api/projects/${pid}/pending/${id}/send`, { digest: 'x' })).status).toBe(404);
    expect(audit3().some((l) => l.event === 'write_expired' && l.id === id)).toBe(true);
  });

  it('turning the hold off needs confirm: true from the desktop; then writes run at once as "not held"', async () => {
    expect((await admin3('GET', '/admin/remote/settings')).data).toEqual({ confirmWrites: true, allowApprove: false });
    const refused = await admin3('PUT', '/admin/remote/settings', { confirmWrites: false });
    expect(refused.status).toBe(400);
    expect(refused.data.error).toContain('poisoned bulletin note');
    expect((await admin3('PUT', '/admin/remote/settings', { confirmWrites: false, confirm: true })).data.confirmWrites).toBe(false);
    try {
      const before = calls.length;
      const r = await tool('muster_send_goal', { text: 'Straight through' });
      expect(r.text).toBe('Sent to Fake Project: goal sent to the Captain');
      expect(orchCalls('/api/ask', before)[0].body.via.approvedOn).toBe('not held');
      expect(audit3().some((l) => l.event === 'settings_changed' && l.after.confirmWrites === false)).toBe(true);
    } finally {
      await admin3('PUT', '/admin/remote/settings', { confirmWrites: true });
    }
    expect((await admin3('GET', '/admin/remote/settings')).data.confirmWrites).toBe(true); // turning it back on needs no confirm
    expect((await admin3('PUT', '/admin/remote/settings', { allowApprove: 'yes' })).status).toBe(400);
  });

  it('the phone learns when the hold is off (for its banner), with when and how many went out untapped', async () => {
    expect((await phone3('GET', '/api/needs')).data.hold).toEqual({ on: true, offSince: null, sentWithoutTap: 0 });
    await admin3('PUT', '/admin/remote/settings', { confirmWrites: false, confirm: true });
    try {
      await tool('muster_send_goal', { text: 'one' });
      await tool('muster_send_goal', { text: 'two' });
      const hold = (await phone3('GET', '/api/needs')).data.hold;
      expect(hold).toEqual({ on: false, offSince: new Date(t3).toISOString(), sentWithoutTap: 2 });
      expect((await admin3('GET', '/admin/remote')).data.hold).toEqual(hold);
    } finally {
      await admin3('PUT', '/admin/remote/settings', { confirmWrites: true });
    }
    expect((await phone3('GET', '/api/needs')).data.hold).toEqual({ on: true, offSince: null, sentWithoutTap: 0 });
  });

  it('a login code shows only in the New code reply: status says one is live, never which; Cancel ends it', async () => {
    const before = (await admin3('GET', '/admin/remote')).data;
    expect(before.codeActiveUntil).toBeNull();
    const made = (await admin3('POST', '/admin/remote/code')).data;
    const status = await admin3('GET', '/admin/remote');
    expect(status.data.codeActiveUntil).toBe(made.expiresAt);
    expect(JSON.stringify(status.data)).not.toContain(made.code);
    expect(JSON.stringify(status.data)).not.toContain(made.display);
    expect((await admin3('DELETE', '/admin/remote/code')).data).toEqual({ ok: true, cancelled: true });
    expect((await admin3('GET', '/admin/remote')).data.codeActiveUntil).toBeNull();
    expect((await admin3('DELETE', '/admin/remote/code')).data.cancelled).toBe(false);
    expect(audit3().some((l) => l.event === 'code_cancelled')).toBe(true);
  });

  it('muster_approve exists only when allowed; it is held too, and Send approves for merge', async () => {
    expect(await toolNames()).not.toContain('muster_approve');
    await admin3('PUT', '/admin/remote/settings', { allowApprove: true });
    try {
      expect(await toolNames()).toContain('muster_approve');
      const r = await tool('muster_approve', { taskId: 't1' });
      expect(r.text).toMatch(/^Held for your OK as P\d+/);
      const id = /as (P\d+)/.exec(r.text)![1];
      const before = calls.length;
      expect((await phone3('POST', `/api/projects/${pid}/pending/${id}/send`, { digest: await dig(id) })).status).toBe(200);
      expect(orchCalls('/api/tasks/T1/approve-merge', before)).toHaveLength(1);
    } finally {
      await admin3('PUT', '/admin/remote/settings', { allowApprove: false });
    }
  });

  it('settings and held writes survive a gateway restart', async () => {
    await tool('muster_send_goal', { text: 'Still here after restart' });
    await gw3.close();
    await start3();
    expect((await remoteItems()).map((i) => i.summary)).toEqual(['Still here after restart']);
    expect((await tool('muster_send_goal', { text: 'next id' })).text).not.toMatch(/as P1 /); // ids keep counting
  });
});

describe('phone gateway: remote access config from Settings (docs/REMOTE.md, milestone 4 contract)', () => {
  let dir4: string;
  let gw4: Gateway;
  let testReply: () => Promise<Response> = async () => new Response('{}', { status: 200 });
  const admin4 = async (method: string, path: string, body?: unknown) => {
    const r = await adminRequest(dir4, method, path, body === undefined ? undefined : JSON.stringify(body));
    return { status: r.status, data: r.body ? JSON.parse(r.body) : null };
  };

  beforeAll(async () => {
    dir4 = join(secrets, 'phone-config');
    gw4 = await startGateway({ dir: dir4, port: 0, host: '127.0.0.1', recentFile: null, pollMs: 60_000, log: () => {}, remoteTestFetch: (() => testReply()) as unknown as typeof fetch });
  });
  afterAll(async () => {
    await gw4?.close();
  });

  it('turns the connector on and off, and restarts it on a new public host or tunnel', async () => {
    expect(gw4.remote).toBeNull();
    const on = await admin4('PUT', '/admin/remote/config', { enabled: true, port: 0, publicHost: 'https://Muster.Example.com/mcp/', tunnel: 'cloudflare' });
    expect(on.status).toBe(200);
    expect(on.data).toMatchObject({ running: true, config: { enabled: true, port: 0, publicHost: 'muster.example.com', tunnel: 'cloudflare' } });
    const first = gw4.remote!;
    expect(first.status()).toMatchObject({ publicHost: 'muster.example.com', tunnel: 'cloudflare' });
    await admin4('PUT', '/admin/remote/config', { tunnel: 'tailscale' });
    expect(gw4.remote).not.toBe(first); // restarted
    expect(gw4.remote!.status().tunnel).toBe('tailscale');
    const status = (await admin4('GET', '/admin/remote')).data;
    expect(status).toMatchObject({ enabled: true, config: { tunnel: 'tailscale' }, hold: { on: true }, settings: { confirmWrites: true } });
    await admin4('PUT', '/admin/remote/config', { enabled: false });
    expect(gw4.remote).toBeNull();
    expect((await admin4('GET', '/admin/remote')).data).toMatchObject({ enabled: false, config: { enabled: false, publicHost: 'muster.example.com' } });
  });

  it('refuses bad config and keeps the old one', async () => {
    expect((await admin4('PUT', '/admin/remote/config', { publicHost: 'not a host' })).status).toBe(400);
    expect((await admin4('PUT', '/admin/remote/config', { tunnel: 'ngrok' })).status).toBe(400);
    expect((await admin4('PUT', '/admin/remote/config', { port: 99999 })).status).toBe(400);
    expect((await admin4('PUT', '/admin/remote/config', { wild: 1 })).status).toBe(400);
    expect((await admin4('GET', '/admin/remote/config')).data.publicHost).toBe('muster.example.com');
  });

  it('the config survives a gateway restart', async () => {
    await admin4('PUT', '/admin/remote/config', { enabled: true, port: 0 });
    await gw4.close();
    gw4 = await startGateway({ dir: dir4, port: 0, host: '127.0.0.1', recentFile: null, pollMs: 60_000, log: () => {}, remoteTestFetch: (() => testReply()) as unknown as typeof fetch });
    expect(gw4.remote).not.toBeNull();
    expect(gw4.remote!.status().publicHost).toBe('muster.example.com');
  });

  it('Test reaches the public address and checks it is this connector', async () => {
    testReply = async () => new Response(JSON.stringify({ resource: 'https://muster.example.com/mcp' }), { status: 200 });
    expect((await admin4('POST', '/admin/remote/test')).data).toMatchObject({ ok: true, status: 200 });
    testReply = async () => new Response(JSON.stringify({ resource: 'https://someone-else.dev/mcp' }), { status: 200 });
    expect((await admin4('POST', '/admin/remote/test')).data).toMatchObject({ ok: false, error: expect.stringContaining('not this Muster') });
    testReply = async () => new Response('bad gateway', { status: 502 });
    expect((await admin4('POST', '/admin/remote/test')).data).toMatchObject({ ok: false, status: 502 });
    testReply = async () => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND muster.example.com') });
    };
    const down = (await admin4('POST', '/admin/remote/test')).data;
    expect(down).toMatchObject({ ok: false, error: 'getaddrinfo ENOTFOUND muster.example.com' });
    expect((await admin4('GET', '/admin/remote')).data.lastTest).toEqual(down);
  });

  it('the app allow-list can be read and pruned with remote access off', async () => {
    await admin4('PUT', '/admin/remote/config', { enabled: false });
    expect(gw4.remote).toBeNull();
    const at = '2026-10-04T10:00:00.000Z';
    writeFileSync(
      join(dir4, 'remote.json'),
      JSON.stringify({ clients: [], grants: [], apps: [{ id: 'app_0123456789abcdef', clientId: 'https://claude.ai/oauth/x', name: 'Claude', kind: 'cimd', status: 'waiting', requestedAt: at, ip: '86.12.44.170' }] }),
    );
    const status = (await admin4('GET', '/admin/remote')).data;
    expect(status).toMatchObject({ enabled: false, appsWaiting: 1, apps: [{ id: 'app_0123456789abcdef', status: 'waiting', connections: 0 }] });
    expect((await admin4('POST', '/admin/remote/apps/app_0123456789abcdef/approve')).data).toMatchObject({ ok: true, app: { status: 'approved', approvedBy: 'desktop' } });
    expect((await admin4('GET', '/admin/remote/apps')).data[0].status).toBe('approved');
    expect((await admin4('DELETE', '/admin/remote/apps/app_nope')).status).toBe(404);
    expect((await admin4('DELETE', '/admin/remote/apps')).data).toEqual({ ok: true, removed: 1, revoked: 0 });
    expect((await admin4('GET', '/admin/remote/apps')).data).toEqual([]);
  });

  it('serves the last log lines newest first', async () => {
    const lines = (await admin4('GET', '/admin/remote/log?limit=3')).data;
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ event: 'app_removed', app: 'Claude' }); // the allow-list test ran last
    expect((await admin4('GET', '/admin/remote/log?limit=20')).data.some((l: any) => l.event === 'test' && l.ok === false)).toBe(true);
    expect(Date.parse(lines[0].at)).toBeGreaterThanOrEqual(Date.parse(lines[2].at));
    expect((await admin4('GET', '/admin/remote/log')).data.some((l: any) => l.event === 'config_changed')).toBe(true);
  });
});

describe('what a tunnel exposes (Tailscale Funnel / Cloudflare): only the connector, never admin or phone routes', () => {
  const PUBLIC = 'wayne-pc.tail1234.ts.net';
  let dir5: string;
  let gw5: Gateway;
  let cert5: string;
  /** A request as the tunnel daemon delivers it: from 127.0.0.1, public Host, the tunnel's headers. */
  const viaFunnel = (port: number, method: string, path: string, extra: Record<string, string> = {}, tls = false): Promise<number> =>
    new Promise((ok, fail) => {
      const headers = { host: PUBLIC, 'tailscale-funnel-request': '?1', 'x-forwarded-for': '203.0.113.7', ...extra };
      const done = (res: { statusCode?: number; resume(): void }) => {
        res.resume();
        ok(res.statusCode ?? 0);
      };
      const req = tls
        ? request({ host: '127.0.0.1', port, method, path, headers, ca: cert5, checkServerIdentity: () => undefined }, done)
        : httpRequest({ host: '127.0.0.1', port, method, path, headers }, done);
      req.on('error', fail);
      req.end(method === 'GET' ? undefined : '{}');
    });

  beforeAll(async () => {
    dir5 = join(secrets, 'phone-funnel');
    gw5 = await startGateway({ dir: dir5, port: 0, host: '127.0.0.1', recentFile: null, pollMs: 60_000, log: () => {}, remote: { port: 0, publicHost: PUBLIC, tunnel: 'tailscale' } });
    cert5 = readFileSync(phoneFiles(dir5).cert, 'utf8');
  });
  afterAll(async () => {
    await gw5?.close();
  });

  it('the connector listener serves /mcp and the sign-in pages on the public host', async () => {
    const port = gw5.remote!.port;
    expect(await viaFunnel(port, 'POST', '/mcp')).toBe(401); // exists, needs sign-in
    expect(await viaFunnel(port, 'GET', '/.well-known/oauth-protected-resource/mcp')).toBe(200);
    expect(await viaFunnel(port, 'GET', '/.well-known/oauth-authorization-server')).toBe(200);
  });

  it('the connector listener has no admin or phone routes, even with the admin token', async () => {
    const port = gw5.remote!.port;
    const admin = { 'x-muster-admin': gw5.adminToken };
    for (const [m, p] of [
      ['GET', '/admin/remote'],
      ['GET', '/admin/status'],
      ['POST', '/admin/remote/code'],
      ['GET', '/admin/remote/apps'],
      ['PUT', '/admin/remote/settings'],
      ['PUT', '/admin/remote/config'],
      ['GET', '/admin/remote/pending'],
      ['GET', '/api/needs'],
      ['GET', '/api/health'],
      ['POST', '/pair'],
      ['GET', '/api/events'],
      ['GET', '/'],
    ] as const) {
      expect([m, p, await viaFunnel(port, m, p, admin)]).toEqual([m, p, 404]);
    }
  });

  it('the phone gateway refuses anything that came through a tunnel (if the wrong port were exposed)', async () => {
    const admin = { 'x-muster-admin': gw5.adminToken };
    for (const [m, p] of [
      ['GET', '/admin/remote'],
      ['GET', '/admin/status'],
      ['POST', '/admin/remote/code'],
      ['GET', '/api/needs'],
      ['GET', '/api/health'],
      ['POST', '/pair'],
    ] as const) {
      expect([m, p, await viaFunnel(gw5.port, m, p, admin, true)]).toEqual([m, p, 403]);
      expect([m, p, await viaFunnel(gw5.port, m, p, { ...admin, 'tailscale-funnel-request': '', 'x-forwarded-for': '', 'cf-connecting-ip': '203.0.113.7' }, true)]).toEqual([m, p, 403]);
    }
    // the phone itself connects directly (LAN or tailnet IP): no tunnel headers, still served
    expect((await call('GET', '/api/health')).status).toBe(200);
  });
});
