import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectBlock, readPublic, type FetchLike } from './botcheck.js';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

describe('detectBlock', () => {
  it('spots the Cloudflare "Just a moment..." interstitial (403)', () => {
    const html = fixture('cf-just-a-moment.html');
    expect(detectBlock({ status: 403, html })).toBe('bot check (Cloudflare)');
    // As the browser sees it: title plus visible text, the status already 200 after a reload
    expect(detectBlock({ status: 200, title: 'Just a moment...', text: 'padlet.com\nChecking if the site connection is secure', html })).toBe('bot check (Cloudflare)');
  });

  it('spots a Cloudflare block page and a "Prove your humanity" check', () => {
    expect(detectBlock({ status: 403, html: fixture('cf-attention-required.html') })).toBe('bot check (Cloudflare)');
    expect(detectBlock({ status: 200, html: fixture('prove-humanity.html') })).toBe('bot check');
    expect(detectBlock({ status: 403, title: 'Padlet', text: 'Prove your humanity' })).toBe('bot check');
  });

  it('treats a 429 as rate limited', () => {
    expect(detectBlock({ status: 429, title: 'Too many requests', text: 'Slow down' })).toBe('rate limited (429)');
  });

  it('leaves real pages alone, even ones with a Turnstile widget or a robot joke', () => {
    expect(detectBlock({ status: 200, html: fixture('normal-pricing.html') })).toBeUndefined();
    expect(detectBlock({ status: 200, title: 'Pricing | Padlet', text: 'Plans for every classroom' })).toBeUndefined();
    // A plain 403 without challenge markers is a real answer (a private page), not a bot check
    expect(detectBlock({ status: 403, title: 'Forbidden', text: 'You do not have access to this padlet.' })).toBeUndefined();
    // A long article that quotes a challenge phrase
    expect(detectBlock({ status: 200, title: 'How bot checks work', text: 'Prove your humanity, they say. ' + 'Lorem ipsum dolor sit amet. '.repeat(100) })).toBeUndefined();
  });
});

describe('readPublic', () => {
  const res = (status: number, body: string, url?: string) => ({ ok: status >= 200 && status < 300, status, text: async () => body, url });

  it('reads through the Jina Reader first', async () => {
    const asked: string[] = [];
    const fetch: FetchLike = async (u) => (asked.push(u), res(200, 'Title: Pricing | Padlet\nURL Source: https://padlet.com/premium\n\nMarkdown Content:\n# Plans\nGold $6.99'));
    const r = await readPublic('https://padlet.com/premium', { fetch });
    expect(asked).toEqual(['https://r.jina.ai/https://padlet.com/premium']);
    expect(r).toEqual({ url: 'https://padlet.com/premium', title: 'Pricing | Padlet', text: '# Plans\nGold $6.99', reader: 'jina' });
  });

  it('falls back to a plain cookie-less request, and gives up on a challenge there too', async () => {
    const plain: FetchLike = async (u, init) => {
      expect(init?.headers?.cookie).toBeUndefined();
      return u.startsWith('https://r.jina.ai/') ? res(422, 'error') : res(200, fixture('normal-pricing.html'), u);
    };
    const r = await readPublic('https://padlet.com/premium', { fetch: plain });
    expect(r.reader).toBe('fetch');
    expect(r.title).toBe('Pricing | Padlet');
    expect(r.text).toMatch(/Gold \$6\.99 per month/);
    expect(r.text).not.toMatch(/<|turnstile/);

    const walled: FetchLike = async (u) =>
      u.startsWith('https://r.jina.ai/') ? res(200, 'Title: Just a moment...\n\nMarkdown Content:\nChecking if the site connection is secure') : res(403, fixture('cf-just-a-moment.html'));
    await expect(readPublic('https://padlet.com/', { fetch: walled })).rejects.toThrow(/public reader: bot check.*plain request: bot check \(Cloudflare\)/);
  });

  it('does not count an app shell with almost no text as a read (live: Reddit answers "Reddit")', async () => {
    const shell: FetchLike = async (u) =>
      u.startsWith('https://r.jina.ai/')
        ? res(200, "Title: \n\nWarning: Target URL returned error 403: Forbidden\n\nMarkdown Content:\nYou've been blocked by network security.")
        : res(200, '<html><head><title>Reddit</title></head><body><shreddit-app>Reddit</shreddit-app><script>boot()</script></body></html>', u);
    await expect(readPublic('https://www.reddit.com/r/Teachers/', { fetch: shell })).rejects.toThrow(/plain request: almost empty page \(\d+ characters: it needs JavaScript or a login\)/);
  });
});
