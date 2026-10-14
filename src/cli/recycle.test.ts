import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { latestHandoff, takeReload } from '../core/handoff.js';
import { ensureDirs, musterPaths } from '../core/paths.js';
import { Store } from '../core/store.js';
import { createTask } from '../core/tasks.js';
import { makeAgent, tempRepo } from '../core/testutil.js';
import { transcriptPath } from '../core/transcript.js';
import { DEFAULT_CONFIG } from '../types.js';
import type { Ctx } from './context.js';
import { colors } from './format.js';
import { recycle } from './recycle.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe('muster recycle (Muster down)', () => {
  it('writes the handoff from the board and the last message, and moves the Captain to a new session', async () => {
    const repo = tempRepo();
    const home = mkdtempSync(join(tmpdir(), 'muster-home-'));
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }), () => rmSync(home, { recursive: true, force: true }));
    const paths = musterPaths(repo);
    ensureDirs(paths);
    const store = new Store(paths);
    const captain = makeAgent('captain', 'captain', { worktree: repo, sessionId: 'old-session' });
    store.state.agents.push(captain);
    createTask(store.state, DEFAULT_CONFIG, { title: 'Invite API', actor: 'you' });
    store.commit();
    mkdirSync(paths.agentDir('captain'), { recursive: true });
    writeFileSync(join(paths.agentDir('captain'), 'resumable'), 'old-session');
    const file = transcriptPath(home, repo, 'old-session');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 5, cache_read_input_tokens: 500_000, output_tokens: 10 }, content: [{ type: 'text', text: 'T1 is next; waiting on Obi for the logo.' }] } }) + '\n');

    const out: string[] = [];
    const ctx: Ctx = { cwd: repo, repoRoot: repo, out: (s) => out.push(s), c: colors(false), now: () => new Date(), openUrl() {} };
    await recycle(ctx, home);

    const after = new Store(paths).state.agents.find((a) => a.id === 'captain')!;
    expect(after.sessionId).not.toBe('old-session');
    expect(after.pastTokens?.cacheRead).toBe(500_000);
    expect(existsSync(join(paths.agentDir('captain'), 'resumable'))).toBe(false);
    const h = latestHandoff(paths)!;
    expect(h.text).toContain('Invite API');
    expect(h.text).toContain('waiting on Obi for the logo');
    expect(takeReload(paths)).toBe(true);
    expect(takeReload(paths)).toBe(false);
    expect(out.join('\n')).toContain('500k context');
  });
});
