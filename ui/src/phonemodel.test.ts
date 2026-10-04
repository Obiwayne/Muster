import { describe, expect, it } from 'vitest';
import {
  ago, dayTime, deviceLine, expiryLine, formatCountdown, manualHost, msLeft, networkRows, parseSettingsTab, sendTarget, shortDns, withNotify,
  type PhoneStatus, shortFingerprint } from './phonemodel';

const status = (over: Partial<PhoneStatus['network']> = {}, devices: PhoneStatus['devices'] = []): PhoneStatus => ({
  pcName: 'WAYNE-PC', port: 47910, fingerprint: 'ab'.repeat(32),
  network: { mode: 'lan', lanHosts: ['192.168.1.20', '10.0.0.5'], tailscale: { installed: false }, ...over },
  devices,
});

describe('pair code countdown', () => {
  it('formats minutes and seconds, rounding up', () => {
    expect(formatCountdown(112_000)).toBe('1:52');
    expect(formatCountdown(120_000)).toBe('2:00');
    expect(formatCountdown(59_001)).toBe('1:00');
    expect(formatCountdown(4_200)).toBe('0:05');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-5)).toBe('0:00');
  });

  it('counts down to the expiry and then says expired', () => {
    const now = Date.parse('2026-10-04T09:00:00Z');
    expect(msLeft('2026-10-04T09:01:52Z', now)).toBe(112_000);
    expect(msLeft('nonsense', now)).toBe(0);
    expect(expiryLine('2026-10-04T09:01:52Z', now)).toEqual({ text: 'Expires in 1:52 · works once', expired: false });
    expect(expiryLine('2026-10-04T08:59:00Z', now).expired).toBe(true);
  });
});

describe('network rows', () => {
  it('shows the LAN address with the port and the manual-entry host', () => {
    const [lan, ts] = networkRows(status());
    expect(lan).toMatchObject({ mode: 'lan', selected: true, detail: '192.168.1.20:47910' });
    expect(ts).toMatchObject({ mode: 'tailscale', selected: false, disabled: true, detail: 'not installed' });
    expect(ts.link?.href).toBe('https://tailscale.com/download');
    expect(manualHost(status())).toBe('192.168.1.20');
    expect(manualHost(null)).toBeNull();
  });

  it('shows the MagicDNS name and whether Tailscale is connected', () => {
    const on = networkRows(status({ mode: 'tailscale', tailscale: { installed: true, ip: '100.101.1.2', dnsName: 'wayne-pc.tail1234.ts.net.', online: true } }))[1];
    expect(on).toMatchObject({ selected: true, disabled: false, detail: 'wayne-pc · connected', dot: 'ok' });
    expect(on.link).toBeUndefined();
    const off = networkRows(status({ tailscale: { installed: true, ip: '100.101.1.2', online: false } }))[1];
    expect(off).toMatchObject({ detail: '100.101.1.2 · offline', dot: 'off', disabled: false });
    expect(shortDns(undefined)).toBe('');
  });

  it('copes with no LAN address', () => {
    expect(networkRows(status({ lanHosts: [] }))[0].detail).toBe('no network found');
  });
});

describe('linked phones', () => {
  const now = new Date(2026, 9, 4, 9, 30).getTime();
  it('formats when a phone was linked and last seen', () => {
    expect(dayTime(new Date(2026, 9, 4, 9, 12).toISOString(), now)).toBe('today 09:12');
    expect(dayTime(new Date(2026, 9, 3, 18, 40).toISOString(), now)).toBe('yesterday 18:40');
    expect(dayTime(new Date(2026, 8, 28, 8, 0).toISOString(), now)).toBe('28 Sep');
    expect(dayTime(new Date(2025, 8, 28, 8, 0).toISOString(), now)).toBe('28 Sep 2025');
    expect(ago(new Date(now - 2 * 60_000).toISOString(), now)).toBe('2 min ago');
    expect(ago(new Date(now - 20_000).toISOString(), now)).toBe('just now');
    expect(ago(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe('3 h ago');
    expect(ago(new Date(now - 50 * 3_600_000).toISOString(), now)).toBe('2 days ago');
  });

  it('builds the row line', () => {
    const d = { id: 'd1', name: 'Pixel 8 · Wayne', createdAt: new Date(2026, 9, 4, 9, 12).toISOString(), lastSeenAt: new Date(now - 120_000).toISOString(), online: false };
    expect(deviceLine(d, now)).toBe('Linked today 09:12 · last seen 2 min ago');
    expect(deviceLine({ ...d, online: true }, now)).toBe('Linked today 09:12 · online now');
    expect(deviceLine({ ...d, lastSeenAt: null }, now)).toBe('Linked today 09:12 · not seen yet');
  });

  it('says where test notifications go', () => {
    const d = (name: string) => ({ id: name, name, createdAt: '2026-10-04T09:00:00Z' });
    expect(sendTarget([])).toMatch(/No phone linked/);
    expect(sendTarget([d('Pixel 8 · Wayne')])).toBe("Goes to Pixel 8 · Wayne. Follows the phone's Do Not Disturb.");
    expect(sendTarget([d('A'), d('B'), d('C')])).toBe("Goes to A and 2 more phones. Follows the phone's Do Not Disturb.");
  });
});

describe('send prefs and tabs', () => {
  it('changes one toggle and keeps the rest', () => {
    const p = { notify: { review: true, question: true, blocked: true, usage: false, stuck: false }, quiet: { on: true, from: '22:00', to: '07:00' } };
    expect(withNotify(p, 'usage', true)).toEqual({ ...p, notify: { ...p.notify, usage: true } });
    expect(withNotify(null, 'review', false).notify).toEqual({ review: false, question: true, blocked: true, usage: false, stuck: false });
  });

  it('parses the tab from the URL', () => {
    expect(parseSettingsTab('phone')).toBe('phone');
    expect(parseSettingsTab('usage')).toBe('usage');
    expect(parseSettingsTab(null)).toBe('general');
    expect(parseSettingsTab('bogus')).toBe('general');
  });
});

describe('shortFingerprint', () => {
  it('shows the first 8 hex characters in two groups, as the phone does', () => {
    expect(shortFingerprint('3f9a21c0deadbeef')).toBe('3F9A 21C0');
    expect(shortFingerprint('3F:9A:21:C0:00')).toBe('3F9A 21C0');
    expect(shortFingerprint(undefined)).toBe('');
  });
});
