// Bot checks and blocks: when a site answers the research browser with a challenge page (Cloudflare's
// "Just a moment…", "Prove your humanity", a 429) instead of content. Muster never tries to get past one:
// it says so, and scout reads the page through a public reader instead (readPublic below).

/** What we know about a loaded page. `html` and `text` may be partial (the first few KB are enough). */
export interface PageSignals {
  status: number;
  title?: string;
  text?: string;
  html?: string;
}

/** The note scout gets (and puts on the source) when a page was read through the public reader. */
export const PUBLIC_READER_NOTE = 'read via public reader (site blocked the research browser)';

const TITLE_RE = /^\s*(just a moment|attention required|please wait\b|checking your browser|security check|verify(ing)? you are (a )?human|access denied|one more step)/i;
const TEXT_RE =
  /prove your humanity|verify(ing)? (that )?you are (a )?human|checking if the site connection is secure|checking your browser before|enable javascript and cookies to continue|needs to review the security of your connection|sorry, you have been blocked|press (&|and) hold|unusual traffic from your (computer )?network|blocked by network security/i;
const HTML_RE = /cf_chl_|\/cdn-cgi\/challenge-platform\/|id="challenge-(form|running|stage|body-text|error-text)"|id="cf-error-details"|captcha-delivery\.com|id="px-captcha"|_Incapsula_Resource/i;
const CLOUDFLARE_RE = /cloudflare|cf_chl_|cdn-cgi|cf-error|just a moment|attention required/i;
/** A real page that merely mentions one of the phrases is long; a challenge page says little else. */
const SHORT_TEXT = 1500;

const visible = (html: string) =>
  html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const titleOf = (html: string) => /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '';

/**
 * Why this page is a bot check or a block rather than content, or undefined when it looks like the page.
 * "bot check (Cloudflare)", "bot check", "rate limited (429)".
 */
export function detectBlock(p: PageSignals): string | undefined {
  const html = p.html ?? '';
  const title = p.title ?? titleOf(html);
  const text = p.text ?? (html ? visible(html) : '');
  const statusBlock = p.status === 403 || p.status === 429 || p.status === 503;
  const label = () => (CLOUDFLARE_RE.test(`${title} ${html}`) ? 'bot check (Cloudflare)' : 'bot check');
  if (TITLE_RE.test(title) && (statusBlock || text.length < SHORT_TEXT)) return label();
  if (HTML_RE.test(html)) return label();
  if (TEXT_RE.test(text) && (statusBlock || text.length < SHORT_TEXT)) return label();
  if (p.status === 429) return 'rate limited (429)';
  return undefined;
}

// ---- the public reader ---------------------------------------------------------------------------

export interface PublicRead {
  url: string;
  title: string;
  text: string;
  /** 'jina' (r.jina.ai, as in the web-research skill) or 'fetch' (a plain request without cookies). */
  reader: 'jina' | 'fetch';
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'follow' }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; url?: string }>;

const TEXT_MAX = 40_000;
const MIN_PLAIN_TEXT = 100;
const clip = (s: string) => (s.length > TEXT_MAX ? s.slice(0, TEXT_MAX) + '\n[… truncated]' : s);

/**
 * Reads a public page without the research profile: first through the Jina Reader (https://r.jina.ai/<url>),
 * then with a plain cookie-less request. Throws when both fail or both meet a bot check too.
 */
export async function readPublic(url: string, opts: { fetch?: FetchLike; timeoutMs?: number } = {}): Promise<PublicRead> {
  const get = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const problems: string[] = [];
  try {
    const res = await get(`https://r.jina.ai/${url}`, { headers: { accept: 'text/plain' }, signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const title = /^Title:\s*(.*)$/m.exec(body)?.[1]?.trim() ?? '';
    const marker = body.indexOf('Markdown Content:');
    const text = (marker >= 0 ? body.slice(marker + 'Markdown Content:'.length) : body).trim();
    const blocked = detectBlock({ status: 200, title, text });
    if (blocked || /^Warning: Target URL returned error (403|429|503)/m.test(body)) throw new Error(blocked ?? 'the site blocked the reader too');
    if (!text) throw new Error('empty page');
    return { url, title, text: clip(text), reader: 'jina' };
  } catch (e) {
    problems.push(`public reader: ${e instanceof Error ? e.message : e}`);
  }
  try {
    const res = await get(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    const html = await res.text();
    const blocked = detectBlock({ status: res.status, html });
    if (blocked) throw new Error(blocked);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = visible(html);
    // A JavaScript app shell (Reddit answers a cookie-less request with just "Reddit") is not a read.
    if (text.length < MIN_PLAIN_TEXT) throw new Error(text ? `almost empty page (${text.length} characters: it needs JavaScript or a login)` : 'empty page');
    return { url: res.url || url, title: titleOf(html), text: clip(text), reader: 'fetch' };
  } catch (e) {
    problems.push(`plain request: ${e instanceof Error ? e.message : e}`);
  }
  throw new Error(problems.join('; '));
}
