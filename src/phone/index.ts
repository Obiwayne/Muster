// Entry: node dist/phone/index.js [--port <n>]  — the phone gateway (one per PC; see docs/PHONE.md).
// Exits quietly when a live gateway already holds the state folder or the port.
import { parseArgs } from 'node:util';
import { startGateway } from './gateway.js';
import { gatewayRunning } from './link.js';
import { DEFAULT_PHONE_PORT, phoneDir } from './store.js';

const { values } = parseArgs({ options: { port: { type: 'string' } } });
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
    gateway = await startGateway({ dir, port, log });
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
