// The phone gateway: one HTTPS server per PC (default 0.0.0.0:47910) shared by every project.
// - POST /pair and the phone API (/api/*, `Authorization: Bearer <device key>`), proxied to each project's
//   orchestrator on 127.0.0.1 as "you";
// - the admin API (/admin/*, loopback only, `x-muster-admin: <admin token>`) used by the orchestrators' /api/phone/*;
// - WebSocket /api/events: new needs-you items per device prefs and quiet hours, diffed by polling every 3 s.
// Contract: docs/PHONE.md.
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import QRCode from 'qrcode';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Agent, MusterConfig, MusterState, Note, Task } from '../types.js';
import { computeProgress, localDate } from '../core/roadmap.js';
import { repoKey, sameToken } from '../core/tokens.js';
import { clonePrefs, mergePrefs, needsFromState, shouldNotify, type NeedItem, type Prefs } from './needs.js';
import { hostsFor, lanHosts as realLanHosts, tailscaleInfo as realTailscale, type TailscaleInfo } from './net.js';
import { displayCode, Pairing } from './pairing.js';
import { desktopSettingsFile, listProjects, orchestratorFetch, orchestratorJson, OrchestratorError, recentRoots, type Project } from './projects.js';
import {
  DEFAULT_PHONE_PORT,
  ensureAdminToken,
  ensureCert,
  ensureDir,
  loadState,
  phoneDir,
  removeServerFile,
  saveState,
  sha256hex,
  writeServerFile,
  type Device,
  type PhoneState,
} from './store.js';

export interface GatewayOptions {
  /** State folder (default secretsBase()/phone). */
  dir?: string;
  /** Default 47910; 0 picks a free port (tests). */
  port?: number;
  /** Default 0.0.0.0 (phones on the LAN / tailnet reach it). */
  host?: string;
  /** The desktop app's settings.json (its `recent` list); null = none (tests). */
  recentFile?: string | null;
  /** How often connected phones' projects are polled for new items (default 3 s). */
  pollMs?: number;
  /** How often `{ type: 'ping' }` goes to each phone (default 25 s). */
  pingMs?: number;
  now?: () => Date;
  log?: (msg: string) => void;
  /** Test seams for network detection. */
  lanHosts?: () => string[];
  tailscale?: () => Promise<TailscaleInfo>;
}

export interface Gateway {
  port: number;
  url: string;
  fingerprint: string;
  adminToken: string;
  dir: string;
  /** Pushes new/resolved items to connected phones now (normally every pollMs). */
  pollNow(): Promise<void>;
  /** Phones connected to /api/events whose baseline is taken (tests). */
  readyClients(): number;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BODY = 256 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const SEEN_SAVE_MS = 60_000;

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new HttpError(413, 'Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return ok({});
      try {
        const v = JSON.parse(text);
        ok(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch {
        fail(new HttpError(400, 'Body is not valid JSON'));
      }
    });
    req.on('error', fail);
  });
}

const bearer = (h: string | undefined): string | null => {
  const m = /^Bearer\s+(\S+)$/i.exec(h ?? '');
  return m ? m[1] : null;
};

const text = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `Missing ${name}`);
  return v.trim();
};

/** "3 files changed, 10 insertions(+), 2 deletions(-)" → numbers. */
export function parseDiffStat(stat: string): { added: number; removed: number; files: number } | null {
  const last = stat.trim().split(/\r?\n/).at(-1) ?? '';
  const files = /(\d+) files? changed/.exec(last);
  if (!files) return null;
  return { files: Number(files[1]), added: Number(/(\d+) insertions?\(\+\)/.exec(last)?.[1] ?? 0), removed: Number(/(\d+) deletions?\(-\)/.exec(last)?.[1] ?? 0) };
}

interface Client {
  ws: WebSocket;
  deviceId: string;
  known: Set<string>;
  ready: boolean;
}

interface StateReply {
  state: MusterState;
  config: MusterConfig;
  paused: boolean;
}

export async function startGateway(opts: GatewayOptions = {}): Promise<Gateway> {
  const dir = opts.dir ?? phoneDir();
  ensureDir(dir);
  const log = opts.log ?? ((msg: string) => console.log(`${new Date().toISOString()} ${msg}`));
  const now = opts.now ?? (() => new Date());
  const recentFile = opts.recentFile === undefined ? desktopSettingsFile() : opts.recentFile;
  const getLan = opts.lanHosts ?? (() => realLanHosts());
  const getTailscale = opts.tailscale ?? realTailscale;
  const pairing = new Pairing(() => now().getTime());
  let state: PhoneState = loadState(dir);
  saveState(dir, state); // first run: writes pcName and the defaults
  const adminToken = ensureAdminToken(dir);
  const save = () => saveState(dir, state);
  const lastSaved = new Map<string, number>();

  // Claim the port before anything else: a second copy fails here and never touches the cert files.
  const server: Server = createServer({ minVersion: 'TLSv1.2' });
  const port = await new Promise<number>((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port ?? DEFAULT_PHONE_PORT, opts.host ?? '0.0.0.0', () => {
      server.off('error', fail);
      const a = server.address();
      ok(typeof a === 'object' && a ? a.port : (opts.port ?? DEFAULT_PHONE_PORT));
    });
  });
  const pair = await ensureCert(dir, state.pcName);
  server.setSecureContext({ cert: pair.cert, key: pair.key });

  // ------------------------------------------------------------------ projects and needs
  const roots = (): string[] => [...state.projects, ...recentRoots(recentFile)];
  const projects = () => listProjects(roots());
  const projectById = async (pid: string): Promise<Project> => {
    const p = (await projects()).find((x) => x.id === pid);
    if (!p) throw new HttpError(404, `No project "${pid}"`);
    if (!p.running) throw new HttpError(409, `${p.name} isn't running; start Muster in it on the PC`);
    return p;
  };
  const stateOf = (p: Project) => orchestratorJson<StateReply>(p, 'GET', '/api/state');

  /** Items of every running project; `polled` = the projects whose state was read (others keep their old items). */
  const collect = async (): Promise<{ projects: Project[]; items: NeedItem[]; polled: Set<string> }> => {
    const list = await projects();
    const items: NeedItem[] = [];
    const polled = new Set<string>();
    await Promise.all(
      list
        .filter((p) => p.running)
        .map(async (p) => {
          try {
            const r = await stateOf(p);
            if (r.config?.projectName) p.name = r.config.projectName;
            items.push(...needsFromState(r.state, p.id, p.name));
            polled.add(p.id);
          } catch (e) {
            log(`could not read ${p.name}: ${e instanceof Error ? e.message : e}`);
          }
        }),
    );
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { projects: list, items, polled };
  };

  // ------------------------------------------------------------------ devices
  const deviceByKey = (key: string | null): Device | undefined => {
    if (!key) return undefined;
    const hash = sha256hex(key);
    return state.devices.find((d) => sameToken(d.keyHash, hash));
  };
  const touch = (d: Device) => {
    d.lastSeenAt = now().toISOString();
    const t = Date.now();
    if (t - (lastSaved.get(d.id) ?? 0) > SEEN_SAVE_MS) {
      lastSaved.set(d.id, t);
      save();
    }
  };
  const clients = new Set<Client>();
  const send = (ws: WebSocket, msg: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const dropDevice = (id: string): boolean => {
    const before = state.devices.length;
    state.devices = state.devices.filter((d) => d.id !== id);
    if (state.devices.length === before) return false;
    save();
    for (const c of clients) if (c.deviceId === id) c.ws.close(4001, 'unlinked');
    return true;
  };

  const networkInfo = async () => {
    const lan = getLan();
    const tailscale = await getTailscale();
    return { lan, tailscale, hosts: hostsFor(state.network.mode, lan, tailscale) };
  };

  // ------------------------------------------------------------------ routes
  type Handler = (r: { params: Record<string, string>; body: Record<string, unknown>; device?: Device; req: IncomingMessage; res: ServerResponse }) => unknown;
  interface Route {
    method: string;
    pattern: RegExp;
    keys: string[];
    handler: Handler;
  }
  const adminRoutes: Route[] = [];
  const phoneRoutes: Route[] = [];
  const add = (list: Route[], method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    list.push({ method, pattern, keys, handler });
  };
  const admin = (m: string, p: string, h: Handler) => add(adminRoutes, m, p, h);
  const phone = (m: string, p: string, h: Handler) => add(phoneRoutes, m, p, h);

  // ---- admin
  admin('POST', '/admin/pair-code', async () => {
    const { code, expiresAt } = pairing.issue();
    const { hosts } = await networkInfo();
    const qrText = `muster://pair?c=${code}&p=${port}&f=${pair.fingerprint}&n=${encodeURIComponent(state.pcName)}&h=${hosts.map(encodeURIComponent).join(',')}`;
    const qrSvg = await QRCode.toString(qrText, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { code, display: displayCode(code), expiresAt: new Date(expiresAt).toISOString(), qrSvg, qrText, hosts };
  });
  admin('GET', '/admin/status', async () => {
    const { lan, tailscale } = await networkInfo();
    const online = new Set([...clients].map((c) => c.deviceId));
    const list = await projects();
    return {
      pcName: state.pcName,
      port,
      fingerprint: pair.fingerprint,
      network: { mode: state.network.mode, lanHosts: lan, tailscale },
      devices: state.devices.map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, online: online.has(d.id) })),
      projects: list.map((p) => ({ id: p.id, name: p.name, root: p.root, running: p.running })),
    };
  });
  admin('PUT', '/admin/network', ({ body }) => {
    if (body.mode !== 'lan' && body.mode !== 'tailscale') throw new HttpError(400, 'mode must be "lan" or "tailscale"');
    state.network.mode = body.mode;
    save();
    return { ok: true, mode: state.network.mode };
  });
  admin('DELETE', '/admin/devices/:id', ({ params }) => {
    if (!dropDevice(params.id)) throw new HttpError(404, `No device "${params.id}"`);
    return { ok: true };
  });
  admin('POST', '/admin/test', () => {
    let sent = 0;
    for (const c of clients) {
      if (c.ws.readyState !== c.ws.OPEN) continue;
      send(c.ws, { type: 'test' });
      sent++;
    }
    return { ok: true, sent };
  });
  admin('GET', '/admin/send', () => state.defaultPrefs);
  admin('PUT', '/admin/send', ({ body }) => {
    try {
      state.defaultPrefs = mergePrefs(state.defaultPrefs, body);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    save();
    return state.defaultPrefs;
  });
  admin('POST', '/admin/projects', ({ body }) => {
    const raw = text(body.root, 'root');
    if (!isAbsolute(raw)) throw new HttpError(400, 'root must be an absolute path');
    const root = resolve(raw);
    if (!existsSync(root)) throw new HttpError(400, `No folder ${root}`);
    const id = repoKey(root);
    if (!state.projects.some((r) => repoKey(r) === id)) {
      state.projects.push(root);
      save();
    }
    return { ok: true, id };
  });

  // ---- phone
  phone('GET', '/api/needs', async () => {
    const { projects: list, items } = await collect();
    return { pcName: state.pcName, projects: list.map((p) => ({ id: p.id, name: p.name, running: p.running })), items };
  });
  phone('GET', '/api/projects/:pid/tasks/:tid', async ({ params }) => {
    const p = await projectById(params.pid);
    const { state: s } = await stateOf(p);
    const task = s.tasks.find((t) => t.id === params.tid.toUpperCase());
    if (!task) throw new HttpError(404, `No task "${params.tid}" in ${p.name}`);
    const review = [...s.notes].reverse().find((n) => n.type === 'review' && n.taskId === task.id);
    const captain = s.agents.find((a) => a.role === 'captain');
    let diffStat: ReturnType<typeof parseDiffStat> = null;
    if (task.branch && captain && task.status !== 'merged') {
      try {
        const d = await orchestratorJson<{ stat: string }>(p, 'GET', `/api/agents/${encodeURIComponent(captain.id)}/diff?branch=${encodeURIComponent(task.branch)}&stat=1`);
        diffStat = parseDiffStat(d.stat ?? '');
      } catch {
        diffStat = null;
      }
    }
    return {
      task: { id: task.id, title: task.title, branch: task.branch ?? null, status: task.status, stations: task.stations, builder: builderOf(s, task), reviewedSha: task.reviewedSha ?? null },
      review: review ? { from: review.from, text: review.text, at: review.createdAt } : null,
      evidence: (task.evidence ?? []).map((e) => ({ id: e.id, summary: e.summary, files: e.files.map((f) => ({ name: f.name, kind: f.kind })) })),
      diffStat,
    };
  });
  phone('GET', '/api/projects/:pid/tasks/:tid/evidence/:eid/:file', async ({ params, res }) => {
    const p = await projectById(params.pid);
    const r = await orchestratorFetch(p, 'GET', `/api/tasks/${encodeURIComponent(params.tid)}/evidence/${encodeURIComponent(params.eid)}/${encodeURIComponent(params.file)}`, undefined, 60_000);
    if (!r.ok || !r.body) {
      const err = await r.json().catch(() => null);
      throw new HttpError(r.status, (err as { error?: string } | null)?.error ?? 'Evidence not found');
    }
    const headers: Record<string, string> = { 'content-type': r.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' };
    const len = r.headers.get('content-length');
    if (len) headers['content-length'] = len;
    res.writeHead(200, headers);
    Readable.fromWeb(r.body as import('node:stream/web').ReadableStream).pipe(res);
    return RAW;
  });
  const taskStatus = async (p: Project, tid: string): Promise<Task> => {
    const list = await orchestratorJson<Task[]>(p, 'GET', '/api/tasks');
    const t = list.find((x) => x.id === tid.toUpperCase());
    if (!t) throw new HttpError(404, `No task "${tid}" in ${p.name}`);
    return t;
  };
  phone('POST', '/api/projects/:pid/tasks/:tid/approve', async ({ params }) => {
    const p = await projectById(params.pid);
    const t = await taskStatus(p, params.tid);
    // A task waiting at a human station is approved there; a reviewed one is approved for merge.
    const path = t.status === 'awaiting_approval' ? `/api/tasks/${encodeURIComponent(t.id)}/approve` : `/api/tasks/${encodeURIComponent(t.id)}/approve-merge`;
    const task = await orchestratorJson<Task>(p, 'POST', path, {});
    return { ok: true, task: { id: task.id, status: task.status, mergeApproval: task.mergeApproval ?? null } };
  });
  phone('POST', '/api/projects/:pid/tasks/:tid/send-back', async ({ params, body }) => {
    const p = await projectById(params.pid);
    const note = text(body.text, 'text');
    const t = await taskStatus(p, params.tid);
    const path = t.status === 'awaiting_approval' ? `/api/tasks/${encodeURIComponent(t.id)}/reject` : `/api/tasks/${encodeURIComponent(t.id)}/sendback`;
    const task = await orchestratorJson<Task>(p, 'POST', path, { note });
    return { ok: true, task: { id: task.id, status: task.status } };
  });
  phone('GET', '/api/projects/:pid/notes/:nid', async ({ params }) => {
    const p = await projectById(params.pid);
    const { state: s } = await stateOf(p);
    const note = s.notes.find((n) => n.id === params.nid.toUpperCase());
    if (!note) throw new HttpError(404, `No note "${params.nid}" in ${p.name}`);
    return note;
  });
  phone('POST', '/api/projects/:pid/notes/:nid/reply', async ({ params, body }) => {
    const p = await projectById(params.pid);
    return orchestratorJson<Note>(p, 'POST', `/api/notes/${encodeURIComponent(params.nid)}/reply`, { text: text(body.text, 'text') });
  });
  phone('POST', '/api/projects/:pid/notes/:nid/answer', async ({ params, body }) => {
    const p = await projectById(params.pid);
    if (!Array.isArray(body.answers)) throw new HttpError(400, 'answers must be a list');
    return orchestratorJson<Note>(p, 'POST', `/api/notes/${encodeURIComponent(params.nid)}/answer`, { answers: body.answers });
  });
  phone('POST', '/api/projects/:pid/checkout/commit', async ({ params }) => orchestratorJson(await projectById(params.pid), 'POST', '/api/checkout/commit', {}));
  phone('POST', '/api/projects/:pid/checkout/stash', async ({ params }) => orchestratorJson(await projectById(params.pid), 'POST', '/api/checkout/stash', {}));
  /** The Crew tab's "Where we are" card: overall %, the current goal and the Captain's last roadmap_status. */
  const whereWeAre = (s: MusterState) => {
    const r = s.roadmap;
    if (!r) return null;
    let pg: ReturnType<typeof computeProgress> = null;
    try {
      pg = computeProgress(s, localDate(now()));
    } catch {
      /* a bad date in the state: show no % rather than fail the tab */
    }
    const goal = pg?.currentGoalId ? r.goals.find((g) => g.id === pg.currentGoalId) : undefined;
    return {
      pct: pg ? pg.overall.percent : null,
      current: goal ? { id: goal.id, title: goal.title } : null,
      status: r.statusLine ? { text: r.statusLine.text, at: r.statusLine.at } : null,
    };
  };
  phone('GET', '/api/projects/:pid/crew', async ({ params }) => {
    const p = await projectById(params.pid);
    const { state: s } = await stateOf(p);
    const title = (id?: string) => (id ? s.tasks.find((t) => t.id === id)?.title ?? '' : '');
    const win = (w?: { usedPercentage: number; resetsAt?: string }) => (w ? { pct: w.usedPercentage, resetsAt: w.resetsAt ?? null } : null);
    return {
      agents: s.agents.map((a: Agent) => ({ id: a.id, role: a.role, status: a.status, taskId: a.taskId ?? null, branch: a.branch, detail: title(a.taskId) })),
      usage: { fiveHour: win(s.usage.fiveHour), weekly: win(s.usage.sevenDay) },
      paused: s.usage.paused,
      roadmap: whereWeAre(s),
    };
  });
  phone('GET', '/api/prefs', ({ device }) => device!.prefs);
  phone('PUT', '/api/prefs', ({ device, body }) => {
    try {
      device!.prefs = mergePrefs(device!.prefs, body);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    save();
    return device!.prefs;
  });
  phone('DELETE', '/api/device', ({ device }) => {
    dropDevice(device!.id);
    return { ok: true };
  });

  const match = (list: Route[], method: string, path: string) => {
    const candidates = list.filter((r) => r.pattern.test(path));
    if (!candidates.length) throw new HttpError(404, `No route ${path}`);
    const r = candidates.find((c) => c.method === method);
    if (!r) throw new HttpError(405, `${method} not allowed on ${path}`);
    const m = r.pattern.exec(path)!;
    let params: Record<string, string>;
    try {
      params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    } catch {
      throw new HttpError(400, 'Bad path');
    }
    return { r, params };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'https://gateway');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';
    if (path === '/api/health' && method === 'GET') return sendJson(res, 200, { ok: true, pcName: state.pcName, fingerprint: pair.fingerprint });
    if (path === '/pair') {
      if (method !== 'POST') throw new HttpError(405, `${method} not allowed on /pair`);
      return sendJson(res, 200, await pairDevice(await readBody(req)));
    }
    if (path.startsWith('/admin/')) {
      if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) throw new HttpError(403, 'The admin API only answers on this PC');
      const t = req.headers['x-muster-admin'];
      if (typeof t !== 'string' || !sameToken(t, adminToken)) throw new HttpError(401, 'Missing or wrong x-muster-admin');
      const { r, params } = match(adminRoutes, method, path);
      const body = method === 'GET' || method === 'HEAD' ? {} : await readBody(req);
      return sendJson(res, 200, (await r.handler({ params, body, req, res })) ?? null);
    }
    if (path.startsWith('/api/')) {
      const device = deviceByKey(bearer(req.headers.authorization));
      if (!device) throw new HttpError(401, 'This phone is not linked to this PC');
      touch(device);
      const { r, params } = match(phoneRoutes, method, path);
      const body = method === 'GET' || method === 'HEAD' ? {} : await readBody(req);
      const result = await r.handler({ params, body, device, req, res });
      if (result === RAW) return;
      return sendJson(res, 200, result ?? null);
    }
    throw new HttpError(404, `No route ${path}`);
  };

  const pairDevice = async (body: Record<string, unknown>) => {
    const check = pairing.redeem(body.code);
    if (check === 'limited') throw new HttpError(429, 'Too many wrong codes; wait a minute and try again');
    if (check === 'expired') throw new HttpError(401, 'That code has expired; make a new one on the PC');
    if (check === 'wrong') throw new HttpError(401, 'Wrong code');
    const key = randomBytes(32).toString('base64url');
    const at = now().toISOString();
    const name = typeof body.deviceName === 'string' && body.deviceName.trim() ? body.deviceName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) : 'Phone';
    const device: Device = { id: `d${randomBytes(6).toString('hex')}`, name, keyHash: sha256hex(key), createdAt: at, lastSeenAt: at, prefs: clonePrefs(state.defaultPrefs) };
    state.devices.push(device);
    save();
    log(`paired ${device.name} (${device.id})`);
    const { hosts } = await networkInfo();
    return { deviceId: device.id, key, pcName: state.pcName, hosts };
  };

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((e) => {
      const status = e instanceof HttpError || e instanceof OrchestratorError ? e.status : 500;
      if (status === 500) log(`error on ${req.method} ${req.url}: ${e instanceof Error ? e.stack : e}`);
      sendJson(res, status, { error: e instanceof Error ? e.message : String(e) });
    });
  });

  // ------------------------------------------------------------------ events websocket
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'https://gateway');
    const device = url.pathname === '/api/events' ? deviceByKey(bearer(req.headers.authorization)) : undefined;
    if (!device) {
      socket.write(url.pathname === '/api/events' ? 'HTTP/1.1 401 Unauthorized\r\n\r\n' : 'HTTP/1.1 404 Not Found\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      touch(device);
      const client: Client = { ws, deviceId: device.id, known: new Set(), ready: false };
      clients.add(client);
      ws.on('close', () => clients.delete(client));
      ws.on('error', () => clients.delete(client));
      // Items already waiting are the baseline: the phone fetches them with GET /api/needs; only new ones are pushed.
      void collect()
        .then(({ items }) => {
          for (const i of items) client.known.add(i.id);
        })
        .catch(() => {})
        .finally(() => {
          client.ready = true;
          schedule();
        });
    });
  });

  let polling: Promise<void> | null = null;
  const poll = async (): Promise<void> => {
    if (![...clients].some((c) => c.ready)) return;
    const { items, polled } = await collect();
    const current = new Set(items.map((i) => i.id));
    const t = now();
    for (const c of clients) {
      if (!c.ready) continue;
      const device = state.devices.find((d) => d.id === c.deviceId);
      if (!device) {
        c.ws.close(4001, 'unlinked');
        continue;
      }
      for (const item of items) {
        if (c.known.has(item.id)) continue;
        c.known.add(item.id);
        if (shouldNotify(item, device.prefs, t)) send(c.ws, { type: 'need', item });
      }
      for (const id of [...c.known]) {
        if (current.has(id) || !polled.has(id.slice(0, id.indexOf(':')))) continue; // unreachable projects keep their items
        c.known.delete(id);
        send(c.ws, { type: 'resolved', id });
      }
    }
  };
  const pollNow = (): Promise<void> => (polling ??= poll()
    .catch((e) => log(`poll failed: ${e instanceof Error ? e.message : e}`))
    .finally(() => (polling = null)));
  const schedule = () => void pollNow();
  const pollTimer = setInterval(schedule, opts.pollMs ?? 3000);
  const pingTimer = setInterval(() => {
    for (const c of clients) send(c.ws, { type: 'ping' });
  }, opts.pingMs ?? 25_000);
  pollTimer.unref();
  pingTimer.unref();

  writeServerFile(dir, { port, pid: process.pid, startedAt: new Date().toISOString(), fingerprint: pair.fingerprint });
  log(`phone gateway listening on https://${opts.host ?? '0.0.0.0'}:${port} (fingerprint ${pair.fingerprint.slice(0, 16)}…)`);

  let closing: Promise<void> | undefined;
  return {
    port,
    url: `https://127.0.0.1:${port}`,
    fingerprint: pair.fingerprint,
    adminToken,
    dir,
    pollNow,
    readyClients: () => [...clients].filter((c) => c.ready).length,
    close: () =>
      (closing ??= (async () => {
        clearInterval(pollTimer);
        clearInterval(pingTimer);
        for (const c of clients) c.ws.terminate();
        wss.close();
        removeServerFile(dir, process.pid, port);
        await new Promise<void>((r) => server.close(() => r()));
        server.closeAllConnections?.();
      })()),
  };
}

/** A handler that already wrote the response (a proxied file). */
const RAW = Symbol('raw');

function builderOf(s: MusterState, task: Task): string | null {
  for (const e of task.history) {
    if (e.kind !== 'claimed' && e.kind !== 'assigned') continue;
    const a = s.agents.find((x) => x.id === e.agentId);
    if (a && a.role !== 'captain') return a.id;
  }
  return task.assignee ?? null;
}

export type { Prefs };
