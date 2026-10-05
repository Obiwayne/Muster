// Pure helpers for Settings → Remote access (docs/REMOTE.md, "Milestone 4 API contract"): the connection indicator,
// the refused-call line, the login code state, the lockout and the activity log lines. No DOM here so vitest can run
// them in node. The desktop reaches the gateway's /admin/remote/* as /api/phone/remote/*.
import { ago, dayTime, formatCountdown, msLeft } from './phonemodel';

export type RemoteTunnel = 'cloudflare' | 'tailscale';
export interface RemoteConfig { enabled: boolean; port: number; publicHost: string | null; tunnel: RemoteTunnel | null }
export interface RemoteHold { on: boolean; offSince: string | null; sentWithoutTap: number }
export interface RemoteSettings { confirmWrites: boolean; allowApprove: boolean }
export interface RemoteConnection { id: string; clientName: string; createdAt: string; lastUsedAt: string }
export interface RemoteTestResult { ok: boolean; status?: number; error?: string; at: string }
export interface RemoteCode { code: string; display: string; expiresAt: string }
/** A connector app on the allow-list (docs/REMOTE.md, "App allow-list"). `id` is `app_<16 hex>`. */
export interface RemoteApp {
  id: string;
  clientId: string;
  name: string;
  kind: 'dcr' | 'cimd';
  status: 'waiting' | 'approved';
  requestedAt: string;
  approvedAt?: string | null;
  approvedBy?: string | null;
  lastUsedAt?: string | null;
  connections: number;
  ip?: string | null;
}

/** GET /api/phone/remote. Remote off: only enabled/config/hold/settings. On: RemoteStatus plus hold/settings/config/lastTest. */
export interface RemoteStatus {
  enabled: boolean;
  port?: number;
  publicHost?: string | null;
  connected?: boolean;
  lastTunnelOkAt?: string | null;
  lastTunnelError?: { at: string; status: number; reason: string } | null;
  lastLocalOkAt?: string | null;
  connections?: RemoteConnection[];
  loginLocked?: boolean;
  loginLockedUntil?: string | null;
  codeActiveUntil?: string | null;
  tunnel?: RemoteTunnel | null;
  hold?: RemoteHold;
  settings?: RemoteSettings;
  config?: RemoteConfig;
  lastTest?: RemoteTestResult | null;
  /** The allow-list, waiting first. Missing on a gateway from before the allow-list. */
  apps?: RemoteApp[];
  appsWaiting?: number;
}

/** One remote.log line as stored (GET /api/phone/remote/log). Every field but `at` depends on the event. */
export type RemoteLogEntry = { at: string } & Record<string, unknown>;

export const TUNNEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'cloudflare', label: 'Cloudflare Tunnel' },
  { value: 'tailscale', label: 'Tailscale Funnel' },
  { value: '', label: 'Not set' },
];

const pad2 = (n: number) => String(n).padStart(2, '0');
/** "14:52" in local time ('' when the date doesn't parse). */
export function hhmm(iso: string | null | undefined): string {
  const d = new Date(iso ?? '');
  return Number.isFinite(d.getTime()) ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : '';
}

/** A length of time: "40 s", "12 min", "2 h", "3 days". */
export function span(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs} h`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? '1 day' : `${days} days`;
}

/** What you paste into a box ("https://Muster.Example.com/mcp/") as a bare hostname ("muster.example.com"); '' when empty. */
export function normalizeHost(input: string): string {
  return input.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/\.$/, '');
}

/** A hostname the gateway can use: letters, digits, dots and dashes, optional :port. */
export function validHost(host: string): boolean {
  return /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/.test(host);
}

/** The URL to add in Claude › Settings › Connectors. */
export function publicUrl(host: string | null | undefined): string | null {
  return host ? `https://${host}/mcp` : null;
}

/** The config, whether the status carries it whole (milestone 4) or only the RemoteStatus fields. */
export function configOf(s: RemoteStatus | null): RemoteConfig {
  return {
    enabled: s?.config?.enabled ?? s?.enabled ?? false,
    port: s?.config?.port ?? s?.port ?? 47911,
    publicHost: s?.config?.publicHost ?? s?.publicHost ?? null,
    tunnel: s?.config ? s.config.tunnel ?? null : s?.tunnel ?? null,
  };
}

export type ConnState = 'connected' | 'idle' | 'off';

/** Latest successful tool call through the tunnel in the log (for "muster_status from Claude"). */
function lastTunnelCall(log: RemoteLogEntry[]): RemoteLogEntry | undefined {
  return log.find((e) => typeof e.tool === 'string' && e.ok === true && e.via === 'tunnel');
}

/** The header of the Connection card: green Connected, grey Not connected, or Off. */
export function connectionView(s: RemoteStatus | null, log: RemoteLogEntry[], now: number): { state: ConnState; title: string; sub: string } {
  if (!s || !s.enabled) return { state: 'off', title: 'Off', sub: "Remote access is off. Claude can't reach Muster until you turn it on." };
  if (s.connected) {
    const call = lastTunnelCall(log);
    const when = s.lastTunnelOkAt ? ago(s.lastTunnelOkAt, now) : '';
    const what = call ? ` · ${call.tool}${call.client ? ` from ${call.client}` : ''}` : '';
    return { state: 'connected', title: 'Connected', sub: `Last call through the tunnel ${when}${what}` };
  }
  if (!s.lastTunnelOkAt) return { state: 'idle', title: 'Not connected', sub: 'No call through the tunnel yet' };
  const since = span(now - Date.parse(s.lastTunnelOkAt));
  return { state: 'idle', title: 'Not connected', sub: `No successful call through the tunnel for ${since} · last one ${dayTime(s.lastTunnelOkAt, now)}` };
}

/** The footer of the Connection card: the last refused tunnel call, and what to do about it. Null when there is none. */
export function refusedLine(s: RemoteStatus | null, log: RemoteLogEntry[], now: number): string | null {
  const err = s?.enabled ? s.lastTunnelError : null;
  if (!err) return null;
  const at = Date.parse(err.at);
  // The log line for the same refusal carries the caller's IP.
  const hit = log.find((e) => e.refused === err.status && e.via === 'tunnel' && Math.abs(Date.parse(e.at) - at) < 5000);
  const ip = typeof hit?.ip === 'string' ? ` from ${hit.ip}` : '';
  let hint = '';
  if (err.status === 421) hint = ' · check the public address matches the tunnel';
  else {
    const again = log.find((e) => e.event === 'login_ok' && Date.parse(e.at) > at);
    if (again) hint = ` · ${typeof again.client === 'string' ? again.client : 'Claude'} signed in again`;
    else if (s?.lastTunnelOkAt && Date.parse(s.lastTunnelOkAt) > at) hint = ' · a call has worked since';
    else if (err.status === 429) hint = ' · too many calls in a minute';
  }
  return `Last refused call ${ago(err.at, now)} · ${err.status} ${err.reason}${ip}${hint}`;
}

/** "Test passed · just now" / "Test failed · 502 · just now" for the Test button's result. */
export function testLine(t: RemoteTestResult | null | undefined, now: number): { text: string; ok: boolean } | null {
  if (!t) return null;
  const when = ago(t.at, now);
  if (t.ok) return { text: `Test passed: the public address answers${when ? ` · ${when}` : ''}`, ok: true };
  const why = [t.status ? String(t.status) : '', t.error ?? ''].filter(Boolean).join(' ');
  return { text: `Test failed${why ? `: ${why}` : ''}${when ? ` · ${when}` : ''}`, ok: false };
}

/** "Signed in today 14:02 · last used 3 min ago". */
export function connectionLine(c: RemoteConnection, now: number): string {
  return `Signed in ${dayTime(c.createdAt, now)} · last used ${ago(c.lastUsedAt, now)}`;
}

// ---------------------------------------------------------------- approved apps

/** The row icon: a terminal for Claude Code (any name with "Code"), the sparkle for Claude, a generic one otherwise. */
export function appIcon(name: string): 'terminal' | 'sparkle' | 'grid' {
  if (/code/i.test(name)) return 'terminal';
  return /claude/i.test(name) ? 'sparkle' : 'grid';
}

/** How the app identified itself: DCR registers on the spot, CIMD points at an identity document it publishes. */
export function appKindText(kind: RemoteApp['kind'] | string): string {
  return kind === 'cimd' ? 'Published identity' : kind === 'dcr' ? 'Registered itself' : 'Unknown kind';
}

/** Waiting first (as the gateway sends them), then approved. */
export function splitApps(apps: RemoteApp[] | null | undefined): { waiting: RemoteApp[]; approved: RemoteApp[] } {
  const list = Array.isArray(apps) ? apps : [];
  return { waiting: list.filter((a) => a.status === 'waiting'), approved: list.filter((a) => a.status === 'approved') };
}

/** How many apps wait for approval (appsWaiting, or counted from the list). 0 while remote access is off. */
export function waitingCount(s: RemoteStatus | null, apps?: RemoteApp[] | null): number {
  if (!s?.enabled) return 0;
  if (typeof s.appsWaiting === 'number') return s.appsWaiting;
  return splitApps(apps ?? s.apps).waiting.length;
}

/** "Published identity · asked 14:41 · from 86.12.44.170". */
export function waitingLine(a: RemoteApp): string {
  const asked = hhmm(a.requestedAt);
  return [appKindText(a.kind), asked ? `asked ${asked}` : '', a.ip ? `from ${a.ip}` : ''].filter(Boolean).join(' · ');
}

/** "Approved today 14:02 · last used 3 min ago · 1 connection" (or "Approved before the allow-list", "not used yet"). */
export function approvedLine(a: RemoteApp, now: number): string {
  const when = a.approvedBy === 'existing' ? 'Approved before the allow-list'
    : a.approvedAt ? `Approved ${dayTime(a.approvedAt, now)}` : 'Approved';
  const used = a.lastUsedAt ? `last used ${ago(a.lastUsedAt, now)}` : 'not used yet';
  const n = a.connections ?? 0;
  return `${when} · ${used} · ${n} connection${n === 1 ? '' : 's'}`;
}

/** The card header: "Approved apps · 2" or "Approved apps · 2 · 1 waiting". */
export function appsHeader(apps: RemoteApp[]): string {
  const { waiting, approved } = splitApps(apps);
  return `Approved apps · ${approved.length}${waiting.length ? ` · ${waiting.length} waiting` : ''}`;
}

// ---------------------------------------------------------------- login code

/**
 * Is the code from our own POST .../code reply still worth showing? Never once it ran out on this clock, once the
 * gateway says no code is active (it was used or cancelled), or once a different code is active (a new code kills
 * the old one). `polledAt` is when the status request started: a reply to a request sent before the code was made
 * says nothing about it.
 */
export function codeStillShown(code: RemoteCode | null, issuedAt: number, s: RemoteStatus | null, polledAt: number, now: number): boolean {
  if (!code) return false;
  if (msLeft(code.expiresAt, now) <= 0) return false;
  if (s && isLocked(s, now)) return false;
  if (!s || polledAt < issuedAt) return true;
  if (!s.enabled) return false;
  if (s.codeActiveUntil === undefined) return true; // an older gateway: rely on the clock
  return s.codeActiveUntil !== null && Date.parse(s.codeActiveUntil) === Date.parse(code.expiresAt);
}

/** "1:47 left · works once" and the bar's fill (0..1) for a 2-minute code. */
export function codeCountdown(expiresAt: string, now: number, totalMs = 120_000): { text: string; frac: number } {
  const ms = msLeft(expiresAt, now);
  return { text: `${formatCountdown(ms)} left · works once`, frac: Math.max(0, Math.min(1, ms / totalMs)) };
}

export function isLocked(s: RemoteStatus | null, now: number): boolean {
  if (!s?.enabled || !s.loginLocked) return false;
  const until = Date.parse(s.loginLockedUntil ?? '');
  return !Number.isFinite(until) || until > now;
}

/** The locked sign-in card: "Until 14:52 · 5 wrong codes" and "Last try 14:42 from 203.0.113.9 · nobody got in". */
export function lockView(s: RemoteStatus, log: RemoteLogEntry[]): { title: string; sub: string | null; until: string } {
  const until = hhmm(s.loginLockedUntil);
  // The wrong codes that caused the lock: the login_failed lines in the minute up to the one that set lockedUntil.
  const lockIdx = log.findIndex((e) => e.event === 'login_failed' && typeof e.lockedUntil === 'string');
  let wrong = 0;
  if (lockIdx >= 0) {
    const lockAt = Date.parse(log[lockIdx].at);
    for (let i = lockIdx; i < log.length && lockAt - Date.parse(log[i].at) <= 60_000; i++) {
      if (log[i].event === 'login_failed' && log[i].reason !== 'locked') wrong++;
    }
  }
  const last = log.find((e) => e.event === 'login_failed');
  const sub = last ? `Last try ${hhmm(last.at)}${typeof last.ip === 'string' ? ` from ${last.ip}` : ''} · nobody got in` : null;
  return { title: `Until ${until || 'soon'}${wrong ? ` · ${wrong} wrong code${wrong === 1 ? '' : 's'}` : ''}`, sub, until };
}

// ---------------------------------------------------------------- hold

/** The hold row's subtext. */
export function holdLine(hold: RemoteHold | undefined): string {
  if (!hold || hold.on) return 'Goals, replies and answers wait in Needs you until you tap Send. This is what stops a poisoned note from getting a reply sent.';
  const since = hold.offSince ? `Off since ${hhmm(hold.offSince)}, turned off on this PC. ` : 'Off, turned off on this PC. ';
  const sent = hold.sentWithoutTap ? ` ${hold.sentWithoutTap} sent without your tap so far.` : '';
  return `${since}Claude's goals, replies and answers now reach the crew without your tap.${sent}`;
}

// ---------------------------------------------------------------- activity

export type LogTone = 'text' | 'muted' | 'red' | 'warm';
export interface LogLine { time: string; title: string; text: string; tone: LogTone }

const str = (v: unknown) => (typeof v === 'string' && v ? v : '');
const join = (...parts: unknown[]) => parts.map(str).filter(Boolean).join(' · ');

const LOGIN_REASON: Record<string, string> = {
  wrong: 'wrong code',
  expired: 'expired code',
  locked: 'sign-in while locked',
  bad_code: 'bad code',
  bad_request: 'bad sign-in request',
  bad_pkce: 'sign-in failed: bad PKCE',
  client_mismatch: 'sign-in failed: wrong app',
  redirect_mismatch: 'sign-in failed: wrong redirect',
  bad_refresh: 'bad refresh token',
  refresh_reused: 'refresh token reused: connection revoked',
  not_approved: 'sign-in refused: app not approved',
};

const onOff = (v: unknown) => (v ? 'on' : 'off');

function settingsText(e: RemoteLogEntry): { text: string; tone: LogTone } {
  const before = (e.before ?? {}) as Partial<RemoteSettings>;
  const after = (e.after ?? {}) as Partial<RemoteSettings>;
  const parts: string[] = [];
  let tone: LogTone = 'muted';
  if (after.confirmWrites !== undefined && after.confirmWrites !== before.confirmWrites) {
    if (after.confirmWrites) parts.push('hold turned back on');
    else { parts.push('hold turned OFF · on this PC, confirmed'); tone = 'warm'; }
  }
  if (after.allowApprove !== undefined && after.allowApprove !== before.allowApprove) parts.push(`approve merges ${onOff(after.allowApprove)}`);
  return { text: parts.join(' · ') || 'settings changed', tone };
}

function configText(e: RemoteLogEntry): string {
  const before = (e.before ?? {}) as Partial<RemoteConfig>;
  const after = (e.after ?? {}) as Partial<RemoteConfig>;
  const parts: string[] = [];
  if (after.enabled !== undefined && after.enabled !== before.enabled) parts.push(`remote access ${onOff(after.enabled)}`);
  if (after.publicHost !== undefined && after.publicHost !== before.publicHost) parts.push(`public address ${after.publicHost ?? 'cleared'}`);
  if (after.tunnel !== undefined && after.tunnel !== before.tunnel) parts.push(`tunnel ${after.tunnel ?? 'not set'}`);
  if (after.port !== undefined && after.port !== before.port) parts.push(`port ${after.port}`);
  return parts.join(' · ') || 'remote config changed';
}

/** One short human line for a remote.log entry. */
export function logLine(e: RemoteLogEntry): { text: string; tone: LogTone } {
  const id = str(e.id);
  const kind = str(e.kind);
  const item = [id, kind].filter(Boolean).join(' ');
  if (typeof e.refused === 'number') return { text: join(`${e.refused} ${str(e.reason) || 'refused'}`, e.ip), tone: 'muted' };
  if (typeof e.tool === 'string') {
    const held = e.held ? `held as ${str(e.pendingId) || 'pending'}` : '';
    if (e.ok === false) return { text: join(e.tool, e.client, `failed: ${str(e.error) || 'error'}`), tone: 'red' };
    return { text: join(e.tool, e.client, held, e.via === 'local' ? 'local' : ''), tone: 'muted' };
  }
  switch (e.event) {
    case 'write_held': return { text: join(`held ${item}`, e.client), tone: 'muted' };
    case 'write_sent':
      return e.approvedOn === 'not held'
        ? { text: join(`sent ${item}`, 'not held'), tone: 'warm' }
        : { text: join(`sent ${item}`, e.approvedOn ? `approved on ${str(e.approvedOn)}` : ''), tone: 'text' };
    case 'write_discarded': return { text: join(`discarded ${item}`, e.on ? `on ${str(e.on)}` : ''), tone: 'muted' };
    case 'write_expired': return { text: join(`expired ${item}`, 'nothing sent'), tone: 'muted' };
    case 'write_send_refused': return { text: join(`send refused ${id}`, str(e.reason).replace(/_/g, ' ')), tone: 'warm' };
    case 'login_failed': {
      const what = LOGIN_REASON[str(e.reason)] ?? `sign-in failed${e.reason ? `: ${str(e.reason)}` : ''}`;
      const lock = typeof e.lockedUntil === 'string' ? `locked sign-ins until ${hhmm(e.lockedUntil)}` : '';
      return { text: join(what, e.client, e.ip, lock), tone: 'red' };
    }
    case 'login_ok': return { text: join(`signed in ${str(e.client) || 'an app'}`, e.ip), tone: 'muted' };
    case 'login_denied': return { text: join('sign-in denied', e.client, e.ip), tone: 'muted' };
    case 'code_issued': return { text: 'new sign-in code made', tone: 'muted' };
    case 'code_cancelled': return { text: 'sign-in code cancelled', tone: 'muted' };
    case 'revoked': {
      const n = typeof e.count === 'number' ? e.count : 0;
      const who = e.grant === 'all' ? `disconnected all apps (${n})` : 'disconnected an app';
      const reused = e.reason === 'refresh_reused';
      return { text: join(who, reused ? 'refresh token reused' : str(e.reason).replace(/_/g, ' ')), tone: reused ? 'red' : 'muted' };
    }
    case 'connected': return { text: join(`${str(e.client) || 'an app'} connected`), tone: 'muted' };
    case 'app_waiting': return { text: join(`${str(e.app) || 'an app'} is waiting for approval`, e.ip), tone: 'warm' };
    case 'app_approved': return { text: join(`approved ${str(e.app) || 'an app'}`), tone: 'text' };
    case 'app_denied': return { text: join(`denied ${str(e.app) || 'an app'}`), tone: 'muted' };
    case 'app_removed': {
      const n = typeof e.revoked === 'number' ? e.revoked : 0;
      return { text: join(`removed ${str(e.app) || 'an app'}`, n ? `${n} connection${n === 1 ? '' : 's'} revoked` : ''), tone: 'muted' };
    }
    case 'client_registered': return { text: join('registered app', e.client), tone: 'muted' };
    case 'settings_changed': return settingsText(e);
    case 'config_changed': return { text: configText(e), tone: 'muted' };
    default: return { text: str(e.event).replace(/_/g, ' ') || 'event', tone: 'muted' };
  }
}

/**
 * The Activity list: newest first as the log comes, one line per entry, with runs of the same line folded into one
 * ("wrong code · 203.0.113.9 ×5", time of the newest).
 */
export function activityLines(log: RemoteLogEntry[]): LogLine[] {
  const out: (LogLine & { n: number; base: string })[] = [];
  for (const e of log) {
    const { text, tone } = logLine(e);
    const prev = out[out.length - 1];
    if (prev && prev.base === text && prev.tone === tone) { prev.n++; prev.text = `${text} ×${prev.n}`; continue; }
    out.push({ time: hhmm(e.at), title: new Date(e.at).toLocaleString(), text, tone, n: 1, base: text });
  }
  return out.map(({ time, title, text, tone }) => ({ time, title, text, tone }));
}
