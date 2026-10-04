import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempRepo } from '../core/testutil.js';
import { startGateway, type Gateway } from '../phone/gateway.js';
import { realPhoneLink, type PhoneLink } from '../phone/link.js';
import { forbiddenReason } from './auth.js';
import { startOrchestrator, type Orchestrator } from './server.js';
import type { PtyLauncher, PtyProcess } from './terminal.js';

class FakePty implements PtyProcess {
  static nextPid = 7000;
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

const savedEnv = { ...process.env };
let secrets: string;
let repo: string;
let gw: Gateway;
let orch: Orchestrator;

async function call(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(orch.url + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-muster-token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  secrets = mkdtempSync(join(tmpdir(), 'muster-secrets-'));
  process.env.MUSTER_SECRETS_DIR = secrets;
  process.env.MUSTER_NO_NOTIFY = '1';
  for (const k of ['MUSTER_AGENT', 'MUSTER_URL', 'MUSTER_TOKEN', 'MUSTER_REPO']) delete process.env[k];
  // A test gateway in the temp secrets folder: its server.json names this (live) process, so the link never spawns one.
  gw = await startGateway({ dir: join(secrets, 'phone'), port: 0, host: '127.0.0.1', recentFile: null, log: () => {}, lanHosts: () => ['192.168.1.20'], tailscale: async () => ({ installed: false, ip: null, dnsName: null, online: false }) });
  repo = tempRepo();
  mkdirSync(join(repo, '.muster'), { recursive: true });
  writeFileSync(join(repo, '.muster', 'config.json'), JSON.stringify({ claudePath: 'C:/fake/claude.exe' }));
  orch = await startOrchestrator({ repoRoot: repo, port: 0, launcher, log: () => {}, registerPhone: true, phone: realPhoneLink({ dir: gw.dir, entry: join(secrets, 'missing.js') }) });
});

afterAll(async () => {
  await orch?.shutdown();
  await gw?.close();
  process.env = savedEnv;
  rmSync(repo, { recursive: true, force: true });
  rmSync(secrets, { recursive: true, force: true });
});

describe('orchestrator /api/phone/*', () => {
  it('registers its repo root with the gateway on start', async () => {
    const end = Date.now() + 5000;
    let projects: any[] = [];
    while (Date.now() < end) {
      projects = (await call('GET', '/api/phone/status', orch.token)).data?.projects ?? [];
      if (projects.length) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(projects).toHaveLength(1);
    expect(resolve(projects[0].root).toLowerCase()).toBe(resolve(repo).toLowerCase());
    expect(projects[0].running).toBe(true);
  });

  it('forwards to the admin API as you', async () => {
    const status = await call('GET', '/api/phone/status', orch.token);
    expect(status.status).toBe(200);
    expect(status.data).toMatchObject({ port: gw.port, fingerprint: gw.fingerprint, network: { mode: 'lan', lanHosts: ['192.168.1.20'] }, devices: [] });
    const code = await call('POST', '/api/phone/pair-code', orch.token);
    expect(code.data.display).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    expect((await call('PUT', '/api/phone/network', orch.token, { mode: 'tailscale' })).data).toEqual({ ok: true, mode: 'tailscale' });
    expect((await call('PUT', '/api/phone/network', orch.token, { mode: 'bad' })).status).toBe(400); // the gateway's own error passes through
    const send = await call('PUT', '/api/phone/send', orch.token, { notify: { review: true, question: false, blocked: true, usage: false, stuck: false }, quiet: { on: false, from: '22:00', to: '07:00' }, projects: {} });
    expect(send.data).toMatchObject({ notify: { question: false }, quiet: { on: false } });
    expect((await call('GET', '/api/phone/send', orch.token)).data.notify.question).toBe(false);
    expect((await call('POST', '/api/phone/test', orch.token)).data).toMatchObject({ sent: 0 });
    expect((await call('DELETE', '/api/phone/devices/nope', orch.token)).status).toBe(404);
  });

  it('refuses agents and callers without a token', async () => {
    const captain = orch.store.state.agents.find((a) => a.role === 'captain');
    expect(captain).toBeTruthy();
    const r = await call('GET', '/api/phone/status', orch.agentToken(captain!.id));
    expect(r.status).toBe(403);
    expect(r.data.error).toMatch(/phone/);
    expect((await call('GET', '/api/phone/status', null)).status).toBe(401);
    expect(forbiddenReason({ actor: 'ada', human: false, role: 'crew' }, 'POST', '/api/phone/pair-code')).toMatch(/phone/);
    expect(forbiddenReason({ actor: 'you', human: true }, 'POST', '/api/phone/pair-code')).toBeUndefined();
  });
});

describe('orchestrator /api/phone/* without a gateway', () => {
  it('answers 503 when the gateway cannot start', async () => {
    const broken: PhoneLink = {
      forward: async () => {
        throw new Error('The phone gateway did not start');
      },
      register: async () => {},
    };
    const repo2 = tempRepo();
    writeFileSync(join(repo2, '.gitignore'), '.muster/\n');
    const o2 = await startOrchestrator({ repoRoot: repo2, port: 0, launcher, log: () => {}, autoStart: false, phone: broken });
    try {
      const res = await fetch(`${o2.url}/api/phone/status`, { headers: { 'x-muster-token': o2.token } });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toMatch(/did not start/);
    } finally {
      await o2.shutdown();
      rmSync(repo2, { recursive: true, force: true });
    }
  });
});
