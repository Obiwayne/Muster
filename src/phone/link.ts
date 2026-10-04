// Talking to the phone gateway from this PC: start it when it isn't running (detached, hidden, like `muster up`
// starts orchestrators), and call its admin API over HTTPS pinned to its own certificate.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';
import { MUSTER_HOME } from '../core/paths.js';
import { certFingerprint, ensureDir, phoneDir, phoneFiles, pidAlive, readAdminToken, readServerFile, type ServerFile } from './store.js';

export interface AdminReply {
  status: number;
  contentType: string;
  body: string;
}

export const gatewayEntry = (home = MUSTER_HOME): string => join(home, 'dist', 'phone', 'index.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One HTTPS request to the gateway on 127.0.0.1, trusting only the certificate in its state folder. */
export function adminRequest(dir: string, method: string, path: string, body?: string, timeoutMs = 10_000): Promise<AdminReply> {
  const info = readServerFile(dir);
  const token = readAdminToken(dir);
  let cert: string;
  try {
    cert = readFileSync(phoneFiles(dir).cert, 'utf8');
  } catch {
    return Promise.reject(new Error('The phone gateway has no certificate yet'));
  }
  if (!info || !token) return Promise.reject(new Error('The phone gateway is not running'));
  const fingerprint = certFingerprint(cert);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: info.port,
        method,
        path,
        ca: cert,
        // The certificate is pinned: exactly the one on disk, whatever name it carries.
        checkServerIdentity: (_host, peer) => (peer.fingerprint256?.replace(/:/g, '').toLowerCase() === fingerprint ? undefined : new Error('The phone gateway presented another certificate')),
        headers: { 'x-muster-admin': token, ...(body !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 502, contentType: String(res.headers['content-type'] ?? 'application/json'), body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('The phone gateway did not answer')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** server.json names a live process whose port answers. */
export async function gatewayRunning(dir = phoneDir()): Promise<ServerFile | null> {
  const info = readServerFile(dir);
  if (!info || !pidAlive(info.pid)) return null;
  try {
    const r = await adminRequest(dir, 'GET', '/api/health', undefined, 2000);
    return r.status === 200 ? info : null;
  } catch {
    return null;
  }
}

export interface EnsureOptions {
  dir?: string;
  entry?: string;
  /** Wait until it answers (default true; `muster up` doesn't wait). */
  wait?: boolean;
  waitMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Starts the gateway unless one is running. Returns its server.json, or null when not waiting / it didn't come up. */
export async function ensureGateway(opts: EnsureOptions = {}): Promise<{ started: boolean; info: ServerFile | null }> {
  const dir = opts.dir ?? phoneDir(opts.env);
  const running = await gatewayRunning(dir);
  if (running) return { started: false, info: running };
  const entry = opts.entry ?? gatewayEntry();
  if (!existsSync(entry)) throw new Error(`The phone gateway is not built (${entry} missing); run \`npm run build\` in the Muster folder`);
  ensureDir(dir);
  const env = { ...(opts.env ?? process.env) };
  // Not an agent's identity, nor a project's: only where the secrets live travels.
  for (const k of Object.keys(env)) if (k.startsWith('MUSTER_') && k !== 'MUSTER_SECRETS_DIR') delete env[k];
  const fd = openSync(phoneFiles(dir).log, 'a');
  const child = spawn(process.execPath, [entry], { detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env });
  closeSync(fd);
  child.on('error', () => {});
  child.unref();
  if (opts.wait === false) return { started: true, info: null };
  const deadline = Date.now() + (opts.waitMs ?? 15_000);
  while (Date.now() < deadline) {
    await sleep(200);
    const info = await gatewayRunning(dir);
    if (info) return { started: true, info };
  }
  return { started: true, info: null };
}

/** What an orchestrator needs from the gateway: forwarding /api/phone/* and registering its repo root. */
export interface PhoneLink {
  forward(method: string, path: string, body?: string): Promise<AdminReply>;
  register(root: string): Promise<void>;
}

export function realPhoneLink(opts: { dir?: string; entry?: string } = {}): PhoneLink {
  const dir = opts.dir ?? phoneDir();
  const ready = async () => {
    const r = await ensureGateway({ dir, entry: opts.entry });
    if (!r.info) throw new Error(`The phone gateway did not start; see ${phoneFiles(dir).log}`);
  };
  return {
    async forward(method, path, body) {
      await ready();
      return adminRequest(dir, method, path, body);
    },
    async register(root) {
      await ready();
      const r = await adminRequest(dir, 'POST', '/admin/projects', JSON.stringify({ root }));
      if (r.status !== 200) throw new Error(`the gateway answered ${r.status}: ${r.body}`);
    },
  };
}
