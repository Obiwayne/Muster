// `muster new "<idea>"`: create a project from nothing, start Muster in it and hand the idea to the Captain.
import { resolve } from 'node:path';
import { createNewProject } from '../core/newproject.js';
import { api, CliError, type Ctx } from './context.js';
import { up } from './lifecycle.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function newApp(ctx: Ctx, idea: string, opts: { dir?: string; title?: string; open?: boolean; waitMs?: number; entry?: string }): Promise<void> {
  if (!idea.trim()) throw new CliError('Give the new app an idea: muster new "<idea>"');
  let project;
  try {
    project = createNewProject({ parentDir: resolve(ctx.cwd, opts.dir ?? '.'), idea, title: opts.title, now: ctx.now() });
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e));
  }
  ctx.out(`Created ${project.root}`);
  const inner: Ctx = { ...ctx, cwd: project.root, repoRoot: project.root };
  await up(inner, { ui: opts.open !== false, waitMs: opts.waitMs, entry: opts.entry });

  // The Captain may still be starting; /api/ask answers 409 until it runs.
  const deadline = Date.now() + (opts.waitMs ?? 15000);
  for (;;) {
    try {
      await api(inner, '/api/ask', { body: { text: idea } });
      break;
    } catch (e) {
      if (Date.now() > deadline || !/not running|no captain/i.test((e as Error).message)) throw e;
      await sleep(250);
    }
  }
  ctx.out('Sent the idea to the Captain.');
  ctx.out(project.root);
}
