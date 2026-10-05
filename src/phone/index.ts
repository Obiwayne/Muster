// Entry: node dist/phone/index.js [--port <n>] [--remote-port <n>]  — the phone gateway (one per PC; see docs/PHONE.md).
// Exits quietly when a live gateway already holds the state folder or the port.
import { parseArgs } from 'node:util';
import { startGateway } from './gateway.js';
import { gatewayRunning } from './link.js';
import type { Tunnel } from './remote.js';
import { DEFAULT_PHONE_PORT, ensureRemoteDevToken, phoneDir } from './store.js';

const { values } = parseArgs({ options: { port: { type: 'string' }, 'remote-port': { type: 'string' } } });
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

async function main(): Promise<void> {
  const dir = phoneDir();
  const live = await gatewayRunning(dir);
  if (live && live.pid !== process.pid) {
    log(`a phone gateway is already running (pid ${live.pid}, port ${live.port}); exiting`);
    process.exit(0);
  }
  const port = values.port ? Number(values.port) : process.env.MUSTER_PHONE_PORT ? Number(process.env.MUSTER_PHONE_PORT) : DEFAULT_PHONE_PORT;
  let gateway;
  try {
    // Remote connector (docs/REMOTE.md): normally switched on in Settings → Remote access (saved in state.json).
    // These only seed it on a PC where it was never configured: --remote-port or MUSTER_REMOTE_PORT;
    // MUSTER_REMOTE_HOST = the tunnel's public hostname; MUSTER_REMOTE_DEV=1 also accepts the fixed dev token.
    const remotePort = values['remote-port'] ?? process.env.MUSTER_REMOTE_PORT;
    const devToken = process.env.MUSTER_REMOTE_DEV === '1' ? ensureRemoteDevToken(dir) : undefined;
    // MUSTER_REMOTE_TUNNEL=cloudflare|tailscale says whose client-IP header the audit log may trust.
    const t = process.env.MUSTER_REMOTE_TUNNEL;
    const tunnel: Tunnel | undefined = t === 'cloudflare' || t === 'tailscale' ? t : undefined;
    if (t && !tunnel) log(`MUSTER_REMOTE_TUNNEL="${t}" is not cloudflare or tailscale; client IPs will not be read from headers`);
    const remote = remotePort ? { port: Number(remotePort), publicHost: process.env.MUSTER_REMOTE_HOST, tunnel, devToken } : undefined;
    gateway = await startGateway({ dir, port, log, remote });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      log(`port ${port} is in use (another phone gateway is starting, or another program holds it); exiting`);
      process.exit(0);
    }
    throw e;
  }
  const stop = (signal: string) => {
    log(`received ${signal}`);
    void gateway.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGBREAK', () => stop('SIGBREAK'));
}

process.on('uncaughtException', (e) => log(`uncaught: ${e.stack ?? e}`));
process.on('unhandledRejection', (e) => log(`unhandled rejection: ${e instanceof Error ? e.stack : e}`));

main().catch((e) => {
  log(`failed to start: ${e instanceof Error ? e.stack : e}`);
  process.exit(1);
});
