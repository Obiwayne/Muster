// HTTP routes for the research browser and the add-competitor probe (docs/ARCHITECTURE.md, Competitive
// intelligence). api.ts registers them with one call: registerBrowserRoutes(route, deps).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ResearchBrowser } from '../browser/researchbrowser.js';
import { PUBLIC_READER_NOTE, readPublic, type PublicRead } from '../browser/botcheck.js';
import { badRequest, conflict, forbidden, HttpError } from '../core/errors.js';
import { probeSite, type ProbeOptions } from '../core/intelprobe.js';
import type { BrowseMode, BrowseResult, IntelProbe, MusterConfig } from '../types.js';

/** The request shape api.ts hands to handlers. */
export interface RouteReq {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, any>;
}
export type RouteFn = (method: string, path: string, handler: (r: RouteReq) => unknown) => void;

/** What the routes need from the browser (the real ResearchBrowser, or a fake in tests). */
export type BrowserLike = Pick<ResearchBrowser, 'status' | 'read' | 'screenshot' | 'scroll' | 'openLogin' | 'closeLogin' | 'operaImport' | 'forget' | 'visibleSites' | 'setVisibleSite'>;

export interface BrowserRouteDeps {
  browser: BrowserLike;
  config(): MusterConfig;
  isHuman(actor: string): boolean;
  isResearcher(actor: string): boolean;
  /** The running intel job or research run scout is browsing for, or null (→ 409). */
  currentWork(): { id: string; mode: BrowseMode; pagesLeft: number } | null;
  countPage(id: string, page?: { url?: string; blocked?: string; loggedIn?: boolean; mode?: string }): void; // job.pagesBrowsed++ (and its progress: what it reads, blocks, missing sign-ins) / run counter
  shotsDir(id: string): string; // .muster/intel/shots/<id>
  /** Test seam for POST /api/intel/probe. */
  probe?: (url: string, opts: ProbeOptions) => Promise<IntelProbe>;
  /** Test seam: the public reader used when a site blocks the research browser (default readPublic). */
  publicRead?: (url: string) => Promise<PublicRead>;
}

const ACTIONS = new Set(['read', 'screenshot', 'scroll']);

/** Next free <n>.png in a job's screenshot folder. */
function nextShot(dir: string): string {
  let n = 1;
  if (existsSync(dir)) for (const f of readdirSync(dir)) n = Math.max(n, (parseInt(f, 10) || 0) + 1);
  return join(dir, `${n}.png`);
}

export function registerBrowserRoutes(route: RouteFn, deps: BrowserRouteDeps): void {
  const { browser } = deps;
  const human = (body: Record<string, any>, what: string) => {
    if (!deps.isHuman(String(body.actor ?? ''))) throw forbidden(`Only you can ${what}; agents never sign in or touch cookies.`);
  };
  /** Work ids whose Opera import already ran (mode 'opera' imports once, before the first page). */
  const imported = new Set<string>();

  route('GET', '/api/browser', () => browser.status());

  route('POST', '/api/browser/login', ({ body }) => {
    human(body, 'open the research browser login window');
    if (body.site !== undefined && typeof body.site !== 'string') throw badRequest('site must be a site name');
    if (body.url !== undefined && typeof body.url !== 'string') throw badRequest('url must be a string');
    return browser.openLogin({ site: body.site || undefined, url: body.url || undefined });
  });

  route('POST', '/api/browser/login/close', ({ body }) => {
    human(body, 'close the login window');
    return browser.closeLogin();
  });

  route('POST', '/api/browser/opera-import', ({ body }) => {
    human(body, 'import cookies from Opera');
    if (body.domains !== undefined && (!Array.isArray(body.domains) || body.domains.some((d: unknown) => typeof d !== 'string'))) throw badRequest('domains must be a list of domains');
    return browser.operaImport(body.domains);
  });

  route('POST', '/api/browser/forget', ({ body }) => {
    human(body, 'forget a site');
    if (typeof body.site !== 'string' || !body.site) throw badRequest('Missing site');
    return browser.forget(body.site);
  });

  // The visible-window list is shared by every project on this PC (like the sign-ins); only you change it.
  route('POST', '/api/browser/visible', ({ body }) => {
    human(body, 'choose which sites scout reads in a visible window');
    if (typeof body.domain !== 'string' || !body.domain.trim()) throw badRequest('Missing domain');
    if (typeof body.visible !== 'boolean') throw badRequest('visible must be true or false');
    browser.setVisibleSite(body.domain, body.visible);
    return browser.status();
  });

  route('POST', '/api/browser/read', async ({ body }): Promise<BrowseResult> => {
    const actor = String(body.actor ?? '');
    if (!deps.isResearcher(actor)) throw forbidden('Only the research agent browses, and only during an intel job or research run.');
    if (typeof body.url !== 'string' || !body.url.trim()) throw badRequest('Missing url');
    const action = body.action ?? 'read';
    if (!ACTIONS.has(action)) throw badRequest('action must be read, screenshot or scroll');
    if (body.by !== undefined && !Number.isFinite(Number(body.by))) throw badRequest('by must be a number of pixels');
    const work = deps.currentWork();
    if (!work) throw conflict('No intel job or research run is running: browse works only during one.');
    if (work.pagesLeft <= 0) throw new HttpError(429, `Page budget used (${deps.config().researchBrowser.maxPagesPerJob} pages for ${work.id}). Finish with what you have.`);
    if (work.mode === 'opera' && !imported.has(work.id)) {
      imported.add(work.id);
      if (deps.config().researchBrowser.operaAllow.length) await browser.operaImport().catch(() => undefined); // still browse as the profile if it fails
    }
    const mode: BrowseMode = work.mode === 'public' ? 'public' : 'profile';
    const out =
      action === 'screenshot'
        ? await browser.screenshot(body.url, { mode, path: nextShot(deps.shotsDir(work.id)), fullPage: body.fullPage === true })
        : action === 'scroll'
          ? await browser.scroll(body.url, { mode, by: body.by === undefined ? undefined : Number(body.by) })
          : await browser.read(body.url, { mode, links: body.links === true });
    deps.countPage(work.id, { url: out.url || body.url, blocked: out.blocked, loggedIn: out.loggedIn, mode });
    const done: BrowseResult = { ...out, via: work.mode, pagesLeft: Math.max(0, work.pagesLeft - 1) };
    if (!done.blocked) return done;
    // The site answered with a bot check: no getting past it. Read the public page another way and say so.
    if (action !== 'read') return { ...done, note: `The site blocked the research browser (${done.blocked}). Use action read to get its text through the public reader.` };
    try {
      const pub = await (deps.publicRead ?? ((u: string) => readPublic(u)))(body.url);
      return {
        ...done,
        url: pub.url || done.url,
        title: pub.title || done.title,
        status: 200,
        text: pub.text,
        links: undefined,
        loggedIn: false,
        readVia: 'public_reader',
        note: `${PUBLIC_READER_NOTE}: ${done.blocked}. Cite it as "${PUBLIC_READER_NOTE}".`,
      };
    } catch (e) {
      return { ...done, note: `The site blocked the research browser (${done.blocked}) and the public reader failed too (${e instanceof Error ? e.message : e}). Use other sources for it.` };
    }
  });

  route('POST', '/api/intel/probe', ({ body }) => {
    if (typeof body.url !== 'string' || !body.url.trim()) throw badRequest('Missing url');
    const key = deps.config().intel?.companiesHouseKey;
    return (deps.probe ?? probeSite)(body.url, { companiesHouseKey: key || undefined });
  });
}
