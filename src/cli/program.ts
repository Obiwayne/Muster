// Command wiring for `muster` (commander). index.ts runs it; tests build it with a fake Ctx.
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import * as cmd from './commands.js';
import { CliError, defaultCtx, type Ctx } from './context.js';
import { initMuster } from './init.js';
import { attach, chat } from './live.js';
import { down, ui, up } from './lifecycle.js';

function int(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError('must be a positive integer');
  return n;
}

export function buildProgram(ctx: Ctx): Command {
  const program = new Command('muster')
    .description('Run a crew of Claude Code agents in parallel on one git repo, led by a Captain.')
    .version('0.1.0')
    .exitOverride() // set first so every subcommand inherits it
    .showHelpAfterError('(run `muster --help` for usage)');

  program
    .command('init')
    .description('set up .muster/ in this repo and add it to .gitignore')
    .action(() => {
      const r = initMuster(ctx.repoRoot ?? ctx.cwd);
      ctx.out(r.created.length ? `Muster set up in ${r.root}: ${r.created.join(', ')}` : `Muster is already set up in ${r.root}.`);
    });

  program
    .command('up')
    .description('start the orchestrator and the Captain, then open the dashboard')
    .option('--port <n>', 'port to listen on (default 47800)', int)
    .option('--no-ui', "don't open the dashboard")
    .action((o: { port?: number; ui: boolean }) => up(ctx, o));

  program
    .command('down')
    .description('stop every agent and the orchestrator')
    .option('--clean', 'also remove worktrees whose branch is merged')
    .action((o: { clean?: boolean }) => down(ctx, o));

  program
    .command('add [name]')
    .description('create a worktree + branch and start a crew agent in it')
    .option('--role <role>', 'crew or design', 'crew')
    .option('--task <task>', 'task id (T3) or a title for a new task')
    .action((name: string | undefined, o: { role?: string; task?: string }) => cmd.add(ctx, name, o));

  program
    .command('role <agent> <role>')
    .description("change an agent's role: captain | crew | design")
    .action((agent: string, role: string) => cmd.setRole(ctx, agent, role));

  program
    .command('ask <goal...>')
    .description('send a goal to the Captain')
    .action((goal: string[]) => cmd.ask(ctx, goal.join(' ')));

  program
    .command('status')
    .description('list agents with role, status, branch, task and last activity')
    .action(() => cmd.status(ctx));

  program
    .command('attach <agent>')
    .description("open an agent's live terminal here (Ctrl+] to detach)")
    .action((agent: string) => attach(ctx, agent));

  program
    .command('diff <agent>')
    .description("show an agent's changes against the base branch")
    .option('--stat', 'summary only')
    .action((agent: string, o: { stat?: boolean }) => cmd.diff(ctx, agent, o));

  program
    .command('merge <agent>')
    .description("merge an agent's finished branch into the base branch")
    .option('--force', "merge even if the Captain hasn't flagged it ready")
    .action((agent: string, o: { force?: boolean }) => cmd.merge(ctx, agent, o));

  program
    .command('stop <agent>')
    .description('stop one agent (its worktree is kept)')
    .action((agent: string) => cmd.stopAgent(ctx, agent));

  program
    .command('start <agent>')
    .description('restart a stopped agent')
    .action((agent: string) => cmd.startAgent(ctx, agent));

  program
    .command('ui')
    .description('open the dashboard in your browser')
    .action(() => ui(ctx));

  program
    .command('board')
    .description('list open notes on the bulletin board')
    .option('--all', 'include closed notes')
    .option('--needs-you', 'only escalations and ready-for-review notes')
    .action((o: { all?: boolean; needsYou?: boolean }) => cmd.board(ctx, o));

  program
    .command('reply <note> <text...>')
    .description('reply to a note as "you"')
    .option('--close', 'close the note')
    .action((note: string, text: string[], o: { close?: boolean }) => cmd.reply(ctx, note, text.join(' '), o));

  program
    .command('cancel <task> [reason...]')
    .description('drop a task that is no longer needed')
    .action((task: string, reason: string[] = []) => cmd.cancel(ctx, task, reason.join(' ')));

  program
    .command('tasks')
    .description('list tasks on the board')
    .action(() => cmd.tasks(ctx));

  program
    .command('usage')
    .description('5-hour and weekly usage, resets, per-agent cost')
    .action(() => cmd.usage(ctx));

  program
    .command('chat')
    .description('print the crew chat log')
    .option('-f, --follow', 'keep printing new messages as they arrive')
    .option('--agent <id>', 'only messages from or to this agent')
    .option('-n, --limit <n>', 'how many past items to show', int, 50)
    .action((o: { follow?: boolean; agent?: string; limit?: number }) => chat(ctx, o));

  program
    .command('say <to> <text...>')
    .description('message an agent (or "everyone") as "you"')
    .action((to: string, text: string[]) => cmd.say(ctx, to, text.join(' ')));

  return program;
}

/** Run the CLI; returns the exit code. */
export async function main(argv: string[], ctx: Ctx = defaultCtx()): Promise<number> {
  const program = buildProgram(ctx);
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode; // commander already printed help/usage/version
    const msg = e instanceof CliError ? e.message : e instanceof Error ? e.message : String(e);
    process.stderr.write(ctx.c.red(msg) + '\n');
    if (!(e instanceof CliError) && process.env.MUSTER_DEBUG && e instanceof Error) process.stderr.write(String(e.stack) + '\n');
    return 1;
  }
}
