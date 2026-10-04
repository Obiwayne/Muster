import { describe, expect, it } from 'vitest';
import type { ResearchBrowserStatus } from '../../src/types';
import { addAllowed, availabilityLine, blockedHint, honestLimits, normaliseDomain, NOT_CHECKED_VISIBLE, operaSummary, siteLine } from './browsermodel';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const minsAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();
const status = (over: Partial<ResearchBrowserStatus> = {}): ResearchBrowserStatus => ({
  available: true, channel: 'chrome', profileDir: 'C:/x', state: 'idle',
  sites: [
    { site: 'reddit', label: 'Reddit', domain: 'reddit.com', loginUrl: '', connected: false, checkedAt: minsAgo(30) },
    { site: 'x', label: 'X', domain: 'x.com', loginUrl: '', connected: false, checkedAt: minsAgo(30) },
  ],
  tools: [{ name: 'yt-dlp', ok: false, note: 'not on PATH' }],
  opera: { found: true, allow: [] },
  ...over,
});

describe('browser settings model', () => {
  it('blocked sites say what to do: the visible window or public reading', () => {
    const at = minsAgo(30);
    expect(blockedHint({ label: 'Reddit' }, NOW)).toBeNull();
    const off = blockedHint({ label: 'Reddit', blocked: { reason: 'blocked (403)', at } }, NOW)!;
    expect(off).toMatchObject({ tone: 'blocked', tag: 'blocked' });
    expect(off.text).toBe('Reddit blocks headless reading (blocked (403), 30 min ago). Turn on the visible window for it, or scout relies on public reading.');
    // a hidden read is recorded explicitly too
    expect(blockedHint({ label: 'Reddit', blocked: { reason: 'blocked (403)', at, visible: false } }, NOW)!.tone).toBe('blocked');
  });

  it('a hidden-read block with the visible window now on is not checked yet: muted, no BLOCKED badge', () => {
    const at = minsAgo(30);
    for (const blocked of [{ reason: 'blocked (403)', at }, { reason: 'blocked (403)', at, visible: false }]) {
      // old records without `visible` count as hidden reads
      expect(blockedHint({ label: 'Reddit', visible: true, blocked }, NOW)).toEqual({ tone: 'pending', tag: '', text: NOT_CHECKED_VISIBLE });
    }
    expect(NOT_CHECKED_VISIBLE).toBe('Not checked in a visible window yet. The next read uses the window.');
  });

  it('a block recorded in the visible window stays red: the site blocks even the window', () => {
    const at = minsAgo(30);
    const on = blockedHint({ label: 'Reddit', visible: true, blocked: { reason: 'bot check (Cloudflare)', at, visible: true } }, NOW)!;
    expect(on).toMatchObject({ tone: 'blocked', tag: 'blocked' });
    expect(on.text).toBe('Reddit blocks even the visible window (bot check (Cloudflare), 30 min ago). scout relies on public reading for it.');
    // window turned off again afterwards: still red, still true
    expect(blockedHint({ label: 'Reddit', visible: false, blocked: { reason: 'bot check (Cloudflare)', at, visible: true } }, NOW)!.tone).toBe('blocked');
  });

  it('site lines', () => {
    expect(siteLine({ connected: true, via: 'login', checkedAt: minsAgo(30) }, NOW)).toBe('Signed in · checked 30 min ago');
    expect(siteLine({ connected: true, via: 'opera', checkedAt: minsAgo(120) }, NOW)).toBe('Signed in via Opera import · checked 2h ago');
    expect(siteLine({ connected: false, checkedAt: '' }, NOW)).toBe('Not signed in');
    // Live run: the server sends a day; it read "checked 12h ago" at lunchtime
    const day = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    expect(siteLine({ connected: true, via: 'opera', checkedAt: day(NOW) }, NOW)).toBe('Signed in via Opera import · checked today');
    expect(siteLine({ connected: false, checkedAt: day(NOW - 86_400_000) }, NOW)).toBe('Not signed in · checked yesterday');
    expect(siteLine({ connected: false, checkedAt: '2026-01-02' }, NOW)).toBe('Not signed in · checked on 2026-01-02');
  });

  it('availability', () => {
    expect(availabilityLine(null).ok).toBe(false);
    expect(availabilityLine(status({ available: false, problem: 'playwright-core is not installed' })).text).toMatch(/^playwright-core is not installed\. scout reads public pages/);
    expect(availabilityLine(status({ state: 'login_open', loginSite: 'reddit' }))).toEqual({ ok: true, text: 'Available · Chrome · login window open (reddit)' });
  });

  it('honest limits follow the live status', () => {
    const off = honestLimits(status(), null);
    expect(off.map((l) => l.key)).toEqual(['youtube', 'reddit', 'linkedin', 'x', 'companies_house', 'cloudflare']);
    expect(off.find((l) => l.key === 'youtube')).toMatchObject({ tone: 'off', text: expect.stringMatching(/yt-dlp is not on PATH/) });
    expect(off.find((l) => l.key === 'reddit')?.tone).toBe('warn');
    expect(off.find((l) => l.key === 'x')?.text).toMatch(/Not set up/);
    expect(off.find((l) => l.key === 'linkedin')?.text).toMatch(/separate account/);
    expect(off.find((l) => l.key === 'cloudflare')?.text).toMatch(/Padlet.*falls back to reading their public pages/);
    expect(off.find((l) => l.key === 'companies_house')?.text).toMatch(/optional/);

    const on = honestLimits(status({
      tools: [{ name: 'yt-dlp', ok: true }],
      sites: [{ site: 'reddit', label: 'Reddit', domain: 'reddit.com', loginUrl: '', connected: true, checkedAt: minsAgo(1) }],
    }), { intel: { recheck: 'weekly', checkMaxAgeDays: 14, companiesHouseKey: 'k' } });
    expect(on.find((l) => l.key === 'youtube')?.tone).toBe('ok');
    expect(on.find((l) => l.key === 'reddit')?.tone).toBe('ok');
    expect(on.find((l) => l.key === 'companies_house')?.tone).toBe('ok');
  });

  it('allowlist domains', () => {
    expect(normaliseDomain('https://www.Reddit.com/r/Teachers')).toBe('reddit.com');
    expect(normaliseDomain('linkedin.com:443')).toBe('linkedin.com');
    expect(normaliseDomain('not a domain')).toBeNull();
    expect(addAllowed(['reddit.com'], 'reddit.com').list).toEqual(['reddit.com']);
    expect(addAllowed(['reddit.com'], 'g2.com').list).toEqual(['reddit.com', 'g2.com']);
    expect(addAllowed([], 'nope').error).toMatch(/isn't a domain/);
  });

  it('opera summary: counts only', () => {
    expect(operaSummary({ found: false, allow: [] }, NOW)).toBe('Opera profile not found on this PC.');
    expect(operaSummary({ found: true, allow: ['reddit.com'] }, NOW)).toBe('Not imported yet.');
    expect(operaSummary({ found: true, allow: ['reddit.com'], lastImportAt: minsAgo(5), imported: { 'reddit.com': 10 } }, NOW)).toBe('reddit.com 10 cookies · imported 5 min ago');
  });
});
