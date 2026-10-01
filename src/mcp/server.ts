// muster-mcp: the tools each Muster agent uses to talk to the orchestrator.
// Built as a factory so tests can inject a fake API and use an in-memory transport.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { musterFetch } from '../client.js';
import { formatGuideline } from '../core/stations.js';
import type { Agent, FeedItem, InboxItem, MusterState, Note, Role, StationDef, Task } from '../types.js';
import {
  BOARD_FILTERS,
  boardQuery,
  clip,
  formatAgents,
  formatBoard,
  formatDiff,
  formatInbox,
  formatNoteLine,
  formatTaskDetail,
  formatTaskLine,
  formatTasks,
  formatTests,
  isTaskId,
  stationLabel,
  truncateTail,
} from './format.js';

export type Api = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

export interface MusterServerOptions {
  role: Role;
  agentId: string;
  api?: Api;
  /** ask_captain polling (defaults: every 5 s, up to 10 min). */
  pollMs?: number;
  askTimeoutMs?: number;
  now?: () => number;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
const enc = encodeURIComponent;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const CAPTAIN_TOOLS = [
  'spawn_crew', 'post_task', 'assign', 'list_agents', 'list_tasks', 'read_board', 'reply', 'message',
  'read_inbox', 'read_output', 'get_diff', 'run_tests', 'request_review', 'send_back', 'cancel_task', 'close_crew', 'escalate',
] as const;
export const CREW_TOOLS = [
  'claim_task', 'list_agents', 'list_tasks', 'post_note', 'read_board', 'reply', 'ask_captain',
  'message_crew', 'handoff', 'report_done', 'read_inbox',
] as const;

export function createMusterServer(opts: MusterServerOptions): McpServer {
  const { role, agentId: me } = opts;
  const api: Api = opts.api ?? ((path, o) => musterFetch(path, o));
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? 5000;
  const askTimeoutMs = opts.askTimeoutMs ?? 10 * 60 * 1000;

  const server = new McpServer(
    { name: 'muster', version: '0.1.0' },
    {
      instructions:
        role === 'captain'
          ? `You are ${me}, the Muster Captain. Check read_board first every turn. Never write code or merge.`
          : `You are ${me}, Muster ${role === 'design' ? 'design crew' : 'crew'}. Work only in your worktree; ask crew before the Captain.`,
    },
  );

  // Register a tool whose handler returns plain text; thrown errors become isError results.
  const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (args: z.infer<z.ZodObject<S>>) => Promise<string>) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server.registerTool as any)(name, { description, inputSchema: shape }, async (args: z.infer<z.ZodObject<S>>) => {
      try {
        return ok(await run(args ?? ({} as z.infer<z.ZodObject<S>>)));
      } catch (e) {
        return fail(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  };

  const getState = async () => (await api<{ state: MusterState; paused: boolean }>('/api/state')).state;
  const findTask = async (id: string) => {
    const want = id.trim().toUpperCase();
    const t = (await getState()).tasks.find((x) => x.id.toUpperCase() === want);
    if (!t) throw new Error(`No task ${id}.`);
    return t;
  };

  const myTask = async (): Promise<Task> => {
    const state = await getState();
    const agent = state.agents.find((a) => a.id === me);
    const task =
      (agent?.taskId && state.tasks.find((t) => t.id === agent.taskId)) ||
      state.tasks.find((t) => t.assignee === me && t.status === 'in_progress');
    if (!task) throw new Error('You hold no task. Call claim_task first (or read_inbox for an assignment).');
    return task;
  };

  // ---- shared tools ----------------------------------------------------------

  tool('list_agents', 'List every agent: role, status, branch and held task.', {}, async () => {
    const state = await getState();
    return formatAgents(state.agents);
  });

  tool('list_tasks', 'List the task board: status, current station, assignee, dependencies.', {}, async () => {
    return formatTasks(await api<Task[]>('/api/tasks'));
  });

  tool(
    'read_board',
    'Read the bulletin board. filter: open (default: open stuck/question/waiting/review/escalation notes), all, mine, to-me, needs-you, or a note type (stuck, question, waiting, progress, done, review, escalation, message, system).',
    { filter: z.enum(BOARD_FILTERS).optional() },
    async ({ filter }) => formatBoard(await api<Note[]>(`/api/notes${boardQuery(filter, me)}`), now()),
  );

  tool(
    'reply',
    'Reply in a note thread (e.g. answer a stuck/question note). close=true closes the note once it is resolved.',
    { note: z.string().describe('Note id, e.g. N14'), text: z.string().min(1), close: z.boolean().optional() },
    async ({ note, text, close }) => {
      const n = await api<Note>(`/api/notes/${enc(note.trim().toUpperCase())}/reply`, { method: 'POST', body: { actor: me, text, close } });
      return `Replied on ${n.id}${n.open ? '' : ' (closed)'}. Delivered to ${n.from}.`;
    },
  );

  tool('read_inbox', 'Read and clear your unread inbox: replies, messages, assignments, hand-offs. Call it whenever a [muster] line appears.', {}, async () => {
    const items = await api<InboxItem[]>(`/api/inbox/${enc(me)}?unread=1`);
    if (items.length) await api(`/api/inbox/${enc(me)}/read`, { method: 'POST', body: { ids: items.map((i) => i.id) } });
    return formatInbox(items, now());
  });

  if (role === 'captain') registerCaptain();
  else registerCrew();
  return server;

  // ---- captain ----------------------------------------------------------------

  function registerCaptain() {
    tool(
      'spawn_crew',
      'Start a new crew agent in its own worktree. task = an existing task id (T3) or a title for a new task. role = crew (default) or design (the Vellum design crew; only one).',
      { task: z.string().optional(), role: z.enum(['crew', 'design']).optional() },
      async ({ task, role: r }) => {
        let taskId: string | undefined;
        if (task && task.trim()) {
          if (isTaskId(task)) taskId = task.trim().toUpperCase();
          else {
            const t = await api<Task>('/api/tasks', { method: 'POST', body: { title: task.trim(), description: task.trim(), actor: me } });
            taskId = t.id;
          }
        }
        const a = await api<Agent>('/api/agents', { method: 'POST', body: { role: r ?? 'crew', taskId, actor: me } });
        return `Spawned ${a.id} (${a.role}) on ${a.branch}${taskId ? ` with task ${taskId}` : ''}. It starts working on its own.`;
      },
    );

    tool(
      'post_task',
      'Post a task to the board. Keep tasks small (one branch, one reviewable change). dependsOn = task ids that must be done first. stations = ordered stations, e.g. ["build","test","design"] ("review" is appended). assignee = agent id to hand it to directly.',
      {
        title: z.string().min(1),
        description: z.string().min(1).describe('What to build, acceptance criteria, files/areas involved'),
        dependsOn: z.array(z.string()).optional(),
        stations: z.array(z.string()).optional(),
        assignee: z.string().optional(),
      },
      async ({ title, description, dependsOn, stations, assignee }) => {
        const t = await api<Task>('/api/tasks', { method: 'POST', body: { title, description, dependsOn, stations, assignee, actor: me } });
        return `Posted ${formatTaskLine(t)}`;
      },
    );

    tool('assign', 'Assign a task to an agent (it gets an inbox item and starts).', { agent: z.string(), task: z.string() }, async ({ agent, task }) => {
      const t = await api<Task>(`/api/tasks/${enc(task.trim().toUpperCase())}/assign`, { method: 'POST', body: { agentId: agent, actor: me } });
      return `Assigned ${formatTaskLine(t)}`;
    });

    tool(
      'message',
      'Send a direct message to one agent, or agent="everyone" to broadcast to the crew.',
      { agent: z.string(), text: z.string().min(1) },
      async ({ agent, text }) => {
        await api<FeedItem>('/api/messages', { method: 'POST', body: { actor: me, to: agent, text } });
        return `Sent to ${agent}.`;
      },
    );

    tool('read_output', "Read the last lines of an agent's terminal (ANSI stripped).", { agent: z.string(), lines: z.number().int().min(1).max(500).optional() }, async ({ agent, lines }) => {
      const r = await api<{ text: string }>(`/api/agents/${enc(agent)}/output?lines=${lines ?? 80}`);
      return truncateTail((r.text ?? '').trimEnd(), 20000) || '(no output)';
    });

    tool(
      'get_diff',
      "Show a branch's diff against the base branch (stat + patch). Pass task (works even after its builder is gone) or agent.",
      { task: z.string().optional(), agent: z.string().optional() },
      async ({ task, agent }) => {
        if (task) {
          const t = await findTask(task);
          if (!t.branch) throw new Error(`${t.id} has no branch yet.`);
          return formatDiff(await api(`/api/agents/${enc(me)}/diff?branch=${enc(t.branch)}`));
        }
        if (!agent) throw new Error('Pass task or agent.');
        return formatDiff(await api(`/api/agents/${enc(agent)}/diff`));
      },
    );

    tool('run_tests', "Run the project's test command in an agent's worktree (up to 10 min).", { agent: z.string() }, async ({ agent }) => {
      return formatTests(await api(`/api/agents/${enc(agent)}/tests`, { method: 'POST', body: {} }));
    });

    tool(
      'request_review',
      'Mark a task ready for merge after you reviewed the diff and tests pass. Pass task (preferred; works even after its builder is gone) or agent. Pins a Ready-for-review note for the user.',
      { task: z.string().optional(), agent: z.string().optional(), summary: z.string().min(1).describe('What changed, test result, anything the user should check') },
      async ({ task: taskId, agent, summary }) => {
        if (taskId) {
          const t = await api<Task>(`/api/tasks/${enc((await findTask(taskId)).id)}/review`, { method: 'POST', body: { actor: me, summary } });
          return `${t.id} is ready for merge (${t.branch ?? 'no branch'}). The user has been notified.`;
        }
        if (!agent) throw new Error('Pass task or agent.');
        const state = await getState();
        const a = state.agents.find((x) => x.id === agent);
        if (!a) throw new Error(`No agent ${agent}. Pass the task id instead: request_review(task: "T1", summary).`);
        const task =
          (a.taskId && state.tasks.find((t) => t.id === a.taskId)) ||
          state.tasks.find((t) => t.status === 'review' && t.history?.some((h) => h.agentId === agent)) ||
          state.tasks.find((t) => t.branch === a.branch);
        if (!task) throw new Error(`${agent} holds no task to review.`);
        const t = await api<Task>(`/api/tasks/${enc(task.id)}/review`, { method: 'POST', body: { actor: me, summary } });
        return `${t.id} is ready for merge (${t.branch ?? a.branch}). The user has been notified.`;
      },
    );

    tool('close_crew', "Close a finished crew agent's terminal: no open task, nothing uncommitted, its work merged. Refused (with the reason) otherwise. Finished crew are also tidied away automatically after their idle shutdown.", { agent: z.string() }, async ({ agent }) => {
      await api(`/api/agents/${enc(agent.trim())}/close`, { method: 'POST', body: { actor: me } });
      return `Closed ${agent.trim()}.`;
    });

    tool('cancel_task', 'Drop a task that is no longer needed (duplicate, superseded, out of scope). Nobody can claim it afterwards; whoever held it is told to stop.', { task: z.string(), reason: z.string().min(1) }, async ({ task, reason }) => {
      const t = await api<Task>(`/api/tasks/${enc(task.trim().toUpperCase())}/cancel`, { method: 'POST', body: { actor: me, reason } });
      return `Cancelled ${t.id} ${t.title}.`;
    });

    tool('send_back', 'Send a task back to its builder with what to fix.', { task: z.string(), note: z.string().min(1) }, async ({ task, note }) => {
      const t = await api<Task>(`/api/tasks/${enc(task.trim().toUpperCase())}/sendback`, { method: 'POST', body: { actor: me, note } });
      return `Sent back ${formatTaskLine(t)}`;
    });

    tool(
      'escalate',
      'Ask the user. Only for decisions only they can make (product/scope, credentials, money, destructive ops). note = the board note it relates to.',
      { text: z.string().min(1), note: z.string().optional() },
      async ({ text, note }) => {
        const n = await api<Note>('/api/escalate', { method: 'POST', body: { actor: me, text, noteId: note?.trim().toUpperCase() } });
        return `Escalated as ${n.id}. The user was notified; carry on with other work meanwhile.`;
      },
    );
  }

  // ---- crew / design ------------------------------------------------------------

  function registerCrew() {
    tool('claim_task', 'Claim the next ready task for your role (oldest first). Returns the task, or nothing if none is ready.', {}, async () => {
      const t = await api<Task | null>('/api/tasks/claim', { method: 'POST', body: { actor: me } });
      if (!t) return 'No ready task for you right now. Check read_board for questions you can answer, or wait for an assignment.';
      const st = await api<StationDef | null>(`/api/stations/${enc(t.stations[t.stationIndex] ?? 'build')}`).catch(() => null);
      const guide = typeof st?.guideline === 'string' ? formatGuideline(st.name, st.guideline) : '';
      return `Claimed ${formatTaskDetail(t)}${guide ? `\n\n${guide}` : ''}`;
    });

    tool(
      'post_note',
      'Pin a note on the board. stuck = cannot move on (say what you tried); question = need a decision; waiting = blocked on another agent (set to); progress = milestone reached; done = step finished.',
      {
        type: z.enum(['stuck', 'question', 'waiting', 'progress', 'done']),
        text: z.string().min(1),
        to: z.string().optional().describe('Agent this concerns (waiting: the agent you wait on)'),
      },
      async ({ type, text, to }) => {
        const n = await api<Note>('/api/notes', { method: 'POST', body: { actor: me, type, text, to } });
        return `Pinned ${formatNoteLine(n, now())}`;
      },
    );

    /** The answer came back as the tool result, so its inbox item must not be nudged or listed again. */
    const markRepliesRead = async (noteId: string) => {
      try {
        const items = await api<InboxItem[]>(`/api/inbox/${enc(me)}?unread=1`);
        const ids = (Array.isArray(items) ? items : []).filter((i) => i.noteId === noteId && i.kind === 'reply').map((i) => i.id);
        if (ids.length) await api(`/api/inbox/${enc(me)}/read`, { method: 'POST', body: { ids } });
      } catch {
        /* best effort: at worst the reply shows up in read_inbox too */
      }
    };

    tool(
      'ask_captain',
      'Post a question note and wait up to 10 minutes for the first reply (crew may answer too). Ask other crew first when they own the area.',
      { question: z.string().min(1) },
      async ({ question }) => {
        const n = await api<Note>('/api/notes', { method: 'POST', body: { actor: me, type: 'question', text: question } });
        const deadline = now() + askTimeoutMs;
        while (now() < deadline) {
          await sleep(pollMs);
          let notes: Note[];
          try {
            notes = await api<Note[]>(`/api/notes?from=${enc(me)}&type=question`);
          } catch {
            continue;
          }
          const cur = notes.find((x) => x.id === n.id);
          if (!cur) continue;
          const r = cur.replies?.find((x) => x.from !== me);
          if (r) {
            await markRepliesRead(n.id);
            return `${r.from} answered ${n.id}: ${r.text}`;
          }
          if (!cur.open) return `${n.id} was closed without an answer. Carry on with your best judgement.`;
        }
        return `No answer yet on ${n.id} — carry on with other work; the answer will arrive in your inbox.`;
      },
    );

    tool('message_crew', 'Send a direct message to another agent (e.g. "I changed the invite API shape"). The Captain sees every message.', { agent: z.string(), text: z.string().min(1) }, async ({ agent, text }) => {
      await api<FeedItem>('/api/messages', { method: 'POST', body: { actor: me, to: agent, text } });
      return `Sent to ${agent}.`;
    });

    tool(
      'handoff',
      'Commit first, then hand your task to the next station. agent = a specific agent id, or omit to let any agent of the next station claim it. note = what you did and what is next.',
      { agent: z.string().optional(), note: z.string().min(1) },
      async ({ agent, note }) => {
        const task = await myTask();
        const t = await api<Task>(`/api/tasks/${enc(task.id)}/handoff`, { method: 'POST', body: { actor: me, to: agent, note } });
        return `Handed ${t.id} on: now at station ${stationLabel(t)}${t.assignee ? ` with ${t.assignee}` : ''} [${t.status}].`;
      },
    );

    tool(
      'report_done',
      'Commit first, then report your task finished; it goes to the Captain for review. summary = what changed, how you tested it, anything left open.',
      { summary: z.string().min(1) },
      async ({ summary }) => {
        const task = await myTask();
        const t = await api<Task>(`/api/tasks/${enc(task.id)}/done`, { method: 'POST', body: { actor: me, summary } });
        return `${t.id} reported done (${clip(t.title, 60)}), now with ${t.assignee ?? 'the Captain'} for review. Call claim_task for more work.`;
      },
    );
  }
}
