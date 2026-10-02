// HTTP API routes (see docs/ARCHITECTURE.md). Handlers return JSON-able values or throw HttpError.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Agent, MusterConfig, NoteType, Role, Task } from '../types.js';
import { createReadStream, statSync } from 'node:fs';
import * as board from '../core/board.js';
import type { ConfigPatch } from '../core/config.js';
import * as evidence from '../core/evidence.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../core/errors.js';
import * as gitOps from '../core/git.js';
import type { MusterPaths } from '../core/paths.js';
import type { Store } from '../core/store.js';
import * as lines from '../core/lines.js';
import * as roadmap from '../core/roadmap.js';
import * as stations from '../core/stations.js';
import * as tasks from '../core/tasks.js';
import { readPartial } from '../core/config.js';
import { ghStatus, realGh, validRepoName, type GhRunner } from '../core/github.js';
import { createVellumChecker, type VellumCall } from '../core/vellum.js';
import { applyUsage, refreshGuard, type RawUsage } from '../core/usage.js';
import type { AgentManager } from './agents.js';
import { applyIdentity, forbiddenReason, type Caller } from './auth.js';

export interface ApiContext {
  store: Store;
  paths: MusterPaths;
  agents: AgentManager;
  version: string;
  /** Build stamp (ms) of the code this server loaded; see core/build.ts. */
  build?: number;
  config(): MusterConfig;
  updateConfig(patch: ConfigPatch): MusterConfig;
  notify(title: string, text: string): void;
  toast(level: 'info' | 'warn', text: string): void;
  shutdown(clean: boolean): void;
  /** Test seam: replaces the real Vellum MCP call. */
  vellumCall?: VellumCall;
  /** Test seam: replaces the real `gh` CLI. */
  ghRunner?: GhRunner;
}

interface Req {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, any>;
}

type Handler = (r: Req) => unknown;

/** A handler result sent as a file rather than JSON. */
class FileReply {
  constructor(public path: string, public contentType: string) {}
}

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
  'defaultStations', 'testCommand', 'baseBranch', 'permissionMode', 'claudePath', 'vellum', 'notify', 'allowedTools', 'projectName', 'userName', 'vellumFile', 'vellumEdit', 'defaultLine', 'lines', 'githubOffer', 'crewNames', 'requireEvidence',
]);
const MAX_EVIDENCE_TEXT = 200_000;

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

  /** Appends the current station's brief (guideline, skills, evidence) to the newest inbox item the task just produced for `agentId`. */
  const attachGuideline = (agentId: string | undefined, task: Task, kinds: string[]) => {
    const block = stations.stationBrief(ctx.paths, task, stations.stationRoles(ctx.paths));
    const item = block && agentId ? [...state().inbox].reverse().find((i) => i.agentId === agentId && i.taskId === task.id && kinds.includes(i.kind) && !i.read) : undefined;
    if (item && !item.text.includes(block)) {
      item.text += `

${block}`;
      store.commit();
    }
  };

  /** The line a new task uses (404 for an unknown name): the stations it asks for win, else the line's. */
  const taskLine = (body: { line?: unknown; stations?: unknown }): { line?: string; stations?: string[] } => {
    const named = body.line !== undefined && body.line !== null && body.line !== '';
    if (named && typeof body.line !== 'string') throw badRequest('line must be a line name');
    const explicit = Array.isArray(body.stations) && body.stations.length > 0;
    const line = named ? (body.line as string) : explicit ? undefined : lines.defaultLineName(ctx.config());
    const found = line === undefined ? undefined : lines.lineStations(ctx.config(), line);
    if (line !== undefined && !found) throw notFound(`No line "${line}"`);
    return { line, stations: explicit ? (body.stations as string[]) : found };
  };

  /**
   * defaultStations is an alias for the default line's stations: a patch carrying it edits that line (the
   * line named in the same patch, else the current default). Also checks lines/defaultLine shapes.
   */
  const lineEdits = (patch: ConfigPatch): void => {
    const cfg = ctx.config();
    let edits: MusterConfig['lines'] = { ...cfg.lines };
    if (patch.lines !== undefined) {
      const v = patch.lines;
      if (v !== null && (typeof v !== 'object' || Array.isArray(v))) throw badRequest('lines must be an object of { label, stations }');
      edits = {};
      for (const [rawName, e] of Object.entries(v ?? {})) edits[lines.lineNameOrThrow(rawName)] = lines.checkedEntry(ctx.paths, e);
    }
    const known = { lines: edits };
    if (patch.defaultLine !== undefined && patch.defaultLine !== null && (typeof patch.defaultLine !== 'string' || !lines.getLine(known, patch.defaultLine))) throw badRequest(`No line "${patch.defaultLine}"`);
    if (patch.defaultStations !== undefined) {
      const target = typeof patch.defaultLine === 'string' ? patch.defaultLine : lines.defaultLineName({ lines: edits, defaultLine: cfg.defaultLine });
      const names = lines.checkedEntry(ctx.paths, { stations: patch.defaultStations }, false).stations;
      const cur = lines.getLine(known, target)!;
      if (names.join() !== cur.stations.filter((x) => x !== 'review').join()) edits[target] = { label: cur.label, stations: names };
      delete patch.defaultStations;
    }
    if (patch.lines !== undefined || JSON.stringify(edits) !== JSON.stringify(cfg.lines)) patch.lines = edits;
  };

  /** A task that just reached a 'human' station: toast and notify you, the way review does. */
  const announceApproval = (task: Task) => {
    const note = task.status === 'awaiting_approval' ? tasks.approvalNote(state(), task) : undefined;
    if (!note) return;
    ctx.notify('Muster: needs your approval', note.text);
    ctx.toast('info', note.text);
  };

  /** After a task lands on an agent: fix up its branch, and wake the agent if it was stopped. */
  const afterTake = async (agent: Agent | undefined, task: Task) => {
    if (!agent) return;
    await agents.syncTaskBranch(agent, task);
    store.commit();
    if (!agents.isRunning(agent.id) && agent.role !== 'captain') await agents.start(agent.id);
  };

  // ------------------------------------------------------------------ state
  route('GET', '/api/lines', () => ({ lines: lines.listLines(ctx.config()), defaultLine: lines.defaultLineName(ctx.config()) }));
  route('PUT', '/api/lines/:name', ({ params, body }) => {
    const { name, entry } = lines.lineEntry(ctx.paths, ctx.config(), decodeURIComponent(params.name), { stations: body.stations, label: body.label });
    const config = ctx.updateConfig({ lines: { ...ctx.config().lines, [name]: entry } });
    return lines.getLine(config, name);
  });
  // Resets a built-in line to its original stations, or removes a custom line (the default line falls back to "feature").
  route('DELETE', '/api/lines/:name', ({ params }) => {
    const name = lines.lineNameOrThrow(decodeURIComponent(params.name));
    const edits = { ...ctx.config().lines };
    if (!(name in edits) && !lines.BUILT_IN_LINES[name]) throw notFound(`No line "${name}"`);
    delete edits[name];
    const config = ctx.updateConfig({ lines: edits, ...(!lines.BUILT_IN_LINES[name] && ctx.config().defaultLine === name ? { defaultLine: null } : {}) });
    return { lines: lines.listLines(config), defaultLine: lines.defaultLineName(config) };
  });
  route('GET', '/api/health', () => ({ ok: true, version: ctx.version, build: ctx.build }));
  route('GET', '/api/state', () => ({ state: state(), config: ctx.config(), paused: state().usage.paused }));
  route('GET', '/api/config', () => ctx.config());
  route('PATCH', '/api/config', ({ body }) => {
    const patch = Object.fromEntries(Object.entries(body).filter(([k]) => CONFIG_KEYS.has(k))) as ConfigPatch;
    if (patch.vellumFile !== undefined && patch.vellumFile !== null && typeof patch.vellumFile !== 'string') throw badRequest('vellumFile must be a string, or null to clear it');
    if (patch.vellumFile === '') patch.vellumFile = null;
    if (patch.vellumEdit !== undefined && patch.vellumEdit !== null && !['ask', 'always', 'never'].includes(patch.vellumEdit)) {
      throw badRequest('vellumEdit must be "ask", "always" or "never"');
    }
    if (patch.githubOffer !== undefined && patch.githubOffer !== null && !['ask', 'never'].includes(patch.githubOffer)) {
      throw badRequest('githubOffer must be "ask" or "never"');
    }
    if (patch.crewNames !== undefined && patch.crewNames !== null && !['names', 'numbers'].includes(patch.crewNames)) {
      throw badRequest('crewNames must be "names" or "numbers"');
    }
    if (patch.requireEvidence !== undefined && patch.requireEvidence !== null && typeof patch.requireEvidence !== 'boolean') {
      throw badRequest('requireEvidence must be true or false');
    }
    lineEdits(patch);
    const before = ctx.config().userName;
    const beforeEdit = ctx.config().vellumEdit;
    const config = ctx.updateConfig(patch);
    // The design crew's tool permissions and prompt are fixed at launch: restart it (same session) to apply.
    if (config.vellumEdit !== beforeEdit) {
      for (const a of state().agents) {
        if (a.role !== 'design' || !agents.isRunning(a.id)) continue;
        void agents.restart(a.id).catch(() => {});
      }
    }
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
  // ------------------------------------------------------------------ stations (files in .muster/stations)
  route('GET', '/api/stations', () => stations.listStations(ctx.paths, ctx.config()));
  route('GET', '/api/stations/:name', ({ params }) => {
    const s = stations.getStation(ctx.paths, stations.stationName(decodeURIComponent(params.name)));
    if (!s) throw notFound(`No station "${params.name}"`);
    return s;
  });
  route('PUT', '/api/stations/:name', ({ params, body }) => {
    if (Array.isArray(body.skills)) {
      const known = new Set(stations.listSkills().map((s) => s.name));
      const unknown = body.skills.filter((s: unknown) => typeof s === 'string' && !known.has(s));
      if (unknown.length) throw badRequest(`Unknown skill${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Muster's skills are in plugin/skills: ${[...known].join(', ') || 'none'}`);
    }
    return stations.saveStation(ctx.paths, decodeURIComponent(params.name), { role: body.role, guideline: body.guideline, skills: body.skills });
  });
  route('GET', '/api/skills', () => stations.listSkills());
  route('DELETE', '/api/stations/:name', ({ params }) => {
    const name = stations.stationName(decodeURIComponent(params.name));
    stations.deleteStation(ctx.paths, name);
    const defaults = ctx.config().defaultStations;
    if (defaults.includes(name) && defaults.length > 2) ctx.updateConfig({ defaultStations: defaults.filter((n) => n !== name) });
    return stations.listStations(ctx.paths, ctx.config());
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
  route('POST', '/api/agents/:id/close', async ({ params, body }) => {
    await agents.close(agentOf(params.id).id, str(body.actor, 'actor'));
    return { ok: true };
  });
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
    return mergeTask(task, task?.branch ?? wanted, board.HUMAN, !!body.force);
  });

  /** Merges a task's reviewed commit into the base branch; `push` also pushes the base branch to origin (when there is one). */
  const mergeTask = async (task: Task | undefined, branch: string, actor: string, force: boolean, push = false) => {
    const s = state();
    const base = ctx.config().baseBranch;
    // Merge exactly the commit the Captain reviewed; a branch that moved since needs a new review.
    let ref = branch;
    if (task?.reviewedSha && !force) {
      const head = await gitOps.revParse(ctx.paths.root, branch);
      if (head && head !== task.reviewedSha) {
        const mover = mutate(() => tasks.reviewAgain(s, task, head));
        throw conflict(`Not merged: ${mover} changed ${task.id} after the Captain's review. It's back with the Captain for a re-review and will show under Needs you again when it's ready.`);
      }
      ref = task.reviewedSha;
    }
    let output = await gitOps.mergeToBase(ctx.paths.root, base, ref, `Merge ${branch}${task ? ` (${task.id} ${task.title})` : ''}`);
    mutate(() => (task ? tasks.markMerged(s, task, actor) : board.feedEvent(s, actor, `merged ${branch}`)));
    let pushed: boolean | undefined;
    if (push && (await originUrl())) {
      const r = await gitOps.git(ctx.paths.root, ['push', 'origin', base], true);
      pushed = r.code === 0;
      output += `
${pushed ? `Pushed ${base} to origin.` : `Push to origin failed: ${(r.stderr || r.stdout).trim()}`}`;
      mutate(() => board.feedEvent(s, actor, pushed ? `pushed ${base} to origin` : `could not push ${base} to origin`));
    }
    return { ok: true, output, ...(pushed !== undefined ? { pushed } : {}) };
  };
  // You're happy with the Captain's review: it may merge the task (merge_task) and push.
  route('POST', '/api/tasks/:id/approve-merge', ({ params, body }) => {
    if (body.actor !== board.HUMAN) throw forbidden('Only you can approve a merge');
    const task = mutate(() => tasks.approveMerge(state(), params.id, board.HUMAN));
    ctx.toast('info', `Approved ${task.id}: the Captain will merge it`);
    return task;
  });
  // The Captain merges a task you approved (exactly the commit it reviewed, the one you approved), then pushes.
  route('POST', '/api/tasks/:id/merge', async ({ params, body }) => {
    const actor = str(body.actor, 'actor');
    if (!board.isCaptain(state(), actor)) throw forbidden('Only the Captain merges through this route');
    const task = tasks.requireTask(state(), params.id);
    if (task.status !== 'ready_for_merge') throw conflict(`${task.id} is ${task.status}, not ready for merge`);
    if (!task.mergeApproval) throw forbidden(`The user has not approved ${task.id} yet. Wait for their approval; never merge without it.`);
    if (task.mergeApproval.sha !== task.reviewedSha) throw conflict(`${task.id} was reviewed again after the user approved it; it needs their approval again.`);
    if (!task.branch) throw conflict(`${task.id} has no branch`);
    return mergeTask(task, task.branch, actor, false, true);
  });

  // ------------------------------------------------------------------ project / GitHub
  const gh = ctx.ghRunner ?? realGh;
  const originUrl = async (): Promise<string | undefined> => (await gitOps.git(ctx.paths.root, ['remote', 'get-url', 'origin'], true)).stdout.trim() || undefined;
  route('GET', '/api/project', async () => {
    const remoteUrl = await originUrl();
    return { name: ctx.config().projectName ?? '', root: ctx.paths.root, ...(remoteUrl ? { remoteUrl } : {}), gh: await ghStatus(gh, ctx.paths.root) };
  });
  route('POST', '/api/project/github', async ({ body }) => {
    const name = str(body.name, 'name').trim();
    if (!validRepoName(name)) throw badRequest('Repository name may only use letters, digits, ".", "_" and "-" (optionally owner/name)');
    if (body.description !== undefined && typeof body.description !== 'string') throw badRequest('description must be a string');
    if (body.private !== undefined && typeof body.private !== 'boolean') throw badRequest('private must be true or false');
    if (await originUrl()) throw conflict('This project already has an "origin" remote');
    const status = await ghStatus(gh, ctx.paths.root);
    if (!status.installed) throw new HttpError(424, 'The GitHub CLI (gh) is not installed. Install it from https://cli.github.com, then run `gh auth login`.');
    if (!status.authed) throw new HttpError(424, 'The GitHub CLI is not signed in. Run `gh auth login`.');
    const args = ['repo', 'create', name, body.private === false ? '--public' : '--private', '--source', ctx.paths.root, '--remote', 'origin', '--push'];
    if (typeof body.description === 'string' && body.description.trim()) args.push('--description', body.description.trim());
    const r = await gh(args, ctx.paths.root);
    if (r.code !== 0) throw new HttpError(502, `gh repo create failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
    const url = (await originUrl()) ?? r.stdout.trim().split(/\s+/).find((w) => /^https?:\/\//.test(w)) ?? '';
    if (!readPartial(ctx.paths).projectName) ctx.updateConfig({ projectName: name.split('/').pop()! });
    return { url };
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
  /** What the worker of the task's current station is told: guideline, skills and (at the last working station) evidence. */
  route('GET', '/api/tasks/:id/brief', ({ params }) => ({ text: stations.stationBrief(ctx.paths, tasks.requireTask(state(), params.id), stations.stationRoles(ctx.paths)) }));

  // ------------------------------------------------------------------ evidence
  route('POST', '/api/tasks/:id/evidence', async ({ params, body }) => {
    const task = tasks.requireTask(state(), params.id);
    const actor = str(body.actor, 'actor');
    const agent = board.findAgent(state(), actor);
    if (agent && agent.role !== 'captain' && task.assignee !== agent.id && task.branch !== agent.branch) {
      throw forbidden(`${actor} doesn't hold ${task.id}; only its current worker or the Captain attaches evidence`);
    }
    const files = body.files === undefined ? [] : body.files;
    if (!Array.isArray(files) || files.some((f: unknown) => typeof f !== 'string')) throw badRequest('files must be a list of paths in your worktree');
    if (body.text !== undefined && typeof body.text !== 'string') throw badRequest('text must be a string');
    if (typeof body.text === 'string' && body.text.length > MAX_EVIDENCE_TEXT) throw badRequest(`text is longer than ${MAX_EVIDENCE_TEXT} characters; save it to a file and attach that`);
    const worktree = agent?.worktree ?? ctx.paths.root;
    const record = evidence.attachEvidence(ctx.paths, {
      task,
      worktree,
      files,
      text: body.text,
      summary: str(body.summary, 'summary'),
      station: tasks.currentStation(task),
      by: actor,
      sha: await gitOps.revParse(worktree, 'HEAD'),
      at: board.nowIso(),
    });
    mutate(() => {
      const t = tasks.requireTask(state(), params.id);
      t.evidence = [...(t.evidence ?? []), record];
      t.updatedAt = record.at;
      board.feedEvent(state(), actor, `attached evidence ${record.id} to ${t.id} (${record.files.length} file${record.files.length === 1 ? '' : 's'}): ${record.summary.split('\n')[0].slice(0, 120)}`);
    });
    return record;
  });
  route('GET', '/api/tasks/:id/evidence/:entry/:file', ({ params }) => {
    const path = evidence.evidencePath(ctx.paths, tasks.requireTask(state(), params.id), params.entry, params.file);
    return new FileReply(path, evidence.contentType(params.file));
  });
  route('POST', '/api/tasks', async ({ body }) => {
    if (body.assignee) await agents.assertCanTakeBranch(body.assignee);
    const task = mutate(() =>
      tasks.createTask(state(), ctx.config(), {
        title: str(body.title, 'title'),
        description: body.description,
        dependsOn: body.dependsOn,
        ...taskLine(body),
        assignee: body.assignee || undefined,
        goalId: body.goalId || undefined,
        actor: str(body.actor, 'actor'),
      }, stations.stationRoles(ctx.paths)),
    );
    announceApproval(task);
    if (task.assignee) await afterTake(board.findAgent(state(), task.assignee), task);
    attachGuideline(task.assignee, task, ['assignment']);
    return task;
  });
  route('POST', '/api/tasks/claim', async ({ body }) => {
    const claimer = board.findAgent(state(), body.actor);
    if (claimer) await agents.assertCanTakeBranch(claimer.id, tasks.nextClaimable(state(), claimer, stations.stationRoles(ctx.paths)));
    const task = mutate(() => tasks.claimTask(state(), str(body.actor, 'actor'), stations.stationRoles(ctx.paths)));
    if (task) await afterTake(board.findAgent(state(), body.actor), task);
    return task;
  });
  route('POST', '/api/tasks/:id/assign', async ({ params, body }) => {
    await agents.assertCanTakeBranch(body.agentId, tasks.requireTask(state(), params.id));
    const task = mutate(() => tasks.assignTask(state(), params.id, str(body.agentId, 'agentId'), str(body.actor, 'actor')));
    await afterTake(board.findAgent(state(), body.agentId), task);
    attachGuideline(task.assignee, task, ['assignment']);
    return task;
  });
  route('POST', '/api/tasks/:id/handoff', async ({ params, body }) => {
    const current = tasks.requireTask(state(), params.id);
    const from = await agents.stationBranch(current); // 409 unless it contains the earlier stations' work
    if (body.to) await agents.assertCanTakeBranch(body.to, current);
    const r = mutate(() => tasks.handoffTask(state(), params.id, str(body.actor, 'actor'), body.to || undefined, body.note ?? '', from, stations.stationRoles(ctx.paths)));
    announceApproval(r.task);
    if (r.receiver) await afterTake(r.receiver, r.task);
    attachGuideline(r.task.assignee, r.task, ['handoff', 'review']);
    return r.task;
  });
  route('POST', '/api/tasks/:id/done', async ({ params, body }) => {
    const from = await agents.stationBranch(tasks.requireTask(state(), params.id));
    const done = mutate(() => tasks.doneTask(state(), params.id, str(body.actor, 'actor'), body.summary ?? '', from, stations.stationRoles(ctx.paths)));
    announceApproval(done);
    attachGuideline(done.assignee, done, ['review', 'handoff']);
    return done;
  });
  route('POST', '/api/tasks/:id/review', async ({ params, body }) => {
    const reviewed = await agents.stationBranch(tasks.requireTask(state(), params.id)); // records the commit the merge will take
    const { task, note } = mutate(() =>
      tasks.requestReview(state(), params.id, str(body.actor, 'actor'), body.summary ?? '', reviewed, { requireEvidence: ctx.config().requireEvidence }),
    );
    await agents.syncDependents(task.id);
    store.commit();
    ctx.notify('Muster: ready for review', note.text);
    ctx.toast('info', note.text);
    return task;
  });
  route('POST', '/api/tasks/:id/cancel', ({ params, body }) =>
    mutate(() => tasks.cancelTask(state(), params.id, str(body.actor, 'actor'), body.reason ?? '')),
  );
  route('POST', '/api/tasks/:id/approve', async ({ params, body }) => {
    const task = mutate(() => tasks.approveTask(state(), params.id, str(body.actor, 'actor'), body.note ?? '', stations.stationRoles(ctx.paths)));
    announceApproval(task);
    attachGuideline(task.assignee, task, ['handoff', 'review']);
    return task;
  });
  route('POST', '/api/tasks/:id/reject', async ({ params, body }) => {
    const roles = stations.stationRoles(ctx.paths);
    const current = tasks.requireTask(state(), params.id);
    await agents.assertCanTakeBranch(tasks.rejectTarget(state(), current, roles)?.id, current);
    const task = mutate(() => tasks.rejectTask(state(), params.id, str(body.actor, 'actor'), body.note ?? '', roles));
    if (task.assignee) await afterTake(board.findAgent(state(), task.assignee), task);
    announceApproval(task);
    attachGuideline(task.assignee, task, ['handoff']);
    return task;
  });
  route('POST', '/api/tasks/:id/sendback', async ({ params, body }) => {
    const current = tasks.requireTask(state(), params.id);
    await agents.assertCanTakeBranch(tasks.builderOf(state(), current)?.id, current);
    const task = mutate(() => tasks.sendBack(state(), params.id, str(body.actor, 'actor'), body.note ?? ''));
    if (task.assignee) await afterTake(board.findAgent(state(), task.assignee), task);
    attachGuideline(task.assignee, task, ['handoff']);
    return task;
  });

  // ------------------------------------------------------------------ roadmap (core/roadmap.ts)
  const roadmapReply = () => ({ roadmap: state().roadmap ?? null, progress: roadmap.computeProgress(state(), roadmap.localDate()) });
  /** A draft waiting for you: toast, and notify when the approval note is new (re-saving a draft only updates it). */
  const announceRoadmap = (c: roadmap.RoadmapChange) => {
    if (!c.note) return;
    if (c.noteOpened) ctx.notify('Muster: roadmap needs your approval', c.note.text);
    ctx.toast('info', c.noteOpened ? c.note.text : `Roadmap draft updated: ${c.roadmap.title}`);
  };
  const roadmapWrite = (fn: () => roadmap.RoadmapChange) => {
    announceRoadmap(mutate(fn));
    return roadmapReply();
  };
  route('GET', '/api/roadmap', roadmapReply);
  route('PUT', '/api/roadmap', ({ body }) =>
    roadmapWrite(() => roadmap.setRoadmap(state(), { title: body.title, summary: body.summary, launchDate: body.launchDate, stages: body.stages }, str(body.actor, 'actor'))),
  );
  route('POST', '/api/roadmap/approve', ({ body }) => {
    const r = mutate(() => roadmap.approveRoadmap(state(), str(body.actor, 'actor')));
    ctx.toast('info', `Roadmap approved (revision ${r.revision})`);
    return roadmapReply();
  });
  route('POST', '/api/roadmap/reject', ({ body }) => {
    mutate(() => roadmap.rejectRoadmap(state(), str(body.actor, 'actor'), body.note));
    return roadmapReply();
  });
  route('PATCH', '/api/roadmap/stages/:id', ({ params, body }) => {
    const before = state().roadmap?.stages.find((s) => s.id === params.id.toUpperCase())?.status;
    const c = mutate(() => roadmap.patchStage(state(), params.id, body, str(body.actor, 'actor')));
    announceRoadmap(c);
    if (before !== 'done' && c.stage.status === 'done') ctx.toast('info', `Stage ${c.stage.id} ${c.stage.title} complete`);
    return roadmapReply();
  });
  route('POST', '/api/roadmap/stages/:id/criteria/:index', ({ params, body }) => {
    if (!/^\d+$/.test(params.index)) throw badRequest('index must be a whole number from 0');
    mutate(() => roadmap.tickCriterion(state(), params.id, Number(params.index), body.done, str(body.actor, 'actor')));
    return roadmapReply();
  });
  route('POST', '/api/roadmap/stages/:id/complete', ({ params, body }) => {
    const { stage, next } = mutate(() => roadmap.completeStage(state(), params.id, str(body.actor, 'actor'), body.force === true));
    ctx.toast('info', `Stage ${stage.id} ${stage.title} complete${next ? `; ${next.id} ${next.title} is next` : '; the roadmap is done'}`);
    return roadmapReply();
  });
  route('POST', '/api/roadmap/goals', ({ body }) => {
    const c = mutate(() => roadmap.addGoal(state(), { stageId: body.stageId, title: body.title, description: body.description, start: body.start, due: body.due }, str(body.actor, 'actor')));
    announceRoadmap(c);
    return { ...roadmapReply(), goal: c.goal };
  });
  route('PATCH', '/api/roadmap/goals/:id', ({ params, body }) => roadmapWrite(() => roadmap.patchGoal(state(), params.id, body, str(body.actor, 'actor'))));
  route('POST', '/api/roadmap/goals/:id/tasks', ({ params, body }) => {
    const r = mutate(() => roadmap.linkTasks(state(), params.id, body.taskIds, str(body.actor, 'actor'), body.unlink === true));
    return { ...roadmapReply(), goal: r.goal, linked: r.linked };
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
      if (!caller.human) agents.touch(caller.actor);
      const result = await r.handler({ params, query: url.searchParams, body });
      if (result instanceof FileReply) return sendFile(res, result);
      sendJson(res, 200, result ?? null);
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

function sendFile(res: ServerResponse, f: FileReply): void {
  res.writeHead(200, {
    'content-type': f.contentType,
    'content-length': String(statSync(f.path).size),
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
    // Text files (an agent's .html report included) are sent as text/plain; this keeps anything else inert too.
    'content-security-policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
  });
  createReadStream(f.path).pipe(res);
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) return;
  const text = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}
