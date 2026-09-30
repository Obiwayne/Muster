import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// src/core/paths.ts and dist/core/paths.js both sit two levels below the package root.
export const MUSTER_HOME = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface MusterPaths {
  root: string;
  dir: string;
  config: string;
  state: string;
  server: string;
  logs: string;
  agents: string;
  worktrees: string;
  agentDir(id: string): string;
  agentLog(id: string): string;
  worktree(id: string): string;
}

export function musterPaths(repoRoot: string): MusterPaths {
  const root = resolve(repoRoot);
  const dir = join(root, '.muster');
  return {
    root,
    dir,
    config: join(dir, 'config.json'),
    state: join(dir, 'state.json'),
    server: join(dir, 'server.json'),
    logs: join(dir, 'logs'),
    agents: join(dir, 'agents'),
    worktrees: join(dir, 'worktrees'),
    agentDir: (id) => join(dir, 'agents', id),
    agentLog: (id) => join(dir, 'logs', `${id}.log`),
    worktree: (id) => join(dir, 'worktrees', id),
  };
}

export function ensureDirs(p: MusterPaths): void {
  for (const d of [p.dir, p.logs, p.agents, p.worktrees]) mkdirSync(d, { recursive: true });
}

export function findRepoRoot(cwd = process.cwd()): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** Forward-slash form for paths embedded in generated JSON commands. */
export const posix = (p: string): string => p.replace(/\\/g, '/');
