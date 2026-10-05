import { describe, expect, it } from 'vitest';
import {
  activityLines, codeCountdown, codeStillShown, configOf, connectionView, hhmm, holdLine, isLocked, lockView, logLine,
  normalizeHost, publicUrl, refusedLine, span, testLine, validHost,
  type RemoteCode, type RemoteLogEntry, type RemoteStatus } from './remotemodel';
import { parseSettingsTab } from './phonemodel';

const NOW = new Date(2026, 9, 5, 14, 45, 0).getTime(); // local 14:45
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const local = (h: number, m: number) => new Date(2026, 9, 5, h, m, 0).toISOString();

const on = (over: Partial<RemoteStatus> = {}): RemoteStatus => ({
  enabled: true, port: 47911, publicHost: 'muster.wayne.dev', connected: false, lastTunnelOkAt: null, lastTunnelError: null,
  lastLocalOkAt: null, connections: [], loginLocked: false, loginLockedUntil: null, codeActiveUntil: null, tunnel: 'cloudflare',
  hold: { on: true, offSince: null, sentWithoutTap: 0 }, settings: { confirmWrites: true, allowApprove: false }, ...over,
});

describe('settings tab', () => {
  it('knows the Remote access tab', () => {
    expect(parseSettingsTab('remote')).toBe('remote');
  });
});

describe('public address', () => {
  it('takes a pasted URL down to the hostname', () => {
    expect(normalizeHost('  https://Muster.Wayne.dev/mcp/ ')).toBe('muster.wayne.dev');
    expect(normalizeHost('muster.wayne.dev.')).toBe('muster.wayne.dev');
    expect(normalizeHost('wayne-pc.tail1234.ts.net?x=1')).toBe('wayne-pc.tail1234.ts.net');
    expect(normalizeHost('')).toBe('');
  });
  it('accepts hostnames only', () => {
    expect(validHost('muster.wayne.dev')).toBe(true);
    expect(validHost('localhost:47911')).toBe(true);
    expect(validHost('bad host')).toBe(false);
    expect(validHost('-x.dev')).toBe(false);
  });
  it('builds the connector URL', () => {
    expect(publicUrl('muster.wayne.dev')).toBe('https://muster.wayne.dev/mcp');
    expect(publicUrl(null)).toBeNull();
  });
  it('reads the config from either shape', () => {
    expect(configOf({ enabled: false, config: { enabled: false, port: 47911, publicHost: 'a.dev', tunnel: null } })).toEqual({ enabled: false, port: 47911, publicHost: 'a.dev', tunnel: null });
    expect(configOf(on())).toEqual({ enabled: true, port: 47911, publicHost: 'muster.wayne.dev', tunnel: 'cloudflare' });
    expect(configOf(null).enabled).toBe(false);
  });
});

describe('connection indicator', () => {
  const log: RemoteLogEntry[] = [
    { at: at(3), tool: 'muster_status', ok: true, client: 'Claude', via: 'tunnel' },
    { at: at(4), tool: 'muster_needs', ok: true, client: 'Inspector', via: 'local' },
  ];
  it('is green with the last tunnel call', () => {
    const v = connectionView(on({ connected: true, lastTunnelOkAt: at(3) }), log, NOW);
    expect(v).toEqual({ state: 'connected', title: 'Connected', sub: 'Last call through the tunnel 3 min ago · muster_status from Claude' });
  });
  it('is grey with the last success, or none yet', () => {
    expect(connectionView(on(), [], NOW)).toEqual({ state: 'idle', title: 'Not connected', sub: 'No call through the tunnel yet' });
    expect(connectionView(on({ lastTunnelOkAt: local(12, 18) }), [], NOW).sub).toBe('No successful call through the tunnel for 2 h · last one today 12:18');
  });
  it('is off when remote is disabled', () => {
    expect(connectionView({ enabled: false }, log, NOW).state).toBe('off');
    expect(connectionView(null, log, NOW).state).toBe('off');
  });
  it('spans', () => {
    expect(span(40_000)).toBe('40 s');
    expect(span(12 * 60_000)).toBe('12 min');
    expect(span(26 * 3_600_000)).toBe('1 day');
  });
});

describe('last refused call', () => {
  it('shows a 421 with the fix', () => {
    const s = on({ lastTunnelError: { at: at(4), status: 421, reason: 'unknown host muster.wayne.dev' } });
    expect(refusedLine(s, [], NOW)).toBe('Last refused call 4 min ago · 421 unknown host muster.wayne.dev · check the public address matches the tunnel');
  });
  it('adds the IP from the log and a later sign-in', () => {
    const errAt = at(41);
    const s = on({ lastTunnelError: { at: errAt, status: 401, reason: 'expired token' }, lastTunnelOkAt: at(3) });
    const log: RemoteLogEntry[] = [
      { at: at(40), event: 'login_ok', client: 'Claude', ip: '86.12.44.170' },
      { at: errAt, refused: 401, reason: 'expired token', via: 'tunnel', ip: '160.79.104.17' },
    ];
    expect(refusedLine(s, log, NOW)).toBe('Last refused call 41 min ago · 401 expired token from 160.79.104.17 · Claude signed in again');
    expect(refusedLine(s, [], NOW)).toBe('Last refused call 41 min ago · 401 expired token · a call has worked since');
  });
  it('is null without one or when off', () => {
    expect(refusedLine(on(), [], NOW)).toBeNull();
    expect(refusedLine({ enabled: false }, [], NOW)).toBeNull();
  });
  it('words the Test result', () => {
    expect(testLine({ ok: true, at: at(0) }, NOW)).toEqual({ text: 'Test passed: the public address answers · just now', ok: true });
    expect(testLine({ ok: false, status: 502, error: 'bad gateway', at: at(0) }, NOW)?.text).toBe('Test failed: 502 bad gateway · just now');
    expect(testLine(null, NOW)).toBeNull();
  });
});

describe('sign-in code', () => {
  const code: RemoteCode = { code: 'R4T9KD', display: 'R4T-9KD', expiresAt: new Date(NOW + 107_000).toISOString() };
  const issued = NOW - 13_000;
  it('stays while the gateway says this code is active', () => {
    expect(codeStillShown(code, issued, on({ codeActiveUntil: code.expiresAt }), NOW - 1000, NOW)).toBe(true);
  });
  it('goes when used (codeActiveUntil null), but not on a reply to a request sent before it was made', () => {
    expect(codeStillShown(code, issued, on({ codeActiveUntil: null }), NOW - 1000, NOW)).toBe(false);
    expect(codeStillShown(code, issued, on({ codeActiveUntil: null }), issued - 500, NOW)).toBe(true);
  });
  it('goes when it runs out on this clock, when another code replaced it, when locked or off', () => {
    expect(codeStillShown(code, issued, on({ codeActiveUntil: code.expiresAt }), NOW, NOW + 108_000)).toBe(false);
    expect(codeStillShown(code, issued, on({ codeActiveUntil: new Date(NOW + 119_000).toISOString() }), NOW, NOW)).toBe(false);
    expect(codeStillShown(code, issued, on({ codeActiveUntil: code.expiresAt, loginLocked: true, loginLockedUntil: at(-10) }), NOW, NOW)).toBe(false);
    expect(codeStillShown(code, issued, { enabled: false }, NOW, NOW)).toBe(false);
    expect(codeStillShown(null, issued, null, NOW, NOW)).toBe(false);
  });
  it('counts down with a bar', () => {
    expect(codeCountdown(code.expiresAt, NOW)).toEqual({ text: '1:47 left · works once', frac: 107 / 120 });
    expect(codeCountdown(code.expiresAt, NOW + 200_000)).toEqual({ text: '0:00 left · works once', frac: 0 });
  });
});

describe('lockout', () => {
  const s = on({ loginLocked: true, loginLockedUntil: local(14, 52) });
  const fail = (sec: number, extra: Record<string, unknown> = {}): RemoteLogEntry =>
    ({ at: new Date(new Date(2026, 9, 5, 14, 42, 0).getTime() - sec * 1000).toISOString(), event: 'login_failed', reason: 'wrong', ip: '203.0.113.9', client: 'Claude', ...extra });
  const log = [fail(0, { lockedUntil: local(14, 52) }), fail(10), fail(20), fail(30), fail(40), fail(600)];
  it('is locked until the time passes', () => {
    expect(isLocked(s, NOW)).toBe(true);
    expect(isLocked(s, new Date(2026, 9, 5, 14, 53).getTime())).toBe(false);
    expect(isLocked(on(), NOW)).toBe(false);
  });
  it('says until when, how many wrong codes, and the last try', () => {
    expect(lockView(s, log)).toEqual({ title: 'Until 14:52 · 5 wrong codes', sub: 'Last try 14:42 from 203.0.113.9 · nobody got in', until: '14:52' });
    expect(lockView(s, [])).toEqual({ title: 'Until 14:52', sub: null, until: '14:52' });
  });
});

describe('hold', () => {
  it('explains the hold, and says since when it is off', () => {
    expect(holdLine({ on: true, offSince: null, sentWithoutTap: 0 })).toMatch(/^Goals, replies and answers wait/);
    expect(holdLine({ on: false, offSince: local(14, 40), sentWithoutTap: 3 }))
      .toBe("Off since 14:40, turned off on this PC. Claude's goals, replies and answers now reach the crew without your tap. 3 sent without your tap so far.");
  });
});

describe('activity', () => {
  it('formats every event as a short line with a tone', () => {
    const t = (e: Record<string, unknown>) => logLine({ at: at(0), ...e });
    expect(t({ event: 'write_sent', id: 'P6', kind: 'goal', approvedOn: 'phone' })).toEqual({ text: 'sent P6 goal · approved on phone', tone: 'text' });
    expect(t({ event: 'write_sent', id: 'P9', kind: 'reply', approvedOn: 'not held' })).toEqual({ text: 'sent P9 reply · not held', tone: 'warm' });
    expect(t({ event: 'write_held', id: 'P6', kind: 'goal', client: 'Claude' })).toEqual({ text: 'held P6 goal · Claude', tone: 'muted' });
    expect(t({ event: 'write_discarded', id: 'P5', kind: 'reply', on: 'desktop' }).text).toBe('discarded P5 reply · on desktop');
    expect(t({ event: 'write_expired', id: 'P4', kind: 'answer' }).text).toBe('expired P4 answer · nothing sent');
    expect(t({ event: 'login_failed', reason: 'wrong', client: 'Claude', ip: '86.12.44.170' })).toEqual({ text: 'wrong code · Claude · 86.12.44.170', tone: 'red' });
    expect(t({ event: 'login_failed', reason: 'wrong', ip: '1.2.3.4', lockedUntil: local(14, 52) }).text).toBe('wrong code · 1.2.3.4 · locked sign-ins until 14:52');
    expect(t({ event: 'login_ok', client: 'Claude', ip: '86.12.44.170' }).text).toBe('signed in Claude · 86.12.44.170');
    expect(t({ event: 'code_issued' }).text).toBe('new sign-in code made');
    expect(t({ event: 'revoked', grant: 'all', count: 2 }).text).toBe('disconnected all apps (2)');
    expect(t({ event: 'revoked', grant: 'g1', count: 1, reason: 'refresh_reused' })).toEqual({ text: 'disconnected an app · refresh token reused', tone: 'red' });
    expect(t({ refused: 421, reason: 'unknown host', ip: '127.0.0.1', via: 'tunnel' }).text).toBe('421 unknown host · 127.0.0.1');
    expect(t({ refused: 429, reason: 'rate limited' }).text).toBe('429 rate limited');
    expect(t({ event: 'settings_changed', before: { confirmWrites: true, allowApprove: false }, after: { confirmWrites: false, allowApprove: false } }))
      .toEqual({ text: 'hold turned OFF · on this PC, confirmed', tone: 'warm' });
    expect(t({ event: 'settings_changed', before: { confirmWrites: false, allowApprove: false }, after: { confirmWrites: true, allowApprove: true } }).text)
      .toBe('hold turned back on · approve merges on');
    expect(t({ event: 'config_changed', before: { tunnel: null }, after: { tunnel: 'cloudflare' } }).text).toBe('tunnel cloudflare');
    expect(t({ tool: 'muster_needs', ok: true, client: 'Claude', via: 'tunnel' }).text).toBe('muster_needs · Claude');
    expect(t({ tool: 'muster_send_goal', ok: true, client: 'Claude', held: true, pendingId: 'P6', via: 'tunnel' }).text).toBe('muster_send_goal · Claude · held as P6');
    expect(t({ tool: 'muster_reply', ok: false, error: 'note closed', client: 'Claude' })).toEqual({ text: 'muster_reply · Claude · failed: note closed', tone: 'red' });
    expect(t({ event: 'something_new' }).text).toBe('something new');
  });
  it('folds runs of the same line, keeping the newest time', () => {
    const e = (min: number): RemoteLogEntry => ({ at: local(14, min), event: 'login_failed', reason: 'wrong', ip: '203.0.113.9' });
    const lines = activityLines([{ at: local(14, 44), event: 'write_sent', id: 'P9', kind: 'reply', approvedOn: 'not held' }, e(42), e(42), e(41), { at: local(13, 50), event: 'code_issued' }]);
    expect(lines.map((l) => `${l.time} ${l.text}`)).toEqual([
      '14:44 sent P9 reply · not held',
      '14:42 wrong code · 203.0.113.9 ×3',
      '13:50 new sign-in code made',
    ]);
    expect(hhmm('nope')).toBe('');
  });
});
