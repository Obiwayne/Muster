// Tokens: the human token (kept outside every repo worktree) and per-agent tokens.
//
// The human token grants "you" (merge, config, shutdown, typing into terminals). It is written only to
// %LOCALAPPDATA%/muster/<hash-of-repo>/token (posix: ~/.muster/<hash>/token), which the agents' guard
// hook refuses to read. `.muster/server.json` holds just the port and pid.
//
// Agent tokens are HMAC(agentSecret, agentId): unforgeable without the secret, which never leaves the
// orchestrator's memory, so each agent's token (in its mcp.json and PTY env) only proves that agent.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const newSecret = (): string => randomBytes(16).toString('hex');

/** Base folder for every repo's human token. MUSTER_SECRETS_DIR overrides it (tests). */
export function secretsBase(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.MUSTER_SECRETS_DIR) return resolve(env.MUSTER_SECRETS_DIR);
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'muster');
  return join(homedir(), '.muster');
}

function repoKey(repoRoot: string, platform = process.platform): string {
  let p = resolve(repoRoot).replace(/\\/g, '/').replace(/\/+$/, '');
  if (platform === 'win32') p = p.toLowerCase();
  return createHash('sha256').update(p).digest('hex').slice(0, 16);
}

export function humanTokenDir(repoRoot: string): string {
  return join(secretsBase(), repoKey(repoRoot));
}

export function humanTokenFile(repoRoot: string): string {
  return join(humanTokenDir(repoRoot), 'token');
}

export function writeHumanToken(repoRoot: string, token: string): string {
  const dir = humanTokenDir(repoRoot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'token');
  writeFileSync(file, token, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows: ACLs of %LOCALAPPDATA% already limit it to the user */
  }
  writeFileSync(join(dir, 'repo'), resolve(repoRoot)); // which repo this hash belongs to (for humans poking around)
  return file;
}

export function readHumanToken(repoRoot: string): string | null {
  const file = humanTokenFile(repoRoot);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function removeHumanToken(repoRoot: string, token: string): void {
  // Only remove our own token: a second orchestrator may have replaced it.
  if (readHumanToken(repoRoot) === token) rmSync(humanTokenFile(repoRoot), { force: true });
}

export function deriveAgentToken(secret: string, agentId: string): string {
  return createHmac('sha256', secret).update(`muster-agent:${agentId}`).digest('hex').slice(0, 40);
}

export function sameToken(a: string | undefined | null, b: string): boolean {
  if (typeof a !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
