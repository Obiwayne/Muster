// The orchestrator process: HTTP API, WebSockets, static dashboard, and wiring of store + agents.
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { MusterConfig, MusterEvent, TermClientMessage } from '../types.js';
import { resolveClaudePath } from '../core/claude.js';
import { loadConfig, saveConfig, type ConfigPatch } from '../core/config.js';
import { notify } from '../core/notify.js';
import { ensureDirs, MUSTER_HOME, musterPaths } from '../core/paths.js';
import { Store } from '../core/store.js';
import { newSecret, removeHumanToken, writeHumanToken } from '../core/tokens.js';
import { installRefGuard } from '../core/refguard.js';
import { refreshGuard } from '../core/usage.js';
import { AgentManager, type Timings } from './agents.js';
import { createApi, sendJson } from './api.js';
import { TokenBook, type Caller } from './auth.js';
import { nodePtyLauncher, type PtyLauncher } from './terminal.js';

export interface OrchestratorOptions {
  repoRoot: string;
  /** Overrides config.port; 0 picks a free port. */
  port?: number;
  launcher?: PtyLauncher;
  uiDir?: string;
  timings?: Partial<Timings>;
  /** Resume previously running agents and create the Captain if missing (default true). */
  autoStart?: boolean;
  log?: (msg: string) => void;
  /** Called after a shutdown requested through the API has finished. */
  onShutdown?: () => void;
}

export interface Orchestrator {
  url: string;
  port: number;
  /** The human token ("you"). Agents get their own tokens, see `agentToken`. */
  token: string;
  agentToken(id: string): string;
  store: Store;
  agents: AgentManager;
  shutdown(clean?: boolean): Promise<void>;
}

const PORT_ATTEMPTS = 21;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function packageVersion(): string {
  try {
    return JSON.parse(readFileSync(join(MUSTER_HOME, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function listen(server: Server, port: number): Promise<number> {
  const attempts = port === 0 ? 1 : PORT_ATTEMPTS;
  for (let i = 0; i < attempts; i++) {
    try {
      await new Promise<void>((ok, fail) => {
        server.once('error', fail);
        server.listen(port + i, '127.0.0.1', () => {
          server.off('error', fail);
          ok();
        });
      });
      const addr = server.address();
      return typeof addr === 'object' && addr ? addr.port : port + i;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error(`Ports ${port}-${port + attempts - 1} are all in use`);
}

export async function startOrchestrator(opts: OrchestratorOptions): Promise<Orchestrator> {
  const paths = musterPaths(opts.repoRoot);
  ensureDirs(paths);
  const log = opts.log ?? ((msg: string) => console.log(`${new Date().toISOString()} ${msg}`));
  let config = loadConfig(paths);
  const store = new Store(paths);
  const token = newSecret(); // the human token
  // Agent tokens are derived from a second secret that never leaves this process (see core/tokens.ts).
  const agentSecret = newSecret();
  const tokens = new TokenBook(token, agentSecret);
  const uiDir = resolve(opts.uiDir ?? join(MUSTER_HOME, 'dist', 'ui'));
  let port = 0;
  let claudePath: string | undefined;

  const agents = new AgentManager({
    store,
    paths,
    config: () => config,
    // `token` here is the secret each agent's own token is derived from (claude.ts agentEnv), never the human token.
    server: () => ({ url: `http://127.0.0.1:${port}`, token: agentSecret }),
    launcher: opts.launcher ?? nodePtyLauncher,
    claudePath: () => (claudePath ??= resolveClaudePath(config)),
    log,
    timings: opts.timings,
  });

  // ---- events websocket: debounced full snapshots plus toasts
  const eventClients = new Set<WebSocket>();
  const broadcast = (e: MusterEvent) => {
    const text = JSON.stringify(e);
    for (const ws of eventClients) if (ws.readyState === ws.OPEN) ws.send(text);
  };
  const snapshot = (): MusterEvent => ({ type: 'state', state: store.state, config });
  let snapshotTimer: NodeJS.Timeout | undefined;
  store.on('change', () => {
    if (snapshotTimer) return;
    snapshotTimer = setTimeout(() => {
      snapshotTimer = undefined;
      broadcast(snapshot());
    }, 100);
  });

  let shuttingDown: Promise<void> | undefined;
  const shutdown = (clean = false): Promise<void> =>
    (shuttingDown ??= (async () => {
      log(`shutting down${clean ? ' (clean)' : ''}`);
      clearInterval(guardTimer);
      agents.dispose();
      await agents.stopAll();
      if (clean) {
        const removed = await agents.cleanMerged().catch((e) => (log(`clean failed: ${e}`), [] as string[]));
        if (removed.length) log(`removed merged worktrees: ${removed.join(', ')}`);
      }
      store.save();
      rmSync(paths.server, { force: true });
      removeHumanToken(paths.root, token);
      for (const ws of [...eventClients, ...termWss.clients]) ws.terminate();
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
    })());

  const api = createApi({
    store,
    paths,
    agents,
    version: packageVersion(),
    config: () => config,
    updateConfig: (patch: ConfigPatch) => {
      config = saveConfig(paths, patch);
      if ('claudePath' in patch) claudePath = undefined;
      broadcast(snapshot());
      return config;
    },
    notify: (title, text) => notify(config, title, text),
    toast: (level, text) => broadcast({ type: 'toast', level, text }),
    shutdown: (clean) => void shutdown(clean).then(() => opts.onShutdown?.()),
  });

  const serveUi = (res: ServerResponse, pathname: string) => {
    const index = join(uiDir, 'index.html');
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return sendJson(res, 400, { error: 'Bad path' });
    }
    let file = pathname === '/' || pathname === '/index.html' ? index : resolve(uiDir, '.' + decoded);
    if (file !== uiDir && !file.startsWith(uiDir + sep)) return sendJson(res, 404, { error: 'Not found' });
    if (!existsSync(file) || !statSync(file).isFile()) {
      if (pathname.startsWith('/assets/')) return sendJson(res, 404, { error: 'Not found' });
      file = index; // hash routing: unknown paths get the app shell
    }
    if (file === index) {
      if (!existsSync(index)) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        return res.end('The dashboard is not built. Run `npm run build` in the Muster folder.');
      }
      const html = readFileSync(index, 'utf8').replace(/<meta name="muster-token" content="[^"]*"\s*\/?>/, `<meta name="muster-token" content="${token}">`);
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      return res.end(html);
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  };

  // DNS rebinding: a page on evil.example resolving to 127.0.0.1 still sends Host: evil.example.
  const hostOk = (req: IncomingMessage) => allowedHost(req.headers.host, port);
  const caller = (t: string | string[] | undefined | null): Caller | null => tokens.resolve(t, store.state.agents);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!hostOk(req)) return sendJson(res, 421, { error: 'Unexpected Host header' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/health' && req.method === 'GET') return void api(req, res, url, { actor: 'anonymous', human: false });
      const who = caller(req.headers['x-muster-token']);
      if (!who) return sendJson(res, 401, { error: 'Missing or wrong x-muster-token' });
      return void api(req, res, url, who);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
    serveUi(res, url.pathname);
  });

  // ---- websockets
  const eventsWss = new WebSocketServer({ noServer: true });
  const termWss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const term = /^\/ws\/term\/([^/]+)$/.exec(url.pathname);
    if (!hostOk(req) || !allowedOrigin(req.headers.origin, port)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    const who = caller(url.searchParams.get('token'));
    if (!who || (url.pathname !== '/ws/events' && !term)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    if (!term) {
      return eventsWss.handleUpgrade(req, socket, head, (ws) => {
        eventClients.add(ws);
        ws.on('close', () => eventClients.delete(ws));
        ws.send(JSON.stringify(snapshot()));
      });
    }
    let id: string;
    try {
      id = decodeURIComponent(term[1]);
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      return socket.destroy();
    }
    termWss.handleUpgrade(req, socket, head, (ws) => {
      const backlog = agents.backlog(id);
      if (backlog) ws.send(backlog);
      const detach = agents.attach(id, (data) => ws.readyState === ws.OPEN && ws.send(data));
      ws.on('message', (raw) => {
        let msg: TermClientMessage;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (!who.human) return; // agents may watch a terminal, never type into one
        if (msg.type === 'input' && typeof msg.data === 'string') agents.write(id, msg.data);
        else if (msg.type === 'resize') agents.resize(id, Number(msg.cols), Number(msg.rows));
      });
      ws.on('close', detach);
    });
  });

  port = await listen(server, opts.port ?? config.port);
  // The human token lives outside the repo (agents can read .muster/server.json; their guard denies the token dir).
  writeHumanToken(paths.root, token);
  writeFileSync(paths.server, JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
  try {
    const r = installRefGuard(paths.root, { node: process.execPath, musterHome: MUSTER_HOME });
    if (r.action !== 'current') log(`git ref guard ${r.action}: ${r.file}${r.chained ? ` (chains ${r.chained})` : ''}`);
  } catch (e) {
    log(`could not install the git ref guard: ${e instanceof Error ? e.message : e}`);
  }
  log(`listening on http://127.0.0.1:${port} for ${paths.root}`);

  // A usage window whose reset time passes un-pauses without waiting for the next status line report.
  const guardTimer = setInterval(() => {
    const before = store.state.usage.paused;
    refreshGuard(store.state, config);
    if (store.state.usage.paused !== before) store.commit();
  }, 60_000).unref();

  if (opts.autoStart !== false) await agents.resumeAll().catch((e) => log(`could not start agents: ${e instanceof Error ? e.message : e}`));

  return { url: `http://127.0.0.1:${port}`, port, token, agentToken: (id) => tokens.agentToken(id), store, agents, shutdown };
}

/** Host must name this server by loopback address: 127.0.0.1:<port> or localhost:<port>. */
export function allowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

/** WebSocket Origin: absent (CLI, node clients) or this server's own page. */
export function allowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  const o = origin.toLowerCase();
  return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
}
