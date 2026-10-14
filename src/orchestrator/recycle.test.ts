import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type MusterConfig } from '../types.js';
import { ensureDirs, musterPaths } from '../core/paths.js';
import { Store } from '../core/store.js';
import { createTask } from '../core/tasks.js';
import { latestHandoff } from '../core/handoff.js';
import { tempRepo } from '../core/testutil.js';
import { AgentManager, type Timings } from './agents.js';
import type { PtyLauncher } from './terminal.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await sleep(10);
  }
}

const T: Partial<Timings> = { enterDelayMs: 1, humanHoldMs: 0, firstPromptDelayMs: 1, firstPromptFallbackMs: 30, stopConfirmMs: 50, submitCheckMs: 10_000 };

interface Launch {
  args: string[];
  written: string[];
}

async function rig(timings: Partial<Timings> = {}, configPatch: Partial<MusterConfig> = {}) {
  const launches: Launch[] = [];
  const launcher: PtyLauncher = (_f, args) => {
    const l: Launch = { args, written: [] };
    launches.push(l);
    let exit: (e: { exitCode: number }) => void = () => {};
    return { pid: 1, onData() {}, onExit: (cb) => (exit = cb), write: (d) => l.written.push(d), resize() {}, kill: () => exit({ exitCode: 0 }) };
  };
  const repo = tempRepo();
  const paths = musterPaths(repo);
  ensureDirs(paths);
  const store = new Store(paths);
  const config = { ...DEFAULT_CONFIG, claudePath: 'claude.exe', captainRecycleTokens: 40_000, ...configPatch };
  const agents = new AgentManager({
    store, paths, config: () => config, server: () => ({ url: 'http://127.0.0.1:1', token: 't' }), launcher, claudePath: () => 'claude.exe',
    timings: { ...T, ...timings }, isAlive: () => false, killPid: () => {},
  });
  cleanups.push(() => {
    agents.dispose();
    rmSync(repo, { recursive: true, force: true });
  });
  const captain = await agents.create({ role: 'captain', actor: 'muster' });
  const typed = (i = launches.length - 1) => launches[i].written.join('');
  /** One Captain turn: prompt hook, then the Stop hook with this context size. */
  const turn = (context: number) => {
    agents.handleEvent(captain.id, 'prompt');
    agents.handleEvent(captain.id, 'stop', '', undefined, { context, totals: { input: context, cacheWrite: 0, cacheRead: 0, output: 100, requests: 1 }, sessionId: captain.sessionId });
  };
  agents.handleEvent(captain.id, 'session-start');
  return { agents, store, paths, config, captain, launches, typed, turn };
}

describe('Captain context tracking', () => {
  it('records the context size and session totals from the Stop hook, and ignores reports from an old session', async () => {
    const { agents, captain, turn } = await rig({}, { captainRecycleTokens: 0 });
    turn(31_000);
    expect(captain.contextTokens).toBe(31_000);
    expect(captain.sessionTokens?.requests).toBe(1);
    agents.handleEvent(captain.id, 'stop', '', undefined, { context: 99_000, sessionId: 'old-session' });
    expect(captain.contextTokens).toBe(31_000);
  });
});

describe('Captain recycle', () => {
  it('asks for a handoff past the threshold, then restarts on a fresh session that starts from it', async () => {
    const { agents, paths, captain, launches, typed, turn } = await rig();
    turn(30_000);
    expect(typed()).not.toContain('Write your handoff now');
    turn(41_000);
    await until(() => typed().includes('Write your handoff now'));
    expect(typed()).toContain('41k tokens');
    const oldSession = captain.sessionId;

    agents.handleEvent(captain.id, 'prompt');
    agents.saveHandoff(captain.id, 'Goal: invites. T4 at review. T5 with ada. Next: review T4.');
    expect(launches).toHaveLength(1); // not mid-turn
    agents.handleEvent(captain.id, 'stop');
    await until(() => launches.length === 2);

    expect(captain.sessionId).not.toBe(oldSession);
    expect(launches[1].args).toContain('--session-id');
    expect(launches[1].args).not.toContain('--resume');
    expect(captain.contextTokens).toBeUndefined();
    expect(captain.pastTokens?.input).toBe(41_000); // the latest report holds the session's totals
    agents.handleEvent(captain.id, 'session-start');
    await until(() => typed(1).includes('fresh session'));
    expect(typed(1)).toContain('Goal: invites. T4 at review.');
    expect(typed(1)).toMatch(/read_board, roadmap and read_inbox/);
    expect(latestHandoff(paths)?.text).toContain('Next: review T4');
    expect(agents.recycleStatus()).toBeUndefined();
  });

  it('a fresh session whose first turn is already past the threshold is not recycled again until it grows', async () => {
    const { typed, turn } = await rig();
    turn(45_000); // first turn of the session: its baseline
    await sleep(20);
    expect(typed()).not.toContain('Write your handoff now');
    turn(56_000);
    await until(() => typed().includes('Write your handoff now'));
  });

  it('queues a message sent during the restart and delivers it to the new session', async () => {
    const { agents, store, captain, typed, turn } = await rig();
    turn(30_000);
    turn(45_000);
    await until(() => typed().includes('Write your handoff now'));
    const queued = await agents.sendToCaptain('Also add a dark mode toggle');
    expect(queued).toBe(true);
    expect(typed(0)).not.toContain('dark mode');
    agents.saveHandoff(captain.id, 'handoff');
    agents.handleEvent(captain.id, 'stop');
    await until(() => !agents.recycleStatus());
    const item = store.state.inbox.find((i) => i.agentId === captain.id && i.text.includes('dark mode'));
    expect(item).toMatchObject({ read: false, from: 'you' });
    agents.handleEvent(captain.id, 'session-start');
    await until(() => typed(1).includes('read_inbox'));
    agents.handleEvent(captain.id, 'prompt');
    agents.handleEvent(captain.id, 'stop');
    await until(() => typed(1).includes('You have 1 new item'));
  });

  it('never recycles while a merge is running', async () => {
    const { agents, captain, launches, typed, turn } = await rig();
    let finish!: () => void;
    const merge = agents.duringMerge(() => new Promise<void>((r) => (finish = r)));
    turn(30_000);
    turn(50_000);
    await sleep(30);
    expect(typed()).not.toContain('Write your handoff now');
    finish();
    await merge;
    agents.watchQuietTerminals();
    await until(() => typed().includes('Write your handoff now'));
    // Handoff written, but a merge starts before the Captain rests: the restart waits for it.
    agents.handleEvent(captain.id, 'prompt');
    agents.saveHandoff(captain.id, 'h');
    let finish2!: () => void;
    const merge2 = agents.duringMerge(() => new Promise<void>((r) => (finish2 = r)));
    agents.handleEvent(captain.id, 'stop');
    await sleep(30);
    expect(launches).toHaveLength(1);
    finish2();
    await merge2;
    agents.watchQuietTerminals();
    await until(() => launches.length === 2);
  });

  it('recycles when a roadmap goal is done, whatever the size', async () => {
    const { agents, store, typed, turn } = await rig();
    store.state.roadmap = { goals: [{ id: 'G1', title: 'Invites', status: 'active' }] } as never;
    turn(5_000);
    (store.state.roadmap!.goals[0] as { status: string }).status = 'done';
    store.commit();
    agents.handleEvent('captain', 'prompt');
    agents.handleEvent('captain', 'stop');
    await until(() => typed().includes('Write your handoff now'));
    expect(typed()).toContain('Goal G1 Invites is done.');
  });

  it('writes the handoff from the board when the Captain does not write one in time', async () => {
    const { agents, store, config, paths, launches, typed, turn } = await rig({ handoffTimeoutMs: 40 });
    createTask(store.state, config, { title: 'Build invites', actor: 'you' });
    turn(30_000);
    turn(45_000);
    await until(() => typed().includes('Write your handoff now'));
    agents.handleEvent('captain', 'prompt');
    agents.handleEvent('captain', 'stop'); // answered without calling handoff
    await sleep(60);
    agents.watchQuietTerminals();
    await until(() => launches.length === 2);
    expect(latestHandoff(paths)).toMatchObject({ by: 'muster' });
    expect(latestHandoff(paths)!.text).toContain('Build invites');
  });
});

describe('watchdog digest', () => {
  it('three idle agents in one interval make one Captain message', async () => {
    const { agents, store, config, captain } = await rig({ watchdogIdleMs: 20, watchdogEscalateMs: 30, digestMs: 60_000 }, { captainRecycleTokens: 0, maxCrew: 5 });
    const crew = [];
    for (let i = 0; i < 3; i++) {
      const a = await agents.create({ role: 'crew', actor: 'muster' });
      agents.handleEvent(a.id, 'stop');
      createTask(store.state, config, { title: `Task ${i}`, assignee: a.id, actor: 'you' });
      crew.push(a);
    }
    await sleep(30);
    agents.watchQuietTerminals(); // re-nudges each
    await sleep(40);
    agents.watchQuietTerminals(); // gives up on all three: one digest
    await sleep(40);
    agents.watchQuietTerminals();
    const digests = store.state.inbox.filter((i) => i.agentId === captain.id && i.text.startsWith('Watchdog:'));
    expect(digests).toHaveLength(1);
    for (const a of crew) expect(digests[0].text).toContain(a.id);
    expect(store.state.inbox.filter((i) => i.agentId === captain.id && i.kind === 'note')).toHaveLength(0);
    expect(store.state.notes.filter((n) => n.type === 'stuck')).toHaveLength(3); // still on the board for you
  });
});
