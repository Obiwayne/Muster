import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type ResearchBrowserConfig } from '../types.js';
import type { PwCookie, RunResult } from './opera.js';
import { channelExecutable, checkUrl, ResearchBrowser, type PwModule } from './researchbrowser.js';

// ---- a fake playwright-core: no real browser is ever started in tests ----------------------------

interface FakeSite {
  status?: number;
  title?: string;
  text?: string;
  links?: { href: string; text: string }[];
  redirect?: string;
  height?: number;
}

class FakePage {
  urlNow = 'about:blank';
  closed = false;
  scrollY = 0;
  gotos: string[] = [];
  shots: { path: string; fullPage?: boolean }[] = [];
  wheels: number[] = [];
  handlers: Record<string, ((...a: any[]) => void)[]> = {};
  constructor(private ctx: FakeContext) {}
  mouse = { wheel: async (_x: number, y: number) => void (this.wheels.push(y), (this.scrollY += y)) };
  on(ev: string, fn: (...a: any[]) => void) {
    (this.handlers[ev] ??= []).push(fn);
    return this;
  }
  emit(ev: string, ...a: any[]) {
    for (const f of this.handlers[ev] ?? []) f(...a);
  }
  async goto(url: string) {
    const w = this.ctx.world;
    w.active++;
    w.maxActive = Math.max(w.maxActive, w.active);
    try {
      await new Promise((r) => setTimeout(r, 5));
      let aborted = false;
      const req = { method: () => 'GET', url: () => url, isNavigationRequest: () => true };
      await this.ctx.routeHandler?.({ request: () => req, abort: async () => void (aborted = true), continue: async () => undefined });
      if (aborted) throw new Error('net::ERR_BLOCKED_BY_CLIENT');
      this.gotos.push(url);
      const site = w.sites[url] ?? {};
      this.urlNow = site.redirect ?? url;
      this.scrollY = 0;
      return { status: () => site.status ?? 200 };
    } finally {
      w.active--;
    }
  }
  url() {
    return this.urlNow;
  }
  async title() {
    return this.ctx.world.sites[this.urlNow]?.title ?? this.ctx.world.sites[this.gotos.at(-1) ?? '']?.title ?? '';
  }
  async evaluate(fn: (arg: any) => any, arg: any) {
    if (fn.toString().includes('navigator')) return this.ctx.world.userAgent;
    const site = this.ctx.world.sites[this.urlNow] ?? this.ctx.world.sites[this.gotos.at(-1) ?? ''] ?? {};
    const g = globalThis as any;
    const page = this;
    g.document = {
      body: { innerText: site.text ?? '' },
      documentElement: { scrollHeight: site.height ?? 900 },
      querySelectorAll: () => (site.links ?? []).map((l) => ({ href: l.href, innerText: l.text, getAttribute: () => null })),
    };
    Object.defineProperty(g, 'scrollY', { configurable: true, get: () => page.scrollY });
    g.scrollBy = (_x: number, y: number) => void (page.scrollY += y);
    try {
      return fn(arg);
    } finally {
      delete g.document;
      delete g.scrollY;
      delete g.scrollBy;
    }
  }
  async screenshot(o: { path: string; fullPage?: boolean }) {
    this.shots.push(o);
  }
  async waitForTimeout() {}
  async close() {
    this.closed = true;
    this.emit('close');
  }
  isClosed() {
    return this.closed;
  }
}

class FakeContext {
  pagesList: FakePage[] = [];
  cookieJar: PwCookie[] = [];
  routeHandler?: (r: any) => unknown;
  handlers: Record<string, ((...a: any[]) => void)[]> = {};
  closed = false;
  added: PwCookie[] = [];
  cleared: (string | RegExp | undefined)[] = [];
  constructor(public world: World, public opts: Record<string, any>, public dir?: string) {
    this.pagesList.push(new FakePage(this));
  }
  pages() {
    return this.pagesList.filter((p) => !p.closed) as any[];
  }
  async newPage() {
    const p = new FakePage(this);
    this.pagesList.push(p);
    for (const f of this.handlers.page ?? []) f(p);
    return p as any;
  }
  async cookies() {
    return this.world.persisted.map((c) => ({ ...c }));
  }
  async addCookies(cs: PwCookie[]) {
    this.added.push(...cs);
    this.world.persisted.push(...cs);
  }
  async clearCookies(o?: { domain?: string | RegExp }) {
    this.cleared.push(o?.domain);
    const d = o?.domain;
    this.world.persisted = this.world.persisted.filter((c) => !(d instanceof RegExp ? d.test(c.domain) : c.domain === d));
  }
  async route(_u: string, h: (r: any) => unknown) {
    this.routeHandler = h;
  }
  on(ev: string, fn: (...a: any[]) => void) {
    (this.handlers[ev] ??= []).push(fn);
    return this;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const f of this.handlers.close ?? []) f();
  }
}

interface World {
  sites: Record<string, FakeSite>;
  persisted: PwCookie[]; // the profile's cookie store
  launches: { dir?: string; opts: Record<string, any> }[];
  contexts: FakeContext[];
  userAgent: string;
  active: number;
  maxActive: number;
  failChannel?: boolean;
}

function fakePw(world: World): PwModule {
  return {
    chromium: {
      async launchPersistentContext(dir: string, opts: Record<string, any>) {
        world.launches.push({ dir, opts });
        if (world.failChannel && opts.channel) throw new Error('Chromium distribution chrome is not found');
        const ctx = new FakeContext(world, opts, dir);
        world.contexts.push(ctx);
        return ctx as any;
      },
      async launch(opts: Record<string, any>) {
        world.launches.push({ opts });
        return {
          newContext: async (o: Record<string, any>) => {
            const ctx = new FakeContext({ ...world, persisted: [] } as World, o);
            ctx.world = Object.assign(Object.create(world), { persisted: [] });
            world.contexts.push(ctx);
            return ctx as any;
          },
          close: async () => undefined,
        } as any;
      },
      executablePath: () => 'Z:/no-bundled/chrome.exe',
    },
  };
}

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sessionCookie = (name: string, domain: string, value = 'SECRET-VALUE-123'): PwCookie => ({ name, value, domain, path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' });

let dir: string;
let world: World;
let cfg: ResearchBrowserConfig;
let sleeps: number[];
let clock: number;
let made: ResearchBrowser[];

function make(over: Partial<ConstructorParameters<typeof ResearchBrowser>[0]> = {}) {
  const b = new ResearchBrowser({
    config: () => cfg,
    baseDir: join(dir, 'research-browser'),
    loadPlaywright: async () => fakePw(world),
    env: { PROGRAMFILES: 'C:\\Program Files', PATH: 'C:\\bin', USERPROFILE: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
    platform: 'win32',
    exists: (p) => p === CHROME,
    run: async (): Promise<RunResult> => ({ code: 1, stdout: '', stderr: '' }),
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    ...over,
  });
  made.push(b);
  return b;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muster-rb-test-'));
  world = { sites: {}, persisted: [], launches: [], contexts: [], userAgent: 'Mozilla/5.0 Chrome/141.0 Safari/537.36', active: 0, maxActive: 0 };
  cfg = { ...DEFAULT_CONFIG.researchBrowser, operaAllow: [] };
  sleeps = [];
  clock = 1_000_000;
  made = [];
});
afterEach(async () => {
  for (const b of made) await b.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('availability', () => {
  it('reports playwright-core missing honestly and refuses to browse', async () => {
    const b = make({
      loadPlaywright: async () => {
        throw Object.assign(new Error("Cannot find package 'playwright-core'"), { code: 'ERR_MODULE_NOT_FOUND' });
      },
    });
    const st = await b.status();
    expect(st.available).toBe(false);
    expect(st.problem).toBe('playwright-core is not installed');
    expect(st.sites.map((s) => s.site)).toContain('reddit');
    await expect(b.read('https://example.com/', { mode: 'profile' })).rejects.toMatchObject({ status: 503 });
  });

  it('says Chrome is missing when the channel browser is not installed', async () => {
    const b = make({ exists: () => false });
    const st = await b.status();
    expect(st.available).toBe(false);
    expect(st.problem).toMatch(/Chrome not found/);
  });

  it('finds the channel executable per platform', () => {
    expect(channelExecutable('chrome', { PROGRAMFILES: 'C:\\Program Files' }, 'win32', (p) => p === CHROME)).toBe(CHROME);
    expect(channelExecutable('msedge', { PROGRAMFILES: 'C:\\Program Files' }, 'win32', () => false)).toBeUndefined();
  });

  it('lists tools with their limits (yt-dlp off PATH, browser_cookie3 check)', async () => {
    const b = make({
      exists: (p) => p === CHROME || p.endsWith('python.exe'),
      run: async (_py, args) => ({ code: args.join(' ').includes('browser_cookie3') ? 0 : 1, stdout: '', stderr: '' }),
    });
    const st = await b.status();
    expect(st.available).toBe(true);
    expect(st.tools.find((t) => t.name === 'yt-dlp')).toMatchObject({ ok: false, note: expect.stringMatching(/not on PATH/) });
    expect(st.tools.find((t) => t.name === 'browser_cookie3')?.ok).toBe(true);
    expect(st.opera.found).toBe(false);
    expect(st.profileDir).toBe(join(dir, 'research-browser', 'profile'));
    expect(st.sites.find((s) => s.site === 'linkedin')?.warning).toMatch(/separate account/);
  });

  it('only browses http and https', () => {
    expect(() => checkUrl('file:///C:/secret.txt')).toThrow(/http/);
    expect(() => checkUrl('javascript:alert(1)')).toThrow();
    expect(checkUrl('https://padlet.com/premium')).toBe('https://padlet.com/premium');
  });
});

describe('read-only browsing', () => {
  it('reads a page through the research profile with chrome, no downloads, no permissions', async () => {
    world.sites['https://padlet.com/premium'] = { redirect: 'https://padlet.com/site/subscriptions' };
    world.sites['https://padlet.com/site/subscriptions'] = { title: 'Pricing - Padlet', text: 'Free £0', links: [{ href: 'https://padlet.com/a', text: 'A' }, { href: 'mailto:x@y.z', text: 'mail' }] };
    const b = make();
    const r = await b.read('https://padlet.com/premium', { mode: 'profile', links: true });
    expect(r).toMatchObject({ url: 'https://padlet.com/site/subscriptions', title: 'Pricing - Padlet', status: 200, text: 'Free £0', via: 'profile' });
    expect(r.links).toEqual([{ text: 'A', url: 'https://padlet.com/a' }]);
    const launch = world.launches[0];
    expect(launch.dir).toBe(join(dir, 'research-browser', 'profile'));
    expect(launch.opts).toMatchObject({ channel: 'chrome', headless: true, acceptDownloads: false, permissions: [] });
  });

  it('truncates long text at 40,000 characters', async () => {
    world.sites['https://a.com/'] = { text: 'x'.repeat(50_000) };
    const r = await make().read('https://a.com/', { mode: 'profile' });
    expect(r.text!.length).toBeLessThan(40_100);
    expect(r.text!.endsWith('[… truncated]')).toBe(true);
  });

  it('aborts non-GET and non-http navigations, lets other requests through', async () => {
    const b = make();
    await b.read('https://a.com/', { mode: 'profile' });
    const ctx = world.contexts[0];
    const call = async (method: string, url: string, nav: boolean) => {
      let result = '';
      await ctx.routeHandler!({ request: () => ({ method: () => method, url: () => url, isNavigationRequest: () => nav }), abort: async () => void (result = 'abort'), continue: async () => void (result = 'continue') });
      return result;
    };
    expect(await call('POST', 'https://a.com/login', true)).toBe('abort');
    expect(await call('GET', 'file:///etc/passwd', true)).toBe('abort');
    expect(await call('GET', 'https://a.com/next', true)).toBe('continue');
    expect(await call('POST', 'https://a.com/analytics', false)).toBe('continue');
  });

  it('closes popups and dismisses dialogs', async () => {
    const b = make();
    await b.read('https://a.com/', { mode: 'profile' });
    const page = world.contexts[0].pagesList[0];
    let popupClosed = false;
    let dismissed = false;
    page.emit('popup', { close: async () => void (popupClosed = true) });
    page.emit('dialog', { dismiss: async () => void (dismissed = true) });
    await new Promise((r) => setTimeout(r, 0));
    expect(popupClosed).toBe(true);
    expect(dismissed).toBe(true);
  });

  it('waits minDelayMs between loads on one domain, not across domains', async () => {
    cfg.minDelayMs = 3000;
    const b = make();
    await b.read('https://a.com/1', { mode: 'profile' });
    await b.read('https://b.com/1', { mode: 'profile' });
    expect(sleeps).toEqual([]);
    clock += 1000;
    await b.read('https://www.a.com/2', { mode: 'profile' });
    expect(sleeps).toEqual([2000]);
  });

  it('runs one call at a time', async () => {
    const b = make();
    await Promise.all([b.read('https://a.com/1', { mode: 'profile' }), b.read('https://b.com/2', { mode: 'profile' }), b.read('https://c.com/3', { mode: 'profile' })]);
    expect(world.maxActive).toBe(1);
  });

  it('scrolls the open page without reloading it, then a read sees the same page', async () => {
    world.sites['https://a.com/'] = { text: 'feed', height: 5000 };
    const b = make();
    await b.read('https://a.com/', { mode: 'profile' });
    const s = await b.scroll('https://a.com/', { mode: 'profile', by: 1500 });
    expect(s.scrolled).toEqual({ y: 1500, height: 5000 });
    await b.read('https://a.com/', { mode: 'profile' });
    const page = world.contexts[0].pagesList[0];
    expect(page.gotos).toEqual(['https://a.com/']);
    await b.read('https://a.com/', { mode: 'profile' });
    expect(page.gotos).toEqual(['https://a.com/', 'https://a.com/']); // a plain re-read loads fresh
  });

  it('takes a screenshot at the path the API chose', async () => {
    const b = make();
    const path = join(dir, 'shots', 'IJ1', '1.png');
    const r = await b.screenshot('https://a.com/', { mode: 'profile', path, fullPage: true });
    expect(r.screenshot).toBe(path);
    expect(world.contexts[0].pagesList[0].shots).toEqual([{ path, fullPage: true }]);
  });

  it('public mode uses a fresh context without the profile', async () => {
    world.persisted.push(sessionCookie('reddit_session', '.reddit.com'));
    const b = make();
    const r = await b.read('https://www.reddit.com/r/Teachers/', { mode: 'public' });
    expect(r).toMatchObject({ via: 'public', loggedIn: false });
    expect(world.launches[0].dir).toBeUndefined();
    expect(world.launches[0].opts).toMatchObject({ channel: 'chrome', headless: true });
  });

  it('reports loggedIn from the site login cookie in the profile', async () => {
    world.persisted.push(sessionCookie('reddit_session', '.reddit.com'));
    const r = await make().read('https://www.reddit.com/r/Teachers/', { mode: 'profile' });
    expect(r.loggedIn).toBe(true);
    const other = await made[0].read('https://padlet.com/', { mode: 'profile' });
    expect(other.loggedIn).toBeUndefined();
  });

  it('reports loggedIn false on a blocked page even with a login cookie', async () => {
    world.persisted.push(sessionCookie('reddit_session', '.reddit.com'));
    world.sites['https://www.reddit.com/r/Teachers/'] = { status: 403, title: 'Just a moment...', text: 'reddit.com\nChecking if the site connection is secure' };
    const r = await make().read('https://www.reddit.com/r/Teachers/', { mode: 'profile' });
    expect(r).toMatchObject({ blocked: 'bot check (Cloudflare)', loggedIn: false });
    const shot = await made[0].screenshot('https://www.reddit.com/r/Teachers/', { mode: 'profile', path: join(dir, 'shots', 'b.png') });
    expect(shot).toMatchObject({ loggedIn: false });
    expect(shot.blocked).toBeTruthy();
  });

  it('marks a bot check as blocked (never solving it), lists the site in the status until a good load', async () => {
    world.sites['https://padlet.com/'] = { status: 403, title: 'Just a moment...', text: 'padlet.com\nChecking if the site connection is secure' };
    world.sites['https://www.reddit.com/r/x/'] = { status: 429, title: 'Too Many Requests', text: 'whoa there, pardner!' };
    const b = make();
    const r = await b.read('https://padlet.com/', { mode: 'profile' });
    expect(r).toMatchObject({ status: 403, blocked: 'bot check (Cloudflare)' });
    expect((await b.read('https://www.reddit.com/r/x/', { mode: 'profile' })).blocked).toBe('rate limited (429)');
    let st = await b.status();
    expect(st.blocked?.map((x) => [x.domain, x.reason])).toEqual([['padlet.com', 'bot check (Cloudflare)'], ['reddit.com', 'rate limited (429)']]);
    expect(st.sites.find((s) => s.site === 'reddit')?.blocked?.reason).toBe('rate limited (429)');
    // Saved with the rest of the status (no cookie values): a new instance still knows
    expect(JSON.parse(readFileSync(join(dir, 'research-browser', 'status.json'), 'utf8')).blocked['padlet.com'].reason).toBe('bot check (Cloudflare)');
    world.sites['https://padlet.com/'] = { title: 'Padlet', text: 'Make beautiful boards' };
    expect((await b.read('https://padlet.com/', { mode: 'profile' })).blocked).toBeUndefined();
    st = await b.status();
    expect(st.blocked?.map((x) => x.domain)).toEqual(['reddit.com']);
  });

  it("keeps the browser's own user agent (no disguise)", async () => {
    world.userAgent = 'Mozilla/5.0 (Windows NT 10.0) HeadlessChrome/141.0.0.0 Safari/537.36';
    await make().read('https://a.com/', { mode: 'profile' });
    await make().read('https://b.com/', { mode: 'public' });
    expect(world.launches).toHaveLength(2);
    for (const l of world.launches) expect(l.opts.userAgent).toBeUndefined();
    for (const c of world.contexts) expect(c.opts.userAgent).toBeUndefined();
    const src = readFileSync(new URL('./researchbrowser.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/userAgent\s*:/);
  });

  it('reads visible-window sites in a headed profile window, others headless', async () => {
    const b = make();
    b.setVisibleSite('reddit.com', true); // the shared list, not this project's config
    expect(cfg.visibleSites).toEqual([]);
    expect((await b.status()).sites.find((x) => x.site === 'reddit')?.visible).toBe(true);
    expect((await b.status()).sites.find((x) => x.site === 'linkedin')?.visible).toBeUndefined();
    const before = world.launches.length;
    await b.read('https://www.reddit.com/r/Teachers/', { mode: 'profile' });
    expect(world.launches[before]).toMatchObject({ dir: join(dir, 'research-browser', 'profile'), opts: { headless: false } });
    await b.read('https://www.reddit.com/r/Teachers/top/', { mode: 'profile' });
    expect(world.launches).toHaveLength(before + 1); // the window is reused
    await b.read('https://padlet.com/', { mode: 'profile' });
    expect(world.launches).toHaveLength(before + 2);
    expect(world.launches.at(-1)!.opts.headless).toBe(true);
    expect(world.contexts[world.contexts.length - 2].closed).toBe(true); // the window closed before the headless relaunch
    await b.read('https://www.reddit.com/', { mode: 'public' });
    expect(world.launches.at(-1)!.opts.headless).toBe(true); // public reading never uses the profile window
  });

  it('visibleFor follows the shared list as it changes (another project turning a site on counts at once)', async () => {
    const a = make();
    const other = make(); // another project's server on the same PC
    other.setVisibleSite('padlet.com', true);
    await a.read('https://padlet.com/', { mode: 'profile' });
    expect(world.launches.at(-1)!.opts.headless).toBe(false);
    other.setVisibleSite('padlet.com', false);
    await a.read('https://padlet.com/2', { mode: 'profile' });
    expect(world.launches.at(-1)!.opts.headless).toBe(true);
    // a project's config list is not read for browsing any more (only migrated at start)
    cfg = { ...cfg, visibleSites: ['padlet.com'] };
    await a.read('https://padlet.com/3', { mode: 'profile' });
    expect(world.launches.at(-1)!.opts.headless).toBe(true);
  });

  it('block records say whether the read was in the visible window (old records count as hidden)', async () => {
    world.sites['https://padlet.com/'] = { status: 403, title: 'Just a moment...', text: 'Checking if the site connection is secure' };
    world.sites['https://www.reddit.com/r/x/'] = { status: 429, title: 'Too Many Requests', text: 'whoa there, pardner!' };
    const b = make();
    b.setVisibleSite('reddit.com', true);
    await b.read('https://padlet.com/', { mode: 'profile' }); // hidden
    await b.read('https://www.reddit.com/r/x/', { mode: 'profile' }); // visible window
    await b.read('https://padlet.com/', { mode: 'public' }); // public reading is never the window
    const saved = JSON.parse(readFileSync(join(dir, 'research-browser', 'status.json'), 'utf8'));
    expect(saved.blocked['padlet.com'].visible).toBe(false);
    expect(saved.blocked['reddit.com'].visible).toBe(true);
    const st = await b.status();
    expect(st.sites.find((s) => s.site === 'reddit')?.blocked).toMatchObject({ reason: 'rate limited (429)', visible: true });
    expect(st.blocked?.find((x) => x.domain === 'padlet.com')?.visible).toBe(false);
    // a record saved before the field existed
    writeFileSync(join(dir, 'research-browser', 'status.json'), JSON.stringify({ sites: {}, opera: {}, blocked: { 'linkedin.com': { reason: 'blocked (403)', at: '2026-10-01T00:00:00.000Z' } } }));
    const old = await make().status();
    expect(old.sites.find((s) => s.site === 'linkedin')?.blocked).toEqual({ reason: 'blocked (403)', at: '2026-10-01T00:00:00.000Z', visible: false });
    expect(old.blocked).toEqual([{ domain: 'linkedin.com', reason: 'blocked (403)', at: '2026-10-01T00:00:00.000Z', visible: false }]);
  });

  it('closes the browsing context after the idle time', async () => {
    const b = make({ idleMs: 20 });
    await b.read('https://a.com/', { mode: 'profile' });
    expect(world.contexts[0].closed).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(world.contexts[0].closed).toBe(true);
    await b.read('https://a.com/2', { mode: 'profile' });
    expect(world.contexts).toHaveLength(2);
  });

  it("exposes no way to act on a page", () => {
    const names = Object.getOwnPropertyNames(ResearchBrowser.prototype);
    for (const banned of ['click', 'fill', 'type', 'press', 'check', 'selectOption', 'setInputFiles', 'submit', 'post'])
      expect(names.filter((n) => n.toLowerCase() === banned.toLowerCase())).toEqual([]);
    const src = readFileSync(new URL('./researchbrowser.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/click|fill|type\(|press|check\(|selectOption|setInputFiles/);
  });
});

describe('visible-window sites (shared by every project on this PC)', () => {
  const file = () => join(dir, 'research-browser', 'visible.json');

  it('sets and unsets one domain at a time, kept in visible.json and seen by a new instance', async () => {
    const b = make();
    expect(b.visibleSites()).toEqual([]);
    expect(b.setVisibleSite('https://www.Reddit.com/r/x', true)).toEqual(['reddit.com']);
    expect(b.setVisibleSite('reddit.com', true)).toEqual(['reddit.com']); // no duplicates
    expect(b.setVisibleSite('padlet.com', true)).toEqual(['reddit.com', 'padlet.com']);
    expect(JSON.parse(readFileSync(file(), 'utf8')).sites).toEqual(['reddit.com', 'padlet.com']);
    const again = make();
    expect(again.visibleSites()).toEqual(['reddit.com', 'padlet.com']);
    expect(again.setVisibleSite('reddit.com', false)).toEqual(['padlet.com']);
    expect(b.visibleSites()).toEqual(['padlet.com']); // read fresh: the first instance sees the change
    const st = await b.status();
    expect(st.visibleSites).toEqual(['padlet.com']);
    expect(st.sites.find((s) => s.site === 'reddit')?.visible).toBeUndefined();
    expect(() => b.setVisibleSite('not a domain', true)).toThrow(/Not a domain/);
    // status.json (written whole by each server) never carries the list
    expect(existsSync(join(dir, 'research-browser', 'status.json')) ? JSON.parse(readFileSync(join(dir, 'research-browser', 'status.json'), 'utf8')).visibleSites : undefined).toBeUndefined();
  });

  it("migrates a project's config.visibleSites once: a union, never removing shared ones, config left alone", () => {
    make().setVisibleSite('padlet.com', true); // already shared
    cfg = { ...cfg, visibleSites: ['reddit.com'] }; // e.g. StarCut's .muster/config.json
    const before = structuredClone(cfg);
    const b = make();
    expect(b.visibleSites()).toEqual(['padlet.com', 'reddit.com']);
    expect(cfg).toEqual(before); // the project's config is untouched
    // another project with no list (or a different one) never removes shared ones
    cfg = { ...cfg, visibleSites: [] };
    expect(make().visibleSites()).toEqual(['padlet.com', 'reddit.com']);
    cfg = { ...cfg, visibleSites: ['x.com'] };
    expect(make().visibleSites()).toEqual(['padlet.com', 'reddit.com', 'x.com']);
    // turned off on this PC: a project whose config still lists it doesn't bring it back
    b.setVisibleSite('reddit.com', false);
    cfg = { ...cfg, visibleSites: ['reddit.com'] };
    expect(make().visibleSites()).toEqual(['padlet.com', 'x.com']);
    expect(JSON.parse(readFileSync(file(), 'utf8')).migrated).toEqual(['padlet.com', 'reddit.com', 'x.com']);
  });

  it('a bad visible.json reads as empty and a migration rewrites it', () => {
    mkdirSync(join(dir, 'research-browser'), { recursive: true });
    writeFileSync(file(), '{ not json');
    expect(make().visibleSites()).toEqual([]);
    cfg = { ...cfg, visibleSites: ['reddit.com'] };
    expect(make().visibleSites()).toEqual(['reddit.com']);
  });
});

describe('login window (plain Chrome, no automation)', () => {
  // A fake Chrome: the first start takes the profile lock and (like real Chrome) the spawned process
  // exits at once after relaunching itself; later starts on the locked profile hand off and exit.
  interface FakeChrome {
    locked: boolean;
    spawns: { exe: string; args: string[]; pid: number }[];
    stops: { pid: number; force: boolean }[];
    ignoreGraceful: boolean;
    lockedAtSpawn: boolean[];
    contextsClosedAtSpawn: boolean[];
  }
  let chrome: FakeChrome;
  const BROWSER_PID = 4242;
  const PROFILE = () => join(dir, 'research-browser', 'profile');
  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

  function makeLogin(over: Partial<ConstructorParameters<typeof ResearchBrowser>[0]> = {}) {
    return make({
      loginPollMs: 5,
      closeWaitMs: 1000,
      spawn: (exe, args) => {
        const pid = 100 + chrome.spawns.length;
        chrome.spawns.push({ exe, args, pid });
        chrome.lockedAtSpawn.push(chrome.locked);
        chrome.contextsClosedAtSpawn.push(world.contexts.every((c) => c.closed));
        const handlers: Record<string, ((...a: any[]) => void)[]> = {};
        chrome.locked = true;
        setTimeout(() => (handlers.exit ?? []).forEach((f) => f(0)), 1);
        return { pid, on: (ev: string, fn: (...a: any[]) => void) => void (handlers[ev] ??= []).push(fn) } as any;
      },
      profileLocked: (d) => d === PROFILE() && chrome.locked,
      findBrowserPid: async () => (chrome.locked ? BROWSER_PID : undefined),
      stopProcess: async (pid, force) => {
        chrome.stops.push({ pid, force });
        if (force || !chrome.ignoreGraceful) chrome.locked = false;
      },
      ...over,
    });
  }

  beforeEach(() => {
    chrome = { locked: false, spawns: [], stops: [], ignoreGraceful: false, lockedAtSpawn: [], contextsClosedAtSpawn: [] };
  });

  it('opens a normal Chrome window on the profile with no automation and locks browsing until it closes', async () => {
    const b = makeLogin();
    const st = await b.openLogin({ site: 'reddit' });
    expect(st.state).toBe('login_open');
    expect(st.loginSite).toBe('reddit');
    expect(chrome.spawns).toHaveLength(1);
    const { exe, args } = chrome.spawns[0];
    expect(exe).toBe(CHROME);
    expect(args).toEqual([`--user-data-dir=${PROFILE()}`, '--no-first-run', '--no-default-browser-check', '--new-window', 'https://www.reddit.com/login/']);
    for (const a of args) expect(a).not.toMatch(/remote-debugging|enable-automation|automation|headless|webdriver|user-agent|disable-blink-features/i);
    expect(world.launches).toEqual([]); // Playwright never touches the sign-in window

    await tick(); // the spawned process exits (Chrome relaunched itself) but the profile stays locked
    expect((await b.status()).state).toBe('login_open');
    await expect(b.read('https://www.reddit.com/', { mode: 'profile' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/close the login window first/) });
    await expect(b.read('https://example.com/', { mode: 'public' })).resolves.toMatchObject({ via: 'public' });
  });

  it('closes the headless profile context before starting Chrome (one process per profile)', async () => {
    const b = makeLogin();
    await b.read('https://a.com/', { mode: 'profile' });
    expect(world.contexts[0].closed).toBe(false);
    await tick(5); // the browse call finishes settling
    await b.openLogin({ site: 'reddit' });
    expect(chrome.contextsClosedAtSpawn).toEqual([true]);
  });

  it('a second site opens a tab in the same window', async () => {
    const b = makeLogin();
    await b.openLogin({ site: 'reddit' });
    await tick();
    const st = await b.openLogin({ site: 'linkedin' });
    expect(st).toMatchObject({ state: 'login_open', loginSite: 'linkedin' });
    expect(chrome.spawns).toHaveLength(2);
    expect(chrome.spawns[1].args).toEqual([`--user-data-dir=${PROFILE()}`, '--no-first-run', '--no-default-browser-check', 'https://www.linkedin.com/login']); // no --new-window: a tab
    expect(chrome.lockedAtSpawn).toEqual([false, true]); // handed to the running window
    await tick();
    expect((await b.status()).state).toBe('login_open');
  });

  it('"Close login window" asks Chrome to close gracefully, then reads cookies headless and connects sites', async () => {
    const b = makeLogin();
    await b.openLogin({ site: 'reddit' });
    await tick();
    world.persisted.push(sessionCookie('reddit_session', '.reddit.com'));
    const after = await b.closeLogin();
    expect(chrome.stops).toEqual([{ pid: BROWSER_PID, force: false }]);
    expect(after.state).toBe('idle');
    expect(after.sites.find((s) => s.site === 'reddit')).toMatchObject({ connected: true, via: 'login' });
    expect(world.launches).toHaveLength(1);
    expect(world.launches[0]).toMatchObject({ dir: PROFILE(), opts: { headless: true, channel: 'chrome' } });
    expect(world.contexts[0].closed).toBe(true); // opened only to read the cookie names
    expect(JSON.stringify(after)).not.toContain('SECRET-VALUE');
    expect(readFileSync(join(dir, 'research-browser', 'status.json'), 'utf8')).not.toContain('SECRET-VALUE');
    await expect(b.read('https://www.reddit.com/', { mode: 'profile' })).resolves.toMatchObject({ loggedIn: true });
  });

  it('repeats the graceful request (one per window) and forces Chrome closed only after the wait', async () => {
    chrome.ignoreGraceful = true;
    const b = makeLogin({ closeWaitMs: 3000 });
    await b.openLogin({ site: 'reddit' });
    await tick();
    const after = await b.closeLogin();
    expect(chrome.stops).toEqual([...Array(3).fill({ pid: BROWSER_PID, force: false }), { pid: BROWSER_PID, force: true }]);
    expect(after.state).toBe('idle');
  });

  it('notices when you close the window yourself', async () => {
    const b = makeLogin();
    await b.openLogin({ site: 'linkedin' });
    await tick();
    world.persisted.push(sessionCookie('li_at', '.www.linkedin.com'));
    chrome.locked = false; // you closed Chrome
    await tick();
    expect((await b.status()).state).toBe('login_open'); // still within the start-up grace
    clock += 60_000;
    await tick();
    const st = await b.status();
    expect(st.state).toBe('idle');
    expect(st.sites.find((s) => s.site === 'linkedin')).toMatchObject({ connected: true, via: 'login' });
    expect(chrome.stops).toEqual([]);
  });

  it('stays open while the profile is locked, even after the spawned process exits', async () => {
    const b = makeLogin();
    await b.openLogin({ site: 'reddit' });
    clock += 60_000;
    await tick(40);
    expect((await b.status()).state).toBe('login_open');
    expect(world.launches).toEqual([]);
  });

  it('treats a locked profile as the open login window after a restart', async () => {
    chrome.locked = true;
    const b = makeLogin();
    expect((await b.status()).state).toBe('login_open');
    await b.closeLogin();
    expect(chrome.stops[0]).toEqual({ pid: BROWSER_PID, force: false });
    expect((await b.status()).state).toBe('idle');
  });

  it('falls back to the bundled Chromium only when Chrome is not installed', async () => {
    const bundled = 'Z:/no-bundled/chrome.exe';
    const b = makeLogin({ exists: (p) => p === bundled });
    await b.openLogin({ url: 'https://padlet.com/auth/login' });
    expect(chrome.spawns[0].exe).toBe(bundled);
    expect(chrome.spawns[0].args.at(-1)).toBe('https://padlet.com/auth/login');
    const withChrome = makeLogin({ exists: (p) => p === bundled || p === CHROME });
    await withChrome.openLogin({ site: 'reddit' }).catch(() => undefined);
    expect(chrome.spawns.at(-1)!.exe).toBe(CHROME);
  });

  it('refuses unknown sites and non-http urls', async () => {
    const b = makeLogin();
    await expect(b.openLogin({ site: 'myspace' })).rejects.toMatchObject({ status: 404 });
    await expect(b.openLogin({ url: 'file:///C:/x' })).rejects.toMatchObject({ status: 400 });
    await expect(b.openLogin({})).rejects.toMatchObject({ status: 400 });
    expect(chrome.spawns).toEqual([]);
  });

  it('never adds automation to the sign-in window in the source', () => {
    const src = readFileSync(new URL('./researchbrowser.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/--remote-debugging|--enable-automation|AutomationControlled|webdriver/);
  });
});

describe('cookies', () => {
  const runner = (cookies: PwCookie[], counts: Record<string, number>) => async (): Promise<RunResult> => ({ code: 0, stdout: JSON.stringify({ cookies, counts, errors: {} }), stderr: '' });

  it('imports Opera cookies for allow-listed domains only and keeps counts, never values', async () => {
    cfg.operaAllow = ['reddit.com'];
    const cookies = [sessionCookie('reddit_session', '.reddit.com'), sessionCookie('loid', '.reddit.com'), sessionCookie('li_at', '.linkedin.com')];
    const b = make({ run: runner(cookies, { 'reddit.com': 2 }) });
    await expect(b.operaImport(['linkedin.com'])).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/not in the Opera allowlist/) });
    const st = await b.operaImport();
    expect(st.opera.imported).toEqual({ 'reddit.com': 2 });
    expect(st.opera.lastImportAt).toBeTruthy();
    expect(st.sites.find((s) => s.site === 'reddit')).toMatchObject({ connected: true, via: 'opera' });
    const ctx = world.contexts[0];
    expect(ctx.added.map((c) => c.name).sort()).toEqual(['loid', 'reddit_session']); // linkedin dropped
    expect(JSON.stringify(st)).not.toContain('SECRET-VALUE');
    expect(readFileSync(join(dir, 'research-browser', 'status.json'), 'utf8')).not.toContain('SECRET-VALUE');
  });

  it('refuses an import with an empty allowlist', async () => {
    await expect(make().operaImport()).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/allowlist is empty/) });
  });

  it('reports a failed export without values', async () => {
    cfg.operaAllow = ['reddit.com'];
    const b = make({ run: async () => ({ code: 1, stdout: '', stderr: 'Traceback…\nPermissionError: locked' }) });
    await expect(b.operaImport()).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/PermissionError: locked/) });
  });

  it('forgets a site by clearing its cookies from the profile', async () => {
    world.persisted.push(sessionCookie('reddit_session', '.reddit.com'), sessionCookie('li_at', '.linkedin.com'));
    const b = make();
    expect((await b.status()).sites.find((s) => s.site === 'reddit')?.connected).toBe(true);
    const st = await b.forget('reddit');
    expect(st.sites.find((s) => s.site === 'reddit')?.connected).toBe(false);
    expect(st.sites.find((s) => s.site === 'linkedin')?.connected).toBe(true);
    const re = world.contexts[0].cleared[0] as RegExp;
    expect(re.test('.reddit.com') && re.test('www.reddit.com') && !re.test('notreddit.com')).toBe(true);
    await expect(b.forget('nope')).rejects.toMatchObject({ status: 404 });
  });
});
