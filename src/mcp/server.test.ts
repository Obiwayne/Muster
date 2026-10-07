import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { Role } from '../types.js';
import { PROGRESS, ROADMAP } from './roadmap.fixture.js';
import { CAPTAIN_TOOLS, CREW_TOOLS, createMusterServer, MEDIA_TOOLS, QA_TOOLS, RESEARCH_TOOLS, type Api } from './server.js';

type Call = { path: string; method?: string; body?: unknown };

async function connect(role: Role, handler: (c: Call) => unknown, extra: { pollMs?: number; askTimeoutMs?: number } = {}) {
  const calls: Call[] = [];
  const api: Api = async <T,>(path: string, o?: { method?: string; body?: unknown }) => {
    const c = { path, method: o?.method, body: o?.body };
    calls.push(c);
    return (await handler(c)) as T;
  };
  const server = createMusterServer({ role, agentId: role === 'captain' ? 'captain' : role === 'research' ? 'scout' : role === 'media' ? 'herald' : 'crew-2', api, ...extra });
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

describe('qa agent tools', () => {
  it('has qa_verdict instead of handoff / report_done, and posts the verdict to the qa route', async () => {
    const { client, calls, call } = await connect('qa', (c) => (c.path === '/api/state' ? { state: { agents: [{ id: 'crew-2', taskId: 'T9' }], tasks: [{ id: 'T9', status: 'in_progress', assignee: 'crew-2' }] } } : { task: { id: 'T9' }, outcome: 'sent_back', round: 1 }));
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([...QA_TOOLS].sort());
    expect(QA_TOOLS).toContain('qa_verdict');
    expect(QA_TOOLS).not.toContain('handoff');
    const rubric = { correct: 3, tested: 5, clean: 5, scoped: 5, safe: 5 };
    const r = await call('qa_verdict', { score: 3, rubric, findings: [{ file: 'a.ts', problem: 'p', fix: 'f' }], summary: 'one fix' });
    expect(r.text).toContain('sent back to its builder (QA round 1/3, 3/5)');
    expect(calls.at(-1)).toEqual({ path: '/api/tasks/T9/qa', method: 'POST', body: { actor: 'crew-2', score: 3, rubric, findings: [{ file: 'a.ts', problem: 'p', fix: 'f' }], summary: 'one fix' } });
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
    for (const n of ['roadmap', 'set_roadmap', 'update_stage', 'check_criterion', 'complete_stage', 'add_goal', 'update_goal', 'link_tasks', 'roadmap_status']) expect(names).not.toContain(n);
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
  it('link_tasks POSTs upper-cased task ids to the goal', async () => {
    const { call, calls } = await connect('captain', () => ({ ...view(), linked: ['T21', 'T26'] }));
    const r = await call('link_tasks', { goal: 'g3', tasks: ['t21', 'T26'] });
    expect(calls[0]).toEqual({ path: '/api/roadmap/goals/G3/tasks', method: 'POST', body: { actor: 'captain', taskIds: ['T21', 'T26'], unlink: false } });
    expect(r.text).toMatch(/^Put T21, T26 on G3 Reactions/);
    expect((await call('link_tasks', { goal: 'G3', tasks: ['T21'], unlink: true })).text).toMatch(/^Took T21, T26 off G3/);
  });
  it('roadmap_status POSTs the text and the upper-cased task for the user', async () => {
    const { client, call, calls } = await connect('captain', () => view());
    const desc = (await client.listTools()).tools.find((t) => t.name === 'roadmap_status')!.description!;
    expect(desc).toMatch(/one or two plain sentences/);
    expect(desc).toMatch(/after every merged task and every roadmap change/);
    const r = await call('roadmap_status', { text: 'M2 60%: G3 done, G4 next. Launch holds.', task: 't21' });
    expect(calls[0]).toEqual({ path: '/api/roadmap/status', method: 'POST', body: { actor: 'captain', text: 'M2 60%: G3 done, G4 next. Launch holds.', taskId: 'T21' } });
    expect(r.text).toBe(`Posted the roadmap status (${PROGRESS.overall.percent}% overall).`);
    await call('roadmap_status', { text: 'x' });
    expect(calls[1].body).toEqual({ actor: 'captain', text: 'x' });
    expect((await call('roadmap_status', { text: 'x'.repeat(401) })).isError).toBe(true);
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

describe('muster-mcp research tools', () => {
  const idea = (patch: Record<string, unknown> = {}) => ({
    id: 'R7', runId: 'RR1', title: 'Moderation queue', summary: 'Teachers want to hold posts for review.', impact: 'high', effort: 'M', stageId: 'M3',
    evidence: [{ kind: 'forum', source: 'r/Teachers · 412 upvotes', text: 'I need to approve posts first', url: 'https://reddit.com/r/Teachers/x', count: 37 }],
    status: 'new', thread: [], createdAt: '2026-10-02T09:00:00Z', ...patch,
  });
  const research = (ideas: unknown[] = [idea()], runs: unknown[] = []) => ({ runs, ideas });

  it('research gets only its tools; crew, design and captain see none of them', async () => {
    const r = await connect('research', () => null);
    expect((await r.client.listTools()).tools.map((t) => t.name).sort()).toEqual([...RESEARCH_TOOLS].sort());
    for (const role of ['crew', 'design', 'captain'] as Role[]) {
      const { client } = await connect(role, () => null);
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const n of ['research_brief', 'add_idea', 'finish_research']) expect(names).not.toContain(n);
      if (role !== 'captain') for (const n of ['list_ideas', 'get_idea', 'advise_idea']) expect(names).not.toContain(n);
    }
  });
  it('research_brief returns the brief text', async () => {
    const { call, calls } = await connect('research', () => ({ text: 'Sources: Padlet\n' }));
    expect((await call('research_brief')).text).toBe('Sources: Padlet');
    expect(calls[0].path).toBe('/api/research/brief');
  });
  it('add_idea posts upper-cased stage/goal ids and the evidence', async () => {
    const { call, calls } = await connect('research', () => idea({ overlapsGoalId: 'G9' }));
    const evidence = [{ kind: 'review', source: 'App Store · Padlet · 2★', text: 'No way to moderate', url: 'https://x', count: 12 }];
    const r = await call('add_idea', { title: 'Moderation queue', summary: 's', impact: 'high', effort: 'M', evidence, stage: 'm3', overlaps: 'g9' });
    expect(calls[0]).toEqual({
      path: '/api/research/ideas', method: 'POST',
      body: { actor: 'scout', title: 'Moderation queue', summary: 's', impact: 'high', effort: 'M', evidence, stageId: 'M3', overlapsGoalId: 'G9' },
    });
    expect(r.text).toBe('Added R7 [new] Moderation queue · impact high · effort M · fits M3 · overlaps G9 · 1 evidence');
  });
  it('add_idea validates impact, effort and evidence before calling the API', async () => {
    const { call, calls } = await connect('research', () => idea());
    const ok = { kind: 'web', source: 's' };
    expect((await call('add_idea', { title: 't', summary: 's', impact: 'huge', effort: 'M', evidence: [ok] })).isError).toBe(true);
    expect((await call('add_idea', { title: 't', summary: 's', impact: 'low', effort: 'XL', evidence: [ok] })).isError).toBe(true);
    expect((await call('add_idea', { title: 't', summary: 's', impact: 'low', effort: 'S', evidence: [] })).isError).toBe(true);
    expect((await call('add_idea', { title: 't', summary: 's', impact: 'low', effort: 'S', evidence: [{ ...ok, text: 'x'.repeat(301) }] })).isError).toBe(true);
    expect((await call('add_idea', { title: 't', summary: 's', impact: 'low', effort: 'S', evidence: Array(9).fill(ok) })).isError).toBe(true);
    expect(calls).toHaveLength(0);
    await call('add_idea', { title: 't', summary: 's', impact: 'business', effort: 'S', evidence: [ok] });
    expect((calls[0].body as Record<string, unknown>).stageId).toBeUndefined();
  });
  it('finish_research finishes the running run', async () => {
    const runs = [{ id: 'RR1', status: 'done', agentId: 'scout', ideaIds: [] }, { id: 'RR2', status: 'running', agentId: 'scout', ideaIds: ['R1'] }];
    const { call, calls } = await connect('research', (c) =>
      c.path === '/api/research' ? research([], runs) : { id: 'RR2', status: 'done', agentId: 'scout', ideaIds: ['R1', 'R2'] },
    );
    const r = await call('finish_research', { summary: 'Read 20 pages.', sourcesRead: 20 });
    expect(calls[1]).toEqual({ path: '/api/research/runs/RR2/finish', method: 'POST', body: { actor: 'scout', summary: 'Read 20 pages.', sourcesRead: 20 } });
    expect(r.text).toBe('Finished RR2: 2 ideas. The user has been told. You are done; stop here.');
    const none = await connect('research', () => research([], [runs[0]]));
    expect(await none.call('finish_research', { summary: 'x' })).toEqual({ text: 'Error: No research run is running.', isError: true });
  });
  it('list_ideas filters by status and flags questions waiting for advice', async () => {
    const asked = idea({ id: 'R8', title: 'Offline mode', thread: [{ at: '', from: 'you', text: 'Worth it?' }] });
    const done = idea({ id: 'R9', title: 'Export', status: 'approved', goalId: 'G14' });
    const { call } = await connect('captain', () => research([idea(), asked, done]));
    const all = (await call('list_ideas')).text.split('\n');
    expect(all).toHaveLength(3);
    expect(all[1]).toContain('question waiting for your advice');
    expect(all[2]).toMatch(/^R9 \[approved → G14\] Export/);
    expect((await call('list_ideas', { status: 'approved' })).text.split('\n')).toHaveLength(1);
    expect((await call('list_ideas', { status: 'rejected' })).text).toBe('No research ideas match.');
  });
  it('get_idea shows evidence, thread and plan; advise_idea posts the advice', async () => {
    const full = idea({ thread: [{ at: '2026-10-02T09:00:00Z', from: 'you', text: 'Cost?' }], plan: ['+ Add goal Moderation queue to M3'] });
    const { call, calls } = await connect('captain', (c) => (c.path === '/api/research' ? research([full]) : full));
    const r = (await call('get_idea', { idea: 'r7' })).text;
    expect(r).toContain('r/Teachers · 412 upvotes (+37 similar): "I need to approve posts first" <https://reddit.com/r/Teachers/x>');
    expect(r).toContain('- you · ');
    expect(r).toContain('Plan on approval:\n- + Add goal Moderation queue to M3');
    expect((await call('get_idea', { idea: 'R99' })).isError).toBe(true);
    const a = await call('advise_idea', { idea: 'r7', text: 'About 3 days.', plan: ['+ Add goal X to M3', '~ Move M3 due'] });
    expect(calls.at(-1)).toEqual({ path: '/api/research/ideas/R7/advice', method: 'POST', body: { actor: 'captain', text: 'About 3 days.', plan: ['+ Add goal X to M3', '~ Move M3 due'] } });
    expect(a.text).toBe('Advised on R7 Moderation queue with a 2-step plan. The user sees it on the Research page.');
    await call('advise_idea', { idea: 'R7', text: 'No plan yet.' });
    expect(calls.at(-1)?.body).toEqual({ actor: 'captain', text: 'No plan yet.' });
  });
  it('add_goal sends ideaId for an approved idea', async () => {
    const { call, calls } = await connect('captain', () => {
      const r = structuredClone(ROADMAP);
      r.goals.push({ id: 'G14', stageId: 'M3', title: 'Moderation queue', description: 'd', status: 'planned' });
      return { roadmap: r, progress: PROGRESS };
    });
    const r = await call('add_goal', { stage: 'm3', title: 'Moderation queue', description: 'd', idea: 'r7' });
    expect((calls[0].body as Record<string, unknown>).ideaId).toBe('R7');
    expect(r.text).toBe('Added G14 Moderation queue to M3 for idea R7.');
  });
});

describe('muster-mcp reactions', () => {
  const inbox = [{ id: 'I1', at: new Date().toISOString(), from: 'captain', kind: 'message', text: 'message from captain: check T3', feedId: 'F12' }];

  it('captain, crew and design get react; research does not', async () => {
    for (const role of ['captain', 'crew', 'design'] as Role[]) {
      const { client } = await connect(role, () => null);
      expect((await client.listTools()).tools.map((t) => t.name)).toContain('react');
    }
    const r = await connect('research', () => null);
    expect((await r.client.listTools()).tools.map((t) => t.name)).not.toContain('react');
  });

  it('read_inbox shows feed ids for reacting roles only', async () => {
    const handler = (c: { method?: string }) => (c.method === 'POST' ? { ok: true } : inbox);
    const crew = await connect('crew', handler);
    expect((await crew.call('read_inbox')).text).toContain('[F12] message from captain: check T3');
    const research = await connect('research', handler);
    expect((await research.call('read_inbox')).text).not.toContain('[F12]');
  });

  it('react posts the emoji to the feed line and reports the toggle', async () => {
    let on = true;
    const { call, calls } = await connect('crew', () => ({ id: 'F12', reactions: on ? [{ emoji: '👍', by: 'crew-2', at: 'x' }] : [] }));
    expect((await call('react', { message: ' f12 ', emoji: '👍' })).text).toBe('Reacted 👍 to F12.');
    expect(calls[0]).toEqual({ path: '/api/feed/F12/react', method: 'POST', body: { actor: 'crew-2', emoji: '👍' } });
    on = false;
    expect((await call('react', { message: 'F12', emoji: '👍' })).text).toBe('Removed your 👍 from F12.');
  });

  it('react rejects other emoji before calling the API', async () => {
    const { call, calls } = await connect('captain', () => null);
    const r = await call('react', { message: 'F12', emoji: '🔥' });
    expect(r.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe('muster-mcp intel tools', () => {
  const src = { kind: 'site', title: 'Padlet features', url: 'https://padlet.com/features' };
  const claim = { label: 'fact', confidence: 'high', sources: [src] };
  const INTEL_RESEARCH = ['intel_brief', 'browse', 'record_intel', 'add_opportunity', 'intel_check', 'finish_intel_job'];
  const INTEL_CAPTAIN = ['intel_overview', 'intel_check_status', 'request_intel_check', 'intel_reply', 'intel_suggest', 'run_sweep'];
  const check = { id: 'IC4', ideaId: 'R12', revision: 1, status: 'done', rows: [{ area: 'features', finding: 'Padlet partial', signal: 'supports', ...claim, asOf: '2026-10-01' }], verdict: 'edge_at_risk', verdictText: 'Build before Padlet ships.', confidence: 'medium', sourceCount: 3, capabilityIds: ['F3'], watchFor: 'Padlet ships approval', createdAt: '', doneAt: '2026-10-01T10:00:00Z', history: [] };

  it('scout gets the intel job tools, the Captain the intel decision tools, crew and design neither', async () => {
    const names = async (role: Role) => (await (await connect(role, () => null)).client.listTools()).tools.map((t) => t.name);
    const research = await names('research');
    for (const n of INTEL_RESEARCH) expect(research).toContain(n);
    for (const n of INTEL_CAPTAIN) expect(research).not.toContain(n);
    const captain = await names('captain');
    for (const n of INTEL_CAPTAIN) expect(captain).toContain(n);
    for (const n of INTEL_RESEARCH) expect(captain).not.toContain(n);
    for (const role of ['crew', 'design'] as Role[]) for (const n of [...INTEL_RESEARCH, ...INTEL_CAPTAIN]) expect(await names(role)).not.toContain(n);
  });

  it('record_intel takes every kind and posts kind + item', async () => {
    const items: Record<string, Record<string, unknown>> = {
      profile: { competitorId: 'padlet', tagline: 'Walls for classes' },
      capability: { name: 'Approve posts', cells: { us: { status: 'yes', ...claim }, padlet: { status: 'none', ...claim } } },
      theme: { title: 'Kids post first', mentions: 40, independentSources: 12, byCompetitor: { padlet: 40 }, severity: 'high', trend: 'rising', confidence: 'medium', sources: [src] },
      sample: { window: 'last 12 months', counts: [{ kind: 'app_store', label: 'reviews', n: 412 }] },
      social: { competitorId: 'padlet', channel: 'youtube', presence: 'active', ...claim },
      social_insight: { kind: 'engagement', text: 'Tutorials get 8x views', ...claim },
      plan: { competitorId: 'padlet', title: 'Approval queue', kind: 'commitment', ...claim },
      finding: { area: 'pricing', title: 'Pro £8/mo', ...claim },
      scenario: { name: '30 teachers', assumptions: ['one school'], costs: { padlet: { amount: 2000, currency: 'GBP', period: 'year' } }, ...claim },
      filing: { competitorId: 'padlet', companyNumber: '123', status: 'Active', limits: 'Micro-entity: no revenue', ...claim },
      positioning: { title: 'Price vs safety', x: { label: 'Price' }, y: { label: 'Safety' }, points: [{ competitorId: 'padlet', x: 0.5, y: 0.2 }], assumptions: ['list prices'], ...claim },
      insight: { kind: 'match', title: 'Approval is table stakes', detail: 'Schools ask for it', implication: 'Build it', ...claim },
      change: { competitorId: 'padlet', area: 'pricing', title: 'Pro to £8', planImpact: 'watch', implication: 'Price gap widens', ...claim },
    };
    for (const [kind, item] of Object.entries(items)) {
      const { call, calls } = await connect('research', () => ({ id: 'X1', title: item.title, name: item.name, ...(kind === 'capability' ? { verdict: 'edge', verdictVs: ['padlet'] } : {}) }));
      const r = await call('record_intel', { kind, item });
      expect(r.isError, `${kind}: ${r.text}`).toBe(false);
      expect(calls[0]).toEqual({ path: '/api/intel/record', method: 'POST', body: { actor: 'scout', kind, item: expect.objectContaining(item) } });
      if (kind === 'capability') expect(r.text).toBe('Recorded capability X1 Approve posts → edge vs padlet.');
    }
  });

  it('intel_brief, intel_check, add_opportunity and finish_intel_job call the intel routes', async () => {
    const { call, calls } = await connect('research', (c) => {
      if (c.path === '/api/intel/brief') return { text: 'Intel job IJ3 (competitor)\n' };
      if (c.path.startsWith('/api/intel/checks/')) return check;
      if (c.path === '/api/intel/opportunities') return { id: 'R12', title: 'Approval queue', impact: 'high', effort: 'S', evidence: [{}], status: 'new', origin: 'intel', opportunity: { kind: 'edge', valueScore: 4, effortScore: 2 }, thread: [] };
      return { id: 'IJ3', status: 'done' };
    });
    expect((await call('intel_brief')).text).toBe('Intel job IJ3 (competitor)');
    const opp = await call('add_opportunity', {
      title: 'Approval queue', summary: 's', impact: 'high', effort: 'S', evidence: [{ kind: 'competitor', source: 'Padlet help' }],
      opportunity: { kind: 'edge', capabilityIds: ['f3'], problem: 'p', alternatives: 'a', proposal: 'x', value: 'v', effortNote: 'e', priority: 'now', validation: 'v', valueScore: 4, effortScore: 2, claim: { ...claim, implication: 'i' } },
    });
    expect(opp.text).toBe('Added R12 [new] Approval queue · impact high · effort S · intel edge (value 4/5, effort 2/5) · 1 evidence. Now write intel_check(R12, …).');
    expect((calls[1].body as { opportunity: { capabilityIds: string[] } }).opportunity.capabilityIds).toEqual(['F3']);
    const c = await call('intel_check', { idea: 'r12', rows: [{ area: 'features', finding: 'Padlet partial', signal: 'supports', ...claim }], verdictText: 'Build before Padlet ships.', confidence: 'medium', capabilities: ['f3'], watchFor: 'Padlet ships approval' });
    expect(calls[2]).toMatchObject({ path: '/api/intel/checks/R12', method: 'POST', body: { actor: 'scout', capabilityIds: ['F3'], verdictText: 'Build before Padlet ships.', watchFor: 'Padlet ships approval' } });
    expect(c.text).toContain('Verdict: edge at risk (medium confidence, 3 sources, coverage 1 of 7)');
    expect((await call('finish_intel_job', { summary: 'Read 9 pages', sourcesRead: 9 })).text).toMatch(/^Finished IJ3\./);
    expect(calls[3]).toEqual({ path: '/api/intel/finish', method: 'POST', body: { actor: 'scout', summary: 'Read 9 pages', sourcesRead: 9 } });
  });

  it('browse posts /api/browser/read and falls back honestly while the browser routes are missing', async () => {
    const missing = await connect('research', () => {
      throw new Error('No route /api/browser/read');
    });
    expect((await missing.call('browse', { url: 'https://reddit.com/r/Teachers' })).text).toBe("The research browser isn't available yet; use the web-research tools.");
    const { call, calls } = await connect('research', () => ({ url: 'https://reddit.com/r/Teachers', title: 'r/Teachers', status: 200, text: 'Posts…', via: 'profile', loggedIn: true, pagesLeft: 140 }));
    const r = await call('browse', { url: 'https://reddit.com/r/Teachers', links: true });
    expect(calls[0]).toEqual({ path: '/api/browser/read', method: 'POST', body: { actor: 'scout', url: 'https://reddit.com/r/Teachers', action: 'read', links: true } });
    expect(r.text).toBe('r/Teachers (200, via profile, signed in) · 140 pages left\nhttps://reddit.com/r/Teachers\n\nPosts…');
    const other = await connect('research', () => {
      throw new Error('page budget used');
    });
    expect(await other.call('browse', { url: 'https://x.example' })).toEqual({ text: 'Error: page budget used', isError: true });
  });

  it('captain: overview, check status, request, reply, suggest, sweep, advise effort', async () => {
    const store = {
      competitors: [{ id: 'us', name: 'wall', isUs: true }, { id: 'padlet', name: 'Padlet', lastSweptAt: '2026-10-01T10:00:00Z' }],
      capabilities: [{ id: 'F3', name: 'Approve posts', verdict: 'gap', verdictVs: ['padlet'], verdictStage: 'M5', ideaId: 'R12', cells: {} }],
      changes: [{ id: 'IX5', at: '2026-10-02', competitorId: 'padlet', area: 'roadmap', title: 'Padlet building approval', planImpact: 'respond', seen: false }],
      jobs: [{ id: 'IJ3', kind: 'sweep', status: 'queued', competitorIds: ['padlet'], by: 'captain' }],
      checks: [check],
      captainThread: [{ at: '2026-10-02T10:00:00Z', from: 'you', text: 'Which gap first?' }],
    };
    const ideas = [{ id: 'R12', title: 'Approval queue', impact: 'high', effort: 'S', evidence: [], status: 'new', origin: 'intel', opportunity: { kind: 'gap', valueScore: 5, effortScore: 3 }, checkId: 'IC4', thread: [] }];
    const { call, calls } = await connect('captain', (c) => {
      if (c.path === '/api/intel') return store;
      if (c.path === '/api/research') return { runs: [], ideas };
      if (c.path === '/api/intel/checks') return { ...check, status: 'queued', jobId: 'IJ4' };
      if (c.path.endsWith('/suggest')) return { id: 'IX5', title: 'Padlet building approval' };
      if (c.path === '/api/intel/jobs') return { id: 'IJ6', kind: 'sweep', status: 'queued', competitorIds: ['padlet'], by: 'captain', pagesBrowsed: 0 };
      return ideas[0];
    });
    const o = (await call('intel_overview')).text;
    expect(o).toContain('- F3 Approve posts vs Padlet (closing M5) · R12 [new]');
    expect(o).toContain('IX5 2026-10-02 Padlet [roadmap] Padlet building approval · plan respond · needs your intel_suggest');
    expect(o).toContain('Queued: IJ3 sweep');
    expect(o).toContain('Which gap first? — answer with intel_reply.');
    expect((await call('intel_check_status', { idea: 'r12' })).text).toContain('IC4 for R12 Approval queue · rev 1 · done');
    expect((await call('request_intel_check', { idea: 'r12' })).text).toBe('IC4 for R12 · rev 1 · queued. Scout is on it (IJ4); approval waits for it.');
    await call('intel_reply', { text: 'R12 first.' });
    expect(calls.at(-1)).toEqual({ path: '/api/intel/reply', method: 'POST', body: { actor: 'captain', text: 'R12 first.' } });
    expect((await call('intel_suggest', { change: 'ix5', text: 'Pull G4 into M2.' })).text).toBe('Suggestion saved on IX5 Padlet building approval.');
    expect((await call('run_sweep', { competitors: ['Padlet'] })).text).toBe('Queued IJ6 [queued] sweep · padlet · by captain.');
    expect(calls.at(-1)!.body).toEqual({ actor: 'captain', kind: 'sweep', competitorIds: ['padlet'] });
    await call('advise_idea', { idea: 'R12', text: 'About a week.', plan: ['Re-check weekly; alert if Padlet ships approval'], effort: 3 });
    expect(calls.at(-1)).toEqual({ path: '/api/research/ideas/R12/advice', method: 'POST', body: { actor: 'captain', text: 'About a week.', plan: ['Re-check weekly; alert if Padlet ships approval'], effort: 3 } });
  });
});

describe('muster-mcp media tools', () => {
  const piece = (patch: Record<string, unknown> = {}) => ({ id: 'MP3', kind: 'social', title: 'Approve before publish', status: 'drafting', about: [], claims: [], requests: [], createdAt: '', updatedAt: '', ...patch });

  it('herald gets only its tools; nobody else sees them', async () => {
    const h = await connect('media', () => null);
    expect((await h.client.listTools()).tools.map((t) => t.name).sort()).toEqual([...MEDIA_TOOLS].sort());
    for (const role of ['crew', 'design', 'captain', 'research'] as Role[]) {
      const names = (await (await connect(role, () => null)).client.listTools()).tools.map((t) => t.name);
      for (const n of MEDIA_TOOLS.filter((t) => t !== 'read_inbox' && !(t === 'browse' && role === 'research'))) expect(names).not.toContain(n);
    }
  });

  it('media_brief, media_draft (current piece by default) and media_finish', async () => {
    const { call, calls } = await connect('media', (c) => (c.path === '/api/media/brief' ? { text: '# MP3 · Social post\n' } : piece({ claims: [{ id: 'C1', quote: 'q', sources: [] }] })));
    expect((await call('media_brief')).text).toBe('# MP3 · Social post');
    const r = await call('media_draft', { title: 'Approve before publish', progress: 'writing X', posts: [{ platform: 'x', versions: ['Hi'] }] });
    expect(calls[1]).toEqual({ path: '/api/media/pieces/current/draft', method: 'POST', body: { actor: 'herald', title: 'Approve before publish', progress: 'writing X', posts: [{ platform: 'x', versions: ['Hi'] }] } });
    expect(r.text).toBe('Saved MP3 (social, drafting) "Approve before publish": title, posts, progress. 1 claim(s) have no source.');
    await call('media_finish', { piece: 'mp3', summary: 'Done.' });
    expect(calls[2]).toEqual({ path: '/api/media/pieces/MP3/finish', method: 'POST', body: { actor: 'herald', summary: 'Done.' } });
  });

  it('the Captain suggests media for a merged task', async () => {
    const { call, calls } = await connect('captain', () => ({ id: 'MS2', ref: 'T41' }));
    expect((await call('suggest_media', { task: 't41', title: 'PDF export', why: 'Teachers asked.' })).text).toBe('Suggested MS2 for T41 on the Media page.');
    expect(calls[0]).toEqual({ path: '/api/media/suggestions', method: 'POST', body: { actor: 'captain', task: 'T41', title: 'PDF export', why: 'Teachers asked.' } });
  });

  it('herald saves demo GIF frames; the Captain links a recording task', async () => {
    const h = await connect('media', () => piece({ kind: 'gif' }));
    const gif = { frames: [{ taskId: 'T38', evidenceId: 'E2', name: 'queue.png', caption: 'New posts wait for you first' }], steps: ['Open a wall'], altText: 'A teacher approves a post.' };
    await h.call('media_draft', { gif });
    expect(h.calls[0].body).toEqual({ actor: 'herald', gif });
    const c = await connect('captain', () => piece({ kind: 'gif', gif: { recording: { status: 'recording', taskId: 'T52' } } }));
    expect((await c.call('media_recording', { piece: 'mp5', task: 't52' })).text).toMatch(/^Linked T52 to MP3\./);
    expect(c.calls[0]).toEqual({ path: '/api/media/pieces/MP5/recording', method: 'POST', body: { actor: 'captain', task: 'T52' } });
  });
});
