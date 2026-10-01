// WebSocket commands: `muster attach` (live terminal) and `muster chat --follow`.
import WebSocket from 'ws';
import { serverInfo } from '../client.js';
import type { FeedItem, MusterConfig, MusterEvent, MusterState, TermClientMessage } from '../types.js';
import { api, CliError, NOT_RUNNING, repoRoot, requireServer, type Ctx } from './context.js';
import { feed } from './commands.js';
import { Coalescer, resizeDeduper } from './coalesce.js';
import { formatFeedItem, idNum } from './format.js';

const DETACH = 0x1d; // Ctrl+]

function wsUrl(httpUrl: string, path: string, token: string): string {
  return httpUrl.replace(/^http/, 'ws').replace(/\/$/, '') + path + '?token=' + encodeURIComponent(token);
}

export async function attach(ctx: Ctx, agent: string): Promise<void> {
  const { state } = await api<{ state: MusterState; config: MusterConfig }>(ctx, '/api/state');
  const a = state.agents.find((x) => x.id === agent);
  if (!a) {
    const ids = state.agents.map((x) => x.id).join(', ') || 'none';
    throw new CliError(`No agent "${agent}" (agents: ${ids}).`);
  }
  const info = requireServer(ctx);
  const ws = new WebSocket(wsUrl(info.url, `/ws/term/${encodeURIComponent(agent)}`, info.token) + '&owner=1');
  const stdin = process.stdin;
  const stdout = process.stdout;

  const send = (m: TermClientMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };
  const resizeWorthSending = resizeDeduper();
  const sendResize = () => {
    if (resizeWorthSending(stdout.columns, stdout.rows)) send({ type: 'resize', cols: stdout.columns, rows: stdout.rows });
  };
  let detached = false;
  const onData = (buf: Buffer) => {
    const i = buf.indexOf(DETACH);
    if (i >= 0) {
      if (i > 0) send({ type: 'input', data: buf.subarray(0, i).toString('utf8') });
      detached = true;
      ws.close();
      return;
    }
    send({ type: 'input', data: buf.toString('utf8') });
  };
  const out = new Coalescer((b) => stdout.write(b));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    out.flush();
    stdin.off('data', onData);
    stdout.off('resize', sendResize);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    stdout.write('\x1b[0m'); // reset attributes the agent may have left on
  };

  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => {
      stdout.write(ctx.c.dim(`[muster] Attached to ${agent}. Press Ctrl+] to detach.`) + '\r\n');
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.on('data', onData);
      stdin.resume();
      stdout.on('resize', sendResize);
      sendResize();
    });
    ws.on('message', (data: WebSocket.RawData) => {
      out.push(Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer));
    });
    ws.on('close', () => {
      cleanup();
      stdout.write('\r\n' + ctx.c.dim(detached ? `[muster] Detached from ${agent}.` : `[muster] ${agent}'s terminal closed.`) + '\n');
      resolve();
    });
    ws.on('error', (err) => {
      cleanup();
      reject(new CliError(`Could not attach to ${agent}: ${err.message}`));
    });
  });
}

/** Print the feed, then (follow) stream new items from /ws/events, reconnecting until Ctrl+C. */
export async function chat(ctx: Ctx, opts: { follow?: boolean; agent?: string; limit?: number }): Promise<void> {
  const items = await feed(ctx, { agent: opts.agent, limit: opts.limit });
  if (!opts.follow) return;
  let last = items.reduce((m, f) => Math.max(m, idNum(f.id)), 0);
  const root = repoRoot(ctx);
  const matches = (f: FeedItem) => !opts.agent || f.from === opts.agent || f.to === opts.agent || f.to === 'everyone';
  let stopping = false;
  let current: WebSocket | null = null;
  const onSig = () => {
    stopping = true;
    current?.close();
  };
  process.once('SIGINT', onSig);
  ctx.out(ctx.c.dim('— following; Ctrl+C to stop —'));

  let warned = false;
  while (!stopping) {
    const info = serverInfo(root);
    if (!info) {
      if (!warned) ctx.out(ctx.c.dim(`[muster] ${NOT_RUNNING}; waiting…`));
      warned = true;
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(wsUrl(info.url, '/ws/events', info.token));
      current = ws;
      ws.on('open', () => {
        if (warned) ctx.out(ctx.c.dim('[muster] reconnected'));
        warned = false;
      });
      ws.on('message', (data: WebSocket.RawData) => {
        let ev: MusterEvent;
        try {
          ev = JSON.parse(data.toString()) as MusterEvent;
        } catch {
          return;
        }
        if (ev.type === 'toast') {
          ctx.out(ctx.c.dim(`[${ev.level}] ${ev.text}`));
          return;
        }
        if (ev.type !== 'state') return;
        const fresh = ev.state.feed.filter((f) => idNum(f.id) > last).sort((a, b) => idNum(a.id) - idNum(b.id));
        for (const f of fresh) {
          last = Math.max(last, idNum(f.id));
          if (matches(f)) ctx.out(formatFeedItem(f, ctx.c, ctx.now()));
        }
      });
      ws.on('close', () => resolve());
      ws.on('error', () => {
        /* close follows */
      });
    });
    current = null;
    if (!stopping) {
      if (!warned) ctx.out(ctx.c.dim('[muster] connection lost; reconnecting…'));
      warned = true;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  process.off('SIGINT', onSig);
}
