import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { MusterState } from '../types.js';
import type { MusterPaths } from './paths.js';

type IdKind = keyof MusterState['nextIds'];
const PREFIX: Record<IdKind, string> = { agent: '', task: 'T', note: 'N', feed: 'F', inbox: 'I', stage: 'M', goal: 'G', idea: 'R', run: 'RR' };

export function emptyState(repoRoot: string): MusterState {
  return {
    version: 1,
    repoRoot,
    agents: [],
    tasks: [],
    notes: [],
    feed: [],
    inbox: [],
    usage: { perAgentCostUsd: {}, paused: false, weeklyWarned: false },
    nextIds: { agent: 2, task: 1, note: 1, feed: 1, inbox: 1, stage: 1, goal: 1, idea: 1, run: 1 },
  };
}

/** Fills fields missing from older or hand-edited state files. */
export function migrate(raw: Partial<MusterState>, repoRoot: string): MusterState {
  const base = emptyState(repoRoot);
  const nextIds = { ...base.nextIds, ...raw.nextIds };
  // Roadmap ids must never be handed out twice, even if nextIds was lost or hand-edited.
  const above = (ids: string[] | undefined) => Math.max(0, ...(ids ?? []).map((id) => Number(id.replace(/\D/g, '')) || 0)) + 1;
  nextIds.stage = Math.max(nextIds.stage, above(raw.roadmap?.stages?.map((x) => x.id)));
  nextIds.goal = Math.max(nextIds.goal, above(raw.roadmap?.goals?.map((x) => x.id)));
  // Research is absent in state files from before it existed; a partial one gets its lists back.
  const research = raw.research && typeof raw.research === 'object' ? { runs: Array.isArray(raw.research.runs) ? raw.research.runs : [], ideas: Array.isArray(raw.research.ideas) ? raw.research.ideas : [] } : undefined;
  nextIds.run = Math.max(nextIds.run, above(research?.runs.map((x) => x.id)));
  nextIds.idea = Math.max(nextIds.idea, above(research?.ideas.map((x) => x.id)));
  // System notes from before topics existed: tag them so the board offers the right controls.
  for (const n of raw.notes ?? []) {
    if (n.topic || (n.type !== 'system' && n.type !== 'approval')) continue;
    if (n.type === 'system' && /^Weekly usage at \d/.test(n.text)) n.topic = 'weekly_usage';
    else if (n.type === 'system' && /^(Paused: 5-hour window|Resumed: the 5-hour window)/.test(n.text)) n.topic = 'five_hour';
    else if (n.type === 'system' && /^This Muster server is running an older build/.test(n.text)) n.topic = 'stale_build';
    else if (n.type === 'approval' && !n.taskId && /^Roadmap ready for your approval/.test(n.text)) n.topic = 'roadmap';
  }
  return {
    ...base,
    ...raw,
    version: 1,
    repoRoot,
    usage: { ...base.usage, ...raw.usage },
    ...(research ? { research } : {}),
    nextIds,
  };
}

export interface StoreOptions {
  /** Injectable for tests. */
  rename?: (from: string, to: string) => void;
  log?: (msg: string) => void;
  /** Delays between rename attempts; Windows briefly locks files that a virus scanner or indexer has open. */
  retryDelaysMs?: number[];
}

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const DEFAULT_RETRY_DELAYS = [20, 40, 80, 160, 320];

/** Blocks the thread for `ms` (save() is synchronous by design so callers can rely on it before exiting). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Writes `file` via `<file>.tmp` + rename, retrying the rename while Windows holds a lock (virus scanner, indexer).
 * Returns false (and logs) if it never succeeds; the caller keeps its data in memory and writes it next time.
 */
export function writeAtomic(file: string, text: string, opts: StoreOptions = {}): boolean {
  const rename = opts.rename ?? renameSync;
  const log = opts.log ?? ((msg: string) => console.error(msg));
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, text);
  } catch (e) {
    log(`could not write ${tmp}: ${e instanceof Error ? e.message : e}`);
    return false;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      rename(tmp, file);
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!RETRYABLE.has(code) || attempt >= delays.length) {
        log(`could not save ${file} (${code || (e instanceof Error ? e.message : e)}) after ${attempt + 1} attempts; it stays in memory and is written on the next change`);
        return false;
      }
      sleepSync(delays[attempt]);
    }
  }
}

/**
 * Owns MusterState. Callers mutate `store.state` and then call `commit()`,
 * which writes state.json atomically and emits 'change'.
 */
export class Store extends EventEmitter {
  state: MusterState;
  /** The repoRoot state.json was saved with, when it differs from this folder (renamed or moved project). */
  movedFrom?: string;
  private rename: (from: string, to: string) => void;
  private log: (msg: string) => void;
  private retryDelays: number[];

  constructor(
    private paths: MusterPaths,
    opts: StoreOptions = {},
  ) {
    super();
    this.rename = opts.rename ?? renameSync;
    this.log = opts.log ?? ((msg) => console.error(msg));
    this.retryDelays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
    this.state = this.load();
  }

  private load(): MusterState {
    if (!existsSync(this.paths.state)) return emptyState(this.paths.root);
    try {
      const raw = JSON.parse(readFileSync(this.paths.state, 'utf8')) as Partial<MusterState>;
      if (typeof raw.repoRoot === 'string' && raw.repoRoot && raw.repoRoot !== this.paths.root) this.movedFrom = raw.repoRoot;
      return migrate(raw, this.paths.root);
    } catch {
      renameSync(this.paths.state, `${this.paths.state}.corrupt-${Date.now()}`);
      return emptyState(this.paths.root);
    }
  }

  /** Writes state.json via tmp + rename, retrying the rename while Windows holds a lock. Returns false (and logs) if it never succeeds. */
  save(): boolean {
    return writeAtomic(this.paths.state, JSON.stringify(this.state, null, 1), { rename: this.rename, log: this.log, retryDelaysMs: this.retryDelays });
  }

  /** Saves and notifies listeners. The change event fires even if the save failed: in-memory state is the truth. */
  commit(): void {
    try {
      this.save();
    } finally {
      this.emit('change');
    }
  }
}

export function nextId(state: MusterState, kind: IdKind): string {
  return `${PREFIX[kind]}${state.nextIds[kind]++}`;
}
