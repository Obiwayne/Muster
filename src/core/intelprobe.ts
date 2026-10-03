// "Add a competitor" lookup (POST /api/intel/probe): from a pasted URL, in a few seconds and without an
// agent, find the product name and tagline, the legal entity named on the site, Companies House
// candidates, and the places scout should look (pricing, roadmap, changelog, help, stores, reviews,
// socials). Public pages only; nothing is saved. See docs/ARCHITECTURE.md, Competitive intelligence.
import type { IntelProbe, IntelSiteSource, IntelSourceKind } from '../types.js';

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'follow' }) => Promise<{
  ok: boolean;
  status: number;
  url: string;
  text(): Promise<string>;
}>;

export interface ProbeOptions {
  fetch?: FetchLike;
  companiesHouseKey?: string;
  deadlineMs?: number; // overall (default 10 s)
}

// An honest, short UA: a full Chrome UA from Node gets 403s from bot checks (padlet.com) that a plain one passes.
const UA = 'Mozilla/5.0 (compatible; Muster-probe/1.0)';
const CH_API = 'https://api.company-information.service.gov.uk';
const CH_WEB = 'https://find-and-update.company-information.service.gov.uk';
const UK_SUFFIX = /\b(ltd|limited|llp|plc|cic)\.?$/i;
const LEGAL_SUFFIX = '(?:Ltd|Limited|LLP|PLC|plc|CIC|Inc|LLC|PBC|GmbH|Pty Ltd|Corp|Corporation|SAS|B\\.V|BV)';
// Up to four capitalised words (with "&", "-" or a comma) right before a company suffix: "Boardly Learning Ltd", "Wallwisher, Inc".
const LEGAL_RE = new RegExp(`((?:[A-Z][A-Za-z0-9&'’.-]*,?\\s){1,4})(${LEGAL_SUFFIX})\\.?(?![A-Za-z])`, 'g');
const STOP_FIRST = new Set(['The', 'For', 'By', 'And', 'Of', 'Our', 'Your', 'All', 'Copyright', 'Information', 'Disclosure', 'Legal', 'Imprint', 'Registered', 'Name', 'Under', 'Is', 'A', 'An', 'In', 'At', 'To', 'With', 'From', 'Rights', 'Reserved', 'Policy', 'Privacy', 'Terms', 'GDPR', 'UK', 'EU']);

/** "padlet.com" / "https://www.padlet.com/x" → "https://padlet.com/" style home URL (keeps www when given). */
export function normaliseHome(input: string): string {
  let s = input.trim();
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) sites can be probed');
  return `${u.protocol}//${u.host}/`;
}

export function slugify(name: string): string {
  const s = name.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40);
  return s === 'us' ? 'us-competitor' : s;
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&copy;|&#169;/g, '©')
    .replace(/&ndash;|&#8211;/g, '–')
    .replace(/&mdash;|&#8212;/g, '—')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

/** Visible-ish text of an HTML page (scripts, styles and tags stripped). */
export function htmlText(html: string): string {
  return decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function meta(html: string, key: string): string | undefined {
  for (const m of html.matchAll(/<meta\s[^>]*>/gi)) {
    const tag = m[0];
    const name = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (name?.toLowerCase() !== key) continue;
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (content?.trim()) return decode(content.trim());
  }
  return undefined;
}

/** Name and tagline from og:site_name / <title> / og:description. */
export function nameAndTagline(html: string): { name?: string; tagline?: string } {
  const title = decode(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const parts = title.split(/\s+[|–—:·-]\s+/).map((p) => p.trim()).filter(Boolean);
  const site = meta(html, 'og:site_name');
  const name = site || parts[0] || meta(html, 'og:title') || undefined;
  const rest = parts.filter((p) => p !== name);
  const tagline = rest[0] || meta(html, 'og:description') || meta(html, 'description') || undefined;
  return { name, tagline: tagline?.slice(0, 200) };
}

/** Every <a href> on the page, resolved against `base`; http(s) only, deduped. */
export function pageLinks(html: string, base: string): { url: string; text: string }[] {
  const out: { url: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\s[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url: string;
    try {
      url = new URL(decode(m[1]), base).href;
    } catch {
      continue;
    }
    if (!/^https?:/i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, text: htmlText(m[2]).slice(0, 80) });
  }
  for (const m of html.matchAll(/<link\s[^>]*type\s*=\s*["']application\/(?:rss|atom)\+xml["'][^>]*>/gi)) {
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1];
    if (!href) continue;
    try {
      const url = new URL(decode(href), base).href;
      if (!seen.has(url)) {
        seen.add(url);
        out.push({ url, text: 'RSS feed' });
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

type Classified = { kind: IntelSourceKind; label: string; note?: string } | { legal: 'privacy' | 'terms' | 'imprint' } | null;

/** What kind of source a link is, relative to the competitor's own domain. */
export function classifyLink(url: string, ownHost: string, text = ''): Classified {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const own = ownHost.toLowerCase().replace(/^www\./, '');
  const brand = own.split('.')[0];
  const p = u.pathname.toLowerCase();
  const full = (host + p).toLowerCase();
  const is = (d: string) => host === d || host.endsWith('.' + d);
  if (is('apps.apple.com') || is('itunes.apple.com')) return { kind: 'app_store', label: 'App Store' };
  if (is('play.google.com')) return { kind: 'google_play', label: 'Google Play' };
  if (is('g2.com') || full.includes('/g2')) return { kind: 'g2', label: 'G2 reviews' };
  if (is('capterra.com') || is('capterra.co.uk') || full.includes('capterra')) return { kind: 'capterra', label: 'Capterra reviews' };
  if (is('linkedin.com')) return p.startsWith('/company') || p.startsWith('/school') ? { kind: 'linkedin', label: 'LinkedIn' } : null;
  if (is('youtube.com') || is('youtu.be')) return p.startsWith('/watch') ? null : { kind: 'youtube', label: 'YouTube' };
  if (is('tiktok.com')) return { kind: 'tiktok', label: 'TikTok' };
  if (is('instagram.com')) return { kind: 'instagram', label: 'Instagram' };
  if (is('twitter.com') || is('x.com')) return p.split('/').filter(Boolean).length === 1 ? { kind: 'x', label: 'X' } : null;
  if (is('facebook.com')) return { kind: 'facebook', label: 'Facebook' };
  if (is('reddit.com')) return { kind: 'reddit', label: 'Reddit' };
  if (is('canny.io')) return { kind: 'roadmap', label: 'Public roadmap', note: 'Canny' };
  if (is('productboard.com') || host.includes('portal.productboard')) return { kind: 'roadmap', label: 'Public roadmap', note: 'Productboard' };
  if (is('headwayapp.co') || is('beamer.com') || is('releasenotes.app')) return { kind: 'changelog', label: 'Changelog' };
  if (is('lever.co') || is('greenhouse.io') || is('workable.com') || is('ashbyhq.com') || is('teamtailor.com') || /(^|\.)(jobs|careers)\./.test(host) || /\.jobs$/.test(host))
    return { kind: 'jobs', label: 'Jobs' };
  const related = host === own || host.endsWith('.' + own) || (brand.length > 2 && host.split('.').some((x) => x === brand));
  if (!related) return null;
  if (/\/(privacy|privacy-policy)\b/.test(p)) return { legal: 'privacy' };
  if (/\/(terms|tos|terms-of-service|terms-of-use)\b/.test(p)) return { legal: 'terms' };
  if (/\/(imprint|impressum|legal-notice|company-information)\b/.test(p)) return { legal: 'imprint' };
  if (/\/(pricing|plans|premium|upgrade|subscriptions?|buy)\b/.test(p) || /^pricing$/i.test(text.trim())) return { kind: 'pricing', label: 'Pricing' };
  if (/roadmap/.test(full)) return { kind: 'roadmap', label: 'Public roadmap' };
  if (/\/(changelog|whats-new|what-s-new|release-notes|releases|updates)\b/.test(p) || /^changelog\./.test(host)) return { kind: 'changelog', label: 'Changelog' };
  if (/^(help|support|docs|knowledge|kb)\./.test(host) || /\.help$/.test(host) || /\/(help|support|faq|knowledge-base)\b/.test(p)) return { kind: 'help', label: 'Help centre' };
  if (/\/(careers|jobs)\b/.test(p)) return { kind: 'jobs', label: 'Jobs' };
  if (/\/(press|newsroom|media)\b/.test(p)) return { kind: 'press', label: 'Press' };
  if (/\/(feed|rss)(\.xml)?\/?$/.test(p)) return { kind: 'rss', label: 'RSS feed' };
  return null;
}

/** Legal entity names in a page's text, most mentioned first. */
export function legalNames(text: string): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(LEGAL_RE)) {
    let words = m[1].trim().split(/\s+/);
    // "Services. Designated Agent X, Inc" → only what follows the full stop
    for (let i = words.length - 2; i >= 0; i--) {
      if (/\.$/.test(words[i]) && words[i].length > 2) {
        words = words.slice(i + 1);
        break;
      }
    }
    while (words.length && (STOP_FIRST.has(words[0].replace(/,$/, '')) || /^\d/.test(words[0]))) words = words.slice(1);
    if (!words.length) continue;
    const name = `${words.join(' ')} ${m[2]}`.replace(/\s+/g, ' ').trim();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  // "DDG Wallwisher, Inc" and "Designated Agent Wallwisher, Inc" are mentions of "Wallwisher, Inc".
  const names = [...counts.keys()].sort((a, b) => a.length - b.length);
  for (const long of names) {
    const short = names.find((n) => n !== long && long.endsWith(' ' + n) && counts.has(n));
    if (short && counts.has(long)) {
      counts.set(short, counts.get(short)! + counts.get(long)!);
      counts.delete(long);
    }
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

/** UK company numbers quoted on a page ("Company number 08181561", "registered in England No. SC123456"). */
export function companyNumbers(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:company|registration|registered)\s*(?:number|no\.?|#)?\s*:?\s*((?:[A-Z]{2}\d{6})|\d{8}|\d{7})\b/gi)) out.add(m[1].toUpperCase().padStart(8, '0'));
  return [...out];
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function isoDate(s: string): string | undefined {
  const m = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(s);
  if (!m) return undefined;
  const mon = MONTHS.indexOf(m[2].toLowerCase());
  if (mon < 0) return undefined;
  return `${m[3]}-${String(mon + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

type Company = IntelProbe['companies'][number];

/** Companies House's public search page → candidates. */
export function parseChSearch(html: string): Company[] {
  const out: Company[] = [];
  for (const m of html.matchAll(/<li class="type-company">([\s\S]*?)<\/li>/g)) {
    const block = m[1];
    const link = /href="\/company\/([A-Z0-9]{8})"[\s\S]*?>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const metaLine = htmlText(/<p class="meta crumbtrail">([\s\S]*?)<\/p>/.exec(block)?.[1] ?? '');
    const address = htmlText(/<p>([\s\S]*?)<\/p>\s*$/.exec(block.trim())?.[1] ?? '') || undefined;
    const dissolved = /dissolved/i.test(metaLine);
    const incorporated = /incorporated on/i.test(metaLine) ? isoDate(metaLine) : undefined;
    out.push({
      number: link[1],
      name: htmlText(link[2]),
      status: dissolved ? 'dissolved' : /liquidation/i.test(metaLine) ? 'liquidation' : 'active',
      ...(incorporated ? { incorporated } : {}),
      ...(address ? { address } : {}),
      url: `${CH_WEB}/company/${link[1]}`,
    });
  }
  return out;
}

/** Companies House API search JSON → candidates. */
export function parseChApi(json: unknown): Company[] {
  const items = (json as { items?: unknown[] })?.items;
  if (!Array.isArray(items)) return [];
  return items
    .map((raw) => raw as Record<string, unknown>)
    .filter((it) => typeof it.company_number === 'string' && typeof it.title === 'string')
    .map((it) => ({
      number: String(it.company_number),
      name: String(it.title),
      status: String(it.company_status ?? 'unknown'),
      ...(typeof it.date_of_creation === 'string' ? { incorporated: it.date_of_creation } : {}),
      ...(typeof it.address_snippet === 'string' ? { address: it.address_snippet } : {}),
      url: `${CH_WEB}/company/${it.company_number}`,
    }));
}

const normName = (s: string) =>
  s
    .toLowerCase()
    .replace(/[.,'’]/g, '')
    .replace(/\blimited\b/g, 'ltd')
    .replace(/\s+/g, ' ')
    .trim();

/** Best first: matches a legal name on the site, then a quoted company number, then active, then the search order. */
export function rankCompanies(list: Company[], legal: string[], numbers: string[], brand?: string): Company[] {
  const want = new Set(legal.map(normName));
  const brandN = brand ? normName(brand) : '';
  const score = (c: Company) =>
    (numbers.includes(c.number) ? 8 : 0) + (want.has(normName(c.name)) ? 6 : 0) + (brandN && normName(c.name).startsWith(brandN + ' ') ? 1 : 0) + (c.status === 'active' ? 2 : 0);
  const seen = new Set<string>();
  return list
    .map((c, i) => ({ c, i, s: score(c) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c)
    .filter((c) => (seen.has(c.number) ? false : (seen.add(c.number), true)));
}

/** Looks a competitor up from its URL. Never throws for site problems: they go in `notes`. */
export async function probeSite(input: string, opts: ProbeOptions = {}): Promise<IntelProbe> {
  const doFetch: FetchLike = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const deadline = Date.now() + (opts.deadlineMs ?? 10_000);
  const notes: string[] = [];
  let home: string;
  try {
    home = normaliseHome(input);
  } catch {
    return { url: input, found: false, legal: [], companies: [], sources: [], notes: ['That does not look like a web address.'] };
  }
  const probe: IntelProbe = { url: home, found: false, legal: [], companies: [], sources: [], notes };

  const get = async (url: string, headers: Record<string, string> = {}, capMs = Infinity): Promise<{ status: number; url: string; body: string } | null> => {
    const left = Math.min(capMs, deadline - Date.now());
    if (left <= 200) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), left);
    try {
      const res = await doFetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', ...headers }, signal: ctl.signal, redirect: 'follow' });
      const body = await res.text();
      return { status: res.status, url: res.url || url, body };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  // 1. Home page: name, tagline, links.
  const page = await get(home);
  let ownHost = new URL(home).hostname;
  let links: { url: string; text: string }[] = [];
  if (!page) notes.push("Couldn't reach the site in time.");
  else if (page.status >= 400) notes.push(`The site answered ${page.status} (it may block anonymous requests); fill the details in by hand.`);
  else {
    probe.found = true;
    try {
      const final = new URL(page.url);
      ownHost = final.hostname;
      probe.url = `${final.protocol}//${final.host}/`;
    } catch {
      /* keep */
    }
    const nt = nameAndTagline(page.body);
    if (nt.name) probe.name = nt.name;
    if (nt.tagline) probe.tagline = nt.tagline;
    links = pageLinks(page.body, probe.url);
  }
  probe.suggestedId = slugify(probe.name || ownHost.replace(/^www\./, '').split('.')[0]);

  // 2. Sources: one per kind (socials one each), in page order.
  const legalPages: { kind: 'privacy' | 'terms' | 'imprint'; url: string }[] = [];
  const seenKinds = new Set<string>();
  for (const l of links) {
    const c = classifyLink(l.url, ownHost, l.text);
    if (!c) continue;
    if ('legal' in c) {
      if (!legalPages.some((p) => p.kind === c.legal)) legalPages.push({ kind: c.legal, url: l.url });
      continue;
    }
    if (seenKinds.has(c.kind)) continue;
    seenKinds.add(c.kind);
    const src: IntelSiteSource = { kind: c.kind, url: l.url, label: c.label, ...(c.note ? { note: c.note } : {}) };
    probe.sources.push(src);
  }

  // 3. Legal names (footer of the home page, then imprint / privacy / terms) while Companies House is
  //    searched for the product name, so a slow legal page can't eat the whole budget.
  let chFailed = false;
  const chSearch = async (q: string): Promise<Company[]> => {
    if (opts.companiesHouseKey) {
      const auth = Buffer.from(`${opts.companiesHouseKey}:`).toString('base64');
      const res = await get(`${CH_API}/search/companies?q=${encodeURIComponent(q)}&items_per_page=5`, { authorization: `Basic ${auth}`, accept: 'application/json' });
      if (!res || res.status >= 400) return (chFailed = true), [];
      try {
        return parseChApi(JSON.parse(res.body));
      } catch {
        return (chFailed = true), [];
      }
    }
    const res = await get(`${CH_WEB}/search/companies?q=${encodeURIComponent(q)}`);
    if (!res || res.status >= 400) return (chFailed = true), [];
    return parseChSearch(res.body).slice(0, 5);
  };
  // The product-name search only keeps companies carrying the name ("PADLET LTD", not "PAD LETTINGS").
  const squash = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const byName = probe.name && squash(probe.name).length > 1 ? chSearch(probe.name).then((l) => l.filter((c) => squash(c.name).includes(squash(probe.name!)))) : Promise.resolve([] as Company[]);

  const legalSeen = new Map<string, { count: number; from: Set<string> }>();
  const numbers = new Set<string>();
  const addLegal = (text: string, from: string) => {
    for (const { name, count } of legalNames(text)) {
      const e = legalSeen.get(name) ?? { count: 0, from: new Set<string>() };
      e.count += count;
      e.from.add(from);
      legalSeen.set(name, e);
    }
    for (const n of companyNumbers(text)) numbers.add(n);
  };
  if (page && probe.found) {
    const footer = /<footer[\s\S]*?<\/footer>/i.exec(page.body)?.[0];
    addLegal(footer ? htmlText(footer) : htmlText(page.body).slice(-4000), 'site footer');
  }
  const order = { imprint: 0, privacy: 1, terms: 2 } as const;
  const legalLabel = { imprint: 'imprint', privacy: 'privacy policy', terms: 'terms' } as const;
  const legalCap = Math.max(1000, (deadline - Date.now()) * 0.6);
  const legalFetched = await Promise.all(legalPages.sort((a, b) => order[a.kind] - order[b.kind]).map(async (p) => ({ p, res: await get(p.url, {}, legalCap) })));
  for (const { p, res } of legalFetched) if (res && res.status < 400) addLegal(htmlText(res.body), legalLabel[p.kind]);
  // Names on more pages first; the merge in legalNames already folded "Agent X, Inc" into "X, Inc".
  probe.legal = [...legalSeen.entries()]
    .sort((a, b) => b[1].from.size - a[1].from.size || b[1].count - a[1].count)
    .slice(0, 5)
    .map(([name, e]) => ({ name, matchedFrom: [...e.from].join(', ') }));

  // 4. Companies House: also search the UK-looking legal names that are the site's own (the top one, or
  //    one carrying the brand), not processors and representatives named in the privacy policy.
  const brand = (probe.name ?? '').toLowerCase();
  const own = probe.legal.filter((l, i) => i === 0 || (brand.length > 2 && l.name.toLowerCase().includes(brand)));
  const ukNames = own.map((l) => l.name).filter((n) => UK_SUFFIX.test(n) && normName(n) !== normName(probe.name ?? ''));
  if (probe.legal.length && !UK_SUFFIX.test(probe.legal[0].name)) notes.push(`${probe.legal[0].name} doesn't look like a UK company, so Companies House may not list it; candidates below match the product name.`);
  const ownSquashed = own.map((l) => squash(l.name.replace(UK_SUFFIX, '')));
  const found = (await Promise.all([...ukNames.slice(0, 2).map(chSearch), byName])).flat().filter((c) => ownSquashed.some((o) => o.length > 2 && squash(c.name).includes(o)) || (probe.name && squash(c.name).includes(squash(probe.name))));
  probe.companies = rankCompanies(found, own.map((l) => l.name), [...numbers], probe.name).slice(0, 6);
  const queries = ukNames.length + (probe.name ? 1 : 0);
  if (chFailed) notes.push(opts.companiesHouseKey ? 'The Companies House API search failed or timed out.' : 'The Companies House search page failed or timed out (an API key in Settings → Intel is faster).');
  else if (queries && !probe.companies.length) notes.push('No Companies House match.');
  if (probe.found && !probe.sources.length) notes.push('No pricing, roadmap, store or social links found on the home page (it may render them with JavaScript).');
  if (Date.now() >= deadline) notes.push('Stopped at the 10 s limit; some lookups were skipped.');
  return probe;
}
