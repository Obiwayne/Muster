// Claude Code hook entry: `node dist/hooks/hook.js <event>` with the hook JSON on stdin.
// Never blocks or fails the session: every error is swallowed and the exit code is always 0.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { musterFetch } from '../client.js';
import { decide, denyOutput, type PreToolInput } from './guard.js';

const EVENTS = new Set(['prompt', 'stop', 'notification', 'session-start']);

export function readStdin(timeoutMs = 2000): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const timer = setTimeout(() => done(), timeoutMs);
    const done = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(data);
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

function parse(raw: string): Record<string, unknown> {
  try {
    const v = raw.trim() ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function baseBranch(): string {
  if (process.env.MUSTER_BASE_BRANCH) return process.env.MUSTER_BASE_BRANCH;
  const repo = process.env.MUSTER_REPO;
  if (repo) {
    try {
      const cfg = JSON.parse(readFileSync(join(repo, '.muster', 'config.json'), 'utf8'));
      if (typeof cfg.baseBranch === 'string' && cfg.baseBranch) return cfg.baseBranch;
    } catch {
      /* default */
    }
  }
  return 'main';
}

function currentBranch(cwd: string | undefined): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: cwd || undefined,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    }).trim();
  } catch {
    return undefined;
  }
}

function eventDetail(event: string, input: Record<string, unknown>): string | undefined {
  const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  if (event === 'notification') return s(input.message);
  if (event === 'prompt') return s(input.prompt)?.slice(0, 300);
  if (event === 'session-start') return s(input.source);
  return undefined;
}

async function main(): Promise<void> {
  const event = process.argv[2] ?? '';
  const input = parse(await readStdin());

  if (event === 'pre-tool') {
    const pre = input as PreToolInput;
    const cmd = String(pre.tool_input?.command ?? '');
    const env = {
      role: process.env.MUSTER_ROLE,
      worktree: process.env.MUSTER_WORKTREE,
      baseBranch: baseBranch(),
      currentBranch: pre.tool_name === 'Bash' && /\bgit\b[^;&|]*\bmerge\b/.test(cmd) ? currentBranch(pre.cwd) : undefined,
    };
    const d = decide(pre, env);
    if (!d.allow) await new Promise<void>((r) => process.stdout.write(denyOutput(d.reason) + '\n', () => r()));
    return;
  }

  if (EVENTS.has(event)) {
    const agent = process.env.MUSTER_AGENT;
    if (!agent) return;
    const body: Record<string, unknown> = { event, detail: eventDetail(event, input), cwd: input.cwd };
    if (event === 'notification' && typeof input.notification_type === 'string') body.kind = input.notification_type;
    await musterFetch(`/api/agents/${encodeURIComponent(agent)}/event`, { method: 'POST', body, timeoutMs: 3000 });
  }
}

const hardStop = setTimeout(() => process.exit(0), 5000);
hardStop.unref();
main()
  .catch(() => {})
  .finally(() => process.exit(0));
