// AgentManager: agent records, their claude processes in PTYs, status from hook events, and inbox nudges.
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, writeFileSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { Agent, AgentStatus, IntelJob, MusterConfig, Role, Task } from '../types.js';
import { captainOf, closeNoteIfOpen, feedEvent, findAgent, HUMAN, inboxFor, isCaptain, noteFeedId, nowIso, nudgeText, postNote, requireAgent, SYSTEM, addInbox } from '../core/board.js';
import { launchArgs, modelFor, ptyEnv, rolePrompt, spawnCommand, trustPromptKeys, writeAgentFiles, type LaunchOptions } from '../core/claude.js';
import { EVIDENCE_DIR } from '../core/evidence.js';
import { badRequest, conflict, forbidden } from '../core/errors.js';
import * as gitOps from '../core/git.js';
import type { MusterPaths } from '../core/paths.js';
import { sanitizeTyped } from '../core/sanitize.js';
import type { Store } from '../core/store.js';
import { failRun, runningRun, SCOUT_ID } from '../core/research.js';
import { addInput, assignTask, hasReportedDone, MERGE_CONFLICT, requireTask, untake, type StationBranch } from '../core/tasks.js';
import { assertNotPaused } from '../core/usage.js';
import { lastLines, RingBuffer, stripAnsi, type PtyLauncher, type PtyProcess } from './terminal.js';

export interface Timings {
  enterDelayMs: number; // between typing text and pressing Enter
  firstPromptDelayMs: number; // after SessionStart before typing the first prompt
  firstPromptFallbackMs: number; // type the first prompt anyway if SessionStart never arrives
  idleShutdownMs: number;
  nudgeDebounceMs: number;
  quietMs: number; // terminal silence after which the watchdog reads the screen
  submitCheckMs: number; // after typing a line, how long to wait for the prompt hook before pressing Enter again
  nudgeConfirmMs: number; // a nudge counts as delivered once a prompt hook follows it; without one, nudge again after this (doubling, max 5 min)
  humanHoldMs: number; // no automated typing into a terminal for this long after a human keystroke there
  stopConfirmMs: number; // how long stop() waits for the process to be gone before killing it again
  watchdogIdleMs: number; // an agent holding work at an idle prompt this long gets a re-nudge
  watchdogStartingMs: number; // ... as does one still 'starting' this long after spawn
  watchdogEscalateMs: number; // still not active this long after the re-nudge: stuck note, Captain inbox item, toast
  scoutStopDelayMs: number; // after finish_research, let scout read the tool result before it is stopped
}

export const DEFAULT_TIMINGS: Timings = {
  enterDelayMs: 120,
  firstPromptDelayMs: 1500,
  firstPromptFallbackMs: 45_000,
  idleShutdownMs: 5 * 60_000,
  nudgeDebounceMs: 300,
  quietMs: 8000,
  submitCheckMs: 4000,
  nudgeConfirmMs: 20_000,
  humanHoldMs: 5000,
  stopConfirmMs: 5000,
  watchdogIdleMs: 5 * 60_000,
  watchdogStartingMs: 3 * 60_000,
  watchdogEscalateMs: 5 * 60_000,
  scoutStopDelayMs: 3000,
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
  /** Process liveness and kill, injectable for tests (defaults: process.kill(pid, 0) and taskkill /T /F). */
  isAlive?: (pid: number) => boolean;
  killPid?: (pid: number) => void;
  /** The watchdog gave up on an agent (after the stuck note): a place for a desktop toast. */
  onStuck?: (text: string) => void;
  /** Intel jobs scout runs besides research runs (src/core/intel.ts); the store lives outside MusterState. */
  intel?: ScoutIntel;
}

export interface ScoutIntel {
  /** The intel job scout is working on, if any. */
  runningJob(): IntelJob | undefined;
  /** scout exited or was stopped mid-job: fail the job (its findings stay). */
  onScoutExit(reason: string): void;
}

/** What scout is told when it starts (or is typed into) for an intel job. */
export const intelJobPrompt = (agentId: string, job: Pick<IntelJob, 'id' | 'kind'>) => `[muster] You are ${agentId} (research). Intel job ${job.id} (${job.kind}). Call intel_brief and start.`;

interface Runtime {
  pty: PtyProcess;
  buffer: RingBuffer;
  startOutput: string; // first few KB of this launch, for first-run dialogs and launch errors
  logFile: WriteStream;
  spawnedAt: number;
  launch: LaunchOptions;
  stopping: boolean;
  exited: Promise<void>;
  trustAnswered: boolean;
  firstPrompt?: string;
  firstPromptTimer?: NodeJS.Timeout;
  permissionNoteId?: string;
  /** Watchdog progress for the work the agent holds; cleared by any sign of life (prompt hook, new status). */
  wd?: { key: string; since: number; nudgedAt?: number; escalated: boolean; promptAt?: string };
  idleSince?: number;
  /** Inbox items typed in the last nudge; marked delivered only when a prompt hook follows. */
  pendingNudge?: { ids: string[]; at: number; attempt: number };
  lastOutputAt?: number;
  typing: Promise<void>;
  size: string; // 'COLSxROWS' last applied to the pty; identical resizes still make Claude repaint the whole screen
}

const RESTING: AgentStatus[] = ['idle', 'done', 'stuck', 'waiting'];
const QUICK_EXIT_MS = 20_000;
/** Crew names, handed out in order (config.crewNames 'numbers' keeps crew-2, crew-3, …). */
export const CREW_NAMES = [
  'ada', 'bea', 'cleo', 'dex', 'eli', 'faye', 'gus', 'iris', 'juno', 'kit', 'leo', 'mabel', 'nico',
  'otto', 'pia', 'quinn', 'rosa', 'sol', 'tess', 'uma', 'vik', 'wren', 'xena', 'yuri', 'zane',
];
const START_OUTPUT_MAX = 64 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const ROLES: Role[] = ['captain', 'crew', 'design', 'research'];
/** The Captain and the research agent work in the repo root on the base branch; everyone else gets a worktree. */
const atRoot = (role: Role) => role === 'captain' || role === 'research';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_NUDGE_BACKOFF_MS = 5 * 60_000;

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Index of the last match of a global regex, or -1. */
function lastMatch(text: string, re: RegExp): number {
  let last = -1;
  for (const m of text.matchAll(re)) last = m.index ?? last;
  return last;
}

export interface CreateAgentInput {
  name?: string;
  role?: Role;
  taskId?: string;
  actor: string;
}

export class AgentManager {
  private runtimes = new Map<string, Runtime>();
  private buffers = new Map<string, RingBuffer>(); // outlive the process so a crashed agent's last output stays readable
  private listeners = new Map<string, Set<(data: string) => void>>(); // per agent id, so terminals survive restarts
  private termOwners = new Map<string, number>(); // agent id → attached CLIs that own the pty size
  private wantedSize = new Map<string, { cols: number; rows: number }>(); // last size a non-owner asked for
  private humanInputAt = new Map<string, number>(); // last human keystroke per agent
  private closing = new Set<string>(); // agents being tidied away after an idle shutdown
  private zombies = new Map<string, number>(); // agent id → pid that survived stop()
  private starting = new Map<string, Promise<Agent>>();
  private flaggedStopped = new Set<string>(); // 'agent:task' keys of stopped agents the watchdog already told the Captain about
  private timings: Timings;
  private nudgeTimer?: NodeJS.Timeout;
  private nudgeRetryTimer?: NodeJS.Timeout;
  private isAlive: (pid: number) => boolean;
  private killPid: (pid: number) => void;
  private idleTimer: NodeJS.Timeout;
  private watchdogTimer: NodeJS.Timeout;
  private inlinePrompt = false; // set if this claude build rejects --append-system-prompt-file
  private log: (msg: string) => void;

  constructor(private o: AgentManagerOptions) {
    this.timings = { ...DEFAULT_TIMINGS, ...o.timings };
    this.log = o.log ?? (() => {});
    this.isAlive = o.isAlive ?? defaultIsAlive;
    this.killPid = o.killPid ?? gitOps.killTree;
    o.store.on('change', () => this.scheduleNudges());
    this.idleTimer = setInterval(() => this.shutdownIdleCrew(), Math.min(30_000, this.timings.idleShutdownMs)).unref();
    this.watchdogTimer = setInterval(() => this.watchQuietTerminals(), Math.max(1000, this.timings.quietMs / 2)).unref();
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
    if (!ROLES.includes(role)) throw badRequest(`Unknown role "${role}"`);
    if (role === 'research' && !internal) throw badRequest('The research agent is started by a research run (Roadmap → Research), not added by hand');
    if (!internal && input.actor !== HUMAN && !isCaptain(state, input.actor)) throw forbidden('Only the Captain or you can add agents');
    if (!internal) assertNotPaused(state);
    if (role === 'captain' && captainOf(state)) throw conflict(`${captainOf(state)!.id} is already the Captain; change roles instead`);
    if (role !== 'captain' && !input.name) {
      const reused = await this.reuseStopped(role, input);
      if (reused) return reused;
    }
    if (role === 'design' && state.agents.some((a) => a.role === 'design')) throw conflict('There is already a design crew agent');
    if (role === 'crew') {
      this.assertCrewRoom(config.maxCrew);
    }
    if (input.taskId) {
      const task = requireTask(state, input.taskId);
      if (task.status === 'merged' || task.status === 'cancelled') throw conflict(`${task.id} is ${task.status}`);
    }
    const id = this.newId(role, input.name);

    // Reserve the record before the first await, so parallel spawns see it (maxCrew, one design agent, ids).
    const root = atRoot(role);
    const at = nowIso();
    const agent: Agent = {
      id,
      role,
      model: modelFor(role, config),
      branch: root ? config.baseBranch : `${id}/work`,
      worktree: root ? this.o.paths.root : this.o.paths.worktree(id),
      status: 'starting',
      sessionId: randomUUID(),
      startedAt: at,
      lastActivityAt: at,
      costUsd: 0,
    };
    state.agents.push(agent);
    try {
      if (!root) agent.branch = await gitOps.addWorktree(this.o.paths.root, agent.worktree, agent.branch, config.baseBranch);
      if (input.taskId) {
        const task = assignTask(state, input.taskId, id, internal ? HUMAN : input.actor);
        await this.syncTaskBranch(agent, task);
      }
    } catch (e) {
      for (const t of state.tasks) if (t.assignee === id) untake(state, t, agent, errText(e));
      state.agents = state.agents.filter((a) => a !== agent);
      this.o.store.commit();
      throw e;
    }
    feedEvent(state, input.actor, `added ${id} (${role}) on ${agent.branch}`);
    this.o.store.commit();
    await this.start(id);
    return agent;
  }

  /**
   * maxCrew counts running crew plus stopped crew that still hold an unfinished task: those are parked work that
   * gets restarted, so a new agent in their place would push the crew past the limit.
   */
  private assertCrewRoom(maxCrew: number): void {
    const parked = (a: Agent) => a.status === 'stopped' && !!a.taskId && this.state.tasks.some((t) => t.id === a.taskId && t.assignee === a.id && t.status !== 'merged' && t.status !== 'cancelled');
    const crew = this.state.agents.filter((a) => a.role === 'crew' && (a.status !== 'stopped' || parked(a)));
    if (crew.length < maxCrew) return;
    const stopped = crew.filter((a) => a.status === 'stopped').map((a) => `${a.id} (${a.taskId})`);
    throw conflict(`Crew limit reached (${crew.length}/${maxCrew})${stopped.length ? `, counting stopped crew that still hold a task: ${stopped.join(', ')}. Restart one of them to finish its task` : '. Wait for one to finish'}, or raise maxCrew.`);
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
    const named = this.o.config().crewNames !== 'numbers';
    let id: string;
    do {
      const n = this.state.nextIds.agent++;
      if (!named) id = `crew-${n}`;
      else {
        // Each number gets its own name, so a name never comes back for a different agent (old branches carry it).
        const i = Math.max(0, n - 2); // the counter starts at 2 (crew-2 is the first numbered crew)
        const base = CREW_NAMES[i % CREW_NAMES.length];
        const round = Math.floor(i / CREW_NAMES.length);
        id = round ? `${base}-${round + 1}` : base;
      }
    } while (taken(id));
    return id;
  }

  /**
   * Starts claude for an existing agent. Resumes its session when it has one (and reminds it of its task),
   * recreates a missing worktree, and never starts while a previous process of the agent is still alive.
   */
  start(id: string): Promise<Agent> {
    const agent = requireAgent(this.state, id);
    if (this.runtimes.has(id)) return Promise.resolve(agent);
    let p = this.starting.get(id);
    if (!p) {
      p = this.doStart(agent).finally(() => this.starting.delete(id));
      this.starting.set(id, p);
    }
    return p;
  }

  private async doStart(agent: Agent): Promise<Agent> {
    const { id } = agent;
    const old = this.zombies.get(id);
    if (old !== undefined) {
      if (this.isAlive(old)) {
        this.log(`${id}: previous process ${old} is still alive; killing it again`);
        this.killPid(old);
        await this.waitGone(old, this.timings.stopConfirmMs);
      }
      if (this.isAlive(old)) throw conflict(`${id}'s previous process (pid ${old}) is still running; end it before starting ${id} again`);
      this.zombies.delete(id);
    }
    await this.ensureWorktree(agent);
    if (this.runtimes.has(id)) return agent;
    const resume = existsSync(this.resumableMarker(id));
    this.spawn(agent, { resume, inlinePrompt: this.inlinePrompt ? '' : undefined }, resume ? this.resumePromptFor(agent) : this.firstPromptFor(agent));
    return agent;
  }

  /** After a --resume the conversation is back, but the agent doesn't know it was restarted. */
  private resumePromptFor(agent: Agent): string | undefined {
    if (agent.role === 'research') return runningRun(this.state) || this.o.intel?.runningJob() ? this.firstPromptFor(agent) : undefined;
    const task = agent.taskId ? this.state.tasks.find((t) => t.id === agent.taskId) : undefined;
    if (!task || task.assignee !== agent.id || task.status !== 'in_progress') return undefined;
    return `[muster] You were restarted. Continue ${task.id} ${task.title}; call read_inbox first.`;
  }

  private resumableMarker(id: string): string {
    return join(this.o.paths.agentDir(id), 'resumable');
  }

  private firstPromptFor(agent: Agent): string | undefined {
    if (agent.role === 'research') {
      const job = runningRun(this.state) ? undefined : this.o.intel?.runningJob();
      return job ? intelJobPrompt(agent.id, job) : `[muster] You are ${agent.id} (research). Call research_brief and start.`;
    }
    if (agent.taskId) {
      const task = this.state.tasks.find((t) => t.id === agent.taskId);
      return `[muster] You are ${agent.id} (${agent.role}). Your task: ${agent.taskId} ${task?.title ?? ''}. Call read_inbox and claim/confirm it, then start.`;
    }
    if (agent.role === 'crew') return `[muster] You are ${agent.id}, crew. Call claim_task to pick up work.`;
    if (agent.role === 'design') return `[muster] You are ${agent.id}, the Vellum design crew. Call read_board, then claim_task to pick up design checks.`;
    return undefined;
  }

  /** Regenerates every agent's mcp.json / settings.json / prompt.md (after the project folder moved). */
  rewriteAgentFiles(): void {
    const ctx = { ...this.o.server(), repoRoot: this.o.paths.root, config: this.o.config() };
    for (const a of this.state.agents) writeAgentFiles(this.o.paths, a, ctx);
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
    const buffer = this.buffers.get(agent.id) ?? this.buffers.set(agent.id, new RingBuffer()).get(agent.id)!;
    if (buffer.text()) {
      // Attached terminals already show the old output; mark where the new process begins.
      const sep = `\r\n\x1b[2m── ${agent.id} ${launch.resume ? 'resumed' : 'started'} ${new Date().toLocaleTimeString()} ──\x1b[0m\r\n`;
      buffer.push(sep);
      this.emitOutput(agent.id, sep);
    }
    const rt: Runtime = {
      pty: p,
      buffer,
      startOutput: '',
      logFile: createWriteStream(this.o.paths.agentLog(agent.id), { flags: 'a' }),
      spawnedAt: Date.now(),
      launch,
      stopping: false,
      exited: new Promise<void>((r) => (onExit = r)),
      trustAnswered: false,
      firstPrompt,
      typing: Promise.resolve(),
      size: '120x32',
    };
    // A log file that can't be written (folder gone, disk full) must not take the orchestrator down.
    rt.logFile.on('error', (e) => this.log(`${agent.id}: terminal log not written: ${errText(e)}`));
    this.runtimes.set(agent.id, rt);
    if (firstPrompt) rt.firstPromptTimer = setTimeout(() => this.typeFirstPrompt(agent.id), this.timings.firstPromptFallbackMs);

    p.onData((data) => this.onOutput(agent.id, rt, data));
    p.onExit(({ exitCode }) => {
      onExit();
      this.onExit(agent.id, rt, exitCode);
    });
    agent.pid = p.pid;
    agent.status = 'starting';
    // A permission prompt from the previous process is gone with it.
    for (const n of this.state.notes) {
      if (n.from === agent.id && n.type === 'stuck' && n.text.startsWith('Waiting for permission')) closeNoteIfOpen(n);
    }
    agent.lastActivityAt = nowIso();
    feedEvent(this.state, SYSTEM, `${agent.id} started${launch.resume ? ' (resumed)' : ''}`);
    this.o.store.commit();
  }

  private onOutput(id: string, rt: Runtime, data: string): void {
    rt.buffer.push(data);
    if (rt.startOutput.length < START_OUTPUT_MAX) rt.startOutput += data;
    rt.logFile.write(data);
    this.emitOutput(id, data);
    const agent = findAgent(this.state, id);
    if (agent) agent.lastActivityAt = nowIso();
    rt.lastOutputAt = Date.now();
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
    // The session exists although no prompt was recorded (e.g. hooks were off): resume it instead.
    if (quick && !rt.launch.resume && !rt.launch.retried && /session id .* is already in use/i.test(out)) {
      this.log(`${id}: session ${agent.sessionId} already exists, resuming it`);
      return this.spawn(agent, { ...rt.launch, resume: true, retried: true }, this.resumePromptFor(agent));
    }
    if (quick && rt.launch.resume && /no conversation found|session.*not found|already in use/i.test(out)) {
      this.log(`${id}: session ${agent.sessionId} not resumable, starting a new one`);
      agent.sessionId = randomUUID();
      return this.spawn(agent, { ...rt.launch, resume: false }, this.firstPromptFor(agent));
    }

    agent.status = 'stopped';
    agent.pid = undefined;
    feedEvent(this.state, SYSTEM, `${id} exited (code ${exitCode})`);
    if (agent.role === 'research') {
      failRun(this.state, `${id} exited (code ${exitCode}) before finish_research`);
      this.o.intel?.onScoutExit(`${id} exited (code ${exitCode}) before finish_intel_job`);
    }
    this.o.store.commit();
  }

  async stop(id: string, reason?: string): Promise<Agent> {
    const agent = requireAgent(this.state, id);
    const rt = this.runtimes.get(id);
    const heldJob = agent.role === 'research' ? this.o.intel?.runningJob()?.id : undefined; // a job started meanwhile isn't this stop's
    if (rt) {
      rt.stopping = true;
      rt.pty.kill();
      await this.confirmGone(id, rt);
      if (this.runtimes.get(id) === rt) this.runtimes.delete(id);
      rt.logFile.end();
      clearTimeout(rt.firstPromptTimer);
    }
    if (agent.status !== 'stopped') {
      agent.status = 'stopped';
      agent.pid = undefined;
      feedEvent(this.state, SYSTEM, reason ? `${id} stopped: ${reason}` : `${id} stopped`);
      this.o.store.commit();
    }
    // Stopped on purpose (not a shutdown, which keeps work for the resume): an intel job it held can't finish.
    if (heldJob && reason !== undefined && this.o.intel?.runningJob()?.id === heldJob) this.o.intel.onScoutExit(`${id} stopped: ${reason}`);
    return agent;
  }

  /**
   * After taskkill, make sure the process is really gone: its exit event, or the pid no longer alive.
   * If it survives, kill it once more; a pid that still survives is remembered so start() won't run a second copy.
   */
  private async confirmGone(id: string, rt: Runtime): Promise<void> {
    const pid = rt.pty.pid;
    let exited = false;
    void rt.exited.then(() => (exited = true));
    const gone = () => exited || !this.isAlive(pid);
    if (await this.until(gone, this.timings.stopConfirmMs)) return;
    this.log(`${id}: process ${pid} still alive ${this.timings.stopConfirmMs} ms after taskkill; killing it again`);
    this.killPid(pid);
    if (await this.until(gone, this.timings.stopConfirmMs)) return;
    this.log(`${id}: process ${pid} survived two kills; ${id} won't start again until it is gone`);
    this.zombies.set(id, pid);
  }

  private async waitGone(pid: number, ms: number): Promise<boolean> {
    return this.until(() => !this.isAlive(pid), ms);
  }

  private async until(check: () => boolean, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    for (;;) {
      if (check()) return true;
      if (Date.now() >= end) return false;
      await sleep(Math.min(100, Math.max(1, end - Date.now())));
    }
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
    for (const a of [...this.state.agents]) {
      if (a.status === 'stopped') continue;
      try {
        await this.start(a.id);
      } catch (e) {
        // One agent that can't start (missing branch, locked folder, zombie process) must not keep the others down.
        this.log(`${a.id}: could not be resumed: ${errText(e)}`);
        a.status = 'stopped';
        a.pid = undefined;
        feedEvent(this.state, SYSTEM, `${a.id} could not be resumed: ${errText(e)}`);
        this.o.store.commit();
      }
    }
    if (!captainOf(this.state)) await this.create({ role: 'captain', actor: SYSTEM });
  }

  /**
   * `down --clean`: removes the worktrees (and records) of crew that are stopped, hold no task and whose
   * branch is merged. Worktrees of every other registered agent stay; the Captain's checkout is never touched.
   */
  async cleanMerged(): Promise<string[]> {
    const { state } = this;
    const config = this.o.config();
    const active = new Set(['blocked', 'ready', 'in_progress', 'review']);
    const registered = new Map(state.agents.filter((a) => !atRoot(a.role)).map((a) => [gitOps.normalise(a.worktree), a]));
    const removable = (a: Agent) =>
      // stopAll() keeps each agent's last status for resume, so "not running" is the test, not status.
      !this.runtimes.has(a.id) && !a.taskId && !state.tasks.some((t) => t.assignee === a.id && active.has(t.status));
    const removed = await gitOps.cleanMergedWorktrees(this.o.paths.root, this.o.paths.worktrees, config.baseBranch, {
      mayRemove: (path) => {
        const a = registered.get(gitOps.normalise(path));
        return !a || removable(a);
      },
    });
    for (const path of removed) {
      const a = registered.get(gitOps.normalise(path));
      if (!a) continue;
      state.agents = state.agents.filter((x) => x !== a);
      this.buffers.delete(a.id);
      feedEvent(state, SYSTEM, `removed ${a.id} (stopped, ${a.branch} merged)`);
    }
    if (removed.length) this.o.store.commit();
    return removed;
  }

  /**
   * A stopped agent of the same role with no task and a clean worktree is restarted instead of adding
   * a new one, so crew numbers and Dashboard tiles don't pile up. Returns undefined when none fits.
   */
  private async reuseStopped(role: Role, input: CreateAgentInput): Promise<Agent | undefined> {
    const { state } = this;
    const config = this.o.config();
    for (const agent of state.agents) {
      if (agent.role !== role || agent.status !== 'stopped' || agent.taskId || this.runtimes.has(agent.id) || this.starting.has(agent.id)) continue;
      if (!existsSync(agent.worktree) || (await gitOps.uncommittedChanges(agent.worktree)).length) continue;
      if (role === 'crew') {
        this.assertCrewRoom(config.maxCrew);
      }
      if (input.taskId) {
        const task = assignTask(state, input.taskId, agent.id, input.actor === SYSTEM ? HUMAN : input.actor);
        await this.syncTaskBranch(agent, task);
      }
      feedEvent(state, input.actor, `restarted ${agent.id} (${role}) instead of adding a new agent${input.taskId ? ` for ${input.taskId}` : ''}`);
      this.o.store.commit();
      await this.start(agent.id);
      return agent;
    }
    return undefined;
  }

  /** Why a crew agent can't be closed yet, or null when it's finished: no open task, nothing uncommitted, nothing unmerged. */
  async unfinishedReason(agent: Agent): Promise<string | null> {
    if (agent.role === 'captain') return "the Captain can't be closed";
    if (agent.role === 'research') {
      if (runningRun(this.state)) return 'its research run is still going (cancel it first)';
      const job = this.o.intel?.runningJob();
      return job ? `its intel job ${job.id} is still going (cancel it first)` : null;
    }
    const config = this.o.config();
    const open = new Set(['blocked', 'ready', 'in_progress', 'review', 'ready_for_merge']);
    const task = agent.taskId ? this.state.tasks.find((t) => t.id === agent.taskId) : undefined;
    const held = task ?? this.state.tasks.find((t) => open.has(t.status) && (t.assignee === agent.id || t.branch === agent.branch));
    if (held && open.has(held.status)) return `${held.id} is still ${held.status.replace(/_/g, ' ')} on it`;
    if (existsSync(agent.worktree)) {
      const dirty = await gitOps.uncommittedChanges(agent.worktree);
      if (dirty.length) return `uncommitted changes in its worktree (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ', …' : ''})`;
    }
    const root = this.o.paths.root;
    if ((await gitOps.branchExists(root, agent.branch)) && !(await gitOps.isMerged(root, agent.branch, config.baseBranch))) {
      if ((await gitOps.commitsAhead(root, config.baseBranch, agent.branch)) > 0) return `unmerged commits on ${agent.branch}`;
    }
    return null;
  }

  /** Closes a finished crew agent: stops it, removes its worktree and (merged or empty) branch, and drops its tile. */
  async close(id: string, actor: string): Promise<void> {
    const { state } = this;
    const agent = requireAgent(state, id);
    if (actor !== HUMAN && actor !== SYSTEM && !isCaptain(state, actor)) throw forbidden('Only the Captain or you can close agents');
    const why = await this.unfinishedReason(agent);
    if (why) throw conflict(`${id} isn't finished: ${why}`);
    if (this.runtimes.has(id)) await this.stop(id, 'closed');
    if (!atRoot(agent.role)) {
      if (existsSync(agent.worktree)) await gitOps.removeWorktree(this.o.paths.root, agent.worktree);
      await gitOps.git(this.o.paths.root, ['branch', '-d', agent.branch], true); // only succeeds when merged or empty
    }
    state.agents = state.agents.filter((a) => a.id !== id);
    this.buffers.delete(id);
    this.humanInputAt.delete(id);
    feedEvent(state, actor, `closed ${id} (finished: work merged, nothing open)`);
    this.o.store.commit();
  }

  /** After an idle shutdown: tidy the agent away if it has nothing left in flight. */
  private async closeIfFinished(id: string): Promise<void> {
    const agent = findAgent(this.state, id);
    if (!agent || agent.role === 'captain' || this.runtimes.has(id) || this.closing.has(id)) return;
    this.closing.add(id);
    try {
      if (await this.unfinishedReason(agent)) return;
      await this.close(id, SYSTEM);
    } catch (e) {
      this.log(`${id}: not tidied away: ${errText(e)}`);
    } finally {
      this.closing.delete(id);
    }
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
    this.humanInputAt.delete(id);
    if (removeWorktree && agent.worktree !== this.o.paths.root) await gitOps.removeWorktree(this.o.paths.root, agent.worktree);
    feedEvent(state, HUMAN, `removed ${id}`);
    this.o.store.commit();
  }

  /** Changes an agent's role and restarts its claude (same session). A new Captain demotes the old one to crew. */
  async setRole(id: string, role: Role, actor: string): Promise<Agent> {
    const { state } = this;
    const agent = requireAgent(state, id);
    if (!ROLES.includes(role)) throw badRequest(`Unknown role "${role}"`);
    if (agent.role === role) return agent;
    if (role === 'research' || agent.role === 'research') throw conflict('The research agent keeps its role; it is started by a research run');
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
    if (wasRunning) await this.start(agent.id);
  }

  // ---------------------------------------------------------------- research agent

  /**
   * A research run or intel job started: start scout (the one research agent) at the repo root. A stopped scout is restarted
   * with its session and told to read the new brief; a running one is told directly.
   */
  async startScout(): Promise<Agent> {
    const existing = findAgent(this.state, SCOUT_ID) ?? this.state.agents.find((a) => a.role === 'research');
    if (!existing) return this.create({ name: SCOUT_ID, role: 'research', actor: SYSTEM });
    if (existing.role !== 'research') throw conflict(`An agent called "${SCOUT_ID}" already exists and isn't the research agent; rename or remove it first`);
    existing.model = modelFor('research', this.o.config());
    const rt = this.runtimes.get(existing.id);
    // Being stopped (a run just ended): let the stop finish, then start it afresh below (start() handles a survivor).
    if (rt?.stopping) await this.until(() => this.runtimes.get(existing.id) !== rt, this.timings.stopConfirmMs * 3);
    else if (rt) {
      const prompt = this.firstPromptFor(existing);
      if (prompt) void this.type(existing.id, prompt).catch(() => {});
      return existing;
    }
    return this.start(existing.id);
  }

  /** The run finished or was cancelled: stop scout, after `delayMs` (unless a new run started meanwhile). */
  async stopScout(reason: string, delayMs = 0): Promise<void> {
    const scout = this.state.agents.find((a) => a.role === 'research');
    if (!scout || !this.runtimes.has(scout.id)) return;
    if (delayMs > 0) {
      setTimeout(() => {
        if (!runningRun(this.state) && !this.o.intel?.runningJob()) void this.stop(scout.id, reason).catch((e) => this.log(`${scout.id}: not stopped: ${errText(e)}`));
      }, delayMs).unref();
      return;
    }
    await this.stop(scout.id, reason);
  }

  get scoutStopDelayMs(): number {
    return this.timings.scoutStopDelayMs;
  }

  // ---------------------------------------------------------------- tasks and branches

  /** A crew worktree folder that vanished (deleted by hand, lost in a clean) is recreated on the agent's branch. */
  private async ensureWorktree(agent: Agent): Promise<void> {
    if (atRoot(agent.role) || existsSync(agent.worktree)) return;
    this.log(`${agent.id}: worktree ${agent.worktree} is missing; recreating it on ${agent.branch}`);
    agent.branch = await gitOps.addWorktree(this.o.paths.root, agent.worktree, agent.branch, this.o.config().baseBranch);
    feedEvent(this.state, SYSTEM, `recreated ${agent.id}'s worktree on ${agent.branch}`);
  }

  /** One branch per task: does taking `task` need a new branch because the agent's current one carries other work? */
  private async needsFreshBranch(agent: Agent, task: Task | undefined): Promise<boolean> {
    if (agent.role === 'captain' || (task && agent.branch === task.branch)) return false;
    if (this.state.tasks.some((t) => t.id !== task?.id && t.branch === agent.branch)) return true;
    if (task?.inputs?.some((i) => i.kind === 'station' && i.branch === agent.branch)) return false; // its own earlier station (send-back)
    return (await gitOps.commitsAhead(this.o.paths.root, this.o.config().baseBranch, agent.branch)) > 0;
  }

  private async assertClean(agent: Agent): Promise<void> {
    const dirty = await gitOps.uncommittedChanges(agent.worktree);
    if (!dirty.length) return;
    const files = dirty.slice(0, 5).map((l) => l.slice(3)).join(', ') + (dirty.length > 5 ? ', ...' : '');
    throw conflict(`${agent.id} has uncommitted changes on ${agent.branch} (${files}). Commit them on ${agent.branch} first: each task gets a branch of its own.`);
  }

  /**
   * Checked before a task is given to an agent (claim, assign, send-back, handoff, spawn): when the agent
   * needs a fresh branch, its worktree must be clean, or the previous task's edits would move over with it.
   * `task` omitted = the task a claim would pick.
   */
  async assertCanTakeBranch(agentId: string | undefined, task?: Task): Promise<void> {
    const agent = agentId ? findAgent(this.state, agentId) : undefined;
    if (!agent || atRoot(agent.role) || !existsSync(agent.worktree)) return;
    if (await this.needsFreshBranch(agent, task)) await this.assertClean(agent);
  }

  /**
   * Called when an agent takes a task. Gives the task a branch of its own in the agent's worktree
   * (renaming an unused `<id>/work`, or creating `<id>/<slug>` from base when the current branch carries
   * other work), then merges in what the task must contain: the branch of the previous station, and any
   * dependency that is flagged ready for merge but not merged yet. A conflicting merge leaves task.branch
   * on the previous branch and tells the agent (inbox) and the Captain (a stuck note from the agent).
   * If the branch can't be set up, the take is undone and the error thrown.
   */
  async syncTaskBranch(agent: Agent, task: Task): Promise<void> {
    if (agent.role === 'captain') return;
    try {
      await this.setupTaskBranch(agent, task);
    } catch (e) {
      untake(this.state, task, agent, errText(e));
      this.o.store.commit();
      throw e;
    }
    const root = this.o.paths.root;
    const incoming = task.branch && task.branch !== agent.branch && (await gitOps.branchExists(root, task.branch)) ? task.branch : undefined;
    const ok = incoming ? await this.mergeInput(agent, task, incoming, incoming, `${incoming} (${task.id}'s previous station)`) : true;
    if (ok) task.branch = agent.branch;
    await this.mergeDependencies(agent, task);
  }

  private async setupTaskBranch(agent: Agent, task: Task): Promise<void> {
    await this.ensureWorktree(agent);
    if (agent.branch === task.branch) return;
    const base = this.o.config().baseBranch;
    const name = `${agent.id}/${gitOps.slug(task.title)}`;
    if (await this.needsFreshBranch(agent, task)) {
      await this.assertClean(agent);
      agent.branch = await gitOps.createBranch(agent.worktree, name, base);
      return;
    }
    if (task.inputs?.some((i) => i.branch === agent.branch)) return; // back on its own earlier branch
    if (agent.branch !== name && !agent.branch.startsWith(`${name}-`)) agent.branch = await gitOps.renameBranch(agent.worktree, agent.branch, name);
    await gitOps.fastForward(agent.worktree, base); // an unused branch may predate recent merges into base
  }

  /** Merges dependencies that are ready for merge (their reviewed commit) into the agent's task branch. */
  async mergeDependencies(agent: Agent, task: Task): Promise<void> {
    if (agent.role === 'captain') return;
    const root = this.o.paths.root;
    for (const depId of task.dependsOn) {
      const dep = this.state.tasks.find((t) => t.id === depId);
      if (!dep || dep.status !== 'ready_for_merge') continue; // merged ones come with base
      const sha = await gitOps.revParse(root, dep.reviewedSha ?? dep.branch ?? '');
      if (!sha) continue;
      const name = dep.branch ?? sha;
      addInput(task, { branch: name, sha, kind: 'dependency', taskId: dep.id });
      await this.mergeInput(agent, task, sha, name, `dependency ${dep.id} ${dep.title} (${name})`);
    }
  }

  /** After a task is flagged ready for merge: its dependents that are already held get it merged in. */
  async syncDependents(taskId: string): Promise<void> {
    for (const t of this.state.tasks) {
      if (!t.dependsOn.includes(taskId) || !t.assignee || (t.status !== 'in_progress' && t.status !== 'blocked')) continue;
      const agent = findAgent(this.state, t.assignee);
      if (!agent || agent.role === 'captain' || agent.branch !== t.branch || !existsSync(agent.worktree)) continue;
      await this.mergeDependencies(agent, t).catch((e) => this.log(`${agent.id}: could not merge dependencies of ${t.id}: ${errText(e)}`));
    }
  }

  /** Merges `ref` into the agent's checked-out branch unless it is already there. Reports a conflict; returns success. */
  private async mergeInput(agent: Agent, task: Task, ref: string, name: string, label: string): Promise<boolean> {
    if (await gitOps.isAncestor(agent.worktree, ref, 'HEAD')) return true;
    const r = await gitOps.mergeInto(agent.worktree, ref, `Merge ${name} into ${agent.branch} (${task.id})`);
    if (r.ok) {
      addInbox(this.state, { agentId: agent.id, from: SYSTEM, kind: 'system', taskId: task.id, text: `Merged ${label} into your branch ${agent.branch}.` });
      return true;
    }
    const files = r.conflicts.join(', ') || 'unknown files';
    addInbox(this.state, {
      agentId: agent.id,
      from: SYSTEM,
      kind: 'system',
      taskId: task.id,
      text: `Could not merge ${label} into your branch ${agent.branch}: conflicts in ${files}. Run \`git merge ${name}\`, resolve them and commit before you hand off or report done.`,
    });
    postNote(this.state, { actor: agent.id, type: 'stuck', taskId: task.id, text: `${MERGE_CONFLICT} ${label} into ${agent.branch} for ${task.id} (conflicts in ${files}); resolving it by hand.` });
    return false;
  }

  /**
   * The branch a station hands on when `task` is handed off, reported done or flagged for review: the
   * holder's branch for crew, else the task branch. Refuses (409) unless it contains every input of the
   * task: the branches of earlier stations and the dependencies merged in when it was taken.
   */
  async stationBranch(task: Task): Promise<StationBranch | undefined> {
    const holder = task.assignee ? findAgent(this.state, task.assignee) : undefined;
    const branch = holder && holder.role !== 'captain' ? holder.branch : task.branch;
    if (!branch) return undefined;
    const root = this.o.paths.root;
    const sha = await gitOps.revParse(root, branch);
    if (!sha) throw conflict(`${task.id}: branch ${branch} does not exist`);
    for (const input of task.inputs ?? []) {
      if (!(await gitOps.revParse(root, input.sha))) continue; // the commit is gone; nothing to check against
      if (await gitOps.isAncestor(root, input.sha, sha)) continue;
      const what = input.kind === 'dependency' ? `dependency ${input.taskId}` : 'an earlier station';
      throw conflict(`${task.id}: ${branch} does not contain ${input.branch} (${what}, ${input.sha.slice(0, 8)}). Merge it first: git merge ${input.kind === 'dependency' ? input.sha : input.branch}`);
    }
    // Evidence is attached with add_evidence, never merged: git ignores the folder, so it only gets in with add -f.
    const tracked = (await gitOps.git(root, ['ls-tree', '-r', '--name-only', sha, '--', `${EVIDENCE_DIR}/`], true)).stdout.trim();
    if (tracked) {
      throw conflict(`${task.id}: ${branch} commits ${EVIDENCE_DIR}/ files (${tracked.split('\n').length}). Evidence is attached with add_evidence, never committed: git rm -r --cached ${EVIDENCE_DIR} and commit, then try again.`);
    }
    return { branch, sha };
  }

  // ---------------------------------------------------------------- terminal I/O

  /**
   * Types into the agent's terminal: control characters and escape sequences stripped, newlines collapsed,
   * then Enter after a short delay so the TUI sees a submit. Automated typing (everything but `human`)
   * waits until nobody has typed into that terminal for `humanHoldMs`.
   */
  type(id: string, text: string, submit = true, opts: { human?: boolean } = {}): Promise<void> {
    const rt = this.requireRuntime(id);
    const line = sanitizeTyped(text);
    if (opts.human) this.noteHumanInput(id);
    rt.typing = rt.typing.then(async () => {
      if (!opts.human) await this.waitForHumanQuiet(id);
      if (this.runtimes.get(id) !== rt) return;
      if (line) rt.pty.write(line);
      if (submit) {
        await sleep(this.timings.enterDelayMs);
        rt.pty.write('\r');
        if (line) this.confirmSubmitted(id, rt, line);
      }
    });
    return rt.typing;
  }

  /**
   * A one-time notice or dialog can swallow the Enter, leaving the line sitting in the input box.
   * If no prompt hook has arrived and the line is still on screen, press Enter again (twice at most).
   */
  private confirmSubmitted(id: string, rt: Runtime, line: string, attempt = 1): void {
    const since = Date.now();
    setTimeout(() => {
      const agent = findAgent(this.state, id);
      if (!agent || this.runtimes.get(id) !== rt || agent.status === 'working') return;
      if (Date.parse(agent.lastPromptAt ?? '') >= since) return;
      const screen = stripAnsi(lastLines(rt.buffer.text(), 8)).replace(/\s+/g, ' ');
      if (!screen.includes(line.slice(0, 40).replace(/\s+/g, ' '))) return;
      this.log(`${id}: typed line was not submitted; pressing Enter again`);
      rt.pty.write('\r');
      if (attempt < 2) this.confirmSubmitted(id, rt, line, attempt + 1);
    }, this.timings.submitCheckMs).unref();
  }

  /** Raw keystrokes from a human at the terminal (the /ws/term input). */
  write(id: string, data: string): void {
    this.noteHumanInput(id);
    this.runtimes.get(id)?.pty.write(data);
  }

  /** A human typed into this agent's terminal: automated typing and nudges hold off for a few seconds. */
  noteHumanInput(id: string): void {
    this.humanInputAt.set(id, Date.now());
  }

  private humanHoldLeft(id: string): number {
    const at = this.humanInputAt.get(id);
    return at === undefined ? 0 : at + this.timings.humanHoldMs - Date.now();
  }

  private async waitForHumanQuiet(id: string): Promise<void> {
    for (let left = this.humanHoldLeft(id); left > 0; left = this.humanHoldLeft(id)) await sleep(left);
  }

  /**
   * Resizes an agent's pty. No-op sizes are dropped, and while an owning client (an attached CLI) is
   * connected, other clients' sizes are only remembered and restored once the last owner leaves.
   */
  resize(id: string, cols: number, rows: number, owner = false): void {
    if (!(cols > 0 && rows > 0)) return;
    const size = { cols: Math.floor(cols), rows: Math.floor(rows) };
    if (!owner) this.wantedSize.set(id, size);
    if (!owner && this.termOwners.get(id)) return;
    this.applySize(id, size);
  }

  private applySize(id: string, { cols, rows }: { cols: number; rows: number }): void {
    const rt = this.runtimes.get(id);
    const key = `${cols}x${rows}`;
    if (!rt || rt.size === key) return;
    rt.size = key;
    rt.pty.resize(cols, rows);
  }

  /** Marks a client as the size owner of an agent's terminal; returns its release function. */
  ownTerminal(id: string): () => void {
    this.termOwners.set(id, (this.termOwners.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.termOwners.get(id) ?? 1) - 1;
      if (left > 0) {
        this.termOwners.set(id, left);
        return;
      }
      this.termOwners.delete(id);
      const want = this.wantedSize.get(id);
      if (want) this.applySize(id, want);
    };
  }

  backlog(id: string): string {
    return this.buffers.get(id)?.text() ?? '';
  }

  output(id: string, lines = 80): string {
    requireAgent(this.state, id);
    return lastLines(this.backlog(id), lines);
  }

  /**
   * Subscribes to live output of an agent id, running or not; the listener keeps receiving across
   * restarts and starts receiving when a stopped agent starts. Returns an unsubscribe function.
   */
  attach(id: string, listener: (data: string) => void): () => void {
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size && this.listeners.get(id) === set) this.listeners.delete(id);
    };
  }

  private emitOutput(id: string, data: string): void {
    for (const l of this.listeners.get(id) ?? []) {
      try {
        l(data);
      } catch (e) {
        this.log(`${id}: terminal listener failed: ${errText(e)}`);
      }
    }
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
        agent.lastPromptAt = nowIso();
        this.confirmNudge(rt);
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
    if (rt) rt.idleSince = Date.now();
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

  /**
   * Types one "[muster] You have N new items" line into each resting agent that has undelivered inbox items.
   * Items are marked delivered only when the agent's next prompt hook confirms the line was submitted; without
   * one, the nudge is repeated after nudgeConfirmMs (doubling each time). Nothing is typed while a human is typing.
   */
  deliverNudges(): void {
    const now = Date.now();
    let retryIn = Infinity;
    for (const agent of this.state.agents) {
      const rt = this.runtimes.get(agent.id);
      if (!rt || !RESTING.includes(agent.status) || rt.firstPrompt || rt.permissionNoteId) continue;
      const items = inboxFor(this.state, agent.id, true).filter((i) => !i.delivered);
      if (!items.length) {
        rt.pendingNudge = undefined;
        continue;
      }
      const hold = this.humanHoldLeft(agent.id);
      if (hold > 0) {
        retryIn = Math.min(retryIn, hold);
        continue;
      }
      let attempt = 1;
      if (rt.pendingNudge) {
        const wait = Math.min(this.timings.nudgeConfirmMs * 2 ** (rt.pendingNudge.attempt - 1), MAX_NUDGE_BACKOFF_MS);
        const left = rt.pendingNudge.at + wait - now;
        if (left > 0) {
          retryIn = Math.min(retryIn, left);
          continue;
        }
        attempt = rt.pendingNudge.attempt + 1;
        this.log(`${agent.id}: no prompt hook after the last nudge; nudging again`);
      }
      rt.pendingNudge = { ids: items.map((i) => i.id), at: now, attempt };
      retryIn = Math.min(retryIn, Math.min(this.timings.nudgeConfirmMs * 2 ** (attempt - 1), MAX_NUDGE_BACKOFF_MS));
      void this.type(agent.id, nudgeText(items)).catch(() => {});
    }
    if (retryIn < Infinity) {
      clearTimeout(this.nudgeRetryTimer);
      this.nudgeRetryTimer = setTimeout(() => this.scheduleNudges(), retryIn + 10);
      this.nudgeRetryTimer.unref();
    }
  }

  /** The prompt hook after a nudge: the line was submitted, so its items count as delivered. */
  private confirmNudge(rt: Runtime | undefined): void {
    const pending = rt?.pendingNudge;
    if (!rt || !pending) return;
    rt.pendingNudge = undefined;
    for (const i of this.state.inbox) if (pending.ids.includes(i.id)) i.delivered = true;
  }

  private shutdownIdleCrew(): void {
    if (!this.o.config().shutdownIdleCrew) return;
    for (const agent of this.state.agents) {
      const rt = this.runtimes.get(agent.id);
      if (!rt || rt.stopping || agent.role !== 'crew' || agent.taskId || (agent.status !== 'idle' && agent.status !== 'done')) continue;
      if (!rt.idleSince || Date.now() - rt.idleSince < this.timings.idleShutdownMs) continue;
      if (inboxFor(this.state, agent.id, true).length) continue;
      void this.stop(agent.id, 'idle with no task').then(() => this.closeIfFinished(agent.id));
    }
  }

  /**
   * Claude fires no hook when a turn is interrupted (e.g. a permission prompt answered "No"),
   * so an agent can sit at its input box while we still think it is working or stuck.
   * When a terminal has been quiet for a while, read the screen and settle the status.
   */
  watchQuietTerminals(): void {
    let changed = false;
    for (const agent of this.state.agents) {
      const rt = this.runtimes.get(agent.id);
      if (!rt || (agent.status !== 'working' && !rt.permissionNoteId)) continue;
      if (!rt.lastOutputAt || Date.now() - rt.lastOutputAt < this.timings.quietMs) continue;
      // The raw stream keeps the old dialog text after it is dismissed, so compare which came last.
      const screen = stripAnsi(lastLines(rt.buffer.text(), 40));
      const dialog = lastMatch(screen, /Do you want to (proceed|make this edit|create)/gi);
      const interrupted = lastMatch(screen, /Interrupted|What should Claude do instead/gi);
      // A permission wait whose dialog is gone from a quiet screen was answered or cleared without a hook.
      const gone = !!rt.permissionNoteId && dialog < 0 && !/Esc to cancel|❯\s*1\.\s*Yes/i.test(screen);
      if (!gone && (interrupted < 0 || interrupted < dialog)) continue;
      this.log(`${agent.id}: ${gone ? 'permission prompt is gone' : 'turn was interrupted'}; marking it resting`);
      this.clearPermissionWait(agent, rt);
      this.setResting(agent, rt);
      changed = true;
    }
    if (this.watchStuckAgents()) changed = true;
    if (changed) this.o.store.commit();
  }

  /** A stopped agent can't be nudged and its parked task counts toward maxCrew: tell the Captain once instead. */
  private flagStopped(agent: Agent, now: number): boolean {
    const task = agent.taskId ? this.state.tasks.find((t) => t.id === agent.taskId && t.assignee === agent.id && t.status !== 'merged' && t.status !== 'cancelled') : undefined;
    if (!task || this.starting.has(agent.id) || now - Date.parse(agent.lastActivityAt) < this.timings.watchdogIdleMs) return false;
    const key = `${agent.id}:${task.id}`;
    if (this.flaggedStopped.has(key)) return false;
    this.flaggedStopped.add(key);
    const text = `${agent.id} is stopped holding ${task.id} (${task.title}); restart it to finish the task`;
    postNote(this.state, { actor: SYSTEM, type: 'stuck', text, taskId: task.id });
    this.log(text);
    this.o.onStuck?.(text);
    return true;
  }

  /** An agent that proved it is alive (it called the API with its own token) is no longer 'starting'. */
  touch(id: string): void {
    const agent = findAgent(this.state, id);
    if (agent?.status !== 'starting') return;
    this.log(`${id}: API call while 'starting' (no session-start hook seen); marking it resting`);
    this.setResting(agent, this.runtimes.get(id));
    this.o.store.commit();
  }

  /**
   * Agents that hold a task or unread inbox but sit idle (or never got past 'starting'): re-nudge once, and if
   * they still show no activity watchdogEscalateMs later, post one stuck note + Captain inbox item + toast.
   * A prompt hook (status 'working') or a new task resets it. Returns true if state changed.
   */
  private watchStuckAgents(now = Date.now()): boolean {
    let changed = false;
    for (const agent of this.state.agents) {
      const rt = this.runtimes.get(agent.id);
      if (!rt && agent.status === 'stopped') {
        if (this.flagStopped(agent, now)) changed = true;
        continue;
      }
      this.flaggedStopped.delete(`${agent.id}:${agent.taskId}`);
      if (!rt || rt.stopping) continue;
      const unread = inboxFor(this.state, agent.id, true);
      const task = agent.taskId ? this.state.tasks.find((t) => t.id === agent.taskId) : undefined;
      const key = task ? task.id : unread.length ? `inbox:${unread[0].id}` : '';
      const starting = agent.status === 'starting';
      const idle = agent.status === 'idle' && !rt.permissionNoteId && now - (rt.lastOutputAt ?? rt.spawnedAt) >= this.timings.watchdogIdleMs;
      const late = starting && now - rt.spawnedAt >= this.timings.watchdogStartingMs;
      if (!key || agent.status === 'working' || (!starting && agent.status !== 'idle')) {
        rt.wd = undefined;
        continue;
      }
      if (rt.wd && rt.wd.promptAt !== agent.lastPromptAt) rt.wd = undefined; // a prompt hook came in between checks
      if (rt.wd && rt.wd.key !== key && !(key.startsWith('inbox:') && rt.wd.key.startsWith('inbox:'))) rt.wd = undefined;
      if (!rt.wd) {
        if (!idle && !late) continue;
        rt.wd = { key, since: starting ? rt.spawnedAt : (rt.lastOutputAt ?? rt.spawnedAt), escalated: false, promptAt: agent.lastPromptAt };
      }
      const wd = rt.wd;
      if (wd.escalated) continue;
      if (wd.nudgedAt === undefined) {
        if (this.humanHoldLeft(agent.id) > 0) continue;
        wd.nudgedAt = now;
        this.log(`${agent.id}: idle holding ${key}; re-nudging`);
        void this.type(agent.id, `[muster] You have work waiting: call read_inbox${task ? `, then continue ${task.id}` : ''}.`).catch(() => {});
      } else if (now - wd.nudgedAt >= this.timings.watchdogEscalateMs) {
        wd.escalated = true;
        const mins = Math.max(1, Math.round((now - wd.since) / 60_000));
        const held = task ? `${task.id} (${task.title})` : `${unread.length} unread inbox item(s)`;
        const text = `${agent.id} has been ${starting ? "stuck at 'starting'" : 'idle'} ${mins} min holding ${held}; nudged twice`;
        const note = postNote(this.state, { actor: SYSTEM, type: 'stuck', text, taskId: task?.id });
        if (!isCaptain(this.state, agent.id)) {
          const captain = captainOf(this.state);
          // postNote already queues stuck notes for the Captain; make sure it is there even without one running.
          if (captain && !this.state.inbox.some((i) => i.noteId === note.id && i.agentId === captain.id)) {
            addInbox(this.state, { agentId: captain.id, from: SYSTEM, kind: 'note', text: `stuck ${note.id} from ${SYSTEM}: ${text}`, noteId: note.id, taskId: task?.id, feedId: noteFeedId(this.state, note.id) });
          }
        }
        this.log(text);
        this.o.onStuck?.(text);
        changed = true;
      }
    }
    return changed;
  }

  dispose(): void {
    clearInterval(this.idleTimer);
    clearInterval(this.watchdogTimer);
    clearTimeout(this.nudgeTimer);
    clearTimeout(this.nudgeRetryTimer);
  }
}
