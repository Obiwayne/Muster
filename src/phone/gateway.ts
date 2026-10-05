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
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import QRCode from 'qrcode';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Agent, MusterConfig, MusterState, Note, RemoteVia, Task } from '../types.js';
import { computeProgress, localDate } from '../core/roadmap.js';
import { repoKey, sameToken } from '../core/tokens.js';
import { clonePrefs, mergePrefs, needsFromState, shouldNotify, type NeedItem, type Prefs } from './needs.js';
import { hostsFor, lanHosts as realLanHosts, tailscaleInfo as realTailscale, type TailscaleInfo } from './net.js';
import { displayCode, Pairing } from './pairing.js';
import { digestOf, PENDING_TTL_MS, pendingSummary, pendingTitle, pendingToNeed, pendingView, sweepExpired, type PendingWrite } from './pending.js';
import { DEFAULT_REMOTE_PORT, startRemote, type Remote, type RemoteSettings, type Tunnel, type WriteInput, type WriteOutcome } from './remote.js';
import { desktopSettingsFile, listProjects, orchestratorFetch, orchestratorJson, OrchestratorError, recentRoots, type Project } from './projects.js';
import {
  DEFAULT_PHONE_PORT,
  ensureAdminToken,
  ensureCert,
  ensureDir,
  loadState,
  phoneDir,
  phoneFiles,
  removeServerFile,
  saveState,
  sha256hex,
  writeServerFile,
  type Device,
  type PhoneState,
  type RemoteConfig,
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
  /** The remote connector (docs/REMOTE.md): off unless given. port 0 picks a free port (tests). */
  remote?: { port: number; publicHost?: string; tunnel?: Tunnel; devToken?: string; fetchMetadata?: (url: string) => Promise<unknown> };
  /** Test seam for POST /admin/remote/test (default: global fetch). */
  remoteTestFetch?: typeof fetch;
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
  /** The remote connector, when it is on (a getter: Settings can restart or stop it). */
  readonly remote: Remote | null;
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

/** "https://Muster.Example.com/mcp/" → "muster.example.com"; null/"" → null. Throws 400 on anything that isn't a hostname. */
export function cleanHost(v: unknown): string | null {
  if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) return null;
  if (typeof v !== 'string') throw new HttpError(400, 'publicHost must be a hostname');
  const host = v.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/mcp\/?$/, '').replace(/\/+$/, '');
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) throw new HttpError(400, `"${v}" is not a hostname like muster.example.com`);
  return host;
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
  let remote: Remote | null = null; // started after the routes exist (see "remote connector" below)

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
    items.push(...livePending().map(pendingToNeed)); // held remote writes wait on you too
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

  // ------------------------------------------------------------------ remote writes (docs/REMOTE.md)
  // Same line format as remote.ts's audit; the gateway logs what happens to held writes.
  const auditRemote = (entry: Record<string, unknown>) => {
    try {
      appendFileSync(phoneFiles(dir).remoteLog, JSON.stringify({ at: now().toISOString(), ...entry }) + '\n');
    } catch (e) {
      log(`remote audit log: ${e instanceof Error ? e.message : e}`);
    }
  };
  /** Pending writes still in time; expired ones are dropped (and logged) on the way. */
  const livePending = (): PendingWrite[] => {
    const { live, expired } = sweepExpired(state.remote.pending, now().getTime());
    if (expired.length) {
      state.remote.pending = live;
      save();
      for (const w of expired) auditRemote({ event: 'write_expired', id: w.id, kind: w.kind, project: w.projectName, client: w.client });
    }
    return live;
  };
  const remoteSettings = (): RemoteSettings => ({ confirmWrites: state.remote.confirmWrites, allowApprove: state.remote.allowApprove });
  /** Saved config, else what the flags/env gave this process, else off. */
  const remoteConfig = (): RemoteConfig =>
    state.remote.config ?? { enabled: !!opts.remote, port: opts.remote?.port ?? DEFAULT_REMOTE_PORT, publicHost: opts.remote?.publicHost?.trim().toLowerCase() || null, tunnel: opts.remote?.tunnel ?? null };
  let remoteError: string | null = null;
  let lastTest: { ok: boolean; status?: number; error?: string; at: string } | null = null;
  let applying: Promise<void> = Promise.resolve();
  /** (Re)starts or stops the /mcp listener to match the config. Serialised: Settings may save twice quickly. */
  const applyRemote = (): Promise<void> =>
    (applying = applying.then(async () => {
      const old = remote;
      remote = null;
      await old?.close();
      remoteError = null;
      const c = remoteConfig();
      if (!c.enabled) return;
      try {
        remote = await startRemote(
          { projects, state: stateOf, needs: () => collect(), write: remoteWrite, settings: remoteSettings },
          {
            port: c.port,
            publicHost: c.publicHost ?? undefined,
            tunnel: c.tunnel ?? undefined,
            devToken: opts.remote?.devToken,
            fetchMetadata: opts.remote?.fetchMetadata,
            pcName: state.pcName,
            dir,
            now,
            log,
            onLock: (info) => void remoteAlert(lockText(info)),
          },
        );
      } catch (e) {
        remoteError = (e as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Port ${c.port} is in use by another program` : e instanceof Error ? e.message : String(e);
        log(`remote connector did not start: ${remoteError}`);
      }
    }));
  /** For the "hold is off" banner on the desktop and the phone (which can't turn it back on). */
  const holdInfo = () => ({ on: state.remote.confirmWrites, offSince: state.remote.confirmWrites ? null : (state.remote.offSince ?? null), sentWithoutTap: state.remote.confirmWrites ? 0 : (state.remote.sentWithoutTap ?? 0) });

  /** The running project a write is for: by id or name, or the only running one. */
  const writeProject = async (want: string | undefined): Promise<Project> => {
    const running = (await projects()).filter((p) => p.running);
    if (want?.trim()) {
      const w = want.trim().toLowerCase();
      const p = (await projects()).find((x) => x.id.toLowerCase() === w || x.name.toLowerCase() === w);
      if (!p) throw new Error(`No project "${want}". Running: ${running.map((x) => x.name).join(', ') || 'none'}.`);
      if (!p.running) throw new Error(`${p.name} isn't running; start Muster in it on the PC.`);
      return p;
    }
    if (running.length === 1) return running[0];
    throw new Error(running.length ? `Several projects are running (${running.map((x) => x.name).join(', ')}); say which.` : 'No Muster project is running.');
  };

  /** Checks a write against the project's current state, so you're never asked to approve something that can't run. */
  const checkWrite = async (p: Project, input: WriteInput): Promise<Pick<PendingWrite, 'replyTo' | 'taskTitle'>> => {
    const { state: s, config } = await stateOf(p);
    if (config?.projectName) p.name = config.projectName; // the name you know it by, as Needs you shows it
    const textOk = () => {
      if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('The text is empty.');
      if (input.text.length > 4000) throw new Error('The text is longer than 4000 characters.');
    };
    if (input.kind === 'goal') {
      textOk();
      const captain = s.agents.find((a) => a.role === 'captain');
      if (!captain || captain.status === 'stopped') throw new Error(`${p.name} has no running Captain to take a goal.`);
      return {};
    }
    if (input.kind === 'reply' || input.kind === 'answer') {
      const note = s.notes.find((n) => n.id.toUpperCase() === (input.noteId ?? '').trim().toUpperCase());
      if (!note) throw new Error(`No note "${input.noteId}" in ${p.name}.`);
      input.noteId = note.id;
      // Shown on the card as it was when held: author, note type, text, and for a question menu its questions (answers sit under them).
      const replyTo: NonNullable<PendingWrite['replyTo']> = {
        id: note.id,
        from: note.from,
        type: note.type,
        text: note.text,
        ...(note.ask ? { questions: note.ask.map((q) => ({ header: q.header, question: q.question, multiSelect: q.multiSelect, options: q.options.map((o) => o.label) })) } : {}),
      };
      if (input.kind === 'reply') {
        textOk();
        return { replyTo };
      }
      if (!note.ask) throw new Error(`${note.id} is not a question menu; use muster_reply.`);
      if (!note.open) throw new Error(`${note.id} is already answered.`);
      if (!Array.isArray(input.answers) || input.answers.length !== note.ask.length) throw new Error(`${note.id} has ${note.ask.length} question(s); give one answer for each, in order.`);
      return { replyTo };
    }
    // approve
    if (!state.remote.allowApprove) throw new Error('Approving merges from the connector is switched off in Muster Settings.');
    const task = s.tasks.find((t) => t.id.toUpperCase() === (input.taskId ?? '').trim().toUpperCase());
    if (!task) throw new Error(`No task "${input.taskId}" in ${p.name}.`);
    input.taskId = task.id;
    const ready = (task.status === 'ready_for_merge' && !task.mergeApproval) || task.status === 'awaiting_approval';
    if (!ready) throw new Error(`${task.id} is ${task.status.replace(/_/g, ' ')}; nothing to approve.`);
    return { taskTitle: task.title };
  };

  /** Runs a write against the orchestrator as you, marked `via` so crew chat shows it as yours, via the connector. */
  const runWrite = async (w: PendingWrite, approvedOn: RemoteVia['approvedOn']): Promise<string> => {
    const p = await projectById(w.projectId);
    const via: RemoteVia = { client: w.client, approvedOn, approvedAt: now().toISOString() };
    let summary: string;
    if (w.kind === 'goal') {
      await orchestratorJson(p, 'POST', '/api/ask', { text: w.text, via });
      summary = 'goal sent to the Captain';
    } else if (w.kind === 'reply') {
      await orchestratorJson(p, 'POST', `/api/notes/${encodeURIComponent(w.noteId!)}/reply`, { text: w.text, via });
      summary = `replied on ${w.noteId}`;
    } else if (w.kind === 'answer') {
      await orchestratorJson(p, 'POST', `/api/notes/${encodeURIComponent(w.noteId!)}/answer`, { answers: w.answers, via });
      summary = `answered ${w.noteId}`;
    } else {
      if (!state.remote.allowApprove) throw new HttpError(409, 'Approving merges from the connector was switched off');
      const t = await taskStatus(p, w.taskId!);
      const path = t.status === 'awaiting_approval' ? `/api/tasks/${encodeURIComponent(t.id)}/approve` : `/api/tasks/${encodeURIComponent(t.id)}/approve-merge`;
      await orchestratorJson(p, 'POST', path, {});
      summary = `approved ${t.id}`;
    }
    auditRemote({ event: 'write_sent', id: w.id, kind: w.kind, project: p.name, client: w.client, approvedOn });
    return summary;
  };

  /** RemoteContext.write: hold it for your tap (default), or run it now when the hold is off. */
  const remoteWrite = async (input: WriteInput, client: string): Promise<WriteOutcome> => {
    const p = await writeProject(input.project);
    const context = await checkWrite(p, input);
    const t = now().getTime();
    const base = {
      id: `P${state.remote.nextPending++}`,
      projectId: p.id,
      projectName: p.name,
      kind: input.kind,
      ...(input.text !== undefined ? { text: input.text.trim() } : {}),
      ...(input.noteId ? { noteId: input.noteId } : {}),
      ...(input.answers ? { answers: JSON.parse(JSON.stringify(input.answers)) as WriteInput['answers'] } : {}), // a copy nothing else holds
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...context,
      client,
      createdAt: new Date(t).toISOString(),
      expiresAt: new Date(t + PENDING_TTL_MS).toISOString(),
    };
    const w: PendingWrite = { ...base, digest: digestOf(base) };
    if (!state.remote.confirmWrites) {
      save(); // the id counter
      const summary = await runWrite(w, 'not held');
      state.remote.sentWithoutTap = (state.remote.sentWithoutTap ?? 0) + 1;
      save();
      return { held: false, projectName: p.name, summary };
    }
    state.remote.pending.push(w);
    save();
    auditRemote({ event: 'write_held', id: w.id, kind: w.kind, project: p.name, client });
    schedule(); // phones hear about it now, not at the next poll
    return { held: true, id: w.id, projectName: p.name, expiresAt: w.expiresAt };
  };

  const pendingById = (id: string, pid?: string): PendingWrite => {
    const w = livePending().find((x) => x.id.toUpperCase() === id.toUpperCase() && (!pid || x.projectId === pid));
    if (!w) throw new HttpError(404, `Nothing held as ${id}: it was already sent, discarded or has expired`);
    return w;
  };
  const dropPending = (w: PendingWrite) => {
    state.remote.pending = state.remote.pending.filter((x) => x.id !== w.id);
    save();
  };
  /** Your tap on Send: `digest` is the one on the card you saw, so exactly that is sent (409 otherwise, and nothing is
   *  sent). A failed send stays held, so you can retry or discard it. */
  const sendPending = async (id: string, on: 'phone' | 'desktop', digest: unknown, pid?: string) => {
    const w = pendingById(id, pid);
    if (typeof digest !== 'string' || !digest) throw new HttpError(400, 'Send needs the digest of the card you saw');
    if (digest !== w.digest || digestOf(w) !== w.digest) {
      auditRemote({ event: 'write_send_refused', id: w.id, reason: digest !== w.digest ? 'digest_mismatch' : 'changed_on_disk', on });
      throw new HttpError(409, `${w.id} is not what your screen showed; reload and check it again. Nothing was sent.`);
    }
    const summary = await runWrite(w, on);
    dropPending(w);
    schedule();
    return { ok: true, id: w.id, summary };
  };
  const discardPending = (id: string, on: 'phone' | 'desktop', pid?: string) => {
    const w = pendingById(id, pid);
    dropPending(w);
    auditRemote({ event: 'write_discarded', id: w.id, kind: w.kind, project: w.projectName, client: w.client, on });
    schedule();
    return { ok: true, id: w.id };
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
  admin('GET', '/admin/remote', () => {
    const extra = { hold: holdInfo(), settings: remoteSettings(), config: remoteConfig(), lastTest, ...(remoteError ? { error: remoteError } : {}) };
    return remote ? { ...remote.status(), ...extra } : { enabled: false as const, ...extra };
  });
  admin('GET', '/admin/remote/config', () => remoteConfig());
  admin('PUT', '/admin/remote/config', async ({ body }) => {
    const before = remoteConfig();
    const next: RemoteConfig = { ...before };
    for (const k of Object.keys(body)) if (!['enabled', 'port', 'publicHost', 'tunnel'].includes(k)) throw new HttpError(400, `Unknown setting "${k}"`);
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
      next.enabled = body.enabled;
    }
    if (body.port !== undefined) {
      if (!Number.isInteger(body.port) || (body.port as number) < 0 || (body.port as number) > 65535) throw new HttpError(400, 'port must be a whole number 0–65535');
      next.port = body.port as number;
    }
    if (body.publicHost !== undefined) next.publicHost = cleanHost(body.publicHost);
    if (body.tunnel !== undefined) {
      if (body.tunnel !== null && body.tunnel !== 'cloudflare' && body.tunnel !== 'tailscale') throw new HttpError(400, 'tunnel must be "cloudflare", "tailscale" or null');
      next.tunnel = body.tunnel;
    }
    state.remote.config = next;
    save();
    auditRemote({ event: 'config_changed', before, after: next });
    await applyRemote();
    return { config: next, running: !!remote, ...(remoteError ? { error: remoteError } : {}) };
  });
  /** "Test": can this PC reach its own connector through the public address? Unauthenticated metadata only. */
  admin('POST', '/admin/remote/test', async () => {
    const host = remoteConfig().publicHost;
    if (!host) throw new HttpError(409, 'Set the public address first');
    const at = now().toISOString();
    try {
      const r = await (opts.remoteTestFetch ?? fetch)(`https://${host}/.well-known/oauth-protected-resource/mcp`, { signal: AbortSignal.timeout(8000), redirect: 'error' });
      let resource: unknown;
      try {
        resource = ((await r.json()) as { resource?: unknown }).resource;
      } catch {
        /* not JSON: not our connector */
      }
      const ok = r.status === 200 && resource === `https://${host}/mcp`;
      lastTest = { ok, status: r.status, at, ...(ok ? {} : { error: r.status === 200 ? 'Something answered, but it is not this Muster (wrong resource)' : `Answered ${r.status}` }) };
    } catch (e) {
      lastTest = { ok: false, at, error: e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e) };
    }
    auditRemote({ event: 'test', ok: lastTest.ok, status: lastTest.status, error: lastTest.error });
    return lastTest;
  });
  admin('GET', '/admin/remote/log', ({ req }) => {
    const limit = Math.min(200, Math.max(1, Number(new URL(req.url ?? '/', 'http://x').searchParams.get('limit')) || 50));
    let lines: string[] = [];
    try {
      lines = readFileSync(phoneFiles(dir).remoteLog, 'utf8').trim().split('\n');
    } catch {
      return [];
    }
    const out: unknown[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]));
      } catch {
        /* a torn line */
      }
    }
    return out;
  });
  const remoteOn = (): Remote => {
    if (!remote) throw new HttpError(409, 'Remote access is off');
    return remote;
  };
  /** The code the consent page asks for: single use, 2 minutes; a new one kills the old one. */
  admin('POST', '/admin/remote/code', () => remoteOn().auth.issueCode());
  admin('DELETE', '/admin/remote/code', () => ({ ok: true, cancelled: remoteOn().auth.cancelCode() }));
  /** Disconnect: one connection, or every one. */
  admin('DELETE', '/admin/remote/connections/:id', ({ params }) => {
    if (!remoteOn().auth.revoke(params.id)) throw new HttpError(404, `No connection "${params.id}"`);
    return { ok: true, revoked: 1 };
  });
  admin('DELETE', '/admin/remote/connections', () => ({ ok: true, revoked: remoteOn().auth.revoke() }));
  /** Held writes, and your tap on Send / Discard from the desktop. */
  admin('GET', '/admin/remote/pending', () => livePending().map((w) => ({ id: w.id, projectId: w.projectId, noteId: w.noteId, ...pendingView(w), title: pendingTitle(w), summary: pendingSummary(w) })));
  admin('POST', '/admin/remote/pending/:id/send', ({ params, body }) => sendPending(params.id, 'desktop', body.digest));
  admin('POST', '/admin/remote/pending/:id/discard', ({ params }) => discardPending(params.id, 'desktop'));
  /** Desktop-only switches. Turning the hold off needs `confirm: true` (the desktop's warning dialog): with it off, an
   *  injected bulletin note could get a reply sent without your tap. */
  admin('GET', '/admin/remote/settings', () => remoteSettings());
  admin('PUT', '/admin/remote/settings', ({ body }) => {
    const before = remoteSettings();
    for (const k of Object.keys(body)) if (!['confirmWrites', 'allowApprove', 'confirm'].includes(k)) throw new HttpError(400, `Unknown setting "${k}"`);
    for (const k of ['confirmWrites', 'allowApprove'] as const) if (body[k] !== undefined && typeof body[k] !== 'boolean') throw new HttpError(400, `${k} must be true or false`);
    if (body.confirmWrites === false && before.confirmWrites && body.confirm !== true) {
      throw new HttpError(400, 'Turning off the hold lets a poisoned bulletin note get a reply sent without your tap. Send confirm: true to do it anyway.');
    }
    if (typeof body.confirmWrites === 'boolean') state.remote.confirmWrites = body.confirmWrites;
    if (!state.remote.confirmWrites && before.confirmWrites) {
      state.remote.offSince = now().toISOString();
      state.remote.sentWithoutTap = 0;
    } else if (state.remote.confirmWrites) {
      delete state.remote.offSince;
      delete state.remote.sentWithoutTap;
    }
    if (typeof body.allowApprove === 'boolean') state.remote.allowApprove = body.allowApprove;
    save();
    const after = remoteSettings();
    if (JSON.stringify(after) !== JSON.stringify(before)) auditRemote({ event: 'settings_changed', before, after });
    return after;
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
    return { pcName: state.pcName, projects: list.map((p) => ({ id: p.id, name: p.name, running: p.running })), items, hold: holdInfo() };
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
  /** Send or Discard a held remote write (NeedItem kind 'remote_write'; :id = its "P3"). */
  phone('POST', '/api/projects/:pid/pending/:id/send', ({ params, body }) => sendPending(params.id, 'phone', body.digest, params.pid));
  phone('POST', '/api/projects/:pid/pending/:id/discard', ({ params }) => discardPending(params.id, 'phone', params.pid));
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

  // ------------------------------------------------------------------ remote connector
  /** A remote-access alert on every running project's Bulletin board ("Needs you", phone); the Windows toast once. */
  const remoteAlert = async (text: string): Promise<number> => {
    const running = (await projects()).filter((p) => p.running);
    let sent = 0;
    for (const p of running) {
      try {
        await orchestratorJson(p, 'POST', '/api/remote/alert', { text, toast: sent === 0 });
        sent++;
      } catch (e) {
        log(`remote alert to ${p.name}: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (!sent) log(`remote alert (no running project to show it): ${text}`);
    return sent;
  };
  const lockText = (info: { until: string; ip: string; ipFrom: string; client: string }) => {
    const until = new Date(info.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const from = info.ipFrom === 'socket' || info.ipFrom.startsWith('socket (') ? `${info.ip} (${info.ipFrom})` : info.ip;
    return (
      `Remote access: 5 wrong login codes in a minute, so connector logins are locked until ${until}. ` +
      `Last try came from ${from} via "${info.client}". Nobody got in. If you are pairing, make a new code after ${until}; ` +
      `if this keeps happening, someone is guessing at your tunnel's sign-in page.`
    );
  };
  await applyRemote();

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
    get remote() {
      return remote;
    },
    close: () =>
      (closing ??= (async () => {
        clearInterval(pollTimer);
        clearInterval(pingTimer);
        for (const c of clients) c.ws.terminate();
        wss.close();
        await remote?.close();
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
