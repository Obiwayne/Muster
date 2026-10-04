// Entry: node dist/orchestrator/index.js --repo <root> [--port <n>]
import { parseArgs } from 'node:util';
import { findRepoRoot } from '../core/paths.js';
import { startOrchestrator } from './server.js';

const { values } = parseArgs({ options: { repo: { type: 'string' }, port: { type: 'string' } } });
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

async function main(): Promise<void> {
  const repoRoot = values.repo ?? findRepoRoot();
  const orchestrator = await startOrchestrator({
    repoRoot,
    port: values.port ? Number(values.port) : undefined,
    log,
    registerPhone: true,
    onShutdown: () => process.exit(0),
  });
  const stop = (signal: string) => {
    log(`received ${signal}`);
    void orchestrator.shutdown().finally(() => process.exit(0));
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
