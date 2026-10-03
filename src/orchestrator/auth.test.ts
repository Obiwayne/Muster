// Token identities, human-only routes, Host/Origin checks: against a real orchestrator (fake PTYs).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Agent, FeedItem, InboxItem, MusterState, Note } from '../types.js';
import { serverInfo } from '../client.js';
import { gitSync, tempRepo } from '../core/testutil.js';
import { humanTokenFile } from '../core/tokens.js';
import { forbiddenReason, HUMAN_CALLER } from './auth.js';
import { allowedHost, allowedOrigin, startOrchestrator, type Orchestrator } from './server.js';
import type { PtyLauncher, PtyProcess } from './terminal.js';

class FakePty implements PtyProcess {
  static nextPid = 5000;
  pid = FakePty.nextPid++;
  written = '';
  private exitCbs: ((e: { exitCode: number }) => void)[] = [];
  onData() {}
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCbs.push(cb);
  }
  write(d: string) {
    this.written += d;
  }
  resize() {}
  kill() {
    setImmediate(() => this.exitCbs.splice(0).forEach((cb) => cb({ exitCode: 1 })));
  }
}

const ptys = new Map<string, FakePty>();
const envs = new Map<string, Record<string, string>>();
const launcher: PtyLauncher = (_file, _args, opts) => {
  const p = new FakePty();
  ptys.set(opts.env.MUSTER_AGENT, p);
  envs.set(opts.env.MUSTER_AGENT, opts.env);
  return p;
};

let repo: string;
let secrets: string;
let orch: Orchestrator;
const savedEnv = { ...process.env };

async function call(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(orch.url + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-muster-token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

/** A raw request with a chosen Host header (fetch won't let us set it). */
function rawGet(path: string, host: string, token?: string): Promise<number> {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port: orch.port, path, headers: { host, ...(token ? { 'x-muster-token': token } : {}) } }, (res) => {
      res.resume();
      ok(res.statusCode ?? 0);
    });
    req.on('error', fail);
    req.end();
  });
}

function wsOutcome(path: string, opts: WebSocket.ClientOptions = {}): Promise<'open' | number> {
  return new Promise((ok) => {
    const ws = new WebSocket(`${orch.url.replace('http', 'ws')}${path}`, opts);
    ws.once('open', () => (ws.close(), ok('open')));
    ws.once('unexpected-response', (_req, res) => ok(res.statusCode ?? 0));
    ws.once('error', () => ok(-1));
  });
}

const human = () => orch.token;
const agentTok = (id: string) => orch.agentToken(id);

beforeAll(async () => {
  secrets = mkdtempSync(join(tmpdir(), 'muster-secrets-'));
  process.env.MUSTER_SECRETS_DIR = secrets;
  process.env.MUSTER_NO_NOTIFY = '1';
  for (const k of ['MUSTER_AGENT', 'MUSTER_URL', 'MUSTER_TOKEN', 'MUSTER_REPO']) delete process.env[k];
  repo = tempRepo();
  const ui = mkdtempSync(join(tmpdir(), 'muster-ui-'));
  writeFileSync(join(ui, 'index.html'), '<html><head><meta name="muster-token" content=""></head><body></body></html>');
  mkdirSync(join(repo, '.muster'), { recursive: true });
  writeFileSync(join(repo, '.muster', 'config.json'), JSON.stringify({ claudePath: 'C:/fake/claude.exe', testCommand: 'node -e "0"' }));
  orch = await startOrchestrator({ repoRoot: repo, port: 0, launcher, uiDir: ui, log: () => {}, timings: { enterDelayMs: 5, firstPromptDelayMs: 5, nudgeDebounceMs: 10 } });
  await call('POST', '/api/agents', human(), {}); // crew-2
});

afterAll(async () => {
  await orch?.shutdown();
  process.env = savedEnv;
  rmSync(repo, { recursive: true, force: true });
  rmSync(secrets, { recursive: true, force: true });
});

describe('token discovery', () => {
  it('keeps the human token out of the repo and gives each agent its own token', () => {
    const server = JSON.parse(readFileSync(join(repo, '.muster', 'server.json'), 'utf8'));
    expect(server.token).toBeUndefined();
    expect(server.port).toBe(orch.port);
    expect(readFileSync(humanTokenFile(repo), 'utf8')).toBe(orch.token);
    expect(humanTokenFile(repo).startsWith(secrets)).toBe(true);

    const captainEnv = envs.get('captain')!;
    const crewEnv = envs.get('crew-2')!;
    expect(captainEnv.MUSTER_TOKEN).toBe(agentTok('captain'));
    expect(crewEnv.MUSTER_TOKEN).toBe(agentTok('crew-2'));
    expect(new Set([orch.token, captainEnv.MUSTER_TOKEN, crewEnv.MUSTER_TOKEN]).size).toBe(3);
    for (const id of ['captain', 'crew-2']) {
      const agentDir = readFileSync(join(repo, '.muster', 'agents', id, 'mcp.json'), 'utf8') + readFileSync(join(repo, '.muster', 'agents', id, 'settings.json'), 'utf8');
      expect(agentDir).not.toContain(orch.token);
    }
  });

  it('client: humans read the token file, agents only ever use their env token', () => {
    expect(serverInfo(repo)).toEqual({ url: orch.url, token: orch.token });
    process.env.MUSTER_AGENT = 'crew-2';
    process.env.MUSTER_URL = orch.url;
    process.env.MUSTER_TOKEN = agentTok('crew-2');
    try {
      expect(serverInfo(repo)).toEqual({ url: orch.url, token: agentTok('crew-2') });
      delete process.env.MUSTER_TOKEN;
      expect(serverInfo(repo)).toBeNull(); // never falls back to the human token
    } finally {
      for (const k of ['MUSTER_AGENT', 'MUSTER_URL', 'MUSTER_TOKEN']) delete process.env[k];
    }
  });
});

describe('identity comes from the token', () => {
  it('rejects unknown tokens and the agent secret stays unusable', async () => {
    expect((await call('GET', '/api/state', 'f'.repeat(32))).status).toBe(401);
    expect((await call('GET', '/api/state', agentTok('crew-99'))).status).toBe(401); // not an agent (yet)
    expect((await call('GET', '/api/state', agentTok('crew-2'))).status).toBe(200);
  });

  it('overwrites a claimed actor with the caller', async () => {
    const note = (await call('POST', '/api/notes', agentTok('crew-2'), { actor: 'you', type: 'progress', text: 'pretending' })).data as Note;
    expect(note.from).toBe('crew-2');
    const n2 = (await call('POST', '/api/notes', human(), { actor: 'captain', type: 'progress', text: 'me' })).data as Note;
    expect(n2.from).toBe('you');
  });

  it('refuses human-only routes for agent tokens, the Captain included', async () => {
    for (const tok of [agentTok('crew-2'), agentTok('captain')]) {
      const refused = [
        await call('POST', '/api/agents/crew-2/merge', tok, { actor: 'you', force: true }),
        await call('PATCH', '/api/config', tok, { maxCrew: 9 }),
        await call('POST', '/api/shutdown', tok, {}),
        await call('POST', '/api/agents/crew-2/role', tok, { role: 'captain' }),
        await call('DELETE', '/api/agents/crew-2', tok),
        await call('POST', '/api/agents/crew-2/input', tok, { text: 'hi' }),
        await call('POST', '/api/agents/captain/input', tok, { text: 'hi' }),
        await call('POST', '/api/ask', tok, { text: 'new goal' }),
      ];
      expect(refused.map((r) => r.status)).toEqual(refused.map(() => 403));
    }
    expect((await call('POST', '/api/agents/captain/stop', agentTok('crew-2'), {})).status).toBe(403);
    expect((await call('POST', '/api/agents/captain/event', agentTok('crew-2'), { event: 'stop' })).status).toBe(403);
    expect((await call('POST', '/api/inbox/captain/read', agentTok('crew-2'), {})).status).toBe(403);
    expect((await call('GET', '/api/agents/captain/output', agentTok('crew-2'))).status).toBe(403);
    expect((await call('GET', '/api/config', human())).data.maxCrew).toBe(3);
  });

  it('lets agents do their own work and the Captain lead', async () => {
    expect((await call('POST', '/api/agents/crew-2/event', agentTok('crew-2'), { event: 'session-start' })).status).toBe(200);
    expect((await call('POST', '/api/inbox/crew-2/read', agentTok('crew-2'), {})).status).toBe(200);
    expect((await call('POST', '/api/messages', agentTok('crew-2'), { to: 'captain', text: 'hello' })).status).toBe(200);
    expect((await call('GET', '/api/agents/crew-2/output', agentTok('captain'))).status).toBe(200);
    expect((await call('GET', '/api/agents/crew-2/diff?stat=1', agentTok('captain'))).status).toBe(200);
    const task = await call('POST', '/api/tasks', agentTok('captain'), { title: 'Auth work', description: 'x' });
    expect(task.status).toBe(200);
    expect(task.data.createdBy).toBe('captain');
    // Crew can't spawn (the handler's role check sees the real caller now).
    expect((await call('POST', '/api/agents', agentTok('crew-2'), { actor: 'you' })).status).toBe(403);
    const usage = await call('POST', '/api/usage', agentTok('crew-2'), { agentId: 'captain', cost: { total_cost_usd: 1.5 } });
    expect(usage.data.perAgentCostUsd).toMatchObject({ 'crew-2': 1.5 });
    expect(usage.data.perAgentCostUsd.captain).toBeUndefined();
  });

  it('an agent running the CLI merge is refused: its env token is not the human token', async () => {
    const r = await call('POST', '/api/agents/crew-2/merge', agentTok('crew-2'), { actor: 'you' });
    expect(r).toMatchObject({ status: 403, data: { error: expect.stringMatching(/Only you can merge/) } });
    const { state } = (await call('GET', '/api/state', human())).data as { state: MusterState };
    expect(gitSync(repo, 'rev-parse', 'main')).toBeTruthy();
    expect(state.agents.map((a: Agent) => a.id)).toContain('crew-2');
  });

  it('policy table', () => {
    expect(forbiddenReason(HUMAN_CALLER, 'POST', '/api/agents/crew-2/merge')).toBeUndefined();
    expect(forbiddenReason({ actor: 'crew-2', human: false, role: 'crew' }, 'POST', '/api/agents/crew-2/stop')).toBeUndefined();
    expect(forbiddenReason({ actor: 'crew-2', human: false, role: 'crew' }, 'POST', '/api/agents/crew-3/tests')).toMatch(/Captain/);
    expect(forbiddenReason({ actor: 'captain', human: false, role: 'captain' }, 'POST', '/api/agents/crew-3/tests')).toBeUndefined();
  });
});

describe('reactions and read receipts', () => {
  it('reacts as the caller, whatever the body claims, and toggles', async () => {
    const msg = (await call('POST', '/api/messages', human(), { to: 'crew-2', text: 'can you check the login page?' })).data as FeedItem;
    const r1 = await call('POST', `/api/feed/${msg.id}/react`, agentTok('crew-2'), { actor: 'captain', emoji: '👀' });
    expect(r1.status).toBe(200);
    expect((r1.data as FeedItem).reactions).toEqual([{ emoji: '👀', by: 'crew-2', at: expect.any(String) }]);
    const r2 = (await call('POST', `/api/feed/${msg.id}/react`, human(), { actor: 'crew-2', emoji: '🙌' })).data as FeedItem;
    expect(r2.reactions!.map((r) => `${r.by}:${r.emoji}`)).toEqual(['crew-2:👀', 'you:🙌']);
    const r3 = (await call('POST', `/api/feed/${msg.id}/react`, agentTok('crew-2'), { emoji: '👀' })).data as FeedItem;
    expect(r3.reactions!.map((r) => `${r.by}:${r.emoji}`)).toEqual(['you:🙌']);
  });

  it('answers 400 for an unknown emoji and 404 for an unknown line, and tells nobody', async () => {
    const msg = (await call('POST', '/api/messages', human(), { to: 'crew-2', text: 'ping' })).data as FeedItem;
    const before = ((await call('GET', '/api/state', human())).data as { state: MusterState }).state.inbox.length;
    expect((await call('POST', `/api/feed/${msg.id}/react`, agentTok('crew-2'), { emoji: '🔥' })).status).toBe(400);
    expect((await call('POST', `/api/feed/${msg.id}/react`, agentTok('crew-2'), {})).status).toBe(400);
    expect((await call('POST', '/api/feed/F99999/react', agentTok('crew-2'), { emoji: '👍' })).status).toBe(404);
    expect((await call('POST', `/api/feed/${msg.id}/react`, agentTok('captain'), { emoji: '👍' })).status).toBe(200);
    const after = ((await call('GET', '/api/state', human())).data as { state: MusterState }).state.inbox.length;
    expect(after).toBe(before);
  });

  it('reading the inbox records the agent in readBy once; inbox items carry feedId', async () => {
    const msg = (await call('POST', '/api/messages', human(), { to: 'crew-2', text: 'read me' })).data as FeedItem;
    const items = (await call('GET', '/api/inbox/crew-2?unread=1', agentTok('crew-2'))).data as InboxItem[];
    expect(items.find((i) => i.text.includes('read me'))?.feedId).toBe(msg.id);
    expect((await call('POST', '/api/inbox/crew-2/read', agentTok('crew-2'), {})).status).toBe(200);
    expect((await call('POST', '/api/inbox/crew-2/read', human(), {})).status).toBe(200);
    const { state } = (await call('GET', '/api/state', human())).data as { state: MusterState };
    expect(state.feed.find((f) => f.id === msg.id)?.readBy).toEqual(['crew-2']);
  });

  it('policy: the research agent may not react', () => {
    expect(forbiddenReason({ actor: 'scout', human: false, role: 'research' }, 'POST', '/api/feed/F1/react')).toMatch(/research/);
    expect(forbiddenReason({ actor: 'crew-2', human: false, role: 'crew' }, 'POST', '/api/feed/F1/react')).toBeUndefined();
    expect(forbiddenReason({ actor: 'captain', human: false, role: 'captain' }, 'POST', '/api/feed/F1/react')).toBeUndefined();
  });
});

describe('DNS rebinding and origins', () => {
  it('accepts only loopback Host names with our port', async () => {
    expect(allowedHost(`127.0.0.1:${orch.port}`, orch.port)).toBe(true);
    expect(allowedHost(`LOCALHOST:${orch.port}`, orch.port)).toBe(true);
    expect(allowedHost(`evil.example:${orch.port}`, orch.port)).toBe(false);
    expect(allowedHost('127.0.0.1', orch.port)).toBe(false);
    expect(allowedHost(undefined, orch.port)).toBe(false);
    expect(await rawGet('/', `evil.example:${orch.port}`)).toBe(421);
    expect(await rawGet('/api/state', `evil.example:${orch.port}`, orch.token)).toBe(421);
    expect(await rawGet('/api/health', `evil.example:${orch.port}`)).toBe(421);
    expect(await rawGet('/', `localhost:${orch.port}`)).toBe(200);
    expect(await rawGet('/api/state', `127.0.0.1:${orch.port}`, orch.token)).toBe(200);
  });

  it('serves the token-bearing page only to the right Host', async () => {
    const res = await fetch(orch.url + '/');
    expect(await res.text()).toContain(`content="${orch.token}"`);
  });

  it('checks Origin (and Host) on websocket upgrades', async () => {
    expect(allowedOrigin(undefined, 1)).toBe(true);
    expect(allowedOrigin('http://127.0.0.1:1', 1)).toBe(true);
    expect(allowedOrigin('http://evil.example', 1)).toBe(false);
    expect(allowedOrigin('null', 1)).toBe(false);
    const path = `/ws/events?token=${orch.token}`;
    expect(await wsOutcome(path)).toBe('open');
    expect(await wsOutcome(path, { origin: `http://localhost:${orch.port}` })).toBe('open');
    expect(await wsOutcome(path, { origin: 'http://evil.example' })).toBe(403);
    expect(await wsOutcome(path, { headers: { host: `evil.example:${orch.port}` } })).toBe(403);
  });

  it('agents may watch a terminal but never type into it', async () => {
    const pty = ptys.get('crew-2')!;
    pty.written = '';
    const ws = new WebSocket(`${orch.url.replace('http', 'ws')}/ws/term/crew-2?token=${agentTok('captain')}`);
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'input', data: 'rm -rf /\r' }));
    await new Promise((r) => setTimeout(r, 150));
    expect(pty.written).toBe('');
    ws.close();
  });

  it('answers 400 to a malformed static path', async () => {
    expect((await fetch(orch.url + '/assets/%E0%A4%A')).status).toBe(400);
  });
});

describe('shutdown', () => {
  it('removes the human token file', async () => {
    const file = humanTokenFile(repo);
    expect(existsSync(file)).toBe(true);
    await orch.shutdown();
    expect(existsSync(file)).toBe(false);
  });
});
