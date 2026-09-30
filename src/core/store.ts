import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { MusterState } from '../types.js';
import type { MusterPaths } from './paths.js';

type IdKind = keyof MusterState['nextIds'];
const PREFIX: Record<IdKind, string> = { agent: '', task: 'T', note: 'N', feed: 'F', inbox: 'I' };

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
    nextIds: { agent: 2, task: 1, note: 1, feed: 1, inbox: 1 },
  };
}

/** Fills fields missing from older or hand-edited state files. */
export function migrate(raw: Partial<MusterState>, repoRoot: string): MusterState {
  const base = emptyState(repoRoot);
  return {
    ...base,
    ...raw,
    version: 1,
    repoRoot,
    usage: { ...base.usage, ...raw.usage },
    nextIds: { ...base.nextIds, ...raw.nextIds },
  };
}

/**
 * Owns MusterState. Callers mutate `store.state` and then call `commit()`,
 * which writes state.json atomically and emits 'change'.
 */
export class Store extends EventEmitter {
  state: MusterState;

  constructor(private paths: MusterPaths) {
    super();
    this.state = this.load();
  }

  private load(): MusterState {
    if (!existsSync(this.paths.state)) return emptyState(this.paths.root);
    try {
      return migrate(JSON.parse(readFileSync(this.paths.state, 'utf8')), this.paths.root);
    } catch {
      renameSync(this.paths.state, `${this.paths.state}.corrupt-${Date.now()}`);
      return emptyState(this.paths.root);
    }
  }

  save(): void {
    const tmp = `${this.paths.state}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    renameSync(tmp, this.paths.state);
  }

  commit(): void {
    this.save();
    this.emit('change');
  }

}

export function nextId(state: MusterState, kind: IdKind): string {
  return `${PREFIX[kind]}${state.nextIds[kind]++}`;
}
