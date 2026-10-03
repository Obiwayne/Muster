import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpError } from '../core/errors.js';
import { DEFAULT_CONFIG, type BrowseMode, type MusterConfig, type ResearchBrowserStatus } from '../types.js';
import { registerBrowserRoutes, type BrowserLike, type BrowserRouteDeps, type RouteReq } from './browserapi.js';

/** A tiny route harness: the same (method, path, handler) shape api.ts uses. */
function harness(deps: BrowserRouteDeps) {
  const routes: { method: string; pattern: RegExp; keys: string[]; handler: (r: RouteReq) => unknown }[] = [];
  registerBrowserRoutes((method, path, handler) => {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, pattern, keys, handler });
  }, deps);
  return async (method: string, path: string, body: Record<string, any> = {}) => {
    const r = routes.find((x) => x.method === method && x.pattern.test(path));
    if (!r) throw new HttpError(404, `no route ${method} ${path}`);
    return r.handler({ params: {}, query: new URLSearchParams(), body });
  };
}

const STATUS = { available: true, channel: 'chrome', profileDir: 'X', state: 'idle', sites: [], tools: [], opera: { found: true, allow: [] } } as unknown as ResearchBrowserStatus;

function fakeBrowser() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const rec =
    (fn: string, result: (...a: any[]) => unknown = () => STATUS) =>
    async (...args: any[]) => {
      calls.push({ fn, args });
      return result(...args) as any;
    };
  const browser: BrowserLike = {
    status: rec('status'),
    openLogin: rec('openLogin'),
    closeLogin: rec('closeLogin'),
    operaImport: rec('operaImport'),
    forget: rec('forget'),
    read: rec('read', (url: string, o: { mode: BrowseMode }) => ({ url, title: 'T', status: 200, text: 'hello', via: o.mode })),
    screenshot: rec('screenshot', (url: string, o: { mode: BrowseMode; path: string }) => ({ url, title: 'T', status: 200, screenshot: o.path, via: o.mode })),
    scroll: rec('scroll', (url: string, o: { mode: BrowseMode }) => ({ url, title: 'T', status: 200, scrolled: { y: 2000, height: 9000 }, via: o.mode })),
  };
  return { browser, calls };
}

let dir: string;
let cfg: MusterConfig;
let work: { id: string; mode: BrowseMode; pagesLeft: number } | null;
let counted: string[];

function setup() {
  const { browser, calls } = fakeBrowser();
  const call = harness({
    browser,
    config: () => cfg,
    isHuman: (a) => a === 'you',
    isResearcher: (a) => a === 'scout',
    currentWork: () => work,
    countPage: (id) => void counted.push(id),
    shotsDir: (id) => join(dir, 'shots', id),
    probe: async (url, opts) => ({ url, found: true, legal: [], companies: [], sources: [], notes: [opts.companiesHouseKey ?? 'no key'] }),
  });
  return { call, calls };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muster-browserapi-'));
  cfg = structuredClone(DEFAULT_CONFIG);
  work = { id: 'IJ3', mode: 'profile', pagesLeft: 150 };
  counted = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('browser routes', () => {
  it('GET /api/browser is open to anyone', async () => {
    const { call } = setup();
    expect(await call('GET', '/api/browser')).toBe(STATUS);
  });

  it('login, close, Opera import and forget are yours only', async () => {
    const { call, calls } = setup();
    for (const [path, body] of [
      ['/api/browser/login', { site: 'reddit' }],
      ['/api/browser/login/close', {}],
      ['/api/browser/opera-import', {}],
      ['/api/browser/forget', { site: 'reddit' }],
    ] as const) {
      await expect(call('POST', path, { ...body, actor: 'scout' })).rejects.toMatchObject({ status: 403 });
      await expect(call('POST', path, { ...body, actor: 'captain' })).rejects.toMatchObject({ status: 403 });
    }
    expect(calls).toEqual([]);
    await call('POST', '/api/browser/login', { actor: 'you', site: 'reddit' });
    await call('POST', '/api/browser/login/close', { actor: 'you' });
    await call('POST', '/api/browser/opera-import', { actor: 'you', domains: ['reddit.com'] });
    await call('POST', '/api/browser/forget', { actor: 'you', site: 'linkedin' });
    expect(calls.map((c) => [c.fn, c.args[0]])).toEqual([
      ['openLogin', { site: 'reddit', url: undefined }],
      ['closeLogin', undefined],
      ['operaImport', ['reddit.com']],
      ['forget', 'linkedin'],
    ]);
    await expect(call('POST', '/api/browser/forget', { actor: 'you' })).rejects.toMatchObject({ status: 400 });
    await expect(call('POST', '/api/browser/opera-import', { actor: 'you', domains: 'reddit.com' })).rejects.toMatchObject({ status: 400 });
  });

  it('read is for the research agent during a job, and counts pages', async () => {
    const { call, calls } = setup();
    await expect(call('POST', '/api/browser/read', { actor: 'captain', url: 'https://a.com/' })).rejects.toMatchObject({ status: 403 });
    await expect(call('POST', '/api/browser/read', { actor: 'you', url: 'https://a.com/' })).rejects.toMatchObject({ status: 403 });
    const r = await call('POST', '/api/browser/read', { actor: 'scout', url: 'https://a.com/', links: true });
    expect(r).toMatchObject({ text: 'hello', via: 'profile', pagesLeft: 149 });
    expect(calls.at(-1)).toEqual({ fn: 'read', args: ['https://a.com/', { mode: 'profile', links: true }] });
    expect(counted).toEqual(['IJ3']);
  });

  it('read returns text, then a screenshot path, then a scroll result', async () => {
    const { call } = setup();
    expect(await call('POST', '/api/browser/read', { actor: 'scout', url: 'https://a.com/' })).toHaveProperty('text', 'hello');
    mkdirSync(join(dir, 'shots', 'IJ3'), { recursive: true });
    writeFileSync(join(dir, 'shots', 'IJ3', '1.png'), '');
    const shot = (await call('POST', '/api/browser/read', { actor: 'scout', url: 'https://a.com/', action: 'screenshot' })) as { screenshot: string };
    expect(shot.screenshot).toBe(join(dir, 'shots', 'IJ3', '2.png'));
    expect(await call('POST', '/api/browser/read', { actor: 'scout', url: 'https://a.com/', action: 'scroll', by: 2000 })).toHaveProperty('scrolled', { y: 2000, height: 9000 });
    await expect(call('POST', '/api/browser/read', { actor: 'scout', url: 'https://a.com/', action: 'click' })).rejects.toMatchObject({ status: 400 });
    expect(counted).toHaveLength(3);
  });

  it('refuses to browse outside a job, and past the page budget', async () => {
    const { call } = setup();
    work = null;
    await expect(call('POST', '/api/browser/read', { actor: 'scout', url: 'https://a.com/' })).rejects.toMatchObject({ status: 409 });
    work = { id: 'R4', mode: 'profile', pagesLeft: 0 };
    await expect(call('POST', '/api/browser/read', { actor: 'scout', url: 'https://a.com/' })).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/Page budget used/) });
    expect(counted).toEqual([]);
  });

  it('public mode browses without the profile; opera mode imports once, then browses as the profile', async () => {
    const { call, calls } = setup();
    work = { id: 'IJ5', mode: 'public', pagesLeft: 10 };
    await call('POST', '/api/browser/read', { actor: 'scout', url: 'https://a.com/' });
    expect(calls.at(-1)!.args[1]).toMatchObject({ mode: 'public' });

    cfg.researchBrowser.operaAllow = ['reddit.com'];
    work = { id: 'IJ6', mode: 'opera', pagesLeft: 10 };
    const r = await call('POST', '/api/browser/read', { actor: 'scout', url: 'https://www.reddit.com/' });
    await call('POST', '/api/browser/read', { actor: 'scout', url: 'https://www.reddit.com/r/x' });
    expect(calls.filter((c) => c.fn === 'operaImport')).toHaveLength(1);
    expect(calls.at(-1)!.args[1]).toMatchObject({ mode: 'profile' });
    expect(r).toMatchObject({ via: 'opera' });
  });

  it('opera mode with an empty allowlist imports nothing', async () => {
    const { call, calls } = setup();
    work = { id: 'IJ7', mode: 'opera', pagesLeft: 10 };
    await call('POST', '/api/browser/read', { actor: 'scout', url: 'https://a.com/' });
    expect(calls.some((c) => c.fn === 'operaImport')).toBe(false);
  });

  it('POST /api/intel/probe passes the Companies House key', async () => {
    const { call } = setup();
    await expect(call('POST', '/api/intel/probe', {})).rejects.toMatchObject({ status: 400 });
    expect(await call('POST', '/api/intel/probe', { url: 'padlet.com' })).toMatchObject({ url: 'padlet.com', notes: ['no key'] });
    cfg.intel.companiesHouseKey = 'abc';
    expect(await call('POST', '/api/intel/probe', { url: 'padlet.com' })).toMatchObject({ notes: ['abc'] });
  });
});
