// `muster recycle`: give the Captain a fresh session. With Muster up, the Captain writes its handoff at its next rest and
// is restarted. With Muster down, the handoff is written here from the board and the old session's last message (no
// turn on the old, big context), and the Captain starts its new session from it on the next `muster up`.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { captainOf } from '../core/board.js';
import { boardHandoff, markReload, saveHandoff } from '../core/handoff.js';
import { musterPaths } from '../core/paths.js';
import { Store } from '../core/store.js';
import { addCounts, formatTokens, lastAssistantText, totalTokens, transcriptPath, transcriptUsage } from '../core/transcript.js';
import { api, CliError, healthy, readServerFile, repoRoot, type Ctx } from './context.js';

export async function recycle(ctx: Ctx, home = homedir()): Promise<void> {
  const root = repoRoot(ctx);
  const server = readServerFile(root);
  if (server && (await healthy(`http://127.0.0.1:${server.port}`))) {
    await api(ctx, '/api/captain/recycle', { body: { actor: 'you' } });
    ctx.out('The Captain writes its handoff at its next rest, then starts a fresh session.');
    return;
  }
  const paths = musterPaths(root);
  if (!existsSync(paths.state)) throw new CliError('No Muster state in this repo yet; there is no Captain to recycle.');
  const store = new Store(paths);
  const state = store.state;
  const captain = captainOf(state);
  if (!captain) throw new CliError('This project has no Captain.');

  const file = transcriptPath(home, captain.worktree, captain.sessionId);
  const jsonl = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const usage = jsonl ? transcriptUsage(jsonl) : undefined;
  const last = jsonl ? lastAssistantText(jsonl) : undefined;
  const text = [boardHandoff(state), last ? `The previous Captain's last message:\n${last.slice(-2500)}` : ''].filter(Boolean).join('\n\n');
  saveHandoff(paths, 'muster', text.slice(0, 8000));

  captain.pastTokens = addCounts(captain.pastTokens, usage?.totals ?? captain.sessionTokens);
  captain.sessionTokens = undefined;
  captain.contextTokens = undefined;
  captain.contextAt = undefined;
  const old = captain.sessionId;
  captain.sessionId = randomUUID();
  rmSync(join(paths.agentDir(captain.id), 'resumable'), { force: true });
  markReload(paths);
  store.commit();
  ctx.out(`Recycled ${captain.id}: session ${old.slice(0, 8)} (${usage ? `${formatTokens(usage.context)} context, ${formatTokens(totalTokens(usage.totals))} tokens used` : 'no transcript found'}) is left behind.`);
  ctx.out('Handoff written from the board. The Captain starts a fresh session from it on the next `muster up`.');
}
