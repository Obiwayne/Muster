import { describe, expect, it } from 'vitest';
import { at, fakeNote, fakeState, fakeTask } from './testfakes.js';
import { DEFAULT_PREFS, clonePrefs, inQuietHours, mergePrefs, needsFromState, shouldNotify, type NeedItem } from './needs.js';
import { CODE_ALPHABET, displayCode, normalizeCode, Pairing } from './pairing.js';
import { hostsFor, isTailscaleIp, lanHosts, parseTailscaleStatus } from './net.js';
import { parseDiffStat } from './gateway.js';

describe('needs mapping', () => {
  const tasks = [
    fakeTask('T1', { evidence: [{ id: 'E1', station: 'build', by: 'ada', at, summary: 's', files: [{ name: 'shot.png', kind: 'image', bytes: 10 }, { name: 'log.txt', kind: 'text', bytes: 5 }] }] }),
    fakeTask('T2', { mergeApproval: { at } }),
    fakeTask('T3', { status: 'awaiting_approval' }),
    fakeTask('T4', { status: 'in_progress' }),
  ];
  const notes = [
    fakeNote('N1', { type: 'review', from: 'captain', to: undefined, taskId: 'T1', text: 'Looks good: the login form works.\nDetails follow' }),
    fakeNote('N2', { type: 'review', from: 'captain', to: undefined, taskId: 'T2' }), // already approved: waits on the Captain
    fakeNote('N3', { type: 'approval', from: 'muster', to: undefined, taskId: 'T3' }),
    fakeNote('N4', { type: 'escalation', from: 'captain' }),
    fakeNote('N5', { type: 'question', from: 'bea' }),
    fakeNote('N6', { type: 'system', from: 'muster', topic: 'checkout', taskId: 'T4' }),
    fakeNote('N7', { type: 'system', from: 'muster', topic: 'weekly_usage' }),
    fakeNote('N8', { type: 'question', to: 'captain' }), // not for you
    fakeNote('N9', { type: 'question', dismissed: true }),
    fakeNote('N10', { type: 'question', open: false }),
    fakeNote('N11', { type: 'system', from: 'muster', topic: 'stale_build' }),
    fakeNote('N12', { type: 'review', from: 'captain', to: undefined, taskId: 'T4' }), // back in work
    fakeNote('N13', { type: 'stuck', from: 'ada' }),
  ];
  const items = needsFromState(fakeState(notes, tasks), 'p1', 'Proj');
  const byNote = (id: string) => items.find((i) => i.noteId === id);

  it('maps each needs-you note to its kind and actions', () => {
    expect(items.map((i) => i.noteId).sort()).toEqual(['N1', 'N13', 'N3', 'N4', 'N5', 'N6', 'N7']);
    expect(byNote('N1')).toMatchObject({ id: 'p1:N1', projectId: 'p1', projectName: 'Proj', kind: 'review', taskId: 'T1', title: 'Task T1', summary: 'Looks good: the login form works.', from: 'captain', actions: ['approve', 'open'] });
    expect(byNote('N3')).toMatchObject({ kind: 'approval', actions: ['approve', 'open'] });
    expect(byNote('N4')).toMatchObject({ kind: 'escalation', actions: ['answer', 'open'] });
    expect(byNote('N5')).toMatchObject({ kind: 'question', actions: ['answer', 'open'] });
    expect(byNote('N6')).toMatchObject({ kind: 'blocked', actions: ['commit', 'stash'], taskId: 'T4' });
    expect(byNote('N7')).toMatchObject({ kind: 'usage' });
    expect(byNote('N13')).toMatchObject({ kind: 'stuck' });
  });

  it('carries the latest evidence with image thumbnails', () => {
    expect(byNote('N1')!.evidence).toEqual({ id: 'E1', files: 2, thumbs: ['/api/projects/p1/tasks/T1/evidence/E1/shot.png'] });
  });

  it('trims the summary to 140 characters', () => {
    const [item] = needsFromState(fakeState([fakeNote('N1', { text: 'x'.repeat(300) })]), 'p', 'P');
    expect(item.summary.length).toBe(140);
  });
});

describe('prefs and quiet hours', () => {
  const item = (kind: NeedItem['kind'], projectId = 'p1'): NeedItem => ({ id: `${projectId}:N1`, projectId, projectName: 'P', kind, title: '', summary: '', from: 'x', createdAt: at, actions: [] });
  const noon = new Date(2026, 9, 4, 12, 0);
  const night = new Date(2026, 9, 4, 23, 30);
  const early = new Date(2026, 9, 4, 6, 59);
  const morning = new Date(2026, 9, 4, 7, 0);

  it('quiet hours wrap midnight', () => {
    const q = DEFAULT_PREFS.quiet;
    expect([noon, night, early, morning].map((d) => inQuietHours(q, d))).toEqual([false, true, true, false]);
    expect(inQuietHours({ on: true, from: '09:00', to: '17:00' }, noon)).toBe(true);
    expect(inQuietHours({ ...q, on: false }, night)).toBe(false);
  });

  it('default prefs: review/question/blocked on, usage/stuck off', () => {
    const p = DEFAULT_PREFS;
    expect(['review', 'approval', 'question', 'escalation', 'blocked', 'usage', 'stuck'].map((k) => shouldNotify(item(k as NeedItem['kind']), p, noon))).toEqual([true, true, true, true, true, false, false]);
  });

  it('only blocked notifies during quiet hours', () => {
    expect(shouldNotify(item('review'), DEFAULT_PREFS, night)).toBe(false);
    expect(shouldNotify(item('blocked'), DEFAULT_PREFS, night)).toBe(true);
  });

  it('a project switched off never notifies', () => {
    const p = mergePrefs(DEFAULT_PREFS, { projects: { p1: false } });
    expect(shouldNotify(item('blocked', 'p1'), p, noon)).toBe(false);
    expect(shouldNotify(item('blocked', 'p2'), p, noon)).toBe(true);
  });

  it('merges partial prefs and rejects bad ones', () => {
    const p = mergePrefs(clonePrefs(DEFAULT_PREFS), { notify: { usage: true }, quiet: { from: '23:15' } });
    expect(p.notify).toEqual({ review: true, question: true, blocked: true, usage: true, stuck: false });
    expect(p.quiet).toEqual({ on: true, from: '23:15', to: '07:00' });
    expect(DEFAULT_PREFS.notify.usage).toBe(false); // untouched
    expect(() => mergePrefs(p, { quiet: { from: '25:00' } })).toThrow(/time/);
    expect(() => mergePrefs(p, { notify: { review: 'yes' } })).toThrow();
    expect(() => mergePrefs(p, { notify: { nope: true } })).toThrow(/Unknown/);
    expect(() => mergePrefs(p, { color: 'red' })).toThrow(/Unknown/);
  });
});

describe('pairing codes', () => {
  it('6 characters from the alphabet, shown as XXX-XXX', () => {
    const { code } = new Pairing().issue();
    expect(code).toMatch(new RegExp(`^[${CODE_ALPHABET}]{6}$`));
    expect(displayCode('K7M4QX')).toBe('K7M-4QX');
    expect(normalizeCode('k7m-4qx')).toBe('K7M4QX');
  });

  it('single use, expires after 2 minutes, a new code replaces the old', () => {
    let t = 0;
    const p = new Pairing(() => t);
    const a = p.issue().code;
    expect(p.redeem(displayCode(a).toLowerCase())).toBe('ok');
    expect(p.redeem(a)).toBe('wrong');
    const b = p.issue().code;
    const c = p.issue().code;
    if (b !== c) expect(p.redeem(b)).toBe('wrong');
    t += 2 * 60_000 + 1;
    expect(p.redeem(c)).toBe('expired');
  });

  it('5 wrong codes in a minute lock it', () => {
    let t = 0;
    const p = new Pairing(() => t);
    const code = p.issue().code;
    for (let i = 0; i < 5; i++) expect(p.redeem('AAAAAA' === code ? 'BBBBBB' : 'AAAAAA')).toBe('wrong');
    expect(p.redeem(code)).toBe('limited');
    t += 60_001;
    expect(p.redeem(code)).toBe('ok');
  });
});

describe('network', () => {
  it('lists LAN IPv4 addresses, skipping virtual adapters, link-local and Tailscale', () => {
    const a = (address: string, extra = {}) => ({ address, family: 'IPv4' as const, internal: false, netmask: '', mac: '', cidr: null, ...extra });
    const hosts = lanHosts({
      'Ethernet': [a('10.0.0.5'), { ...a('fe80::1'), family: 'IPv6' as const, scopeid: 0 }],
      'Wi-Fi': [a('192.168.1.20')],
      'vEthernet (WSL)': [a('172.20.0.1')],
      'Loopback Pseudo-Interface 1': [a('127.0.0.1', { internal: true })],
      'Tailscale': [a('100.101.102.103')],
      'Ethernet 3': [a('169.254.3.4'), a('100.70.1.2')],
    });
    expect(hosts).toEqual(['192.168.1.20', '10.0.0.5']);
  });

  it('reads tailscale status --json', () => {
    const info = parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: ['100.101.102.103', 'fd7a::1'], DNSName: 'wayne-pc.tail1234.ts.net.' } }));
    expect(info).toEqual({ installed: true, ip: '100.101.102.103', dnsName: 'wayne-pc.tail1234.ts.net', online: true });
    expect(isTailscaleIp('100.64.0.1')).toBe(true);
    expect(isTailscaleIp('100.128.0.1')).toBe(false);
    expect(hostsFor('lan', ['192.168.1.20'], info)).toEqual(['192.168.1.20']);
    expect(hostsFor('tailscale', ['192.168.1.20'], info)).toEqual(['192.168.1.20', '100.101.102.103', 'wayne-pc.tail1234.ts.net']);
  });

  it('parses git diff --stat', () => {
    expect(parseDiffStat(' a.ts | 3 ++-\n 2 files changed, 10 insertions(+), 2 deletions(-)\n')).toEqual({ files: 2, added: 10, removed: 2 });
    expect(parseDiffStat(' 1 file changed, 1 deletion(-)')).toEqual({ files: 1, added: 0, removed: 1 });
    expect(parseDiffStat('')).toBeNull();
  });
});
