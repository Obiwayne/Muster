// The phone gateway's files in secretsBase()/phone/: state.json (devices, network mode, registered projects),
// cert.pem/key.pem (self-signed), admin-token and server.json. Never inside a repo. See docs/PHONE.md.
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import * as selfsigned from 'selfsigned';
import { secretsBase } from '../core/tokens.js';
import { clonePrefs, DEFAULT_PREFS, type Prefs } from './needs.js';

export const DEFAULT_PHONE_PORT = 47910;

export interface Device {
  id: string;
  name: string;
  keyHash: string; // sha256 hex of the device key; the key itself lives only on the phone
  createdAt: string;
  lastSeenAt: string;
  prefs: Prefs;
}

export interface PhoneState {
  pcName: string;
  devices: Device[];
  network: { mode: 'lan' | 'tailscale' };
  /** Repo roots registered by orchestrators (POST /admin/projects), in addition to the desktop's recent list. */
  projects: string[];
  /** Prefs a newly paired device starts with (the desktop's "Send to phone" toggles; GET/PUT /admin/send). */
  defaultPrefs: Prefs;
}

export interface ServerFile {
  port: number;
  pid: number;
  startedAt: string;
  fingerprint: string;
}

/** secretsBase()/phone (MUSTER_SECRETS_DIR moves it, like every other secret). */
export function phoneDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(secretsBase(env), 'phone');
}

export const phoneFiles = (dir: string) => ({
  state: join(dir, 'state.json'),
  cert: join(dir, 'cert.pem'),
  key: join(dir, 'key.pem'),
  adminToken: join(dir, 'admin-token'),
  server: join(dir, 'server.json'),
  log: join(dir, 'gateway.log'),
});

export const sha256hex = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

function writePrivate(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* Windows: %LOCALAPPDATA% ACLs already limit it to the user */
  }
  renameSync(tmp, file);
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function freshState(): PhoneState {
  return { pcName: hostname(), devices: [], network: { mode: 'lan' }, projects: [], defaultPrefs: clonePrefs(DEFAULT_PREFS) };
}

const withDefaults = (p: Partial<Prefs> | undefined, base: Prefs): Prefs => ({
  notify: { ...base.notify, ...(p?.notify ?? {}) },
  quiet: { ...base.quiet, ...(p?.quiet ?? {}) },
  projects: { ...(p?.projects ?? {}) },
});

export function loadState(dir: string): PhoneState {
  const file = phoneFiles(dir).state;
  if (!existsSync(file)) return freshState();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PhoneState>;
    const base = freshState();
    const defaultPrefs = withDefaults(raw.defaultPrefs, DEFAULT_PREFS);
    return {
      pcName: typeof raw.pcName === 'string' && raw.pcName ? raw.pcName : base.pcName,
      devices: Array.isArray(raw.devices) ? raw.devices.map((d) => ({ ...d, prefs: withDefaults(d.prefs, DEFAULT_PREFS) })) : [],
      network: { mode: raw.network?.mode === 'tailscale' ? 'tailscale' : 'lan' },
      projects: Array.isArray(raw.projects) ? raw.projects.filter((p) => typeof p === 'string') : [],
      defaultPrefs,
    };
  } catch {
    return freshState();
  }
}

export function saveState(dir: string, state: PhoneState): void {
  ensureDir(dir);
  writePrivate(phoneFiles(dir).state, JSON.stringify(state, null, 2));
}

export function readAdminToken(dir: string): string | null {
  try {
    return readFileSync(phoneFiles(dir).adminToken, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** The admin token, created on first run. */
export function ensureAdminToken(dir: string): string {
  const existing = readAdminToken(dir);
  if (existing) return existing;
  ensureDir(dir);
  const token = randomBytes(24).toString('hex');
  writePrivate(phoneFiles(dir).adminToken, token);
  return token;
}

export interface CertPair {
  cert: string;
  key: string;
  /** sha256 hex (lowercase, no separators) of the certificate's DER bytes: what the phone pins. */
  fingerprint: string;
}

export const certFingerprint = (pem: string): string => sha256hex(new X509Certificate(pem).raw);

/** Loads cert.pem/key.pem, or makes a self-signed pair (CN = pcName, 10 years) on first run. */
export async function ensureCert(dir: string, pcName: string): Promise<CertPair> {
  const f = phoneFiles(dir);
  if (existsSync(f.cert) && existsSync(f.key)) {
    try {
      const cert = readFileSync(f.cert, 'utf8');
      return { cert, key: readFileSync(f.key, 'utf8'), fingerprint: certFingerprint(cert) };
    } catch {
      /* unreadable: make a new pair (paired phones will have to pair again) */
    }
  }
  ensureDir(dir);
  const notBeforeDate = new Date(Date.now() - 60_000);
  const notAfterDate = new Date(notBeforeDate);
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 10);
  const dnsName = pcName.replace(/[^A-Za-z0-9.-]/g, '-') || 'muster';
  const pems = await selfsigned.generate([{ name: 'commonName', value: pcName }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: dnsName }, { type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] },
    ],
  });
  writePrivate(f.key, pems.private);
  writePrivate(f.cert, pems.cert);
  return { cert: pems.cert, key: pems.private, fingerprint: certFingerprint(pems.cert) };
}

export function readServerFile(dir: string): ServerFile | null {
  try {
    const s = JSON.parse(readFileSync(phoneFiles(dir).server, 'utf8')) as ServerFile;
    return typeof s.port === 'number' && typeof s.pid === 'number' ? s : null;
  } catch {
    return null;
  }
}

export function writeServerFile(dir: string, s: ServerFile): void {
  ensureDir(dir);
  writePrivate(phoneFiles(dir).server, JSON.stringify(s, null, 2));
}

/** Removes server.json only when it still describes this process (a newer gateway may have replaced it). */
export function removeServerFile(dir: string, pid: number, port: number): void {
  const s = readServerFile(dir);
  if (s && s.pid === pid && s.port === port) rmSync(phoneFiles(dir).server, { force: true });
}

export function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
