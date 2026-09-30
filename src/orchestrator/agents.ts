// AgentManager: agent records, their claude processes in PTYs, status from hook events, and inbox nudges.
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, writeFileSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { Agent, AgentStatus, MusterConfig, Role, Task } from '../types.js';
import { captainOf, closeNoteIfOpen, feedEvent, findAgent, HUMAN, inboxFor, isCaptain, nowIso, nudgeText, postNote, requireAgent, SYSTEM, addInbox } from '../core/board.js';
import { launchArgs, modelFor, ptyEnv, rolePrompt, spawnCommand, trustPromptKeys, writeAgentFiles, type LaunchOptions } from '../core/claude.js';
import { badRequest, conflict, forbidden } from '../core/errors.js';
import * as gitOps from '../core/git.js';
import type { MusterPaths } from '../core/paths.js';
import type { Store } from '../core/store.js';
import { assignTask, hasReportedDone, requireTask } from '../core/tasks.js';
import { assertNotPaused } from '../core/usage.js';
import { lastLines, RingBuffer, stripAnsi, type PtyLauncher, type PtyProcess } from './terminal.js';

export interface Timings {
  enterDelayMs: number; // between typing text and pressing Enter
  firstPromptDelayMs: number; // after SessionStart before typing the first prompt
  firstPromptFallbackMs: number; // type the first prompt anyway if SessionStart never arrives
  idleShutdownMs: number;
  nudgeDebounceMs: number;
}

export const DEFAULT_TIMINGS: Timings = {
  enterDelayMs: 120,
  firstPromptDelayMs: 1500,
  firstPromptFallbackMs: 45_000,
  idleShutdownMs: 5 * 60_000,
  nudgeDebounceMs: 300,
};

export interface AgentManagerOptions {
  store: Store;
  paths: MusterPaths;
  config: () => MusterConfig;
  server: () => { url: string; token: string };
  launcher: PtyLauncher;
  claudePath: () => string;
  log?: (msg: string) => void;
  timings?: Partial<Timings>;
}

interface Runtime {
  pty: PtyProcess;
  buffer: RingBuffer;
  startOutput: string; // first few KB of this launch, for first-run dialogs and launch errors
  listeners: Set<(data: string) => void>;
  logFile: WriteStream;
  spawnedAt: number;
  launch: LaunchOptions;
  stopping: boolean;
  exited: Promise<void>;
  trustAnswered: boolean;
  firstPrompt?: string;
  firstPromptTimer?: NodeJS.Timeout;
  permissionNoteId?: string;
  idleSince?: number;
  nudgedAt?: number;
  typing: Promise<void>;
}

const RESTING: AgentStatus[] = ['idle', 'done', 'stuck', 'waiting'];
const QUICK_EXIT_MS = 20_000;
const START_OUTPUT_MAX = 64 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CreateAgentInput {
  name?: string;
  role?: Role;
  taskId?: string;
  actor: string;
}

export class AgentManager {
  private runtimes = new Map<string, Runtime>();
  private buffers = new Map<string, RingBuffer>(); // outlive the process so a crashed agent's last output stays readable
  private timings: Timings;
  private nudgeTimer?: NodeJS.Timeout;
  private idleTimer: NodeJS.Timeout;
  private inlinePrompt = false; // set if this claude build rejects --append-system-prompt-file
  private log: (msg: string) => void;

  constructor(private o: AgentManagerOptions) {
    this.timings = { ...DEFAULT_TIMINGS, ...o.timings };
    this.log = o.log ?? (() => {});
    o.store.on('change', () => this.scheduleNudges());
    this.idleTimer = setInterval(() => this.shutdownIdleCrew(), Math.min(30_000, this.timings.idleShutdownMs)).unref();
  }

  private get state() {
    return this.o.store.state;
  }

  isRunning(id: string): boolean {
    return this.runtimes.has(id);
  }

  // ---------------------------------------------------------------- lifecycle

  async create(input: CreateAgentInput): Promise<Agent> {
    const { state } = this;
    const config = this.o.config();
    const role = input.role ?? 'crew';
    const internal = input.actor === SYSTEM;
    if (!['captain', 'crew', 'design'].includes(role)) throw badRequest(`Unknown role "${role}"`);
    if (!internal && input.actor !== HUMAN && !isCaptain(state, input.actor)) throw forbidden('Only the Captain or you can add agents');
    if (!internal) assertNotPaused(state);
    if (role === 'captain' && captainOf(state)) throw conflict(`${captainOf(state)!.id} is already the Captain; change roles instead`);
    if (role === 'design' && state.agents.some((a) => a.role === 'design')) throw conflict('There is already a design crew agent');
    if (role === 'crew') {
      const running = state.agents.filter((a) => a.role === 'crew' && a.status !== 'stopped').length;
      if (running >= config.maxCrew) throw conflict(`Crew limit reached (${running}/${config.maxCrew} running). Stop one or raise maxCrew.`);
    }
    if (input.taskId) requireTask(state, input.taskId);
    const id = this.newId(role, input.name);

    let worktree = this.o.paths.root;
    let branch = config.baseBranch;
    if (role !== 'captain') {
      worktree = this.o.paths.worktree(id);
      branch = await gitOps.addWorktree(this.o.paths.root, worktree, `${id}/work`, config.baseBranch);
    }
    const at = nowIso();
    const agent: Agent = { id, role, model: modelFor(role, config), branch, worktree, status: 'starting', sessionId: randomUUID(), startedAt: at, lastActivityAt: at, costUsd: 0 };
    state.agents.push(agent);
    feedEvent(state, input.actor, `added ${id} (${role}) on ${branch}`);
    if (input.taskId) {
      const task = assignTask(state, input.taskId, id, internal ? HUMAN : input.actor);
      await this.syncTaskBranch(agent, task);
    }
    this.o.store.commit();
    this.start(id);
    return agent;
  }

  private newId(role: Role, name?: string): string {
    const taken = (id: string) => this.state.agents.some((a) => a.id.toLowerCase() === id.toLowerCase()) || id === HUMAN || id === SYSTEM || id === 'everyone';
    if (name) {
      if (!ID_PATTERN.test(name)) throw badRequest('Agent names use letters, digits, - and _ only');
      if (taken(name)) throw conflict(`An agent called "${name}" already exists`);
      return name;
    }
    if (role !== 'crew') {
      for (let i = 1; ; i++) if (!taken(i === 1 ? role : `${role}-${i}`)) return i === 1 ? role : `${role}-${i}`;
    }
    let id: string;
    do id = `crew-${this.state.nextIds.agent++}`;
    while (taken(id));
    return id;
  }

  /** Starts claude for an existing agent. Resumes its session when it has one. */
  start(id: string): Agent {
    const agent = requireAgent(this.state, id);
    if (this.runtimes.has(id)) return agent;
    const resume = existsSync(this.resumableMarker(id));
    this.spawn(agent, { resume, inlinePrompt: this.inlinePrompt ? '' : undefined }, resume ? undefined : this.firstPromptFor(agent));
    return agent;
  }

  private resumableMarker(id: string): string {
    return join(this.o.paths.agentDir(id), 'resumable');
  }

  private firstPromptFor(agent: Agent): string | undefined {
    if (agent.taskId) {
      const task = this.state.tasks.find((t) => t.id === agent.taskId);
      return `[muster] You are ${agent.id} (${agent.role}). Your task: ${agent.taskId} ${task?.title ?? ''}. Call read_inbox and claim/confirm it, then start.`;
    }
    if (agent.role === 'crew') return `[muster] You are ${agent.id}, crew. Call claim_task to pick up work.`;
    if (agent.role === 'design') return `[muster] You are ${agent.id}, the Vellum design crew. Call read_board, then claim_task to pick up design checks.`;
    return undefined;
  }

  private spawn(agent: Agent, launch: LaunchOptions, firstPrompt?: string): void {
    const config = this.o.config();
    const ctx = { ...this.o.server(), repoRoot: this.o.paths.root, config };
    const files = writeAgentFiles(this.o.paths, agent, ctx);
    if (launch.inlinePrompt !== undefined) launch = { ...launch, inlinePrompt: rolePrompt(agent, ctx) };
    const cmd = spawnCommand(this.o.claudePath(), launchArgs(agent, config, files, launch));
    const env = ptyEnv(agent, ctx);
    this.log(`start ${agent.id}: ${cmd.file} ${cmd.args.map((a) => (a.length > 80 ? a.slice(0, 77) + '...' : a)).join(' ')}`);
    const p = this.o.launcher(cmd.file, cmd.args, { cwd: agent.worktree, env, cols: 120, rows: 32 });
    let onExit!: () => void;
    const rt: Runtime = {
      pty: p,
      buffer: this.buffers.get(agent.id) ?? this.buffers.set(agent.id, new RingBuffer()).get(agent.id)!,
      startOutput: '',
      listeners: new Set(),
      logFile: createWriteStream(this.o.paths.agentLog(agent.id), { flags: 'a' }),
      spawnedAt: Date.now(),
      launch,
      stopping: false,
      exited: new Promise<void>((r) => (onExit = r)),
      trustAnswered: false,
      firstPrompt,
      typing: Promise.resolve(),
    };
    this.runtimes.set(agent.id, rt);
    if (firstPrompt) rt.firstPromptTimer = setTimeout(() => this.typeFirstPrompt(agent.id), this.timings.firstPromptFallbackMs);

    p.onData((data) => this.onOutput(agent.id, rt, data));
    p.onExit(({ exitCode }) => {
      onExit();
      this.onExit(agent.id, rt, exitCode);
    });
    agent.pid = p.pid;
    agent.status = 'starting';
    agent.lastActivityAt = nowIso();
    feedEvent(this.state, SYSTEM, `${agent.id} started${launch.resume ? ' (resumed)' : ''}`);
    this.o.store.commit();
  }

  private onOutput(id: string, rt: Runtime, data: string): void {
    rt.buffer.push(data);
    if (rt.startOutput.length < START_OUTPUT_MAX) rt.startOutput += data;
    rt.logFile.write(data);
    for (const l of rt.listeners) l(data);
    const agent = findAgent(this.state, id);
    if (agent) agent.lastActivityAt = nowIso();
    if (rt.trustAnswered || rt.startOutput.length >= START_OUTPUT_MAX || Date.now() - rt.spawnedAt > 120_000) return;
    const keys = trustPromptKeys(stripAnsi(rt.startOutput));
    if (!keys) return;
    rt.trustAnswered = true;
    this.log(`${id}: accepting the folder-trust prompt`);
    // Arrow keys first, then Enter on its own so the menu has registered the move.
    const moves = keys.slice(0, -1);
    setTimeout(() => {
      if (moves) rt.pty.write(moves);
      setTimeout(() => rt.pty.write('\r'), 150);
    }, 200);
  }

  private onExit(id: string, rt: Runtime, exitCode: number): void {
    rt.logFile.end();
    clearTimeout(rt.firstPromptTimer);
    if (this.runtimes.get(id) !== rt) return;
    this.runtimes.delete(id);
    const agent = findAgent(this.state, id);
    if (!agent) return;
    this.log(`${id} exited with code ${exitCode}`);

    if (rt.stopping) return; // stop() records the status

    // Launch problems show up as an immediate exit with an error message; retry once with the fix.
    const quick = Date.now() - rt.spawnedAt < QUICK_EXIT_MS;
    const out = stripAnsi(rt.startOutput);
    if (quick && rt.launch.inlinePrompt === undefined && /unknown option.*append-system-prompt-file/i.test(out)) {
      this.inlinePrompt = true;
      this.log(`${id}: --append-system-prompt-file rejected, retrying with --append-system-prompt`);
      return this.spawn(agent, { ...rt.launch, inlinePrompt: '' }, rt.firstPrompt);
    }
    if (quick && rt.launch.resume && /no conversation found|session.*not found/i.test(out)) {
      this.log(`${id}: session ${agent.sessionId} not resumable, starting a new one`);
      agent.sessionId = randomUUID();
      return this.spawn(agent, { ...rt.launch, resume: false }, this.firstPromptFor(agent));
    }

    agent.status = 'stopped';
    agent.pid = undefined;
    feedEvent(this.state, SYSTEM, `${id} exited (code ${exitCode})`);
    this.o.store.commit();
  }

  async stop(id: string, reason?: string): Promise<Agent> {
    const agent = requireAgent(this.state, id);
    const rt = this.runtimes.get(id);
    if (rt) {
      rt.stopping = true;
      rt.pty.kill();
      await Promise.race([rt.exited, sleep(5000)]);
      this.runtimes.delete(id);
      rt.logFile.end();
    }
    if (agent.status !== 'stopped') {
      agent.status = 'stopped';
      agent.pid = undefined;
      feedEvent(this.state, SYSTEM, reason ? `${id} stopped: ${reason}` : `${id} stopped`);
      this.o.store.commit();
    }
    return agent;
  }

  async restart(id: string): Promise<Agent> {
    await this.stop(id);
    return this.start(id);
  }

  /** Orchestrator shutdown: stops every PTY but keeps each agent's status, so the next start resumes the ones that were running. */
  async stopAll(): Promise<void> {
    const running = [...this.runtimes.keys()].map((id) => ({ id, status: requireAgent(this.state, id).status }));
    await Promise.all(running.map(({ id }) => this.stop(id)));
    for (const { id, status } of running) {
      const agent = findAgent(this.state, id);
      if (agent) agent.status = status;
    }
  }

  /** On orchestrator startup: resume agents that were running, and make sure there is a Captain. */
  async resumeAll(): Promise<void> {
    for (const a of this.state.agents) if (a.status !== 'stopped') this.start(a.id);
    if (!captainOf(this.state)) await this.create({ role: 'captain', actor: SYSTEM });
  }

  async remove(id: string, removeWorktree: boolean): Promise<void> {
    const agent = await this.stop(id);
    const { state } = this;
    for (const t of state.tasks) {
      if (t.assignee !== id || t.status !== 'in_progress') continue;
      t.assignee = undefined;
      t.status = 'ready';
    }
    state.agents = state.agents.filter((a) => a.id !== id);
    this.buffers.delete(id);
    if (removeWorktree && agent.worktree !== this.o.paths.root) await gitOps.removeWorktree(this.o.paths.root, agent.worktree);
    feedEvent(state, HUMAN, `removed ${id}`);
    this.o.store.commit();
  }

  /** Changes an agent's role and restarts its claude (same session). A new Captain demotes the old one to crew. */
  async setRole(id: string, role: Role, actor: string): Promise<Agent> {
    const { state } = this;
    const agent = requireAgent(state, id);
    if (!['captain', 'crew', 'design'].includes(role)) throw badRequest(`Unknown role "${role}"`);
    if (agent.role === role) return agent;
    if (role === 'design' && state.agents.some((a) => a.role === 'design' && a.id !== id)) throw conflict('There is already a design crew agent');
    const config = this.o.config();

    const previous = role === 'captain' ? captainOf(state) : undefined;
    if (previous) await this.applyRole(previous, 'crew', config);
    await this.applyRole(agent, role, config);
    feedEvent(state, actor, `set ${id} as ${role}${previous ? ` (${previous.id} is now crew)` : ''}`);
    this.o.store.commit();
    return agent;
  }

  private async applyRole(agent: Agent, role: Role, config: MusterConfig): Promise<void> {
    const wasRunning = this.runtimes.has(agent.id);
    if (wasRunning) await this.stop(agent.id);
    if (role === 'captain') {
      agent.worktree = this.o.paths.root;
      agent.branch = config.baseBranch;
    } else if (agent.role === 'captain') {
      agent.worktree = this.o.paths.worktree(agent.id);
      agent.branch = await gitOps.addWorktree(this.o.paths.root, agent.worktree, `${agent.id}/work`, config.baseBranch);
    }
    agent.role = role;
    agent.model = modelFor(role, config);
    if (wasRunning) this.start(agent.id);
  }

  // ---------------------------------------------------------------- tasks and branches

  /**
   * Called when an agent takes a task: a fresh `<id>/work` branch is renamed after the task,
   * and the branch that carried the work so far is merged into the agent's worktree.
   */
  async syncTaskBranch(agent: Agent, task: Task): Promise<void> {
    if (agent.role === 'captain') return;
    const config = this.o.config();
    const root = this.o.paths.root;
    if (agent.branch === `${agent.id}/work` && (await gitOps.commitsAhead(root, config.baseBranch, agent.branch)) === 0) {
      const renamed = await gitOps.renameBranch(agent.worktree, agent.branch, `${agent.id}/${gitOps.slug(task.title)}`);
      if (task.branch === agent.branch) task.branch = renamed;
      agent.branch = renamed;
    }
    if (task.branch && task.branch !== agent.branch && (await gitOps.branchExists(root, task.branch))) {
      const r = await gitOps.mergeInto(agent.worktree, task.branch);
      const text = r.ok
        ? `Merged ${task.branch} into your branch ${agent.branch} for ${task.id}.`
        : `Could not merge ${task.branch} into ${agent.branch} automatically (conflicts: ${r.conflicts.join(', ') || 'unknown'}). Run \`git merge ${task.branch}\` and resolve them.`;
      addInbox(this.state, { agentId: agent.id, from: SYSTEM, kind: 'system', taskId: task.id, text });
    }
    task.branch = agent.branch;
  }

  // ---------------------------------------------------------------- terminal I/O

  /** Types into the agent's terminal: newlines collapsed, then Enter after a short delay so the TUI sees a submit. */
  type(id: string, text: string, submit = true): Promise<void> {
    const rt = this.requireRuntime(id);
    const line = text.replace(/[\r\n]+/g, ' ');
    rt.typing = rt.typing.then(async () => {
      if (line) rt.pty.write(line);
      if (submit) {
        await sleep(this.timings.enterDelayMs);
        rt.pty.write('\r');
      }
    });
    return rt.typing;
  }

  write(id: string, data: string): void {
    this.runtimes.get(id)?.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.runtimes.get(id)?.pty.resize(Math.floor(cols), Math.floor(rows));
  }

  backlog(id: string): string {
    return this.buffers.get(id)?.text() ?? '';
  }

  output(id: string, lines = 80): string {
    requireAgent(this.state, id);
    return lastLines(this.backlog(id), lines);
  }

  /** Subscribes to live output; returns an unsubscribe function. */
  attach(id: string, listener: (data: string) => void): () => void {
    const rt = this.runtimes.get(id);
    rt?.listeners.add(listener);
    return () => rt?.listeners.delete(listener);
  }

  private requireRuntime(id: string): Runtime {
    requireAgent(this.state, id);
    const rt = this.runtimes.get(id);
    if (!rt) throw conflict(`${id} is not running`);
    return rt;
  }

  private typeFirstPrompt(id: string): void {
    const rt = this.runtimes.get(id);
    if (!rt?.firstPrompt) return;
    const text = rt.firstPrompt;
    rt.firstPrompt = undefined;
    clearTimeout(rt.firstPromptTimer);
    void this.type(id, text).catch(() => {});
  }

  // ---------------------------------------------------------------- hook events

  handleEvent(id: string, event: string, detail = '', kind?: string): void {
    const agent = requireAgent(this.state, id);
    const rt = this.runtimes.get(id);
    agent.lastActivityAt = nowIso();
    switch (event) {
      case 'session-start':
        if (agent.status === 'starting') this.setResting(agent, rt);
        if (rt?.firstPrompt) setTimeout(() => this.typeFirstPrompt(id), this.timings.firstPromptDelayMs);
        break;
      case 'prompt':
        this.clearPermissionWait(agent, rt);
        agent.status = 'working';
        if (rt) rt.nudgedAt = undefined;
        writeFileSync(this.resumableMarker(id), agent.sessionId);
        break;
      case 'stop':
        this.clearPermissionWait(agent, rt);
        this.setResting(agent, rt);
        break;
      case 'notification':
      case 'permission':
        if (event === 'permission' || kind === 'permission_prompt' || /permission/i.test(detail)) this.permissionWait(agent, rt, detail);
        break;
      default:
        throw badRequest(`Unknown event "${event}"`);
    }
    this.o.store.commit();
  }

  private setResting(agent: Agent, rt: Runtime | undefined): void {
    const open = (type: string) => this.state.notes.some((n) => n.open && n.from === agent.id && n.type === type);
    agent.status = open('stuck') ? 'stuck' : open('waiting') ? 'waiting' : hasReportedDone(this.state, agent) ? 'done' : 'idle';
    if (rt) {
      rt.idleSince = Date.now();
      rt.nudgedAt = undefined;
    }
  }

  private permissionWait(agent: Agent, rt: Runtime | undefined, detail: string): void {
    agent.status = 'stuck';
    if (!rt || rt.permissionNoteId) return;
    rt.permissionNoteId = postNote(this.state, { actor: agent.id, type: 'stuck', text: `Waiting for permission: ${detail || 'a tool call needs approval'}` }).id;
  }

  private clearPermissionWait(agent: Agent, rt: Runtime | undefined): void {
    if (!rt?.permissionNoteId) return;
    const note = this.state.notes.find((n) => n.id === rt.permissionNoteId);
    if (note) closeNoteIfOpen(note);
    rt.permissionNoteId = undefined;
  }

  // ---------------------------------------------------------------- nudges and idle shutdown

  private scheduleNudges(): void {
    if (this.nudgeTimer) return;
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = undefined;
      this.deliverNudges();
    }, this.timings.nudgeDebounceMs);
    this.nudgeTimer.unref();
  }

  /** Types one "[muster] You have N new items" line into each resting agent that has undelivered inbox items. */
  deliverNudges(): void {
    let changed = false;
    for (const agent of this.state.agents) {
      const rt = this.runtimes.get(agent.id);
      if (!rt || !RESTING.includes(agent.status) || rt.firstPrompt || rt.permissionNoteId) continue;
      if (rt.nudgedAt && Date.now() - rt.nudgedAt < 60_000) continue; // wait for the prompt hook before nudging again
      const items = inboxFor(this.state, agent.id, true).filter((i) => !i.delivered);
      if (!items.length) continue;
      for (const i of items) i.delivered = true;
      rt.nudgedAt = Date.now();
      changed = true;
      void this.type(agent.id, nudgeText(items)).catch(() => {});
    }
    if (changed) this.o.store.save();
  }

  private shutdownIdleCrew(): void {
    if (!this.o.config().shutdownIdleCrew) return;
    for (const agent of this.state.agents) {
      const rt = this.runtimes.get(agent.id);
      if (!rt || agent.role !== 'crew' || agent.taskId || (agent.status !== 'idle' && agent.status !== 'done')) continue;
      if (!rt.idleSince || Date.now() - rt.idleSince < this.timings.idleShutdownMs) continue;
      if (inboxFor(this.state, agent.id, true).length) continue;
      void this.stop(agent.id, 'idle with no task');
    }
  }

  dispose(): void {
    clearInterval(this.idleTimer);
    clearTimeout(this.nudgeTimer);
  }
}
