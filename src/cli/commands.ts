// HTTP-backed commands: agents, goal, status, diff, merge, board, tasks, usage, chat, say.
import type { Agent, FeedItem, MusterConfig, MusterState, Note, Role, Task, UsageState } from '../types.js';
import { api, CliError, requireServer, staleServer, type Ctx } from './context.js';
import { formatFeedItem, formatNotes, formatStatus, formatTasks, formatUsage, roleColor } from './format.js';

const ROLES: Role[] = ['captain', 'crew', 'design'];
const enc = encodeURIComponent;

export function parseRole(r: string): Role {
  const role = r.toLowerCase() as Role;
  if (!ROLES.includes(role)) throw new CliError(`Unknown role "${r}" — use captain, crew or design.`);
  return role;
}

function describeAgent(ctx: Ctx, a: Agent): string {
  return `${roleColor(ctx.c, a.role)(a.id)} (${a.role}) · ${a.status} · ${a.branch}${a.taskId ? ' · ' + a.taskId : ''}`;
}

export async function add(ctx: Ctx, name: string | undefined, opts: { role?: string; task?: string }): Promise<void> {
  const role = opts.role ? parseRole(opts.role) : 'crew';
  if (role === 'captain') throw new CliError('Use `muster role <agent> captain` to change the Captain.');
  let taskId: string | undefined;
  if (opts.task) {
    if (/^T\d+$/i.test(opts.task)) taskId = opts.task.toUpperCase();
    else {
      const t = await api<Task>(ctx, '/api/tasks', { body: { title: opts.task, description: opts.task, actor: 'you' } });
      ctx.out(ctx.c.dim(`Posted task ${t.id}: ${t.title}`));
      taskId = t.id;
    }
  }
  const agent = await api<Agent>(ctx, '/api/agents', { body: { name, role, taskId, actor: 'you' } });
  ctx.out(`Started ${describeAgent(ctx, agent)}`);
}

export async function setRole(ctx: Ctx, agent: string, role: string): Promise<void> {
  const a = await api<Agent>(ctx, `/api/agents/${enc(agent)}/role`, { body: { role: parseRole(role), actor: 'you' } });
  ctx.out(`${describeAgent(ctx, a)}`);
}

export async function ask(ctx: Ctx, goal: string): Promise<void> {
  if (!goal.trim()) throw new CliError('Give the Captain a goal: muster ask "<goal>"');
  await api(ctx, '/api/ask', { body: { text: goal } });
  ctx.out('Sent to the Captain. Watch with `muster attach captain` or `muster chat --follow`.');
}

export async function status(ctx: Ctx): Promise<void> {
  const data = await api<{ state: MusterState; config: MusterConfig; paused: boolean }>(ctx, '/api/state');
  ctx.out(formatStatus(data, ctx.c, ctx.now()));
  const stale = await staleServer(requireServer(ctx).url);
  if (stale) ctx.out(ctx.c.amber(stale));
}

export async function diff(ctx: Ctx, agent: string, opts: { stat?: boolean }): Promise<void> {
  const d = await api<{ branch: string; base: string; stat: string; diff: string }>(
    ctx,
    `/api/agents/${enc(agent)}/diff${opts.stat ? '?stat=1' : ''}`,
  );
  const { c } = ctx;
  ctx.out(c.dim(`${d.base}...${d.branch}`));
  const body = opts.stat ? d.stat : d.diff || d.stat;
  if (!body || !body.trim()) {
    ctx.out('No changes against ' + d.base + '.');
    return;
  }
  const lines = body.replace(/\n$/, '').split('\n');
  ctx.out(
    lines
      .map((l) => {
        if (opts.stat) return l;
        if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ')) return c.bold(l);
        if (l.startsWith('+')) return c.green(l);
        if (l.startsWith('-')) return c.red(l);
        if (l.startsWith('@@')) return c.teal(l);
        return l;
      })
      .join('\n'),
  );
}

export async function merge(ctx: Ctx, agent: string, opts: { force?: boolean }): Promise<void> {
  let r: { ok: boolean; output: string };
  try {
    r = await api<{ ok: boolean; output: string }>(ctx, `/api/agents/${enc(agent)}/merge`, { body: { force: Boolean(opts.force), actor: 'you' } });
  } catch (e) {
    throw new CliError(`Merge refused: ${(e as Error).message}`);
  }
  if (r.output?.trim()) ctx.out(r.output.trimEnd());
  ctx.out(ctx.c.green(`Merged ${agent}'s branch.`));
}

export async function stopAgent(ctx: Ctx, agent: string): Promise<void> {
  const a = await api<Agent>(ctx, `/api/agents/${enc(agent)}/stop`, { body: { actor: 'you' } });
  ctx.out(`Stopped ${describeAgent(ctx, a)}`);
}

export async function startAgent(ctx: Ctx, agent: string): Promise<void> {
  const a = await api<Agent>(ctx, `/api/agents/${enc(agent)}/start`, { body: { actor: 'you' } });
  ctx.out(`Started ${describeAgent(ctx, a)}`);
}

export async function board(ctx: Ctx, opts: { all?: boolean; needsYou?: boolean }): Promise<void> {
  const q = new URLSearchParams();
  if (!opts.all) q.set('open', '1');
  if (opts.needsYou) q.set('needsYou', '1');
  const qs = q.toString();
  const notes = await api<Note[]>(ctx, `/api/notes${qs ? '?' + qs : ''}`);
  ctx.out(notes.length ? formatNotes(notes, ctx.c, ctx.now()) : opts.needsYou ? 'Nothing needs you.' : opts.all ? 'No notes yet.' : 'No open notes.');
}

export async function reply(ctx: Ctx, note: string, text: string, opts: { close?: boolean }): Promise<void> {
  if (!text.trim()) throw new CliError('Reply text is empty.');
  const id = note.toUpperCase().startsWith('N') ? note.toUpperCase() : `N${note}`;
  const n = await api<Note>(ctx, `/api/notes/${enc(id)}/reply`, { body: { actor: 'you', text, close: Boolean(opts.close) } });
  ctx.out(`Replied on ${n.id}${n.open ? '' : ' (closed)'}.`);
}

export async function cancel(ctx: Ctx, task: string, reason: string): Promise<void> {
  const id = task.toUpperCase().startsWith('T') ? task.toUpperCase() : `T${task}`;
  const t = await api<Task>(ctx, `/api/tasks/${enc(id)}/cancel`, { body: { actor: 'you', reason: reason.trim() || 'cancelled by you' } });
  ctx.out(`Cancelled ${t.id} ${t.title}.`);
}

export async function tasks(ctx: Ctx): Promise<void> {
  const list = await api<Task[]>(ctx, '/api/tasks');
  ctx.out(formatTasks(list, ctx.c, ctx.now()));
}

export async function usage(ctx: Ctx): Promise<void> {
  const [u, config] = await Promise.all([
    api<UsageState & { paused: boolean }>(ctx, '/api/usage'),
    api<MusterConfig>(ctx, '/api/config').catch(() => undefined),
  ]);
  ctx.out(formatUsage(u, config, ctx.c, ctx.now()));
}

export async function feed(ctx: Ctx, opts: { limit?: number; agent?: string }): Promise<FeedItem[]> {
  const q = new URLSearchParams({ limit: String(opts.limit ?? 200) });
  if (opts.agent) q.set('agent', opts.agent);
  const items = await api<FeedItem[]>(ctx, `/api/feed?${q}`);
  if (!items.length) ctx.out(ctx.c.dim('No chat yet.'));
  for (const f of items) ctx.out(formatFeedItem(f, ctx.c, ctx.now()));
  return items;
}

export async function say(ctx: Ctx, to: string, text: string): Promise<void> {
  if (!text.trim()) throw new CliError('Message is empty.');
  const target = to.toLowerCase() === 'everyone' || to.toLowerCase() === 'all' ? 'everyone' : to;
  await api<FeedItem>(ctx, '/api/messages', { body: { actor: 'you', to: target, text } });
  ctx.out(`Sent to ${target}.`);
}
