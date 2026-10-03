import { describe, expect, it } from 'vitest';
import { agentReachPython, exportOperaCookies, OPERA_SCRIPT, operaFound, operaProfileDir, type PythonRunner } from './opera.js';
import { cleanDomain, hostMatches, siteForHost } from './sites.js';

const cookie = (name: string, domain: string, extra: Record<string, unknown> = {}) => ({ name, value: 'VALUE-' + name, domain, path: '/', expires: 1900000000, httpOnly: true, secure: true, sameSite: 'Lax', ...extra });

describe('exportOperaCookies', () => {
  it('runs the script with Agent Reach python and only the clean domains', async () => {
    const calls: { python: string; args: string[] }[] = [];
    const run: PythonRunner = async (python, args) => {
      calls.push({ python, args });
      return { code: 0, stdout: JSON.stringify({ cookies: [], counts: {}, errors: {} }), stderr: '' };
    };
    await exportOperaCookies(['https://www.Reddit.com/', 'not a domain', 'reddit.com'], { run, python: 'py.exe' });
    expect(calls).toEqual([{ python: 'py.exe', args: [OPERA_SCRIPT, 'reddit.com'] }]);
  });

  it('keeps only cookies for the asked domains and counts them', async () => {
    const run: PythonRunner = async () => ({
      code: 0,
      stdout: JSON.stringify({
        cookies: [cookie('reddit_session', '.reddit.com'), cookie('loid', 'www.reddit.com'), cookie('evil', '.notreddit.com'), cookie('li_at', '.linkedin.com'), { name: 'bad' }],
        counts: { 'reddit.com': 99 },
        errors: {},
      }),
      stderr: '',
    });
    const out = await exportOperaCookies(['reddit.com'], { run });
    expect(out.cookies.map((c) => c.name)).toEqual(['reddit_session', 'loid']);
    expect(out.counts).toEqual({ 'reddit.com': 2 }); // counted here, not trusted from the script
  });

  it('normalises cookie fields to what Playwright accepts', async () => {
    const run: PythonRunner = async () => ({
      code: 0,
      stdout: JSON.stringify({ cookies: [cookie('a', '.x.com', { sameSite: 'None', secure: false, expires: null, path: '' })], counts: {}, errors: {} }),
      stderr: '',
    });
    const [c] = (await exportOperaCookies(['x.com'], { run })).cookies;
    expect(c).toMatchObject({ sameSite: 'Lax', expires: -1, path: '/', secure: false });
  });

  it('turns a crash into an error line without echoing stdout', async () => {
    const run: PythonRunner = async () => ({ code: 1, stdout: 'garbage VALUE-secret', stderr: 'Traceback\nModuleNotFoundError: No module named browser_cookie3' });
    const out = await exportOperaCookies(['reddit.com'], { run });
    expect(out.errors['*']).toMatch(/No module named browser_cookie3/);
    expect(JSON.stringify(out)).not.toContain('VALUE-secret');
  });

  it('passes per-domain errors through', async () => {
    const run: PythonRunner = async () => ({ code: 0, stdout: JSON.stringify({ cookies: [], counts: {}, errors: { 'g2.com': 'BrowserCookieError: x' } }), stderr: '' });
    const out = await exportOperaCookies(['g2.com'], { run });
    expect(out.errors['g2.com']).toMatch(/BrowserCookieError/);
    expect(out.counts['g2.com']).toBe(0);
  });

  it('does nothing for an empty list', async () => {
    const run: PythonRunner = async () => {
      throw new Error('should not run');
    };
    expect(await exportOperaCookies([], { run })).toEqual({ cookies: [], counts: {}, errors: {} });
  });
});

describe('paths and domains', () => {
  it('finds Agent Reach python and the Opera profile', () => {
    expect(agentReachPython({ AGENT_REACH_PYTHON: 'X:/py.exe' }, 'win32')).toBe('X:/py.exe');
    const fwd = (p: string) => p.replace(/[\\/]+/g, '/');
    expect(fwd(agentReachPython({ USERPROFILE: 'C:/Users/me' }, 'win32'))).toBe('C:/Users/me/.agent-reach/venv/Scripts/python.exe');
    expect(fwd(operaProfileDir({ APPDATA: 'C:/Users/me/AppData/Roaming' }, 'win32'))).toBe('C:/Users/me/AppData/Roaming/Opera Software/Opera Stable');
    const dir = 'C:/O';
    expect(operaFound(dir, (p) => ['C:/O/Local State', 'C:/O/Default/Network/Cookies'].includes(fwd(p)))).toBe(true);
    expect(operaFound(dir, () => false)).toBe(false);
  });

  it('cleans allowlist entries and matches hosts', () => {
    expect(cleanDomain('https://www.Reddit.com/r/x')).toBe('reddit.com');
    expect(cleanDomain('localhost')).toBeNull();
    expect(cleanDomain('a b.com')).toBeNull();
    expect(hostMatches('.reddit.com', 'reddit.com')).toBe(true);
    expect(hostMatches('old.reddit.com', 'reddit.com')).toBe(true);
    expect(hostMatches('notreddit.com', 'reddit.com')).toBe(false);
    expect(siteForHost('twitter.com')?.site).toBe('x');
    expect(siteForHost('www.linkedin.com')?.site).toBe('linkedin');
  });
});
