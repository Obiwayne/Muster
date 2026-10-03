import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyLink, companyNumbers, legalNames, nameAndTagline, normaliseHome, parseChApi, parseChSearch, probeSite, slugify, type FetchLike } from './intelprobe.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const HOME = fixture('probe-home.html');
const PRIVACY = fixture('probe-privacy.html');
const CH_SEARCH = fixture('probe-ch-search.html');
const CH_API = fixture('probe-ch-api.json');

type Reply = { status?: number; body: string; url?: string; delayMs?: number };

function fakeFetch(routes: Record<string, Reply | ((url: string, headers: Record<string, string>) => Reply)>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers = init?.headers ?? {};
    calls.push({ url, headers });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return { ok: false, status: 404, url, text: async () => 'not found' };
    const r = routes[key];
    const reply = typeof r === 'function' ? r(url, headers) : r;
    if (reply.delayMs)
      await new Promise((res, rej) => {
        const t = setTimeout(res, reply.delayMs);
        init?.signal?.addEventListener('abort', () => (clearTimeout(t), rej(new Error('aborted'))));
      });
    return { ok: (reply.status ?? 200) < 400, status: reply.status ?? 200, url: reply.url ?? url, text: async () => reply.body };
  };
  return { fetch, calls };
}

const CH_WEB = 'https://find-and-update.company-information.service.gov.uk/search/companies';
const CH_API_URL = 'https://api.company-information.service.gov.uk/search/companies';

describe('probeSite', () => {
  it('finds name, tagline, legal entity, Companies House match and sources from the site', async () => {
    const { fetch, calls } = fakeFetch({
      'https://boardly.io/legal/privacy': { body: PRIVACY },
      'https://boardly.io/legal/terms': { body: '<p>These terms are between you and Boardly Learning Ltd.</p>' },
      'https://boardly.io/': { body: HOME },
      [CH_WEB]: { body: CH_SEARCH },
    });
    const p = await probeSite('boardly.io', { fetch });
    expect(p.found).toBe(true);
    expect(p.url).toBe('https://boardly.io/');
    expect(p.name).toBe('Boardly');
    expect(p.suggestedId).toBe('boardly');
    expect(p.tagline).toBe('Safe Walls for Classrooms');
    expect(p.legal[0]).toEqual({ name: 'Boardly Learning Ltd', matchedFrom: 'site footer, privacy policy, terms' });
    expect(p.legal.map((l) => l.name)).not.toContain('Fake Script Ltd'); // script text is ignored
    expect(p.companies[0]).toMatchObject({ number: '08181561', name: 'BOARDLY LEARNING LTD', status: 'active', incorporated: '2012-08-16', url: 'https://find-and-update.company-information.service.gov.uk/company/08181561' });
    expect(p.companies.find((c) => c.number === '10542207')).toMatchObject({ status: 'dissolved' });
    expect(p.companies.map((c) => c.name)).not.toContain('SBS PROPERTY SERVICES LTD');
    const kinds = Object.fromEntries(p.sources.map((s) => [s.kind, s.url]));
    expect(kinds).toEqual({
      pricing: 'https://boardly.io/site/subscriptions',
      roadmap: 'https://boardly.canny.io/roadmap',
      changelog: 'https://boardly.io/changelog',
      help: 'https://help.boardly.io/hc/en',
      app_store: 'https://apps.apple.com/gb/app/boardly/id123',
      google_play: 'https://play.google.com/store/apps/details?id=io.boardly',
      g2: 'https://www.g2.com/products/boardly/reviews',
      capterra: 'https://www.capterra.com/p/1/Boardly/',
      x: 'https://twitter.com/boardly',
      youtube: 'https://www.youtube.com/@boardly',
      linkedin: 'https://www.linkedin.com/company/boardly',
      jobs: 'https://boardly.io/careers',
      rss: 'https://boardly.io/blog/feed.xml',
    });
    expect(p.sources.find((s) => s.kind === 'roadmap')?.note).toBe('Canny');
    // Companies House public search, by legal name and by product name
    const chQueries = calls.filter((c) => c.url.startsWith(CH_WEB)).map((c) => decodeURIComponent(new URL(c.url).searchParams.get('q')!));
    expect(chQueries.sort()).toEqual(['Boardly', 'Boardly Learning Ltd']);
    expect(p.notes).toEqual([]);
  });

  it('uses the Companies House API with basic auth when a key is set', async () => {
    const { fetch, calls } = fakeFetch({
      'https://boardly.io/legal/privacy': { body: PRIVACY },
      'https://boardly.io/': { body: HOME },
      [CH_API_URL]: { body: CH_API },
    });
    const p = await probeSite('https://boardly.io', { fetch, companiesHouseKey: 'k3y' });
    const api = calls.find((c) => c.url.startsWith(CH_API_URL))!;
    expect(api.headers.authorization).toBe('Basic ' + Buffer.from('k3y:').toString('base64'));
    expect(calls.some((c) => c.url.startsWith(CH_WEB))).toBe(false);
    expect(p.companies[0]).toMatchObject({ number: '08181561', status: 'active', incorporated: '2012-08-16', address: '38 Oakleigh Avenue, Edgware, Middlesex, HA8 5DR' });
  });

  it('says so when the legal entity is not a UK company', async () => {
    const home = HOME.replace('Boardly Learning Ltd', 'Wallwisher, Inc');
    const { fetch } = fakeFetch({ 'https://boardly.io/': { body: home }, [CH_WEB]: { body: CH_SEARCH } });
    const p = await probeSite('boardly.io', { fetch });
    expect(p.legal[0].name).toBe('Wallwisher, Inc');
    expect(p.notes.join(' ')).toMatch(/Wallwisher, Inc doesn't look like a UK company/);
  });

  it('reports a blocked site honestly and still suggests an id', async () => {
    const { fetch } = fakeFetch({ 'https://padlet.com/': { status: 403, body: 'Just a moment...' }, [CH_WEB]: { body: '<ul></ul>' } });
    const p = await probeSite('https://padlet.com/premium', { fetch });
    expect(p.found).toBe(false);
    expect(p.suggestedId).toBe('padlet');
    expect(p.notes[0]).toMatch(/answered 403/);
  });

  it('stops at the deadline', async () => {
    const { fetch } = fakeFetch({ 'https://slow.io/': { body: HOME, delayMs: 5000 } });
    const t = Date.now();
    const p = await probeSite('slow.io', { fetch, deadlineMs: 150 });
    expect(Date.now() - t).toBeLessThan(2000);
    expect(p.found).toBe(false);
    expect(p.notes.join(' ')).toMatch(/Couldn't reach the site in time/);
  });

  it('rejects things that are not web addresses', async () => {
    const p = await probeSite('ftp://x', { fetch: fakeFetch({}).fetch });
    expect(p.found).toBe(false);
    expect(p.notes[0]).toMatch(/does not look like a web address/);
  });
});

describe('probe helpers', () => {
  it('normalises the home page and slugs', () => {
    expect(normaliseHome('Padlet.com/premium?x=1')).toBe('https://padlet.com/');
    expect(normaliseHome('http://www.linoit.com/en/')).toBe('http://www.linoit.com/');
    expect(slugify('Lino-it Pro!')).toBe('lino-it-pro');
    expect(slugify('Us')).toBe('us-competitor'); // 'us' is reserved
  });

  it('reads name and tagline from og tags and the title', () => {
    expect(nameAndTagline('<title>Padlet - Visual Collaboration for Creative Work</title><meta property="og:site_name" content="Padlet">')).toEqual({ name: 'Padlet', tagline: 'Visual Collaboration for Creative Work' });
    expect(nameAndTagline('<title>Wakelet</title><meta name="description" content="Save &amp; share">')).toEqual({ name: 'Wakelet', tagline: 'Save & share' });
  });

  it('finds legal names and folds longer mentions into the short one', () => {
    const text = 'Imprint Legal disclosure information for Wallwisher, Inc. Padlet is registered under the name Wallwisher, Inc. Services. Designated Agent Wallwisher, Inc. UK GDPR rep EDPO UK Ltd';
    const names = legalNames(text);
    expect(names[0]).toEqual({ name: 'Wallwisher, Inc', count: 3 });
    expect(names.map((n) => n.name)).toContain('EDPO UK Ltd');
    expect(legalNames('© 2026 Boardly Learning Limited. All rights reserved')[0].name).toBe('Boardly Learning Limited');
  });

  it('finds company numbers', () => {
    expect(companyNumbers('company number 08181561, Registered No. SC123456')).toEqual(['08181561', 'SC123456']);
  });

  it('classifies links', () => {
    expect(classifyLink('https://padlet.com/site/subscriptions', 'padlet.com')).toMatchObject({ kind: 'pricing' });
    expect(classifyLink('https://www.padlet.help/', 'padlet.com')).toMatchObject({ kind: 'help' });
    expect(classifyLink('https://padlet.jobs/open-roles', 'padlet.com')).toMatchObject({ kind: 'jobs' });
    expect(classifyLink('https://padlet.link/capterra', 'padlet.com')).toMatchObject({ kind: 'capterra' });
    expect(classifyLink('https://legal.padlet.com/imprint', 'padlet.com')).toEqual({ legal: 'imprint' });
    expect(classifyLink('https://portal.productboard.com/x', 'a.com')).toMatchObject({ kind: 'roadmap', note: 'Productboard' });
    expect(classifyLink('https://other.com/pricing', 'padlet.com')).toBeNull();
    expect(classifyLink('https://twitter.com/padlet/status/1', 'padlet.com')).toBeNull();
  });

  it('parses Companies House search pages and API results', () => {
    const web = parseChSearch(CH_SEARCH);
    expect(web.map((c) => c.number)).toEqual(['10542207', '08181561', '05329383']); // the mustache template is skipped
    expect(web[0]).toMatchObject({ status: 'dissolved', address: '4 Speldhurst Court, Maidstone, Kent, England, ME16 0JH' });
    expect(web[0].incorporated).toBeUndefined();
    const api = parseChApi(JSON.parse(CH_API));
    expect(api[1]).toMatchObject({ number: '11111111', name: 'BOARDLY HOLDINGS LIMITED', status: 'dissolved' });
    expect(parseChApi({})).toEqual([]);
  });
});
