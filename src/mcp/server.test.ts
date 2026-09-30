import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { Role } from '../types.js';
import { CAPTAIN_TOOLS, CREW_TOOLS, createMusterServer, type Api } from './server.js';

type Call = { path: string; method?: string; body?: unknown };

async function connect(role: Role, handler: (c: Call) => unknown, extra: { pollMs?: number; askTimeoutMs?: number } = {}) {
  const calls: Call[] = [];
  const api: Api = async <T,>(path: string, o?: { method?: string; body?: unknown }) => {
    const c = { path, method: o?.method, body: o?.body };
    calls.push(c);
    return (await handler(c)) as T;
  };
  const server = createMusterServer({ role, agentId: role === 'captain' ? 'captain' : 'crew-2', api, ...extra });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content[0].text, isError: !!r.isError };
  };
  return { client, calls, call };
}

describe('muster-mcp tools by role', () => {
  it('captain gets captain tools', async () => {
    const { client } = await connect('captain', () => null);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...CAPTAIN_TOOLS].sort());
  });
  it('crew and design get crew tools', async () => {
    for (const role of ['crew', 'design'] as Role[]) {
      const { client } = await connect(role, () => null);
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual([...CREW_TOOLS].sort());
    }
  });
});

describe('muster-mcp calls', () => {
  it('sends actor and formats claim_task', async () => {
    const { call, calls } = await connect('crew', () => ({ id: 'T3', title: 'Share dialog', description: 'Build it', status: 'in_progress', stations: ['build', 'review'], stationIndex: 0, dependsOn: [] }));
    const r = await call('claim_task');
    expect(calls[0]).toEqual({ path: '/api/tasks/claim', method: 'POST', body: { actor: 'crew-2' } });
    expect(r.text).toContain('Claimed T3 [in_progress] Share dialog · station build 1/2');
    expect(r.text).toContain('Build it');
  });
  it('turns API errors into isError results', async () => {
    const { call } = await connect('captain', () => {
      throw new Error('Paused: 5-hour window at 83% (resets 21:40)');
    });
    const r = await call('spawn_crew', { task: 'T4' });
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Error: Paused: 5-hour window at 83% (resets 21:40)');
  });
  it('spawn_crew creates a task from a title first', async () => {
    const { call, calls } = await connect('captain', (c) =>
      c.path === '/api/tasks' ? { id: 'T9', title: 'x' } : { id: 'crew-4', role: 'crew', branch: 'crew-4/work' },
    );
    const r = await call('spawn_crew', { task: 'Add invite API' });
    expect(calls[1].body).toEqual({ role: 'crew', taskId: 'T9', actor: 'captain' });
    expect(r.text).toBe('Spawned crew-4 (crew) on crew-4/work with task T9. It starts working on its own.');
  });
  it('report_done resolves the held task', async () => {
    const { call, calls } = await connect('crew', (c) =>
      c.path === '/api/state'
        ? { state: { agents: [{ id: 'crew-2', taskId: 'T3' }], tasks: [{ id: 'T3' }] } }
        : { id: 'T3', title: 'Share dialog', assignee: 'captain' },
    );
    const r = await call('report_done', { summary: 'done' });
    expect(calls[1]).toEqual({ path: '/api/tasks/T3/done', method: 'POST', body: { actor: 'crew-2', summary: 'done' } });
    expect(r.text).toContain('T3 reported done');
  });
  it('read_inbox marks items read', async () => {
    const { call, calls } = await connect('crew', (c) =>
      c.method === 'POST' ? { ok: true } : [{ id: 'I1', at: new Date().toISOString(), from: 'captain', kind: 'message', text: 'hi' }],
    );
    const r = await call('read_inbox');
    expect(calls[1]).toEqual({ path: '/api/inbox/crew-2/read', method: 'POST', body: { ids: ['I1'] } });
    expect(r.text).toContain('I1 message from captain');
  });
  it('ask_captain returns the first reply', async () => {
    let polls = 0;
    const { call } = await connect(
      'crew',
      (c) => {
        if (c.method === 'POST') return { id: 'N7', type: 'question', from: 'crew-2', text: 'q', open: true, replies: [] };
        polls++;
        return [{ id: 'N7', open: true, from: 'crew-2', replies: polls < 2 ? [] : [{ from: 'crew-3', text: 'Use v2', at: '' }] }];
      },
      { pollMs: 5 },
    );
    const r = await call('ask_captain', { question: 'Which API version?' });
    expect(r.text).toBe('crew-3 answered N7: Use v2');
  });
  it('ask_captain times out politely', async () => {
    const { call } = await connect(
      'crew',
      (c) => (c.method === 'POST' ? { id: 'N8', replies: [], open: true } : [{ id: 'N8', open: true, replies: [] }]),
      { pollMs: 5, askTimeoutMs: 30 },
    );
    expect((await call('ask_captain', { question: 'q' })).text).toMatch(/^No answer yet on N8 — carry on with other work/);
  });
});
