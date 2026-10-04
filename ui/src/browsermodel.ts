// Pure helpers for Settings → Research browser: site status lines, the honest limits list, the Opera allowlist
// and import summary. No DOM; tested in browsermodel.test.ts.
import type { MusterConfig, ResearchBrowserStatus, ResearchSiteStatus } from '../../src/types';
import { agoText } from './research';

/** "Signed in · checked 30 min ago" / "Signed in via Opera · …" / "Not signed in · …". */
export function siteLine(s: Pick<ResearchSiteStatus, 'connected' | 'via' | 'checkedAt'>, now = Date.now()): string {
  const state = s.connected ? (s.via === 'opera' ? 'Signed in via Opera import' : 'Signed in') : 'Not signed in';
  return s.checkedAt ? `${state} · checked ${checkedText(s.checkedAt, now)}` : state;
}

/** The server keeps a site's checkedAt as a day ("2026-10-03"): "today" / "yesterday" / the day, not "12h ago" (UTC midnight). */
function checkedText(at: string, now: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(at)) return agoText(at, now);
  const day = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  return at === day(now) ? 'today' : at === day(now - 86_400_000) ? 'yesterday' : `on ${at}`;
}

export const NOT_CHECKED_VISIBLE = 'Not checked in a visible window yet. The next read uses the window.';

/**
 * What a site row says about its last bot check. Null when the last load went through.
 * - 'blocked' (red BLOCKED badge and text): the site blocked a hidden read and the visible window is off, or it
 *   blocked even the visible window.
 * - 'pending' (muted, no badge): it blocked a hidden read, but the visible window is on now and hasn't been tried
 *   yet. Records without `visible` (saved before it existed) count as hidden reads.
 */
export function blockedHint(s: Pick<ResearchSiteStatus, 'blocked' | 'visible' | 'label'>, now = Date.now()): { tone: 'blocked' | 'pending'; tag: string; text: string } | null {
  if (!s.blocked) return null;
  const why = `${s.blocked.reason}, ${agoText(s.blocked.at, now)}`;
  if (s.blocked.visible) return { tone: 'blocked', tag: 'blocked', text: `${s.label} blocks even the visible window (${why}). scout relies on public reading for it.` };
  if (s.visible) return { tone: 'pending', tag: '', text: NOT_CHECKED_VISIBLE };
  return { tone: 'blocked', tag: 'blocked', text: `${s.label} blocks headless reading (${why}). Turn on the visible window for it, or scout relies on public reading.` };
}

/** One line for the whole browser: available or not, and what it is doing. */
export function availabilityLine(st: ResearchBrowserStatus | null | undefined): { ok: boolean; text: string } {
  if (!st) return { ok: false, text: 'Checking…' };
  if (!st.available) return { ok: false, text: `${st.problem ?? 'Not available'}. scout reads public pages with its web tools instead.` };
  const browser = st.channel === 'msedge' ? 'Edge' : 'Chrome';
  const state = st.state === 'login_open' ? `login window open${st.loginSite ? ` (${st.loginSite})` : ''}` : st.state === 'browsing' ? 'scout is browsing' : 'idle';
  return { ok: true, text: `Available · ${browser} · ${state}` };
}

export interface Limit { key: string; title: string; text: string; tone: 'off' | 'warn' | 'ok' | 'info' }

/**
 * What scout can't do (or can only partly do) on this PC, in plain words. Uses the live status where it has one
 * (yt-dlp, Reddit/LinkedIn login, X) and the known limits otherwise.
 */
export function honestLimits(st: ResearchBrowserStatus | null | undefined, cfg: Pick<MusterConfig, 'intel'> | null | undefined): Limit[] {
  const site = (id: string) => st?.sites.find((s) => s.site === id);
  const tool = (name: string) => st?.tools.find((t) => t.name.toLowerCase() === name);
  const out: Limit[] = [];

  const yt = tool('yt-dlp');
  out.push(yt?.ok
    ? { key: 'youtube', title: 'YouTube', text: 'On: yt-dlp is on PATH.', tone: 'ok' }
    : { key: 'youtube', title: 'YouTube', text: `Off: yt-dlp is not on PATH${yt?.note && !/path/i.test(yt.note) ? ` (${yt.note})` : ''}. Agent Reach's YouTube channel stays off until it is.`, tone: 'off' });

  const reddit = site('reddit');
  out.push(reddit?.connected
    ? { key: 'reddit', title: 'Reddit', text: 'Signed in: reads work. Anonymous Reddit JSON is blocked, so keep this login.', tone: 'ok' }
    : { key: 'reddit', title: 'Reddit', text: 'Needs the login: anonymous Reddit JSON is blocked. Connect Reddit above.', tone: 'warn' });

  out.push({ key: 'linkedin', title: 'LinkedIn', text: 'May restrict automated accounts: sign in with a separate account, not your own. scout only reads.', tone: 'warn' });

  const x = site('x');
  out.push(x?.connected
    ? { key: 'x', title: 'X', text: 'Signed in.', tone: 'ok' }
    : { key: 'x', title: 'X (Twitter)', text: 'Not set up. scout skips X.', tone: 'off' });

  out.push(cfg?.intel?.companiesHouseKey
    ? { key: 'companies_house', title: 'Companies House', text: 'API key set: filings come from the official API.', tone: 'ok' }
    : { key: 'companies_house', title: 'Companies House', text: 'API key optional. Without one scout reads the public search pages (slower, and they can change).', tone: 'info' });

  out.push({
    key: 'cloudflare', title: 'Cloudflare checks',
    text: 'Some sites (Padlet, for one) show a Cloudflare check to an automated browser. scout then falls back to reading their public pages with its web tools, or you can turn on a visible window for that site above.',
    tone: 'info',
  });
  return out;
}

/** "https://www.Reddit.com/r/x" → "reddit.com"; null when it isn't a domain. */
export function normaliseDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^\.+|\.+$/g, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null;
}

/** Add a domain to the allowlist (no duplicates). Returns the list unchanged when the input isn't a domain. */
export function addAllowed(list: string[], input: string): { list: string[]; error?: string } {
  const d = normaliseDomain(input);
  if (!d) return { list, error: `“${input.trim()}” isn't a domain. Use the site's address, e.g. reddit.com` };
  return list.includes(d) ? { list } : { list: [...list, d] };
}

/** "reddit.com 10 · linkedin.com 32 · imported 2h ago" (counts only; values are never returned). */
export function operaSummary(o: ResearchBrowserStatus['opera'] | undefined, now = Date.now()): string {
  if (!o) return '';
  if (!o.found) return 'Opera profile not found on this PC.';
  const counts = Object.entries(o.imported ?? {}).map(([d, n]) => `${d} ${n}`);
  if (!o.lastImportAt) return 'Not imported yet.';
  return `${counts.length ? `${counts.join(' · ')} cookies · ` : ''}imported ${agoText(o.lastImportAt, now)}`;
}
