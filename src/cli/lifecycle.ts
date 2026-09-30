// `muster up` / `muster down` / `muster ui`: start and stop the orchestrator process.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { serverInfo } from '../client.js';
import type { Agent, MusterConfig, MusterState } from '../types.js';
import { api, CliError, dashboardUrl, healthy, musterHome, NOT_RUNNING, readServerFile, repoRoot, requireServer, type Ctx } from './context.js';
import { roleColor } from './format.js';
import { initMuster } from './init.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function up(ctx: Ctx, opts: { port?: number; ui?: boolean; waitMs?: number; entry?: string }): Promise<void> {
  const { c } = ctx;
  const init = initMuster(ctx.repoRoot ?? ctx.cwd);
  const root = init.root;
  if (init.created.length) ctx.out(c.dim(`Set up ${init.created.join(', ')}`));

  const existing = readServerFile(root);
  let url: string;
  if (existing && (await healthy(`http://127.0.0.1:${existing.port}`))) {
    url = `http://127.0.0.1:${existing.port}`;
    ctx.out(`Muster is already running in this repo (pid ${existing.pid}).`);
  } else {
    const entry = opts.entry ?? join(musterHome(), 'dist', 'orchestrator', 'index.js'); // entry: tests only
    if (!existsSync(entry)) throw new CliError(`Orchestrator not built (${entry} missing) — run \`npm run build\` in the Muster folder.`);
    if (existing) rmSync(join(root, '.muster', 'server.json'), { force: true }); // stale: the process is gone

    const logPath = join(root, '.muster', 'logs', 'orchestrator.log');
    const fd = openSync(logPath, 'a');
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('MUSTER_')) delete env[k]; // don't inherit an agent's identity
    const args = [entry, '--repo', root, ...(opts.port ? ['--port', String(opts.port)] : [])];
    const child = spawn(process.execPath, args, { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env });
    closeSync(fd);
    let exited: number | null | undefined;
    child.on('exit', (code) => (exited = code ?? -1));
    child.on('error', () => (exited = -1));
    child.unref();
    ctx.out(c.dim(`Starting orchestrator (pid ${child.pid})…`));

    const deadline = Date.now() + (opts.waitMs ?? 15000);
    let found: string | null = null;
    while (Date.now() < deadline) {
      if (exited !== undefined) throw new CliError(`The orchestrator exited (code ${exited}). See .muster/logs/orchestrator.log`);
      const info = readServerFile(root);
      if (info && (await healthy(`http://127.0.0.1:${info.port}`))) {
        found = `http://127.0.0.1:${info.port}`;
        break;
      }
      await sleep(250);
    }
    if (!found) throw new CliError('The orchestrator did not come up within 15 s. See .muster/logs/orchestrator.log');
    url = found;
    ctx.out(c.green('Muster is up.'));
  }

  ctx.out(`Dashboard: ${url}/`);
  try {
    const { state } = await api<{ state: MusterState; config: MusterConfig; paused: boolean }>(ctx, '/api/state');
    const captain = state.agents.find((a: Agent) => a.role === 'captain');
    ctx.out(captain ? `Captain: ${roleColor(c, 'captain')(captain.id)} · ${captain.status} · ${captain.branch}` : 'Captain: not started yet');
  } catch (e) {
    ctx.out(c.dim(`(could not read state: ${(e as Error).message})`));
  }
  ctx.out(c.dim('Next: muster ask "<goal>"   ·   muster status   ·   muster attach captain'));
  if (opts.ui !== false) ctx.openUrl(`${url}/`);
}

export async function down(ctx: Ctx, opts: { clean?: boolean; waitMs?: number }): Promise<void> {
  const root = repoRoot(ctx);
  const file = readServerFile(root);
  const info = serverInfo(root);
  if (!info || !(await healthy(info.url))) {
    if (file && !pidAlive(file.pid)) rmSync(join(root, '.muster', 'server.json'), { force: true });
    throw new CliError(NOT_RUNNING);
  }
  try {
    await api(ctx, '/api/shutdown', { body: { clean: Boolean(opts.clean) } });
  } catch (e) {
    // The server may exit before it answers; only a real API error matters.
    if ((e as Error).message !== NOT_RUNNING) throw e;
  }
  ctx.out(ctx.c.dim(opts.clean ? 'Stopping agents and removing merged worktrees…' : 'Stopping agents…'));
  const deadline = Date.now() + (opts.waitMs ?? 30000);
  while (Date.now() < deadline) {
    const still = readServerFile(root);
    const alive = file ? pidAlive(file.pid) : false;
    if (!still && !alive) break;
    await sleep(250);
  }
  if (readServerFile(root) || (file && pidAlive(file.pid))) {
    throw new CliError(`Muster is still shutting down (pid ${file?.pid}). Check .muster/logs/orchestrator.log`);
  }
  ctx.out('Muster is down.');
}

export async function ui(ctx: Ctx): Promise<void> {
  const info = requireServer(ctx);
  if (!(await healthy(info.url))) throw new CliError(NOT_RUNNING);
  const url = dashboardUrl(info);
  ctx.out(`Opening ${url}`);
  ctx.openUrl(url);
}
