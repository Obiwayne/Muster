// git reference-transaction hook body: `node dist/hooks/ref-hook.js <state> <repoRoot>`, ref updates on stdin.
// Run by the sh wrapper core/refguard.ts installs, only when MUSTER_AGENT is set. Exits 1 to abort
// the transaction. Fails closed: if anything here throws for an agent, the update is refused.
import { resolve } from 'node:path';
import { configuredBaseBranch, knownAgents, parseRefUpdates, refViolation } from '../core/refguard.js';

function readAll(): Promise<string> {
  return new Promise((ok) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => ok(data));
    process.stdin.on('error', () => ok(data));
  });
}

const norm = (p: string) => {
  const r = resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

async function main(): Promise<number> {
  const [state, repo] = process.argv.slice(2);
  const input = await readAll();
  const agent = process.env.MUSTER_AGENT;
  if (state !== 'prepared' || !agent || !repo) return 0;
  // An agent running git in some other repository (e.g. tests that make temp repos) is not our business.
  if (process.env.MUSTER_REPO && norm(process.env.MUSTER_REPO) !== norm(repo)) return 0;
  const why = refViolation(parseRefUpdates(input), { agent, baseBranch: configuredBaseBranch(repo), agents: knownAgents(repo) });
  if (!why) return 0;
  process.stderr.write(why + '\n');
  return 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`Muster ref guard failed: ${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  },
);
