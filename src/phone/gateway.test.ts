import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
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
