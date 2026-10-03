// Pure helpers for Settings → Research browser: site status lines, the honest limits list, the Opera allowlist
// and import summary. No DOM; tested in browsermodel.test.ts.
import type { MusterConfig, ResearchBrowserStatus, ResearchSiteStatus } from '../../src/types';
import { agoText } from './research';

/** "Signed in · checked 30 min ago" / "Signed in via Opera · …" / "Not signed in · …". */
export function siteLine(s: Pick<ResearchSiteStatus, 'connected' | 'via' | 'checkedAt'>, now = Date.now()): string {
  const state = s.connected ? (s.via === 'opera' ? 'Signed in via Opera import' : 'Signed in') : 'Not signed in';
  return s.checkedAt ? `${state} · checked ${agoText(s.checkedAt, now)}` : state;
}

/**
 * A site that answered the headless research browser with a bot check: the "blocked" pill and what to do about it
 * (read it in a visible window, or rely on public reading). Null when the last load went through.
 */
export function blockedHint(s: Pick<ResearchSiteStatus, 'blocked' | 'visible' | 'label'>, now = Date.now()): { tag: string; text: string } | null {
  if (!s.blocked) return null;
  const why = `${s.blocked.reason}, ${agoText(s.blocked.at, now)}`;
  return s.visible
    ? { tag: 'blocked', text: `Blocked the last read (${why}), before the visible window was on. The next read uses the window; until then scout relies on public reading.` }
    : { tag: 'blocked', text: `${s.label} blocks headless reading (${why}). Turn on the visible window for it, or scout relies on public reading.` };
}

/** visibleSites with `domain` turned on or off (no duplicates). */
export function setVisible(list: string[], domain: string, on: boolean): string[] {
  const rest = list.filter((d) => d !== domain);
  return on ? [...rest, domain] : rest;
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
