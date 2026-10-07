// Media's social routes through the HTTP API: research (Refresh vs herald's save), Vellum post images, conversations
// and replies, and posting through your Chrome with the board note and the wait for your Post.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MediaConversation, MediaPiece, MediaPublishJob, MediaSummary, MusterState, Task } from '../types.js';
import { tempRepo } from '../core/testutil.js';
import { startOrchestrator, type Orchestrator } from './server.js';
import type { PtyLauncher, PtyProcess } from './terminal.js';

const typed: string[] = [];
const launchArgs: string[][] = [];
class FakePty implements PtyProcess {
  static nextPid = 9500;
  pid = FakePty.nextPid++;
  private exitCbs: ((e: { exitCode: number }) => void)[] = [];
  onData() {}
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCbs.push(cb);
  }
  write(data: string) {
    typed.push(data);
  }
  resize() {}
  kill() {
    setImmediate(() => this.exitCbs.splice(0).forEach((cb) => cb({ exitCode: 1 })));
  }
}
const launcher: PtyLauncher = (_file, args) => {
  launchArgs.push(args);
  return new FakePty();
};

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

let repo: string;
let orch: Orchestrator;
let task: Task;

async function call<T = any>(actor: string, method: string, path: string, body: Record<string, unknown> = {}): Promise<{ status: number; data: T; raw: Buffer }> {
  const token = actor === 'you' ? orch.token : orch.agentToken(actor);
  const res = await fetch(orch.url + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-muster-token': token },
    body: method === 'GET' ? undefined : JSON.stringify({ actor, ...body }),
  });
  const raw = Buffer.from(await res.arrayBuffer());
  let data: any = null;
  try {
    data = raw.length ? JSON.parse(raw.toString('utf8')) : null;
  } catch {
    data = null;
  }
  return { status: res.status, data, raw };
}
async function ok<T = any>(actor: string, method: string, path: string, body?: Record<string, unknown>): Promise<T> {
  const r = await call<T>(actor, method, path, body);
  if (r.status !== 200) throw new Error(`${actor} ${method} ${path} → ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
const state = () => orch.store.state as MusterState;
const piece = (id: string) => orch.media.store.pieces.find((p) => p.id === id)!;
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out: ${check.toString().slice(0, 120)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeAll(async () => {
  process.env.MUSTER_NO_NOTIFY = '1';
  repo = tempRepo();
  const ui = mkdtempSync(join(tmpdir(), 'muster-ui-'));
  writeFileSync(join(ui, 'index.html'), '<html></html>');
  mkdirSync(join(repo, '.muster'), { recursive: true });
  writeFileSync(
    join(repo, '.muster', 'config.json'),
    JSON.stringify({ lines: { feature: { label: 'Feature', stations: ['build'] } }, claudePath: 'C:/fake/claude.exe', maxCrew: 1, projectName: 'wall', vellumFile: 'F9', vellum: { command: 'node', args: ['vellum-mcp.js'] } }),
  );
  orch = await startOrchestrator({
    repoRoot: repo,
    port: 0,
    launcher,
    uiDir: ui,
    log: () => {},
    timings: { enterDelayMs: 1, firstPromptDelayMs: 1, nudgeDebounceMs: 10, scoutStopDelayMs: 20, stopConfirmMs: 200 },
  });
  task = await ok<Task>('you', 'POST', '/api/tasks', { title: 'Approval queue' });
});

afterAll(async () => {
  await orch?.shutdown();
  rmSync(repo, { recursive: true, force: true });
});

describe('media social API', () => {
  it('a social draft: herald runs with --chrome and Vellum (export root .muster/media); research first, then a draft with hashtags', async () => {
    const p = await ok<MediaPiece>('you', 'POST', '/api/media/pieces', { kind: 'social', about: [{ kind: 'task', ref: task.id }], platforms: ['x', 'linkedin'] });
    await until(() => piece(p.id).status === 'drafting' && launchArgs.length > 0);
    expect(launchArgs.at(-1)).toContain('--chrome');
    const mcp = JSON.parse(readFileSync(join(repo, '.muster', 'agents', 'herald', 'mcp.json'), 'utf8'));
    expect(mcp.mcpServers.vellum).toMatchObject({ command: 'node', env: { VELLUM_EXPORT_ROOTS: join(repo, '.muster', 'media') } });
    const brief = (await ok<{ text: string }>('herald', 'GET', '/api/media/brief')).text;
    expect(brief).toContain('## Research steps');
    expect(brief).toContain('https://x.com/search?q=');
    expect(brief).toContain('Post images: Vellum file F9');
    expect((await call('you', 'POST', `/api/media/pieces/${p.id}/research`)).status).toBe(409); // drafting
    await ok('herald', 'POST', `/api/media/pieces/${p.id}/research`, { platforms: ['x'], query: ['class wall'], read: { posts: 12, articles: 2 }, themes: [{ text: 'Worry about live posts', count: 7 }], hashtags: [{ tag: 'edtech', platforms: ['x', 'linkedin'] }] });
    expect(piece(p.id).research).toMatchObject({ read: { posts: 12, articles: 2 } });
    expect((await ok<{ text: string }>('herald', 'GET', '/api/media/brief')).text).toContain('## Reply rules');
    await ok('herald', 'POST', `/api/media/pieces/${p.id}/draft`, { posts: [{ platform: 'x', versions: ['Approve first.'], hashtags: ['edtech'] }, { platform: 'linkedin', versions: ['Longer.'], hashtags: ['edtech', 'teachers', 'classroom'] }] });
    await ok('herald', 'POST', `/api/media/pieces/${p.id}/finish`);
    await ok('you', 'POST', `/api/media/pieces/${p.id}/approve`);
  });

  it('post images: 409 without Vellum, herald attaches exported PNGs, the PNG is served', async () => {
    const id = 'MP1';
    expect((await call('herald', 'POST', `/api/media/pieces/${id}/design`, { style: 'headline' })).status).toBe(403);
    await ok('you', 'POST', `/api/media/pieces/${id}/design`, { style: 'headline', platforms: ['x'] });
    await until(() => orch.media.store.current?.kind === 'design');
    const brief = (await ok<{ text: string }>('herald', 'GET', '/api/media/brief')).text;
    expect(brief).toContain('# Make post images for MP1');
    const dir = join(repo, '.muster', 'media', id, 'images');
    expect(brief).toContain(`outputDir "${dir}"`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'MP1 x.png'), png(1600, 900));
    expect((await call('herald', 'POST', `/api/media/pieces/${id}/designs`, { designs: [{ platform: 'x', file: 'missing.png', caption: 'c' }] })).status).toBe(400);
    const p = await ok<MediaPiece>('herald', 'POST', `/api/media/pieces/${id}/designs`, { designs: [{ platform: 'x', file: 'MP1 x.png', caption: 'See every post first', vellum: { fileId: 'F9', nodeId: '3-0' } }] });
    expect(p.designs).toMatchObject([{ id: 'D1', platform: 'x', width: 1600, height: 900 }]);
    const served = await call('you', 'GET', `/api/media/pieces/${id}/designs/${encodeURIComponent('MP1 x.png')}`);
    expect(served.status).toBe(200);
    expect(served.raw.subarray(1, 4).toString()).toBe('PNG');
    expect((await call('you', 'GET', `/api/media/pieces/${id}/designs/nope.png`)).status).toBe(404);
  });

  it('posting: a ready note, the wait answers go, done marks the piece used; the design is the X image', async () => {
    const { jobs } = await ok<{ jobs: MediaPublishJob[] }>('you', 'POST', '/api/media/publish', { pieceId: 'MP1', platforms: ['x'] });
    expect(jobs[0]).toMatchObject({ id: 'PJ1', platform: 'x', text: 'Approve first.\n\n#edtech', images: [join(repo, '.muster', 'media', 'MP1', 'images', 'MP1 x.png')] });
    expect((await call('herald', 'POST', '/api/media/publish', { pieceId: 'MP1', platforms: ['x'] })).status).toBe(403);
    await until(() => orch.media.store.current?.kind === 'publish');
    // herald may have been stopped after the image work and started afresh: its first prompt waits for session-start.
    await until(() => orch.agents.isRunning('herald'));
    await ok('herald', 'POST', '/api/agents/herald/event', { event: 'session-start' });
    await until(() => typed.some((t) => t.includes('Put post PJ1 into X: call media_brief and start.')));
    const next = await ok<{ job: MediaPublishJob }>('herald', 'POST', '/api/media/publish/next');
    expect(next.job.status).toBe('filling');
    await ok('herald', 'POST', '/api/media/publish/PJ1/ready', { composer: 'Approve first. #edtech', attached: 1 });
    const note = state().notes.at(-1)!;
    expect(note).toMatchObject({ topic: 'media', open: true });
    expect(note.text.split('\n')[0]).toBe('X post ready (PJ1)');
    expect((await ok<MediaSummary>('you', 'GET', '/api/media/summary')).publishReady).toBe(1);
    const waiting = call<{ decision: string }>('herald', 'POST', '/api/media/publish/PJ1/wait');
    await new Promise((r) => setTimeout(r, 50));
    expect((await call('herald', 'POST', '/api/media/publish/PJ1/go')).status).toBe(403);
    await ok('you', 'POST', '/api/media/publish/PJ1/go');
    expect((await waiting).data.decision).toBe('go');
    expect(state().notes.find((n) => n.id === note.id)!.dismissed).toBe(true);
    await ok('herald', 'POST', '/api/media/publish/PJ1/done', { url: 'https://x.com/me/status/1' });
    expect(piece('MP1')).toMatchObject({ status: 'used' });
    await until(() => state().agents.find((a) => a.id === 'herald')!.status === 'stopped');
  });

  it('a cancelled job answers cancel; stop cancels what has not gone out', async () => {
    await ok('you', 'PUT', '/api/media/reply-policy', { perDay: 1 });
    const { added } = await ok<{ added: MediaConversation[] }>('herald', 'POST', '/api/media/conversations', {
      conversations: [
        { platform: 'x', url: 'https://x.com/a/1', who: 'Teacher', quote: 'Does it hold comments?', why: 'asked', draft: 'Yes.', claims: [{ quote: 'Yes', sources: [] }] },
        { platform: 'x', url: 'https://x.com/a/2', who: 'Teacher 2', quote: 'Any tool for this?', why: 'asked for a tool', draft: 'My own project does this.', mentionsProduct: true },
      ],
    });
    expect(added.map((c) => c.id)).toEqual(['MC1', 'MC2']);
    expect((await ok<MediaSummary>('you', 'GET', '/api/media/summary')).conversations).toBe(2);
    expect((await call('you', 'POST', '/api/media/conversations/MC1/reply')).status).toBe(409); // unsourced
    await ok('you', 'POST', '/api/media/conversations/MC1/claims/C1/confirm');
    const job = await ok<MediaPublishJob>('you', 'POST', '/api/media/conversations/MC1/reply');
    expect(job).toMatchObject({ kind: 'reply', conversationId: 'MC1' });
    expect((await call('you', 'POST', '/api/media/conversations/MC2/reply')).status).toBe(409); // 1 a day
    await until(() => orch.media.store.current?.id === job.id);
    expect((await ok<{ text: string }>('herald', 'GET', '/api/media/brief')).text).toContain('Reply to: https://x.com/a/1');
    await ok('herald', 'POST', '/api/media/publish/next');
    await ok('herald', 'POST', `/api/media/publish/${job.id}/ready`, { composer: 'Yes.' });
    await ok('you', 'POST', `/api/media/publish/${job.id}/cancel`);
    expect((await ok<{ decision: string }>('herald', 'POST', `/api/media/publish/${job.id}/wait`)).decision).toBe('cancel');
    expect(orch.media.store.conversations![0].status).toBe('draft');
    await ok('you', 'POST', '/api/media/conversations/MC2/skip');
    expect((await call('you', 'POST', '/api/media/publish/stop', { pieceId: 'MP1' })).status).toBe(200);
  });

  it('research Refresh is yours; the comment check is herald\'s', async () => {
    await ok('you', 'POST', '/api/media/pieces/MP1/research');
    await until(() => orch.media.store.current?.kind === 'research');
    expect((await ok<{ text: string }>('herald', 'GET', '/api/media/brief')).text).toContain('This is a refresh');
    await ok('herald', 'POST', '/api/media/pieces/MP1/research', { platforms: ['x'], themes: [{ text: 'Still worried', count: 3 }] });
    expect(piece('MP1').researchQueued).toBeUndefined();
    orch.media.store.watchQueuedAt = new Date().toISOString();
    orch.media.commit();
    await until(() => orch.media.store.current?.kind === 'watch');
    expect((await ok<{ text: string }>('herald', 'GET', '/api/media/brief')).text).toContain('https://x.com/me/status/1');
    expect((await call('you', 'POST', '/api/media/watch/done')).status).toBe(403);
    await ok('herald', 'POST', '/api/media/watch/done');
    expect(orch.media.store.lastWatch).toBeTruthy();
    expect(orch.media.store.current).toBeUndefined();
  });
});
