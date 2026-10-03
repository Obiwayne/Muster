// The research browser: Muster's own Chrome profile that scout reads pages through, never your
// everyday browser (docs/ARCHITECTURE.md, Competitive intelligence → Research browser).
//
// Read-only by construction: the class exposes read, screenshot and scroll (plus the human's login
// window and cookie housekeeping) and nothing that acts on a page. Navigation is http(s) GET only,
// downloads are refused, permission prompts denied, dialogs dismissed and popups closed.
//
// playwright-core is loaded with a dynamic import, so Muster builds, tests and runs without it; the
// tiny interfaces below are the only parts of its API this module touches (tests inject a fake).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, posix, win32 } from 'node:path';
import { HttpError, badRequest, conflict, notFound } from '../core/errors.js';
import { secretsBase } from '../core/tokens.js';
import type { BrowseMode, BrowseResult, ResearchBrowserConfig, ResearchBrowserStatus, ResearchSiteStatus } from '../types.js';
import { agentReachPython, exportOperaCookies, operaFound, operaProfileDir, realRunner, type OperaOptions, type PwCookie, type PythonRunner } from './opera.js';
import { detectBlock } from './botcheck.js';
import { cleanDomain, hostMatches, siteByName, siteDomains, siteForHost, SITES } from './sites.js';

// ---- the slice of playwright-core this module uses ---------------------------------------------

export interface PwResponse {
  status(): number;
}
export interface PwRequest {
  method(): string;
  url(): string;
  isNavigationRequest(): boolean;
}
export interface PwRoute {
  request(): PwRequest;
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
}
export interface PwDialog {
  dismiss(): Promise<void>;
}
export interface PwPage {
  goto(url: string, opts?: { waitUntil?: 'load' | 'domcontentloaded'; timeout?: number }): Promise<PwResponse | null>;
  url(): string;
  title(): Promise<string>;
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>;
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<unknown>;
  mouse: { wheel(deltaX: number, deltaY: number): Promise<void> };
  waitForTimeout(ms: number): Promise<void>;
  on(event: 'popup', fn: (p: PwPage) => void): unknown;
  on(event: 'dialog', fn: (d: PwDialog) => void): unknown;
  on(event: 'close', fn: () => void): unknown;
  close(): Promise<void>;
  isClosed(): boolean;
}
export interface PwContext {
  pages(): PwPage[];
  newPage(): Promise<PwPage>;
  cookies(urls?: string | string[]): Promise<PwCookie[]>;
  addCookies(cookies: PwCookie[]): Promise<void>;
  clearCookies(opts?: { domain?: string | RegExp }): Promise<void>;
  route(url: string, handler: (route: PwRoute) => unknown): Promise<void>;
  on(event: 'close', fn: () => void): unknown;
  on(event: 'page', fn: (p: PwPage) => void): unknown;
  close(): Promise<void>;
}
export interface PwBrowser {
  newContext(opts: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
}
export interface PwModule {
  chromium: {
    launchPersistentContext(dir: string, opts: Record<string, unknown>): Promise<PwContext>;
    launch(opts: Record<string, unknown>): Promise<PwBrowser>;
    executablePath?(): string;
  };
}

// ---- options and saved state ---------------------------------------------------------------------

export interface ResearchBrowserOptions {
  config(): ResearchBrowserConfig;
  /** Base folder (default `<secretsBase()>/research-browser`): profile/ and status.json live here. */
  baseDir?: string;
  /** Test seam / live check: loads playwright-core (default: dynamic import). */
  loadPlaywright?: () => Promise<PwModule>;
  exists?: (p: string) => boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run?: PythonRunner; // python runner for the Opera export and the browser_cookie3 check
  opera?: OperaOptions;
  idleMs?: number; // the browsing context closes after this long unused (default 2 min)
  navTimeoutMs?: number; // per page load (default 30 s)
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface SavedState {
  sites: Record<string, { connected: boolean; via?: 'login' | 'opera'; checkedAt: string }>;
  opera: { lastImportAt?: string; imported?: Record<string, number> };
  /** domain → the bot check it answered with last time (cleared by a good load). */
  blocked?: Record<string, { reason: string; at: string }>;
}

export interface ReadOpts {
  mode: BrowseMode;
  links?: boolean;
}
export type BrowseOut = Omit<BrowseResult, 'pagesLeft'>;

const TEXT_MAX = 40_000;
const LINKS_MAX = 200;
const TOOLS_TTL_MS = 5 * 60_000;
const LOGIN_POLL_MS = 3000;

const defaultLoader = async (): Promise<PwModule> => {
  const name = 'playwright-core'; // a variable keeps tsc from resolving the optional module
  const mod = (await import(name)) as PwModule & { default?: PwModule };
  return mod.chromium ? mod : (mod.default as PwModule);
};

/** http(s) URLs only; anything else is a 400. */
export function checkUrl(url: unknown): string {
  if (typeof url !== 'string' || !url.trim()) throw badRequest('Missing url');
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw badRequest(`Not a URL: ${url}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw badRequest('Only http and https pages can be browsed');
  return u.href;
}

const today = (now: number) => new Date(now).toISOString().slice(0, 10);
const domainKey = (host: string) => host.toLowerCase().replace(/^www\./, '');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Executable of an installed browser channel, or undefined. */
export function channelExecutable(channel: 'chrome' | 'msedge', env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (p: string) => boolean): string | undefined {
  const list: string[] = [];
  const pj = platform === 'win32' ? win32.join : posix.join;
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((p): p is string => !!p);
    const rel = channel === 'chrome' ? ['Google', 'Chrome', 'Application', 'chrome.exe'] : ['Microsoft', 'Edge', 'Application', 'msedge.exe'];
    for (const r of roots) list.push(pj(r, ...rel));
  } else if (platform === 'darwin') {
    list.push(channel === 'chrome' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    list.push(channel === 'chrome' ? '/opt/google/chrome/chrome' : '/opt/microsoft/msedge/msedge', channel === 'chrome' ? '/usr/bin/google-chrome' : '/usr/bin/microsoft-edge');
  }
  return list.find((p) => exists(p));
}

/** True when `bin` is on PATH. */
export function onPath(bin: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (p: string) => boolean): boolean {
  const dirs = (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  const exts = platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : [''];
  const pj = platform === 'win32' ? win32.join : posix.join;
  return dirs.some((d) => exts.some((e) => exists(pj(d, bin + e))));
}

export class ResearchBrowser {
  readonly baseDir: string;
  readonly profileDir: string;
  private readonly stateFile: string;
  private readonly exists: (p: string) => boolean;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly run: PythonRunner;
  private readonly idleMs: number;
  private readonly navTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private pw?: PwModule;
  private pwError?: string;
  private profileCtx?: PwContext;
  private profilePage?: PwPage;
  private publicBrowser?: PwBrowser;
  private publicCtx?: PwContext;
  private publicPage?: PwPage;
  private loginCtx?: PwContext;
  private loginSite?: string;
  private loginPoll?: NodeJS.Timeout;
  private loginCookies?: { name: string; domain: string }[]; // names/domains only, never values
  private loginClosing?: Promise<void>;
  private idleTimer?: NodeJS.Timeout;
  private chain: Promise<unknown> = Promise.resolve();
  private inFlight = 0;
  private lastLoad = new Map<string, number>();
  private lastStatus = new WeakMap<PwPage, number>();
  private lastAction = new WeakMap<PwPage, 'read' | 'screenshot' | 'scroll'>();
  private requested = new WeakMap<PwPage, string>(); // the URL asked for (before redirects), so a scroll after a read reuses the page
  private profileHeaded = false; // the profile context is a visible window (a site in config.visibleSites)
  private tools?: { at: number; list: ResearchBrowserStatus['tools'] };
  private firstLookAt = -Infinity; // last time status() launched the profile just to read which sites are signed in
  private saved: SavedState;

  constructor(private readonly opts: ResearchBrowserOptions) {
    this.env = opts.env ?? process.env;
    this.platform = opts.platform ?? process.platform;
    this.baseDir = opts.baseDir ?? join(secretsBase(this.env, this.platform), 'research-browser');
    this.profileDir = join(this.baseDir, 'profile');
    this.stateFile = join(this.baseDir, 'status.json');
    this.exists = opts.exists ?? existsSync;
    this.run = opts.run ?? opts.opera?.run ?? realRunner;
    this.idleMs = opts.idleMs ?? 2 * 60_000;
    this.navTimeoutMs = opts.navTimeoutMs ?? 30_000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.saved = this.loadSaved();
  }

  // ---- status ------------------------------------------------------------------------------------

  /** What the research browser can do on this PC (GET /api/browser). */
  async status(): Promise<ResearchBrowserStatus> {
    const cfg = this.opts.config();
    const problem = await this.problem(cfg);
    // First look, or the profile is open anyway: read which sites are signed in (cookie names only).
    // A failed first look isn't retried for a minute, so polling GET /api/browser never launches Chrome per call.
    const firstLook = !Object.keys(this.saved.sites).length && this.now() - this.firstLookAt > 60_000;
    if (!problem && !this.loginCtx && this.inFlight === 0 && (this.profileCtx || firstLook)) {
      if (!this.profileCtx) this.firstLookAt = this.now();
      await this.exclusive(async () => this.refreshSites(await this.profileContext())).catch(() => undefined);
    }
    const sites: ResearchSiteStatus[] = SITES.map((s) => {
      const st = this.saved.sites[s.site];
      return {
        site: s.site,
        label: s.label,
        domain: s.domain,
        loginUrl: s.loginUrl,
        connected: !!st?.connected,
        ...(st?.connected && st.via ? { via: st.via } : {}),
        checkedAt: st?.checkedAt ?? '',
        ...(s.warning ? { warning: s.warning } : {}),
        ...(s.limits ? { limits: s.limits } : {}),
        ...((cfg.visibleSites ?? []).some((d) => siteDomains(s).some((x) => hostMatches(x, d) || hostMatches(d, x))) ? { visible: true } : {}),
        ...(this.blockedFor(siteDomains(s)) ? { blocked: this.blockedFor(siteDomains(s)) } : {}),
      };
    });
    const blocked = Object.entries(this.saved.blocked ?? {}).map(([domain, b]) => ({ domain, ...b }));
    const operaDir = operaProfileDir(this.env, this.platform);
    const found = operaFound(operaDir, this.exists);
    return {
      available: !problem,
      ...(problem ? { problem } : {}),
      channel: cfg.channel,
      profileDir: this.profileDir,
      state: this.loginCtx ? 'login_open' : this.inFlight > 0 ? 'browsing' : 'idle',
      ...(this.loginSite ? { loginSite: this.loginSite } : {}),
      sites,
      tools: await this.toolList(found),
      opera: {
        found,
        ...(found ? { profileDir: operaDir } : {}),
        allow: [...cfg.operaAllow],
        ...(this.saved.opera.lastImportAt ? { lastImportAt: this.saved.opera.lastImportAt } : {}),
        ...(this.saved.opera.imported ? { imported: { ...this.saved.opera.imported } } : {}),
      },
      ...(blocked.length ? { blocked } : {}),
    };
  }

  /** The newest bot-check record for any of a site's domains (or their subdomains). */
  private blockedFor(domains: string[]): { reason: string; at: string } | undefined {
    const hits = Object.entries(this.saved.blocked ?? {}).filter(([d]) => domains.some((s) => hostMatches(d, s)));
    return hits.sort((a, b) => b[1].at.localeCompare(a[1].at))[0]?.[1];
  }

  /** Remembers (or clears) that a domain answered with a bot check; saved only when it changes. */
  private noteBlocked(url: string, reason: string | undefined): void {
    let host: string;
    try {
      host = domainKey(new URL(url).hostname);
    } catch {
      return;
    }
    const all = (this.saved.blocked ??= {});
    if (!reason) {
      if (!all[host]) return;
      delete all[host];
    } else {
      all[host] = { reason, at: new Date(this.now()).toISOString() };
      const keys = Object.keys(all);
      if (keys.length > 50) for (const k of keys.sort((a, b) => all[a].at.localeCompare(all[b].at)).slice(0, keys.length - 50)) delete all[k];
    }
    this.save();
  }

  /** Why the browser can't run, or undefined when it can. */
  private async problem(cfg: ResearchBrowserConfig): Promise<string | undefined> {
    const pw = await this.playwright().catch(() => undefined);
    if (!pw) return this.pwError ?? 'playwright-core is not installed';
    if (channelExecutable(cfg.channel, this.env, this.platform, this.exists)) return undefined;
    const bundled = this.bundledExecutable(pw);
    if (bundled) return undefined;
    return cfg.channel === 'chrome' ? 'Chrome not found: install Google Chrome, or switch the channel to Edge' : 'Microsoft Edge not found';
  }

  private bundledExecutable(pw: PwModule): string | undefined {
    try {
      const p = pw.chromium.executablePath?.();
      return p && this.exists(p) ? p : undefined;
    } catch {
      return undefined;
    }
  }

  private async toolList(operaOk: boolean): Promise<ResearchBrowserStatus['tools']> {
    if (this.tools && this.now() - this.tools.at < TOOLS_TTL_MS) {
      return this.tools.list.map((t) => (t.name === 'Opera profile' ? { ...t, ok: operaOk } : t));
    }
    const python = agentReachPython(this.env, this.platform);
    const hasPython = this.exists(python);
    let bc3 = false;
    if (hasPython) bc3 = (await this.run(python, ['-c', 'import browser_cookie3'], 20_000).catch(() => ({ code: 1 }))).code === 0;
    const ytdlp = onPath('yt-dlp', this.env, this.platform, this.exists);
    const list: ResearchBrowserStatus['tools'] = [
      { name: 'yt-dlp', ok: ytdlp, ...(ytdlp ? {} : { note: "not on PATH: Agent Reach's YouTube channel (search, subtitles) is off" }) },
      { name: 'Agent Reach python', ok: hasPython, note: hasPython ? python : 'not found: Opera import and RSS need ~/.agent-reach/venv' },
      { name: 'browser_cookie3', ok: bc3, ...(bc3 ? { note: 'reads Opera cookies for the allowlist only' } : { note: 'not installed in the Agent Reach python: Opera import is off' }) },
      { name: 'Opera profile', ok: operaOk, ...(operaOk ? {} : { note: 'Opera not found on this PC' }) },
    ];
    this.tools = { at: this.now(), list };
    return list;
  }

  // ---- read-only browsing ------------------------------------------------------------------------

  /** Visible text of a page (≤ 40,000 chars), and its links when asked. */
  read(url: string, opts: ReadOpts): Promise<BrowseOut> {
    const target = checkUrl(url);
    return this.browse(opts.mode, target, 'read', async (page) => {
      // A read loads the page fresh, except right after a scroll of it (to see what the scroll loaded).
      const status = await this.navigate(page, target, this.lastAction.get(page) === 'scroll');
      const got = await page.evaluate(
        (want: { links: boolean; max: number; maxLinks: number }) => {
          const doc = (globalThis as any).document;
          let text = String(doc?.body?.innerText ?? '');
          if (text.length > want.max) text = text.slice(0, want.max) + '\n[… truncated]';
          const links: { text: string; url: string }[] = [];
          if (want.links) {
            const seen = new Set<string>();
            for (const a of Array.from(doc?.querySelectorAll('a[href]') ?? []) as any[]) {
              const href = String(a.href || '');
              if (!/^https?:/i.test(href) || seen.has(href)) continue;
              seen.add(href);
              links.push({ text: String(a.innerText || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 200), url: href });
              if (links.length >= want.maxLinks) break;
            }
          }
          return { text, links };
        },
        { links: !!opts.links, max: TEXT_MAX, maxLinks: LINKS_MAX },
      );
      return { status, text: got.text, ...(opts.links ? { links: got.links } : {}) };
    });
  }

  /** A PNG of the page at `path` (the API picks .muster/intel/shots/<id>/<n>.png). */
  screenshot(url: string, opts: { mode: BrowseMode; path: string; fullPage?: boolean }): Promise<BrowseOut> {
    const target = checkUrl(url);
    return this.browse(opts.mode, target, 'screenshot', async (page) => {
      const status = await this.navigate(page, target, true);
      mkdirSync(dirname(opts.path), { recursive: true });
      await page.screenshot({ path: opts.path, fullPage: !!opts.fullPage });
      return { status, screenshot: opts.path };
    });
  }

  /** Scrolls the page (loading it first unless it is already open) by `by` pixels; a later read sees what loaded. */
  scroll(url: string, opts: { mode: BrowseMode; by?: number }): Promise<BrowseOut> {
    const target = checkUrl(url);
    const by = Number.isFinite(opts.by) ? Math.max(-20_000, Math.min(20_000, Number(opts.by))) : 2000;
    return this.browse(opts.mode, target, 'scroll', async (page) => {
      const status = await this.navigate(page, target, true);
      const where = () =>
        page.evaluate(() => {
          const g = globalThis as any;
          return { y: Math.round(Number(g.scrollY) || 0), height: Math.round(Number(g.document?.documentElement?.scrollHeight) || 0) };
        }, undefined);
      const before = await where();
      await page.mouse.wheel(0, by);
      await page.waitForTimeout(800);
      let scrolled = await where();
      if (scrolled.y === before.y) {
        // The wheel landed outside the scrolling element (or the page ignores it): scroll the window instead.
        await page.evaluate((dy: number) => (globalThis as any).scrollBy?.(0, dy), by);
        await page.waitForTimeout(500);
        scrolled = await where();
      }
      return { status, scrolled };
    });
  }

  /** Runs one browse call: one at a time, on the mode's page; adds url, title, loggedIn and via. */
  private browse(mode: BrowseMode, target: string, action: 'read' | 'screenshot' | 'scroll', fn: (page: PwPage) => Promise<Partial<BrowseOut> & { status: number }>): Promise<BrowseOut> {
    if (mode !== 'public' && this.loginCtx) return Promise.reject(conflict('The research browser login window is open: close the login window first.'));
    return this.exclusive(async () => {
      if (mode !== 'public' && this.loginCtx) throw conflict('The research browser login window is open: close the login window first.');
      await this.ensureAvailable();
      const page = mode === 'public' ? await this.publicPageGet() : await this.profilePageGet(this.visibleFor(target));
      const out = await fn(page);
      this.lastAction.set(page, action);
      const final = page.url();
      const title = await page.title().catch(() => '');
      const loggedIn = mode === 'public' ? false : await this.loggedIn(final);
      // A bot check or block instead of the page: say so (the API falls back to the public reader); the page is left as it is.
      const seen = await page
        .evaluate(() => {
          const doc = (globalThis as any).document;
          return { html: String(doc?.documentElement?.outerHTML ?? '').slice(0, 60_000), text: String(doc?.body?.innerText ?? '').slice(0, 5000) };
        }, undefined)
        .catch(() => ({ html: '', text: '' }));
      const blocked = detectBlock({ status: out.status, title, html: seen.html, text: out.text ?? seen.text });
      this.noteBlocked(final, blocked);
      // A blocked page is not a signed-in page, whatever cookies the profile holds: the site never served it.
      return {
        url: final,
        title,
        ...out,
        ...(blocked ? { loggedIn: false, blocked } : loggedIn !== undefined ? { loggedIn } : {}),
        via: mode,
      } as BrowseOut;
    });
  }

  /** Loads `url` (GET), waiting out the per-domain delay; an already open page with the same URL is reused. */
  private async navigate(page: PwPage, url: string, reuse: boolean): Promise<number> {
    if (reuse && !page.isClosed() && this.lastStatus.has(page) && (page.url() === url || this.requested.get(page) === url)) return this.lastStatus.get(page)!;
    const host = domainKey(new URL(url).hostname);
    const min = this.opts.config().minDelayMs;
    const last = this.lastLoad.get(host);
    if (last !== undefined && min > 0) {
      const wait = last + min - this.now();
      if (wait > 0) await this.sleep(wait);
    }
    this.lastLoad.set(host, this.now());
    let res: PwResponse | null;
    try {
      res = await page.goto(url, { waitUntil: 'load', timeout: this.navTimeoutMs });
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0];
      if (!/timeout/i.test(msg)) throw new HttpError(502, `Couldn't load ${url}: ${msg}`);
      res = null; // slow page: read what is there
    }
    let status = res?.status() ?? 0;
    if (status === 403 || status === 503) status = await this.passChallenge(page, url, status);
    this.lastStatus.set(page, status);
    this.requested.set(page, url);
    return status;
  }

  /**
   * Bot-check interstitials ("Just a moment...", Cloudflare) solve themselves in a real browser after a
   * few seconds of JavaScript. Wait for the title to change (up to ~12 s), then load the page once more
   * for its real status. Nothing on the page is touched: a check that needs a human stays unsolved and is reported.
   */
  private async passChallenge(page: PwPage, url: string, status: number): Promise<number> {
    const isCheck = (t: string) => /just a moment|security check|attention required|verify(ing)? you are human|checking your browser/i.test(t);
    if (!isCheck(await page.title().catch(() => ''))) return status;
    for (let waited = 0; waited < 12_000; waited += 1000) {
      await page.waitForTimeout(1000);
      if (!isCheck(await page.title().catch(() => ''))) {
        const again = await page.goto(url, { waitUntil: 'load', timeout: this.navTimeoutMs }).catch(() => null);
        return again?.status() ?? 200;
      }
    }
    return status;
  }

  private async loggedIn(url: string): Promise<boolean | undefined> {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return undefined;
    }
    const site = siteForHost(host);
    if (!site || !this.profileCtx) return undefined;
    const cookies = await this.profileCtx.cookies().catch(() => [] as PwCookie[]);
    return cookies.some((c) => site.authCookies.includes(c.name) && siteDomains(site).some((d) => hostMatches(c.domain, d)));
  }

  // ---- contexts ----------------------------------------------------------------------------------

  private async playwright(): Promise<PwModule> {
    if (this.pw) return this.pw;
    try {
      this.pw = await (this.opts.loadPlaywright ?? defaultLoader)();
      if (!this.pw?.chromium) throw new Error('no chromium export');
      this.pwError = undefined;
      return this.pw;
    } catch (e) {
      this.pw = undefined;
      const code = (e as NodeJS.ErrnoException).code;
      this.pwError = code === 'ERR_MODULE_NOT_FOUND' || /cannot find/i.test((e as Error).message) ? 'playwright-core is not installed' : `playwright-core failed to load: ${(e as Error).message}`;
      throw e;
    }
  }

  private async ensureAvailable(): Promise<PwModule> {
    const problem = await this.problem(this.opts.config());
    if (problem) throw new HttpError(503, `The research browser isn't available: ${problem}`);
    return this.pw!;
  }

  private launchOpts(headless: boolean): Record<string, unknown> {
    return {
      headless,
      acceptDownloads: false,
      permissions: [],
      ...(headless ? { viewport: { width: 1280, height: 900 } } : { viewport: null }),
    };
  }

  /**
   * Sites you asked to read in a visible window (config.visibleSites): the research profile opens as a normal,
   * headed Chrome window for them. The browser's own user agent is used everywhere; Muster never disguises it.
   */
  private visibleFor(url: string): boolean {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return false;
    }
    return (this.opts.config().visibleSites ?? []).some((d) => hostMatches(host, d));
  }

  /** Launch with the configured channel; fall back to playwright's own Chromium when that fails and one is cached. */
  private async launch<T>(fn: (extra: Record<string, unknown>) => Promise<T>): Promise<T> {
    const pw = await this.ensureAvailable();
    const channel = this.opts.config().channel;
    try {
      return await fn({ channel });
    } catch (e) {
      if (!this.bundledExecutable(pw)) throw new HttpError(503, `Couldn't start ${channel}: ${(e as Error).message.split('\n')[0]}`);
      return await fn({});
    }
  }

  /** Guards every page scout's context opens: GET-only http(s) navigation, no popups, no dialogs. */
  private async guard(ctx: PwContext): Promise<void> {
    await ctx.route('**/*', (route) => {
      const req = route.request();
      if (req.isNavigationRequest() && (req.method().toUpperCase() !== 'GET' || !/^https?:/i.test(req.url()))) return route.abort('blockedbyclient');
      return route.continue();
    });
    ctx.on('page', (p) => this.guardPage(p));
  }

  private guardPage(p: PwPage): void {
    p.on('popup', (pop) => void pop.close().catch(() => undefined));
    p.on('dialog', (d) => void d.dismiss().catch(() => undefined));
  }

  /** The research profile, headless unless `headed` (a visible-window site); switching closes and relaunches it. */
  private async profileContext(headed?: boolean): Promise<PwContext> {
    if (this.profileCtx && (headed === undefined || headed === this.profileHeaded)) return this.profileCtx;
    if (this.profileCtx) {
      const old = this.profileCtx;
      this.profileCtx = this.profilePage = undefined;
      await old.close().catch(() => undefined);
    }
    const pw = await this.ensureAvailable();
    mkdirSync(this.profileDir, { recursive: true });
    const show = !!headed;
    const ctx = await this.launch((extra) => pw.chromium.launchPersistentContext(this.profileDir, { ...this.launchOpts(!show), ...extra }));
    this.profileHeaded = show;
    await this.guard(ctx);
    for (const p of ctx.pages()) this.guardPage(p);
    ctx.on('close', () => {
      if (this.profileCtx === ctx) {
        this.profileCtx = undefined;
        this.profilePage = undefined;
      }
    });
    this.profileCtx = ctx;
    return ctx;
  }

  private async profilePageGet(headed: boolean): Promise<PwPage> {
    const ctx = await this.profileContext(headed);
    if (this.profilePage && !this.profilePage.isClosed()) return this.profilePage;
    const first = ctx.pages().find((p) => !p.isClosed());
    this.profilePage = first ?? (await ctx.newPage());
    if (!first) this.guardPage(this.profilePage);
    return this.profilePage;
  }

  private async publicPageGet(): Promise<PwPage> {
    if (this.publicPage && !this.publicPage.isClosed()) return this.publicPage;
    if (!this.publicCtx) {
      const pw = await this.ensureAvailable();
      const browser = await this.launch((extra) => pw.chromium.launch({ headless: true, ...extra }));
      this.publicBrowser = browser;
      const make = () => {
        const { headless: _h, ...opts } = this.launchOpts(true);
        return browser.newContext(opts);
      };
      const ctx = await make();
      await this.guard(ctx);
      this.publicCtx = ctx;
    }
    this.publicPage = await this.publicCtx.newPage();
    this.guardPage(this.publicPage);
    return this.publicPage;
  }

  /** One browse/import/forget at a time; the browsing context closes after `idleMs` unused. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.inFlight++;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined).finally(() => {
      this.inFlight--;
      if (this.inFlight === 0) this.armIdle();
    });
    return run;
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.profileCtx && !this.publicCtx) return;
    this.idleTimer = setTimeout(() => void this.closeBrowsing(), this.idleMs);
    this.idleTimer.unref?.();
  }

  /** Closes the headless contexts (not the login window). */
  async closeBrowsing(): Promise<void> {
    if (this.inFlight > 0) return;
    const ctx = this.profileCtx;
    const pub = this.publicBrowser;
    this.profileCtx = this.profilePage = undefined;
    this.publicCtx = this.publicPage = this.publicBrowser = undefined;
    await ctx?.close().catch(() => undefined);
    await pub?.close().catch(() => undefined);
  }

  /** Closes everything (server shutdown). Never starts anything: no status refresh, no python check. */
  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await this.closeLoginWindow().catch(() => undefined);
    await this.closeBrowsing();
  }

  // ---- login window (the human signs in; scout never does) ---------------------------------------

  /** Opens a headed window on the research profile at the site's login page. */
  async openLogin(target: { site?: string; url?: string }): Promise<ResearchBrowserStatus> {
    let url: string;
    let site: string | undefined;
    if (target.site) {
      const s = siteByName(target.site);
      if (!s) throw notFound(`No known site "${target.site}"`);
      url = s.loginUrl;
      site = s.site;
    } else if (target.url) {
      url = checkUrl(target.url);
      site = siteForHost(new URL(url).hostname)?.site;
    } else throw badRequest('Give a site or a url to sign in to');
    if (this.inFlight > 0) throw conflict('Scout is browsing right now; try again in a moment.');
    const pw = await this.ensureAvailable();
    if (this.loginCtx) {
      const page = this.loginCtx.pages()[0] ?? (await this.loginCtx.newPage());
      this.loginSite = site;
      void page.goto(url).catch(() => undefined);
      return this.status();
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await this.closeBrowsing();
    mkdirSync(this.profileDir, { recursive: true });
    const ctx = await this.launch((extra) => pw.chromium.launchPersistentContext(this.profileDir, { ...this.launchOpts(false), ...extra }));
    this.loginCtx = ctx;
    this.loginSite = site;
    this.loginCookies = undefined;
    ctx.on('close', () => void this.loginGone(ctx));
    const watchPage = (p: PwPage) => p.on('close', () => {
      if (this.loginCtx === ctx && ctx.pages().every((x) => x.isClosed())) void this.closeLogin();
    });
    ctx.on('page', watchPage);
    for (const p of ctx.pages()) watchPage(p);
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    void page.goto(url).catch(() => undefined);
    // Remember which login cookies exist (names and domains only) in case the window is closed abruptly.
    this.loginPoll = setInterval(() => {
      void ctx.cookies().then((cs) => {
        if (this.loginCtx === ctx) this.loginCookies = cs.map((c) => ({ name: c.name, domain: c.domain }));
      }, () => undefined);
    }, LOGIN_POLL_MS);
    this.loginPoll.unref?.();
    return this.status();
  }

  /** Closes the login window and records which sites are now signed in. */
  async closeLogin(): Promise<ResearchBrowserStatus> {
    await this.closeLoginWindow();
    return this.status();
  }

  private async closeLoginWindow(): Promise<void> {
    const ctx = this.loginCtx;
    if (ctx) {
      if (!this.loginClosing) {
        this.loginClosing = (async () => {
          const cookies = await ctx.cookies().catch(() => undefined);
          if (cookies) this.loginCookies = cookies.map((c) => ({ name: c.name, domain: c.domain }));
          await ctx.close().catch(() => undefined);
          await this.loginGone(ctx);
        })().finally(() => (this.loginClosing = undefined));
      }
      await this.loginClosing;
    }
  }

  private async loginGone(ctx: PwContext): Promise<void> {
    if (this.loginCtx !== ctx) return;
    if (this.loginPoll) clearInterval(this.loginPoll);
    this.loginPoll = undefined;
    this.loginCtx = undefined;
    this.loginSite = undefined;
    if (this.loginCookies) this.applySites(this.loginCookies, 'login');
    this.loginCookies = undefined;
  }

  // ---- cookies: site status, Opera import, forget -------------------------------------------------

  private async refreshSites(ctx: PwContext, via: 'login' | 'opera' = 'login', viaDomains?: string[]): Promise<void> {
    const cookies = await ctx.cookies();
    this.applySites(cookies.map((c) => ({ name: c.name, domain: c.domain })), via, viaDomains);
  }

  /** Marks each known site connected when one of its login cookies is present. */
  private applySites(cookies: { name: string; domain: string }[], via: 'login' | 'opera', viaDomains?: string[]): void {
    const at = today(this.now());
    for (const s of SITES) {
      const domains = siteDomains(s);
      const connected = cookies.some((c) => s.authCookies.includes(c.name) && domains.some((d) => hostMatches(c.domain, d)));
      const prev = this.saved.sites[s.site];
      const newVia = connected ? (viaDomains ? (viaDomains.some((d) => domains.includes(d)) ? via : prev?.via ?? 'login') : prev?.connected ? prev.via ?? via : via) : undefined;
      this.saved.sites[s.site] = { connected, ...(newVia ? { via: newVia } : {}), checkedAt: at };
    }
    this.save();
  }

  /** Imports Opera cookies for allow-listed domains into the research profile (counts only are kept). */
  async operaImport(domains?: string[]): Promise<ResearchBrowserStatus> {
    const allow = this.opts.config().operaAllow.map((d) => cleanDomain(d)).filter((d): d is string => !!d);
    if (!allow.length) throw badRequest('The Opera allowlist is empty: add the sites you allow in Settings → Research browser first.');
    const want = domains?.length ? domains : allow;
    const clean: string[] = [];
    for (const d of want) {
      const c = cleanDomain(String(d));
      if (!c || !allow.includes(c)) throw badRequest(`${d} is not in the Opera allowlist`);
      if (!clean.includes(c)) clean.push(c);
    }
    if (this.loginCtx) throw conflict('The research browser login window is open: close the login window first.');
    await this.exclusive(async () => {
      if (this.loginCtx) throw conflict('The research browser login window is open: close the login window first.');
      const exp = await exportOperaCookies(clean, { ...this.opts.opera, run: this.opts.opera?.run ?? this.run });
      if (exp.errors['*']) throw new HttpError(502, exp.errors['*']);
      const failed = clean.filter((d) => exp.errors[d]);
      if (failed.length === clean.length) throw new HttpError(502, `The Opera cookie export failed for ${failed.join(', ')}: ${exp.errors[failed[0]]}`);
      const ctx = await this.profileContext();
      if (exp.cookies.length) await ctx.addCookies(exp.cookies);
      exp.cookies.length = 0;
      this.saved.opera = { lastImportAt: new Date(this.now()).toISOString(), imported: { ...(this.saved.opera.imported ?? {}), ...exp.counts } };
      await this.refreshSites(ctx, 'opera', clean);
    });
    return this.status();
  }

  /** Clears one site's cookies from the research profile. */
  async forget(siteName: string): Promise<ResearchBrowserStatus> {
    const s = siteByName(siteName);
    if (!s) throw notFound(`No known site "${siteName}"`);
    if (this.loginCtx) throw conflict('The research browser login window is open: close the login window first.');
    const domains = siteDomains(s);
    await this.exclusive(async () => {
      await this.ensureAvailable();
      const ctx = await this.profileContext();
      for (const d of domains) await ctx.clearCookies({ domain: new RegExp(`(^|\\.)${escapeRe(d)}$`) });
      if (this.saved.opera.imported) for (const d of domains) delete this.saved.opera.imported[d];
      await this.refreshSites(ctx);
    });
    return this.status();
  }

  // ---- saved status (no cookie values, ever) ----------------------------------------------------

  private loadSaved(): SavedState {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Partial<SavedState>;
      return {
        sites: raw.sites && typeof raw.sites === 'object' ? raw.sites : {},
        opera: raw.opera && typeof raw.opera === 'object' ? raw.opera : {},
        ...(raw.blocked && typeof raw.blocked === 'object' ? { blocked: raw.blocked } : {}),
      };
    } catch {
      return { sites: {}, opera: {} };
    }
  }

  private save(): void {
    try {
      mkdirSync(this.baseDir, { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify(this.saved, null, 2) + '\n');
    } catch {
      // status is a cache; the next refresh rebuilds it
    }
  }
}
