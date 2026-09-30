// The orchestrator process: HTTP API, WebSockets, static dashboard, and wiring of store + agents.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { MusterConfig, MusterEvent, TermClientMessage } from '../types.js';
import { resolveClaudePath } from '../core/claude.js';
import { loadConfig, saveConfig, type ConfigPatch } from '../core/config.js';
import { cleanMergedWorktrees } from '../core/git.js';
import { notify } from '../core/notify.js';
import { ensureDirs, MUSTER_HOME, musterPaths } from '../core/paths.js';
import { Store } from '../core/store.js';
import { refreshGuard } from '../core/usage.js';
import { AgentManager, type Timings } from './agents.js';
import { createApi, sendJson } from './api.js';
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
  token: string;
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
  const token = randomBytes(16).toString('hex');
  const uiDir = resolve(opts.uiDir ?? join(MUSTER_HOME, 'dist', 'ui'));
  let port = 0;
  let claudePath: string | undefined;

  const agents = new AgentManager({
    store,
    paths,
    config: () => config,
    server: () => ({ url: `http://127.0.0.1:${port}`, token }),
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
        const removed = await cleanMergedWorktrees(paths.root, paths.worktrees, config.baseBranch).catch((e) => (log(`clean failed: ${e}`), []));
        if (removed.length) log(`removed merged worktrees: ${removed.join(', ')}`);
      }
      store.save();
      rmSync(paths.server, { force: true });
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
    let file = pathname === '/' || pathname === '/index.html' ? index : resolve(uiDir, '.' + decodeURIComponent(pathname));
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

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname !== '/api/health' && req.headers['x-muster-token'] !== token) return sendJson(res, 401, { error: 'Missing or wrong x-muster-token' });
      return void api(req, res, url);
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
    if (url.searchParams.get('token') !== token || (url.pathname !== '/ws/events' && !term)) {
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
    const id = decodeURIComponent(term[1]);
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
        if (msg.type === 'input' && typeof msg.data === 'string') agents.write(id, msg.data);
        else if (msg.type === 'resize') agents.resize(id, Number(msg.cols), Number(msg.rows));
      });
      ws.on('close', detach);
    });
  });

  port = await listen(server, opts.port ?? config.port);
  writeFileSync(paths.server, JSON.stringify({ port, pid: process.pid, token, startedAt: new Date().toISOString() }, null, 2));
  log(`listening on http://127.0.0.1:${port} for ${paths.root}`);

  // A usage window whose reset time passes un-pauses without waiting for the next status line report.
  const guardTimer = setInterval(() => {
    const before = store.state.usage.paused;
    refreshGuard(store.state, config);
    if (store.state.usage.paused !== before) store.commit();
  }, 60_000).unref();

  if (opts.autoStart !== false) await agents.resumeAll().catch((e) => log(`could not start agents: ${e instanceof Error ? e.message : e}`));

  return { url: `http://127.0.0.1:${port}`, port, token, store, agents, shutdown };
}
