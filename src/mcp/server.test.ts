import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { Role } from '../types.js';
import { PROGRESS, ROADMAP } from './roadmap.fixture.js';
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
  it('claim_task appends the station guideline', async () => {
    const task = { id: 'T3', title: 'Share dialog', description: 'Build it', status: 'in_progress', stations: ['build', 'review'], stationIndex: 0, dependsOn: [] };
    const { call, calls } = await connect('crew', (c) => (c.path === '/api/tasks/claim' ? task : { text: '## Station: build guidelines\nKeep it small.' }));
    const r = await call('claim_task');
    expect(calls[1].path).toBe('/api/tasks/T3/brief');
    expect(r.text).toContain('## Station: build guidelines');
    expect(r.text).toContain('Keep it small.');
  });
  it('claim_task falls back to the station file on an orchestrator without /brief, skills included', async () => {
    const task = { id: 'T3', title: 'Share dialog', description: 'Build it', status: 'in_progress', stations: ['build', 'review'], stationIndex: 0, dependsOn: [] };
    const { call, calls } = await connect('crew', (c) => {
      if (c.path === '/api/tasks/claim') return task;
      if (c.path.endsWith('/brief')) throw new Error('No route');
      return { name: 'build', role: 'crew', builtin: true, guideline: 'Keep it small.', skills: ['code-structure'] };
    });
    const r = await call('claim_task');
    expect(calls[2].path).toBe('/api/stations/build');
    expect(r.text).toContain('Keep it small.');
    expect(r.text).toContain('`muster:code-structure`');
  });
  it('claim_task adds no block for an empty guideline and cuts long ones', async () => {
    const task = { id: 'T3', title: 'X', description: 'd', status: 'in_progress', stations: ['build', 'review'], stationIndex: 0, dependsOn: [] };
    const noBrief = (guideline: string) => (c: { path: string }) => {
      if (c.path === '/api/tasks/claim') return task;
      if (c.path.endsWith('/brief')) throw new Error('No route');
      return { name: 'build', role: 'crew', builtin: true, guideline };
    };
    const empty = await connect('crew', noBrief('  '));
    expect((await empty.call('claim_task')).text).not.toContain('guidelines');
    const long = await connect('crew', noBrief('x'.repeat(9000)));
    expect((await long.call('claim_task')).text).toContain('(guideline cut, 1000 more characters in .muster/stations/build.md)');
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
  it('request_review and get_diff work by task id after the builder is gone', async () => {
    const { call, calls } = await connect('captain', (c) =>
      c.path === '/api/state'
        ? { state: { agents: [{ id: 'captain', role: 'captain' }], tasks: [{ id: 'T1', branch: 'crew-2/fix', status: 'review' }] } }
        : c.path.includes('/diff')
          ? { branch: 'crew-2/fix', base: 'main', stat: ' a.ts | 1 +', diff: '+x' }
          : { id: 'T1', branch: 'crew-2/fix' },
    );
    await call('get_diff', { task: 't1' });
    expect(calls[1].path).toBe('/api/agents/captain/diff?branch=crew-2%2Ffix');
    const r = await call('request_review', { task: 'T1', summary: 'looks good' });
    expect(calls.at(-1)).toEqual({ path: '/api/tasks/T1/review', method: 'POST', body: { actor: 'captain', summary: 'looks good' } });
    expect(r.text).toBe('T1 is ready for merge (crew-2/fix). The user has been notified.');
    const missing = await call('request_review', { agent: 'crew-2', summary: 'x' });
    expect(missing.text).toContain('Pass the task id instead');
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
  it('ask_captain marks the answered reply read so it is not nudged or listed again', async () => {
    const { call, calls } = await connect('crew', (c) => {
      if (c.path === '/api/notes') return { id: 'N7', type: 'question', from: 'crew-2', text: 'q', open: true, replies: [] };
      if (c.path.startsWith('/api/notes?')) return [{ id: 'N7', open: true, from: 'crew-2', replies: [{ from: 'captain', text: 'Yes', at: '' }] }];
      if (c.path === '/api/inbox/crew-2?unread=1')
        return [
          { id: 'I4', kind: 'reply', noteId: 'N7', text: 'reply from captain on N7: Yes' },
          { id: 'I5', kind: 'message', text: 'message from crew-3: hi' },
        ];
      return { ok: true };
    }, { pollMs: 5 });
    expect((await call('ask_captain', { question: 'Ship it?' })).text).toBe('captain answered N7: Yes');
    expect(calls.at(-1)).toEqual({ path: '/api/inbox/crew-2/read', method: 'POST', body: { ids: ['I4'] } });
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

describe('muster-mcp roadmap tools', () => {
  const view = (patch: (r: typeof ROADMAP) => void = () => {}) => {
    const r = structuredClone(ROADMAP);
    patch(r);
    return { roadmap: r, progress: PROGRESS };
  };
  it('are captain only', async () => {
    const { client } = await connect('crew', () => null);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['roadmap', 'set_roadmap', 'update_stage', 'check_criterion', 'complete_stage', 'add_goal', 'update_goal']) expect(names).not.toContain(n);
  });
  it('roadmap reads GET /api/roadmap and handles no roadmap', async () => {
    let v: unknown = { roadmap: null, progress: null };
    const { call, calls } = await connect('captain', () => v);
    expect((await call('roadmap')).text).toBe('No roadmap yet — draft one with set_roadmap before posting build tasks.');
    expect(calls[0]).toEqual({ path: '/api/roadmap', method: undefined, body: undefined });
    v = view();
    expect((await call('roadmap')).text).toContain('▶ M2 Core wall');
  });
  it('set_roadmap PUTs the plan with upper-cased ids and reports the draft', async () => {
    const { call, calls } = await connect('captain', () => view((r) => { r.status = 'draft'; r.revision = 0; }));
    const stages = [{ id: 'm1', title: 'Foundations', description: 'd', start: '2026-09-01', due: '2026-09-14', exitCriteria: ['CI green'], goals: [{ id: 'g1', title: 'Repo', description: '' }, { title: 'New', description: '' }] }];
    const r = await call('set_roadmap', { title: 'v1', summary: 's', launchDate: '2026-11-15', stages });
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].path).toBe('/api/roadmap');
    expect(calls[0].body).toEqual({
      actor: 'captain', title: 'v1', summary: 's', launchDate: '2026-11-15',
      stages: [{ id: 'M1', title: 'Foundations', description: 'd', start: '2026-09-01', due: '2026-09-14', exitCriteria: ['CI green'], goals: [{ id: 'G1', title: 'Repo', description: '' }, { id: undefined, title: 'New', description: '' }] }],
    });
    expect(r.text.split('\n')[0]).toBe('Saved roadmap draft rev 0. The user has been asked to approve it; post no build tasks for new goals until then.');
    expect(r.text).toContain('Roadmap: wall-education v1.0');
  });
  it('set_roadmap rejects bad dates before calling the API', async () => {
    const { call, calls } = await connect('captain', () => view());
    const r = await call('set_roadmap', { title: 'v1', summary: 's', stages: [{ title: 'x', description: '', start: '1 Oct', exitCriteria: [], goals: [] }] });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
  it('check_criterion is 1-based in the tool and 0-based in the API', async () => {
    const { call, calls } = await connect('captain', () => view((r) => (r.stages[1].exitCriteria[1].done = true)));
    const r = await call('check_criterion', { stage: 'm2', index: 2 });
    expect(calls[0]).toEqual({ path: '/api/roadmap/stages/M2/criteria/1', method: 'POST', body: { actor: 'captain', done: true } });
    expect(r.text).toBe('Ticked M2 criterion 2 (2/3): Students can react.');
    const all = await connect('captain', () => view((r) => r.stages[1].exitCriteria.forEach((c) => (c.done = true))));
    expect((await all.call('check_criterion', { stage: 'M2', index: 3 })).text).toContain('All ticked: complete_stage(M2).');
    const un = await connect('captain', () => view());
    await un.call('check_criterion', { stage: 'M2', index: 2, done: false });
    expect(un.calls[0].body).toEqual({ actor: 'captain', done: false });
    expect((await un.call('check_criterion', { stage: 'M2', index: 0 })).isError).toBe(true);
  });
  it('complete_stage names the next goal to break down, and surfaces refusals', async () => {
    const { call, calls } = await connect('captain', () =>
      view((r) => {
        r.stages[1].status = 'done';
        r.stages[2].status = 'active';
        r.goals[3].status = 'active';
      }),
    );
    const r = await call('complete_stage', { stage: 'M2' });
    expect(calls[0]).toEqual({ path: '/api/roadmap/stages/M2/complete', method: 'POST', body: { actor: 'captain' } });
    expect(r.text).toBe('Completed M2. Now M3 Launch: break G4 Store listing into tasks (post_task with goal: "G4").');
    const refused = await connect('captain', () => {
      throw new Error('M2 has 2 open exit criteria');
    });
    expect(await refused.call('complete_stage', { stage: 'M2' })).toEqual({ text: 'Error: M2 has 2 open exit criteria', isError: true });
  });
  it('add_goal posts to the stage and says the roadmap went back for approval', async () => {
    const { call, calls } = await connect('captain', () =>
      view((r) => {
        r.status = 'draft';
        r.revision = 2;
        r.goals.push({ id: 'G5', stageId: 'M2', title: 'Dark mode', description: 'd', status: 'planned' });
      }),
    );
    const r = await call('add_goal', { stage: 'm2', title: 'Dark mode', description: 'd' });
    expect(calls[0]).toEqual({ path: '/api/roadmap/goals', method: 'POST', body: { actor: 'captain', stageId: 'M2', title: 'Dark mode', description: 'd', start: undefined, due: undefined } });
    expect(r.text).toBe("Added G5 Dark mode to M2. The roadmap is a draft (rev 2) waiting for the user's approval; keep working on approved goals meanwhile.");
  });
  it('update_stage and update_goal PATCH only what was given', async () => {
    const { call, calls } = await connect('captain', () => view());
    expect((await call('update_stage', { stage: 'm2', due: '2026-10-12' })).text).toBe('Updated M2 Core wall [active].');
    expect(calls[0]).toEqual({ path: '/api/roadmap/stages/M2', method: 'PATCH', body: { actor: 'captain', due: '2026-10-12' } });
    expect((await call('update_goal', { goal: 'g3', status: 'cancelled' })).text).toBe('Updated G3 Reactions [planned].');
    expect(calls[1]).toEqual({ path: '/api/roadmap/goals/G3', method: 'PATCH', body: { actor: 'captain', status: 'cancelled' } });
  });
  it('post_task sends goalId', async () => {
    const { call, calls } = await connect('captain', () => ({ id: 'T7', title: 'Post form', status: 'ready', stations: ['build', 'review'], stationIndex: 0, goalId: 'G2' }));
    const r = await call('post_task', { title: 'Post form', description: 'd', goal: 'g2' });
    expect((calls[0].body as { goalId?: string }).goalId).toBe('G2');
    expect(r.text).toBe('Posted T7 [ready] Post form · station build 1/2 · goal G2');
    await call('post_task', { title: 'x', description: 'd' });
    expect((calls[1].body as { goalId?: string }).goalId).toBeUndefined();
  });
  it('crew list_tasks shows each task\'s goal', async () => {
    const { call } = await connect('crew', () => [{ id: 'T7', title: 'Post form', status: 'ready', stations: ['build', 'review'], stationIndex: 0, goalId: 'G2' }]);
    expect((await call('list_tasks')).text).toBe('T7 [ready] Post form · station build 1/2 · goal G2');
  });
});
