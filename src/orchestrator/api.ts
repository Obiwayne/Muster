// HTTP API routes (see docs/ARCHITECTURE.md). Handlers return JSON-able values or throw HttpError.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Agent, MusterConfig, NoteType, Role, Task } from '../types.js';
import * as board from '../core/board.js';
import type { ConfigPatch } from '../core/config.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../core/errors.js';
import * as gitOps from '../core/git.js';
import type { MusterPaths } from '../core/paths.js';
import type { Store } from '../core/store.js';
import * as tasks from '../core/tasks.js';
import { createVellumChecker, type VellumCall } from '../core/vellum.js';
import { applyUsage, refreshGuard, type RawUsage } from '../core/usage.js';
import type { AgentManager } from './agents.js';
import { applyIdentity, forbiddenReason, type Caller } from './auth.js';

export interface ApiContext {
  store: Store;
  paths: MusterPaths;
  agents: AgentManager;
  version: string;
  config(): MusterConfig;
  updateConfig(patch: ConfigPatch): MusterConfig;
  notify(title: string, text: string): void;
  toast(level: 'info' | 'warn', text: string): void;
  shutdown(clean: boolean): void;
  /** Test seam: replaces the real Vellum MCP call. */
  vellumCall?: VellumCall;
}

interface Req {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, any>;
}

type Handler = (r: Req) => unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const TEST_TIMEOUT_MS = 10 * 60_000;
const MAX_BODY = 2 * 1024 * 1024;
const CONFIG_KEYS = new Set<string>([
  'port', 'captainModel', 'crewModel', 'designModel', 'maxCrew', 'pauseAtFiveHourPct', 'warnAtWeeklyPct', 'shutdownIdleCrew',
  'defaultStations', 'testCommand', 'baseBranch', 'permissionMode', 'claudePath', 'vellum', 'notify', 'allowedTools', 'projectName', 'userName', 'vellumFile',
]);

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw badRequest(`Missing ${name}`);
  return v;
};
const flag = (q: URLSearchParams, k: string) => q.get(k) === '1' || q.get(k) === 'true';

export function createApi(ctx: ApiContext) {
  const { store, agents } = ctx;
  const state = () => store.state;
  const vellum = createVellumChecker({ call: ctx.vellumCall });
  const routes: Route[] = [];
  const route = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, pattern, keys, handler });
  };
  /** Runs a state mutation, commits and returns its result. */
  const mutate = <T>(fn: () => T): T => {
    const result = fn();
    store.commit();
    return result;
  };
  const agentOf = (id: string) => board.requireAgent(state(), decodeURIComponent(id));
  const requireBranch = async (branch: unknown) => {
    if (typeof branch !== 'string' || branch.startsWith('-') || !(await gitOps.branchExists(ctx.paths.root, branch))) throw notFound(`No branch "${branch}"`);
  };

  /** After a task lands on an agent: fix up its branch, and wake the agent if it was stopped. */
  const afterTake = async (agent: Agent | undefined, task: Task) => {
    if (!agent) return;
    await agents.syncTaskBranch(agent, task);
    store.commit();
    if (!agents.isRunning(agent.id) && agent.role !== 'captain') await agents.start(agent.id);
  };

  // ------------------------------------------------------------------ state
  route('GET', '/api/health', () => ({ ok: true, version: ctx.version }));
  route('GET', '/api/state', () => ({ state: state(), config: ctx.config(), paused: state().usage.paused }));
  route('GET', '/api/config', () => ctx.config());
  route('PATCH', '/api/config', ({ body }) => {
    const patch = Object.fromEntries(Object.entries(body).filter(([k]) => CONFIG_KEYS.has(k))) as ConfigPatch;
    const before = ctx.config().userName;
    const config = ctx.updateConfig(patch);
    return mutate(() => {
      refreshGuard(state(), config);
      // Running agents learned the old name from their launch prompt; tell them now.
      if ('userName' in patch && config.userName !== before) {
        const text = config.userName
          ? `The person you work for is called ${config.userName}. Call them ${config.userName} from now on, never "the human".`
          : 'Refer to the person you work for as "the user", never "the human".';
        for (const a of state().agents) if (a.status !== 'stopped') board.addInbox(state(), { agentId: a.id, from: board.SYSTEM, kind: 'system', text });
      }
      return config;
    });
  });
  route('GET', '/api/vellum', ({ query }) => vellum.check(ctx.config(), flag(query, 'refresh')));
  route('POST', '/api/shutdown', ({ body }) => {
    setImmediate(() => ctx.shutdown(Boolean(body.clean)));
    return { ok: true };
  });

  // ------------------------------------------------------------------ agents
  route('POST', '/api/agents', ({ body }) =>
    agents.create({ name: body.name || undefined, role: body.role as Role | undefined, taskId: body.taskId || undefined, actor: str(body.actor, 'actor') }),
  );
  route('POST', '/api/agents/:id/role', ({ params, body }) => agents.setRole(agentOf(params.id).id, str(body.role, 'role') as Role, body.actor ?? board.HUMAN));
  route('POST', '/api/agents/:id/stop', ({ params, body }) => agents.stop(agentOf(params.id).id, body.actor ? `by ${body.actor}` : undefined));
  route('POST', '/api/agents/:id/start', ({ params }) => agents.start(agentOf(params.id).id));
  route('DELETE', '/api/agents/:id', async ({ params, query }) => {
    await agents.remove(agentOf(params.id).id, flag(query, 'removeWorktree'));
    return { ok: true };
  });
  route('POST', '/api/agents/:id/input', async ({ params, body }) => {
    if (typeof body.text !== 'string') throw badRequest('Missing text');
    await agents.type(agentOf(params.id).id, body.text, Boolean(body.submit), { human: true });
    return { ok: true };
  });
  route('GET', '/api/agents/:id/output', ({ params, query }) => ({ text: agents.output(agentOf(params.id).id, Number(query.get('lines')) || 80) }));
  route('GET', '/api/agents/:id/diff', async ({ params, query }) => {
    const agent = agentOf(params.id);
    const base = ctx.config().baseBranch;
    const requested = query.get('branch');
    if (requested) await requireBranch(requested);
    const branch = requested || agent.branch;
    if (!requested && agent.role === 'captain') return { branch, base, stat: '', diff: '' };
    const d = await gitOps.diff(ctx.paths.root, base, branch);
    return { branch, base, stat: d.stat, diff: flag(query, 'stat') ? '' : d.diff };
  });
  route('POST', '/api/agents/:id/tests', ({ params }) => gitOps.runTests(agentOf(params.id).worktree, ctx.config().testCommand, TEST_TIMEOUT_MS));
  route('POST', '/api/agents/:id/event', ({ params, body }) => {
    agents.handleEvent(agentOf(params.id).id, str(body.event, 'event'), typeof body.detail === 'string' ? body.detail : '', body.kind);
    return { ok: true };
  });
  route('POST', '/api/agents/:id/merge', async ({ params, body }) => {
    if (body.actor !== board.HUMAN) throw forbidden('Only you can merge');
    const agent = agentOf(params.id);
    const s = state();
    // Which branch: an explicit task or branch from the body, else the agent's flagged task, else its current task.
    const wanted: string = body.branch || (body.taskId ? tasks.requireTask(s, body.taskId).branch : '') || agent.branch;
    if (body.branch) await requireBranch(body.branch);
    const task = body.taskId
      ? tasks.requireTask(s, body.taskId)
      : (s.tasks.find((t) => t.status === 'ready_for_merge' && t.branch === wanted) ??
        (body.branch ? s.tasks.find((t) => t.branch === wanted && t.status !== 'merged') : undefined) ??
        (agent.taskId ? tasks.requireTask(s, agent.taskId) : s.tasks.find((t) => t.branch === wanted && t.status !== 'merged')));
    if (!body.force) {
      if (!task) throw conflict(`No task on ${wanted} is ready to merge`);
      if (task.status !== 'ready_for_merge') throw conflict(`${task.id} is ${task.status}, not ready for merge (the Captain has not flagged it)`);
    }
    const branch = task?.branch ?? wanted;
    const base = ctx.config().baseBranch;
    // Merge exactly the commit the Captain reviewed; a branch that moved since needs a new review.
    let ref = branch;
    if (task?.reviewedSha && !body.force) {
      const head = await gitOps.revParse(ctx.paths.root, branch);
      if (head && head !== task.reviewedSha) {
        const mover = mutate(() => tasks.reviewAgain(s, task, head));
        throw conflict(`Not merged: ${mover} changed ${task.id} after the Captain's review. It's back with the Captain for a re-review and will show under Needs you again when it's ready.`);
      }
      ref = task.reviewedSha;
    }
    const output = await gitOps.mergeToBase(ctx.paths.root, base, ref, `Merge ${branch}${task ? ` (${task.id} ${task.title})` : ''}`);
    mutate(() => (task ? tasks.markMerged(s, task, board.HUMAN) : board.feedEvent(s, board.HUMAN, `merged ${branch}`)));
    return { ok: true, output };
  });

  // ------------------------------------------------------------------ goal
  route('POST', '/api/ask', async ({ body }) => {
    const text = str(body.text, 'text').trim();
    const captain = board.captainOf(state());
    if (!captain) throw conflict('There is no Captain');
    if (!agents.isRunning(captain.id)) throw conflict(`${captain.id} is not running (muster start ${captain.id})`);
    mutate(() => {
      state().goal = { text, at: board.nowIso() };
      board.addFeed(state(), { kind: 'message', from: board.HUMAN, to: captain.id, text });
    });
    await agents.type(captain.id, text, true);
    return { ok: true };
  });

  // ------------------------------------------------------------------ tasks
  route('GET', '/api/tasks', () => state().tasks);
  route('POST', '/api/tasks', async ({ body }) => {
    if (body.assignee) await agents.assertCanTakeBranch(body.assignee);
    const task = mutate(() =>
      tasks.createTask(state(), ctx.config(), {
        title: str(body.title, 'title'),
        description: body.description,
        dependsOn: body.dependsOn,
        stations: body.stations,
        assignee: body.assignee || undefined,
        actor: str(body.actor, 'actor'),
      }),
    );
    if (task.assignee) await afterTake(board.findAgent(state(), task.assignee), task);
    return task;
  });
  route('POST', '/api/tasks/claim', async ({ body }) => {
    const claimer = board.findAgent(state(), body.actor);
    if (claimer) await agents.assertCanTakeBranch(claimer.id, tasks.nextClaimable(state(), claimer));
    const task = mutate(() => tasks.claimTask(state(), str(body.actor, 'actor')));
    if (task) await afterTake(board.findAgent(state(), body.actor), task);
    return task;
  });
  route('POST', '/api/tasks/:id/assign', async ({ params, body }) => {
    await agents.assertCanTakeBranch(body.agentId, tasks.requireTask(state(), params.id));
    const task = mutate(() => tasks.assignTask(state(), params.id, str(body.agentId, 'agentId'), str(body.actor, 'actor')));
    await afterTake(board.findAgent(state(), body.agentId), task);
    return task;
  });
  route('POST', '/api/tasks/:id/handoff', async ({ params, body }) => {
    const current = tasks.requireTask(state(), params.id);
    const from = await agents.stationBranch(current); // 409 unless it contains the earlier stations' work
    if (body.to) await agents.assertCanTakeBranch(body.to, current);
    const r = mutate(() => tasks.handoffTask(state(), params.id, str(body.actor, 'actor'), body.to || undefined, body.note ?? '', from));
    if (r.receiver) await afterTake(r.receiver, r.task);
    return r.task;
  });
  route('POST', '/api/tasks/:id/done', async ({ params, body }) => {
    const from = await agents.stationBranch(tasks.requireTask(state(), params.id));
    return mutate(() => tasks.doneTask(state(), params.id, str(body.actor, 'actor'), body.summary ?? '', from));
  });
  route('POST', '/api/tasks/:id/review', async ({ params, body }) => {
    const reviewed = await agents.stationBranch(tasks.requireTask(state(), params.id)); // records the commit the merge will take
    const { task, note } = mutate(() => tasks.requestReview(state(), params.id, str(body.actor, 'actor'), body.summary ?? '', reviewed));
    await agents.syncDependents(task.id);
    store.commit();
    ctx.notify('Muster: ready for review', note.text);
    ctx.toast('info', note.text);
    return task;
  });
  route('POST', '/api/tasks/:id/cancel', ({ params, body }) =>
    mutate(() => tasks.cancelTask(state(), params.id, str(body.actor, 'actor'), body.reason ?? '')),
  );
  route('POST', '/api/tasks/:id/sendback', async ({ params, body }) => {
    const current = tasks.requireTask(state(), params.id);
    await agents.assertCanTakeBranch(tasks.builderOf(state(), current)?.id, current);
    const task = mutate(() => tasks.sendBack(state(), params.id, str(body.actor, 'actor'), body.note ?? ''));
    if (task.assignee) await afterTake(board.findAgent(state(), task.assignee), task);
    return task;
  });

  // ------------------------------------------------------------------ board, chat, inbox
  route('GET', '/api/notes', ({ query }) =>
    board.listNotes(state(), {
      open: flag(query, 'open'),
      type: query.get('type') ?? undefined,
      from: query.get('from') ?? undefined,
      to: query.get('to') ?? undefined,
      needsYou: flag(query, 'needsYou'),
    }),
  );
  route('POST', '/api/notes', ({ body }) =>
    mutate(() => board.postNote(state(), { actor: str(body.actor, 'actor'), type: str(body.type, 'type') as NoteType, text: str(body.text, 'text'), taskId: body.taskId, to: body.to })),
  );
  route('POST', '/api/notes/:id/reply', ({ params, body }) =>
    mutate(() => board.replyNote(state(), params.id, str(body.actor, 'actor'), str(body.text, 'text'), Boolean(body.close))),
  );
  route('POST', '/api/notes/:id/close', ({ params, body }) => mutate(() => board.closeNote(state(), params.id, str(body.actor, 'actor'))));
  route('POST', '/api/escalate', ({ body }) => {
    const note = mutate(() => board.escalate(state(), str(body.actor, 'actor'), str(body.text, 'text'), body.noteId || undefined));
    ctx.notify('Muster: the Captain needs you', note.text);
    ctx.toast('warn', note.text);
    return note;
  });
  route('POST', '/api/messages', ({ body }) => mutate(() => board.sendMessage(state(), str(body.actor, 'actor'), str(body.to, 'to'), str(body.text, 'text'))));
  route('GET', '/api/feed', ({ query }) =>
    board.listFeed(state(), { limit: Number(query.get('limit')) || 200, before: query.get('before') ?? undefined, agent: query.get('agent') ?? undefined }),
  );
  route('GET', '/api/inbox/:agentId', ({ params, query }) => board.inboxFor(state(), agentOf(params.agentId).id, flag(query, 'unread')));
  route('POST', '/api/inbox/:agentId/read', ({ params, body }) => {
    const id = agentOf(params.agentId).id;
    return mutate(() => ({ ok: true, marked: board.markRead(state(), id, Array.isArray(body.ids) ? body.ids : undefined) }));
  });

  // ------------------------------------------------------------------ usage
  route('POST', '/api/usage', ({ body }) => {
    const wasPaused = state().usage.paused;
    const warnings = mutate(() => applyUsage(state(), ctx.config(), body as RawUsage));
    for (const w of warnings) {
      ctx.notify('Muster: weekly usage', w);
      ctx.toast('warn', w);
    }
    if (state().usage.paused !== wasPaused) ctx.toast('warn', state().usage.paused ? 'Muster paused new work (5-hour window)' : 'Muster resumed new work');
    return state().usage;
  });
  route('GET', '/api/usage', () => state().usage); // UsageState already carries `paused`

  /** `caller` is resolved from the token by the server; it decides what may run and overwrites body.actor. */
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL, caller: Caller): Promise<void> {
    try {
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const candidates = routes.filter((r) => r.pattern.test(path));
      if (!candidates.length) throw notFound(`No route ${path}`);
      const r = candidates.find((c) => c.method === req.method);
      if (!r) throw new HttpError(405, `${req.method} not allowed on ${path}`);
      const m = r.pattern.exec(path)!;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const denied = forbiddenReason(caller, req.method ?? 'GET', path);
      if (denied) throw forbidden(denied);
      const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readBody(req);
      if (req.method !== 'GET' && req.method !== 'HEAD') applyIdentity(caller, path, body);
      sendJson(res, 200, (await r.handler({ params, query: url.searchParams, body })) ?? null);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      sendJson(res, status, { error: e instanceof Error ? e.message : String(e) });
    }
  };
}

function readBody(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const v = JSON.parse(text);
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch {
        reject(badRequest('Body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) return;
  const text = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}
