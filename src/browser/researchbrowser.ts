// The research browser: Muster's own Chrome profile that scout reads pages through, never your
// everyday browser (docs/ARCHITECTURE.md, Competitive intelligence → Research browser).
//
// Read-only by construction: the class exposes read, screenshot and scroll (plus the human's login
// window and cookie housekeeping) and nothing that acts on a page. Navigation is http(s) GET only,
// downloads are refused, permission prompts denied, dialogs dismissed and popups closed.
//
// playwright-core is loaded with a dynamic import, so Muster builds, tests and runs without it; the
// tiny interfaces below are the only parts of its API this module touches (tests inject a fake).
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
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
  /** Test seams for the sign-in window, which is plain Chrome started by Muster with no automation at all. */
  spawn?: (exe: string, args: string[]) => LoginProcess;
  /** True while a browser holds the profile's lock (Windows: `<profile>/lockfile`; elsewhere `SingletonLock`). */
  profileLocked?: (profileDir: string) => boolean;
  /** PID of the browser process (not a child) running on the profile, if any. */
  findBrowserPid?: (profileDir: string) => Promise<number | undefined>;
  /** Asks a browser process to close (force: kill it and its children). */
  stopProcess?: (pid: number, force: boolean) => Promise<void>;
  loginPollMs?: number; // how often the open sign-in window is checked (default 3 s)
  closeWaitMs?: number; // how long "Close login window" waits for a graceful exit before forcing (default 10 s)
}

/** The slice of a child process the sign-in window uses. */
export interface LoginProcess {
  pid?: number;
  on(event: 'exit', fn: (code: number | null) => void): unknown;
  on(event: 'error', fn: (e: Error) => void): unknown;
}

/** Plain Chrome flags for the sign-in window: a separate profile and a page, nothing else (a tab when joining the open window). */
export function loginArgs(profileDir: string, url: string, newWindow = true): string[] {
  return [`--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', ...(newWindow ? ['--new-window'] : []), url];
}

/**
 * Whether a browser holds the profile. Chrome on Windows keeps `<profile>/lockfile` open with
 * delete-on-close, so the file exists exactly while a browser runs on the profile (the OS removes it
 * even when Chrome crashes). On macOS/Linux `SingletonLock` is a symlink to "<host>-<pid>": locked
 * while that pid is alive (a stale link after a crash is ignored).
 */
export function defaultProfileLocked(profileDir: string, platform: NodeJS.Platform, exists: (p: string) => boolean): boolean {
  if (platform === 'win32') return exists(join(profileDir, 'lockfile'));
  const pid = singletonPid(profileDir);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function singletonPid(profileDir: string): number | undefined {
  try {
    const link = join(profileDir, 'SingletonLock');
    if (!lstatSync(link).isSymbolicLink()) return undefined;
    const pid = Number(readlinkSync(link).split('-').pop());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

const execOut = (cmd: string, args: string[], env?: NodeJS.ProcessEnv) =>
  new Promise<string>((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 20_000, ...(env ? { env } : {}) }, (_e, out) => resolve(String(out ?? ''))));

/** The browser process on a profile: Windows asks WMI for the process whose command line has the profile and no --type=. */
async function defaultFindBrowserPid(profileDir: string, platform: NodeJS.Platform): Promise<number | undefined> {
  if (platform !== 'win32') return singletonPid(profileDir);
  const ps =
    "$d=$env:MUSTER_PROFILE_DIR; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($d) -and -not $_.CommandLine.Contains('--type=') } | Select-Object -First 1 -ExpandProperty ProcessId";
  const out = await execOut('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { ...process.env, MUSTER_PROFILE_DIR: profileDir });
  const pid = Number(out.trim().split(/\s+/)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Graceful: Windows `taskkill /PID <pid>` without /F posts WM_CLOSE to the browser's windows, so Chrome
 * shuts down normally and flushes its cookies. (/T is not used for the graceful step: Chrome's sandboxed
 * children refuse it and that leaves the browser half-closed.) Force: `taskkill /PID <pid> /T /F`.
 */
async function defaultStopProcess(pid: number, force: boolean, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') {
    await execOut('taskkill', force ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid)]);
    return;
  }
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // already gone
  }
}

const defaultSpawn = (exe: string, args: string[]): LoginProcess => {
  const child = nodeSpawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
};

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
const LOGIN_GRACE_MS = 10_000; // Chrome may relaunch itself at start: the window counts as open this long after a spawn

/** The human's sign-in window: plain Chrome on the research profile, started without any automation. */
interface LoginWindow {
  exe: string;
  pid?: number; // the process Muster spawned (Chrome may hand off or relaunch, so it can exit while the window stays)
  exited: boolean;
  startedAt: number;
  goneOnce: boolean; // the last check saw it gone (two checks in a row end the login)
  stopping?: Promise<void>;
}

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
  private login?: LoginWindow;
  private loginSite?: string;
  private loginPoll?: NodeJS.Timeout;
  private loginCookies?: { name: string; domain: string }[]; // names/domains only, never values
  private loginClosing?: Promise<void>;
  private profileClosedAt = -Infinity; // when Muster last closed its own Playwright context on the profile
  private readonly spawnFn: (exe: string, args: string[]) => LoginProcess;
  private readonly profileLocked: (profileDir: string) => boolean;
  private readonly findBrowserPid: (profileDir: string) => Promise<number | undefined>;
  private readonly stopProcess: (pid: number, force: boolean) => Promise<void>;
  private readonly loginPollMs: number;
  private readonly closeWaitMs: number;
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
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.profileLocked = opts.profileLocked ?? ((d) => defaultProfileLocked(d, this.platform, this.exists));
    this.findBrowserPid = opts.findBrowserPid ?? ((d) => defaultFindBrowserPid(d, this.platform));
    this.stopProcess = opts.stopProcess ?? ((pid, force) => defaultStopProcess(pid, force, this.platform));
    this.loginPollMs = opts.loginPollMs ?? LOGIN_POLL_MS;
    this.closeWaitMs = opts.closeWaitMs ?? 10_000;
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
    this.adoptLogin();
    if (!problem && !this.login && this.inFlight === 0 && (this.profileCtx || firstLook)) {
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
      state: this.login ? 'login_open' : this.inFlight > 0 ? 'browsing' : 'idle',
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
    if (mode !== 'public' && this.login) return Promise.reject(conflict('The research browser login window is open: close the login window first.'));
    return this.exclusive(async () => {
      if (mode !== 'public' && this.login) throw conflict('The research browser login window is open: close the login window first.');
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
      this.profileClosedAt = this.now();
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
    if (ctx) this.profileClosedAt = this.now();
    await pub?.close().catch(() => undefined);
  }

  /**
   * Closes Muster's own contexts (server shutdown). Never starts anything: no status refresh, no python check.
   * A sign-in window is plain Chrome, not Muster's: it stays open, and the next status() notices the profile
   * lock and treats it as the login window again.
   */
  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.stopLoginPoll();
    this.login = undefined;
    this.loginSite = undefined;
    await this.closeBrowsing();
  }

  // ---- login window (the human signs in; scout never does) ---------------------------------------
  //
  // The sign-in window is a normal Chrome window on the research profile: Muster starts the browser's own
  // executable with a separate --user-data-dir and the login page, and nothing else. No Playwright, no
  // remote debugging, no automation flags, so sites (Google included) see an ordinary browser. Chrome
  // locks a profile to one process, so Muster's headless context is closed first and the profile is read
  // again (headless, cookie names and domains only) after the window has closed.

  /** Opens a normal Chrome window on the research profile at the site's login page. */
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
    if (this.loginClosing || this.login?.stopping) throw conflict('The login window is closing; try again in a moment.');
    const pw = await this.ensureAvailable();
    const exe = channelExecutable(this.opts.config().channel, this.env, this.platform, this.exists) ?? this.bundledExecutable(pw);
    if (!exe) throw new HttpError(503, "The research browser isn't available: no browser executable found");
    this.adoptLogin();
    if (this.login) {
      // Chrome hands a second start on the same profile to the running window, which opens a tab.
      this.spawnLogin(exe, url, false);
      this.loginSite = site;
      return this.status();
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await this.closeBrowsing();
    mkdirSync(this.profileDir, { recursive: true });
    this.login = this.spawnLogin(exe, url);
    this.loginSite = site;
    this.loginCookies = undefined;
    this.watchLogin();
    return this.status();
  }

  /** Starts the browser executable on the profile; a second start while the window is open joins it. */
  private spawnLogin(exe: string, url: string, newWindow = true): LoginWindow {
    const login: LoginWindow = { exe, exited: false, startedAt: this.now(), goneOnce: false };
    let child: LoginProcess;
    try {
      child = this.spawnFn(exe, loginArgs(this.profileDir, url, newWindow));
    } catch (e) {
      throw new HttpError(503, `Couldn't start ${exe}: ${(e as Error).message.split('\n')[0]}`);
    }
    login.pid = child.pid;
    child.on('exit', () => {
      login.exited = true;
      if (this.login === login) void this.pollLogin();
    });
    child.on('error', () => {
      login.exited = true;
    });
    if (this.login) {
      // The open window gets the new tab; give the handoff the same start-up grace.
      this.login.startedAt = login.startedAt;
      this.login.goneOnce = false;
    }
    return login;
  }

  /** Muster restarted (or lost track) while a browser holds the profile: that is the login window. */
  private adoptLogin(): void {
    if (this.login || this.loginClosing || this.profileCtx || this.inFlight > 0) return;
    if (this.now() - this.profileClosedAt < LOGIN_GRACE_MS) return; // our own headless Chrome may still be exiting
    if (!this.profileLocked(this.profileDir)) return;
    this.login = { exe: '', exited: true, startedAt: -Infinity, goneOnce: false };
    this.watchLogin();
  }

  private watchLogin(): void {
    this.stopLoginPoll();
    this.loginPoll = setInterval(() => void this.pollLogin(), this.loginPollMs);
    this.loginPoll.unref?.();
  }

  private stopLoginPoll(): void {
    if (this.loginPoll) clearInterval(this.loginPoll);
    this.loginPoll = undefined;
  }

  /** Open while the spawned process runs, the profile lock is held, or Chrome is still starting. */
  private loginStillOpen(login: LoginWindow): boolean {
    return !login.exited || this.profileLocked(this.profileDir) || this.now() - login.startedAt < LOGIN_GRACE_MS;
  }

  /** The window counts as closed after two looks in a row find no process and no lock. */
  private async pollLogin(): Promise<void> {
    const login = this.login;
    if (!login || login.stopping || this.loginClosing) return;
    if (this.loginStillOpen(login)) {
      login.goneOnce = false;
      return;
    }
    if (!login.goneOnce) {
      login.goneOnce = true;
      return;
    }
    await this.finishLogin();
  }

  /** Closes the login window ("Close login window") and records which sites are now signed in. */
  async closeLogin(): Promise<ResearchBrowserStatus> {
    await this.closeLoginWindow();
    return this.status();
  }

  /** Asks Chrome to close normally (so it saves its cookies), forcing it only after closeWaitMs. */
  private async closeLoginWindow(): Promise<void> {
    this.adoptLogin();
    const login = this.login;
    if (!login) return this.loginClosing;
    login.stopping ??= (async () => {
      const open = () => !login.exited || this.profileLocked(this.profileDir);
      if (open()) {
        const pid = (await this.findBrowserPid(this.profileDir).catch(() => undefined)) ?? (login.exited ? undefined : login.pid);
        if (pid) {
          // Each graceful request closes one Chrome window, so it is repeated about once a second.
          let closed = false;
          for (let waited = 0; !closed && waited < this.closeWaitMs; waited += 1000) {
            await this.stopProcess(pid, false).catch(() => undefined);
            closed = await this.waitFor(() => !open(), Math.min(1000, this.closeWaitMs - waited));
          }
          if (!closed) {
            await this.stopProcess(pid, true).catch(() => undefined);
            await this.waitFor(() => !open(), 5000);
          }
        }
      }
      await this.finishLogin();
    })();
    await login.stopping;
  }

  private async waitFor(done: () => boolean, ms: number): Promise<boolean> {
    for (let waited = 0; waited < ms; waited += 250) {
      if (done()) return true;
      await this.sleep(250);
    }
    return done();
  }

  /** The window has closed: read which sites are signed in (headless, names and domains only), then unlock. */
  private finishLogin(): Promise<void> {
    if (this.loginClosing) return this.loginClosing;
    const login = this.login;
    if (!login) return Promise.resolve();
    this.stopLoginPoll();
    this.loginClosing = (async () => {
      this.loginCookies = await this.readProfileCookies().catch(() => undefined);
      if (this.login === login) {
        this.login = undefined;
        this.loginSite = undefined;
      }
      if (this.loginCookies) this.applySites(this.loginCookies, 'login');
      this.loginCookies = undefined;
    })().finally(() => (this.loginClosing = undefined));
    return this.loginClosing;
  }

  /** Opens the profile headless just long enough to list its cookies (names and domains, never values). */
  private async readProfileCookies(): Promise<{ name: string; domain: string }[]> {
    const pw = await this.ensureAvailable();
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await this.sleep(1500); // Chrome may still be letting go of the profile
      try {
        return await this.exclusive(async () => {
          const ctx = await this.launch((extra) => pw.chromium.launchPersistentContext(this.profileDir, { ...this.launchOpts(true), ...extra }));
          try {
            return (await ctx.cookies()).map((c) => ({ name: c.name, domain: c.domain }));
          } finally {
            await ctx.close().catch(() => undefined);
            this.profileClosedAt = this.now();
          }
        });
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError;
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
    if (this.login) throw conflict('The research browser login window is open: close the login window first.');
    await this.exclusive(async () => {
      if (this.login) throw conflict('The research browser login window is open: close the login window first.');
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
    if (this.login) throw conflict('The research browser login window is open: close the login window first.');
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
