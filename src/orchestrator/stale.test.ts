import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HUMAN, SYSTEM } from '../core/board.js';
import { staleServer } from '../cli/context.js';
import { tempRepo } from '../core/testutil.js';
import { startOrchestrator, type Orchestrator } from './server.js';

let repo: string;
let orch: Orchestrator;
let disk = 1_000_000;

beforeAll(async () => {
  process.env.MUSTER_NO_NOTIFY = '1';
  repo = tempRepo();
  const ui = mkdtempSync(join(tmpdir(), 'muster-ui-'));
  writeFileSync(join(ui, 'index.html'), '<html></html>');
  mkdirSync(join(repo, '.muster'), { recursive: true });
  writeFileSync(join(repo, '.muster', 'config.json'), '{}');
  orch = await startOrchestrator({ repoRoot: repo, port: 0, uiDir: ui, autoStart: false, log: () => {}, buildStamp: () => disk, buildCheckMs: 20 });
});
afterAll(async () => {
  await orch?.shutdown();
  rmSync(repo, { recursive: true, force: true });
});

const staleNotes = () => orch.store.state.notes.filter((n) => n.from === SYSTEM && /older build/.test(n.text));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('stale build warning', () => {
  it('reports the loaded build on /api/health', async () => {
    const health = await (await fetch(orch.url + '/api/health')).json();
    expect(health.build).toBe(1_000_000);
  });

  it('stays quiet while the build on disk is the one it started with', async () => {
    await wait(80);
    expect(staleNotes()).toHaveLength(0);
    expect(await staleServer(orch.url, 1_000_000)).toBeNull();
  });

  it('puts one open note on "Needs you" after a rebuild', async () => {
    disk = 2_000_000;
    await wait(80);
    disk = 3_000_000; // a second rebuild doesn't add another note
    await wait(80);
    const notes = staleNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ to: HUMAN, open: true, type: 'system' });
    expect(notes[0].text).toMatch(/muster down.*muster up/);
  });

  it('lets the CLI spot it too', async () => {
    expect(await staleServer(orch.url, 2_000_000)).toMatch(/older build.*muster down/);
  });
});
