// Pure helpers for Settings → Phone (docs/PHONE.md): pairing countdown, the network rows, linked-phone lines.
// No DOM here so vitest can run them in node.

export type PhoneNetworkMode = 'lan' | 'tailscale';

export interface PhoneTailscale { installed: boolean; ip?: string | null; dnsName?: string | null; online?: boolean }
export interface PhoneDevice { id: string; name: string; createdAt: string; lastSeenAt?: string | null; online?: boolean }
export interface PhoneStatus {
  pcName: string;
  port: number;
  fingerprint: string;
  network: { mode: PhoneNetworkMode; lanHosts: string[]; tailscale: PhoneTailscale };
  devices: PhoneDevice[];
}
export interface PhonePairCode { code: string; display: string; expiresAt: string; qrSvg: string; qrText: string }
export type PhoneNotifyKey = 'review' | 'question' | 'blocked' | 'usage' | 'stuck';
export interface PhoneSendPrefs {
  notify: Record<PhoneNotifyKey, boolean>;
  quiet?: { on: boolean; from: string; to: string };
  projects?: Record<string, boolean>;
}

/** The five "Send to phone" toggles, in the design's order. */
export const SEND_ROWS: { key: PhoneNotifyKey; title: string; sub: string }[] = [
  { key: 'review', title: 'Approvals and ready for review', sub: 'A branch passed the Captain and waits for your Approve' },
  { key: 'question', title: 'Captain questions and escalations', sub: 'The Captain needs an answer before the crew can go on' },
  { key: 'blocked', title: 'Blocked merges', sub: 'A merge hit a conflict or a failing station' },
  { key: 'usage', title: 'Usage alerts', sub: 'When the 5-hour or weekly window crosses your warn level' },
  { key: 'stuck', title: 'Agent stuck', sub: 'An agent has made no progress for 10 minutes' },
];

/** PHONE.md defaults: review/question/blocked on, usage/stuck off. */
export const DEFAULT_NOTIFY: Record<PhoneNotifyKey, boolean> = { review: true, question: true, blocked: true, usage: false, stuck: false };

/** Milliseconds left on a pair code (never negative; 0 when the date doesn't parse). */
export function msLeft(expiresAt: string, now: number): number {
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) ? Math.max(0, t - now) : 0;
}

/** 112000 → "1:52"; rounds up so a code never shows 0:00 while it still works. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "Expires in 1:52 · works once", or "Expired · getting a new code" once it ran out. */
export function expiryLine(expiresAt: string, now: number): { text: string; expired: boolean } {
  const ms = msLeft(expiresAt, now);
  if (ms <= 0) return { text: 'Expired · getting a new code', expired: true };
  return { text: `Expires in ${formatCountdown(ms)} · works once`, expired: false };
}

/** The address a phone types in by hand ("Type the code instead"): the first LAN IPv4. */
export function manualHost(s: PhoneStatus | null): string | null {
  return s?.network.lanHosts[0] ?? null;
}

export interface NetworkRow {
  mode: PhoneNetworkMode;
  title: string;
  sub: string;
  selected: boolean;
  disabled: boolean;
  /** Right-hand detail: an address, "wayne-pc · connected", "not installed"… */
  detail: string;
  /** 'ok' shows a green dot, 'off' a faint one, none no dot. */
  dot?: 'ok' | 'off';
  link?: { text: string; href: string };
  /** The part of `detail` that is an address (hidden until you press the eye). */
  secret?: string;
}

/** The first label of a MagicDNS name ("wayne-pc.tail1234.ts.net" → "wayne-pc"). */
export function shortDns(name: string | null | undefined): string {
  return (name ?? '').replace(/\.$/, '').split('.')[0] ?? '';
}

/**
 * "How your phone reaches this PC": the LAN and Tailscale rows from GET /admin/status. Both paths are always
 * offered to the phone, so these show which ones work right now (`selected`); they are not a choice.
 */
export function networkRows(s: PhoneStatus): NetworkRow[] {
  const { lanHosts, tailscale: ts } = s.network;
  const lan: NetworkRow = {
    mode: 'lan', title: 'Home Wi‑Fi', sub: 'When the phone is on the same network',
    selected: lanHosts.length > 0, disabled: lanHosts.length === 0,
    detail: lanHosts.length ? `${lanHosts[0]}:${s.port}` : 'no network found',
    ...(lanHosts.length ? { secret: lanHosts[0] } : {}),
  };
  const tsRow: NetworkRow = {
    mode: 'tailscale', title: 'Anywhere with Tailscale', sub: 'Mobile data and other networks, with Tailscale on the phone',
    selected: ts.installed && !!ts.online, disabled: !ts.installed, detail: '',
  };
  if (!ts.installed) {
    tsRow.detail = 'not installed';
    tsRow.link = { text: 'Get it at tailscale.com', href: 'https://tailscale.com/download' };
  } else {
    const who = shortDns(ts.dnsName) || ts.ip || s.pcName.toLowerCase();
    tsRow.detail = `${who} · ${ts.online ? 'connected' : 'offline'}`;
    tsRow.secret = who;
    tsRow.dot = ts.online ? 'ok' : 'off';
  }
  return [lan, tsRow];
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "today 09:12", "yesterday 18:40", "3 Oct" (local time). */
export function dayTime(iso: string, now: number): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (diff === 0) return `today ${hm}`;
  if (diff === 1) return `yesterday ${hm}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== today.getFullYear() ? ` ${d.getFullYear()}` : ''}`;
}

/** "just now", "2 min ago", "3 h ago", "4 days ago". */
export function ago(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const min = Math.floor(Math.max(0, now - t) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/** "Linked today 09:12 · last seen 2 min ago" (or "· online now", "· not seen yet"). */
export function deviceLine(d: PhoneDevice, now: number): string {
  const seen = d.online ? 'online now' : d.lastSeenAt ? `last seen ${ago(d.lastSeenAt, now)}` : 'not seen yet';
  return `Linked ${dayTime(d.createdAt, now)} · ${seen}`;
}

/** The note next to "Send test notification". */
export function sendTarget(devices: PhoneDevice[]): string {
  if (!devices.length) return 'No phone linked yet. Link one to get these.';
  const first = devices[0].name;
  const more = devices.length - 1;
  return `Goes to ${first}${more ? ` and ${more} more phone${more > 1 ? 's' : ''}` : ''}. Follows the phone's Do Not Disturb.`;
}

/** The send prefs with one toggle changed; missing notify keys take the PHONE.md defaults. */
export function withNotify(p: PhoneSendPrefs | null, key: PhoneNotifyKey, on: boolean): PhoneSendPrefs {
  return { ...(p ?? {}), notify: { ...DEFAULT_NOTIFY, ...(p?.notify ?? {}), [key]: on } };
}

/** Settings tabs (#/settings?tab=…); anything unknown is General. */
export const SETTINGS_TABS = [
  { id: 'general', label: 'General' },
  { id: 'usage', label: 'Usage guard' },
  { id: 'line', label: 'Factory line' },
  { id: 'phone', label: 'Phone' },
  { id: 'remote', label: 'Remote access' },
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number]['id'];
export function parseSettingsTab(v: string | null | undefined): SettingsTab {
  return (SETTINGS_TABS.find((t) => t.id === v)?.id ?? 'general') as SettingsTab;
}

/** The first 8 hex characters of the certificate fingerprint, as the phone shows them for a typed-in code ("3F9A 21C0"). */
export function shortFingerprint(fingerprint: string | undefined): string {
  const hex = (fingerprint ?? '').replace(/[^0-9a-f]/gi, '').slice(0, 8).toUpperCase();
  return hex.length === 8 ? `${hex.slice(0, 4)} ${hex.slice(4)}` : '';
}

/** An address with every letter and digit hidden, keeping its shape: "192.168.0.60" → "•••.•••.•.••". */
export function maskAddress(text: string): string {
  return text.replace(/[0-9a-z]/gi, '•');
}

/** `detail` with its address part hidden unless shown. */
export function shownDetail(row: Pick<NetworkRow, 'detail' | 'secret'>, show: boolean): string {
  return show || !row.secret ? row.detail : row.detail.replace(row.secret, maskAddress(row.secret));
}
