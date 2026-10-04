// Where a phone can reach this PC: LAN IPv4 addresses, and Tailscale (IP in 100.64.0.0/10 + MagicDNS name).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';

export interface TailscaleInfo {
  installed: boolean;
  ip: string | null;
  dnsName: string | null;
  online: boolean;
}

/** Adapters a phone can't reach: Hyper-V / WSL / Docker switches, VM host-only networks, VPN tunnels. */
const VIRTUAL = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|vmnet|vboxnet|docker|br-|veth|virbr|Loopback|Tailscale|ZeroTier|utun|tun\d|tap\d|Npcap|Bluetooth/i;

const octets = (ip: string): number[] => ip.split('.').map(Number);

export function isTailscaleIp(ip: string): boolean {
  const [a, b] = octets(ip);
  return a === 100 && b >= 64 && b <= 127; // 100.64.0.0/10
}

const isPrivate = (ip: string): boolean => {
  const [a, b] = octets(ip);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
};

const rank = (ip: string): number => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : isPrivate(ip) ? 2 : 3);

/** The PC's LAN IPv4 addresses, home-network ranges first. */
export function lanHosts(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.') || isTailscaleIp(a.address)) continue;
      if (!out.includes(a.address)) out.push(a.address);
    }
  }
  return out.sort((x, y) => rank(x) - rank(y));
}

function tailscaleCli(): string | null {
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      const exe = base ? join(base, 'Tailscale', 'tailscale.exe') : '';
      if (exe && existsSync(exe)) return exe;
    }
  }
  return 'tailscale'; // on PATH, if installed at all
}

const run = (file: string, args: string[]): Promise<string | null> =>
  new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: 4000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
    } catch {
      resolve(null);
    }
  });

/** Parses `tailscale status --json`. */
export function parseTailscaleStatus(json: string): TailscaleInfo {
  try {
    const s = JSON.parse(json) as { BackendState?: string; Self?: { TailscaleIPs?: string[]; DNSName?: string; Online?: boolean } };
    const ip = s.Self?.TailscaleIPs?.find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x) && isTailscaleIp(x)) ?? null;
    const dnsName = s.Self?.DNSName ? s.Self.DNSName.replace(/\.$/, '') || null : null;
    return { installed: true, ip, dnsName, online: s.BackendState === 'Running' };
  } catch {
    return { installed: true, ip: null, dnsName: null, online: false };
  }
}

let cached: { at: number; info: TailscaleInfo } | undefined;

/** Tailscale through its CLI when present (cached 30 s); else a 100.64.0.0/10 address on any adapter. */
export async function tailscaleInfo(): Promise<TailscaleInfo> {
  if (cached && Date.now() - cached.at < 30_000) return cached.info;
  const cli = tailscaleCli();
  const out = cli ? await run(cli, ['status', '--json']) : null;
  let info: TailscaleInfo;
  if (out) info = parseTailscaleStatus(out);
  else {
    const ip = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && isTailscaleIp(a.address))?.address ?? null;
    info = { installed: ip !== null, ip, dnsName: null, online: ip !== null };
  }
  cached = { at: Date.now(), info };
  return info;
}

/** Hosts for the pairing QR code and the pair response: LAN first, then Tailscale in tailscale mode. */
export function hostsFor(mode: 'lan' | 'tailscale', lan: string[], ts: TailscaleInfo): string[] {
  const out = [...lan];
  if (mode === 'tailscale') {
    if (ts.ip) out.push(ts.ip);
    if (ts.dnsName) out.push(ts.dnsName);
  }
  return out;
}
