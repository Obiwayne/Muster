// Helpers shared by the core and orchestrator tests.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent, Role } from '../types.js';

export function makeAgent(id: string, role: Role, extra: Partial<Agent> = {}): Agent {
  const at = new Date().toISOString();
  return { id, role, model: 'sonnet', branch: role === 'captain' ? 'main' : `${id}/work`, worktree: `/tmp/${id}`, status: 'idle', sessionId: `s-${id}`, startedAt: at, lastActivityAt: at, costUsd: 0, ...extra };
}

export const gitSync = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A fresh repo on `main` with one commit and .muster ignored. */
export function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muster-test-'));
  gitSync(dir, 'init', '-q', '-b', 'main');
  gitSync(dir, 'config', 'user.email', 'test@example.com');
  gitSync(dir, 'config', 'user.name', 'Muster Test');
  gitSync(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, '.gitignore'), '.muster/\n');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  gitSync(dir, 'add', '.');
  gitSync(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

export function commitFile(cwd: string, file: string, content: string, message = `edit ${file}`): void {
  writeFileSync(join(cwd, file), content);
  gitSync(cwd, 'add', file);
  gitSync(cwd, 'commit', '-q', '-m', message);
}
