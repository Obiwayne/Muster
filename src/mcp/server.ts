// muster-mcp: the tools each Muster agent uses to talk to the orchestrator.
// Built as a factory so tests can inject a fake API and use an in-memory transport.
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { musterFetch } from '../client.js';
import { formatEvidence } from '../core/evidence.js';
import { formatGuideline } from '../core/stations.js';
import type { Agent, Evidence, FeedItem, InboxItem, MusterState, Note, ResearchIdea, ResearchRun, ResearchState, Role, Roadmap, RoadmapProgress, StationDef, Task } from '../types.js';
import {
  BOARD_FILTERS,
  boardQuery,
  clip,
  formatAgents,
  formatBoard,
  formatDiff,
  formatIdeaDetail,
  formatIdeaLine,
  formatIdeas,
  formatInbox,
  formatNoteLine,
  formatRoadmap,
  formatTaskDetail,
  formatTaskLine,
  formatTasks,
  formatTests,
  isTaskId,
  stationLabel,
  truncateHead,
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

type RoadmapView = { roadmap: Roadmap | null; progress: RoadmapProgress | null };
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const upId = (s: string) => s.trim().toUpperCase();

/** Trailer for roadmap writes: says when the change sent the plan back to the user for approval. */
function draftNote(r: Roadmap | null | undefined): string {
  return r?.status === 'draft' ? ` The roadmap is a draft (rev ${r.revision}) waiting for the user's approval; keep working on approved goals meanwhile.` : '';
}

export const CAPTAIN_TOOLS = [
  'spawn_crew', 'post_task', 'assign', 'list_agents', 'list_tasks', 'read_board', 'reply', 'message',
  'read_inbox', 'read_output', 'get_diff', 'run_tests', 'request_review', 'merge_task', 'send_back', 'cancel_task', 'close_crew', 'escalate',
  'add_evidence', 'get_evidence',
  'roadmap', 'set_roadmap', 'update_stage', 'check_criterion', 'complete_stage', 'add_goal', 'update_goal', 'link_tasks',
  'list_ideas', 'get_idea', 'advise_idea',
] as const;
export const CREW_TOOLS = [
  'claim_task', 'list_agents', 'list_tasks', 'post_note', 'read_board', 'reply', 'ask_captain',
  'message_crew', 'handoff', 'report_done', 'read_inbox', 'add_evidence',
] as const;
/** The research agent (scout): reads public pages and posts ideas; no board, task or code tools. */
export const RESEARCH_TOOLS = ['research_brief', 'add_idea', 'finish_research', 'read_inbox'] as const;

const IDEA_STATUSES = ['new', 'approved', 'rejected'] as const;
const evidenceShape = z.object({
  kind: z.enum(['review', 'forum', 'competitor', 'app', 'web']),
  source: z.string().min(1).max(160).describe('Where it came from, e.g. "App Store review · Padlet · 2★", "r/Teachers · 412 upvotes", "Wakelet public roadmap"'),
  text: z.string().max(300).optional().describe('A short quote or finding, at most 300 characters'),
  url: z.string().optional().describe('Link to the page'),
  count: z.number().int().min(1).optional().describe('How many similar reports you saw ("+37 similar")'),
});

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
          ? `You are ${me}, the Muster Captain. Check read_board first every turn. Never write code; merge only tasks the user approved, with merge_task.`
          : role === 'research'
            ? `You are ${me}, the Muster research agent. Start with research_brief; post each idea with add_idea; end with finish_research. Public pages only; never change code.`
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

  tool('read_inbox', 'Read and clear your unread inbox: replies, messages, assignments, hand-offs. Call it whenever a [muster] line appears.', {}, async () => {
    const items = await api<InboxItem[]>(`/api/inbox/${enc(me)}?unread=1`);
    if (items.length) await api(`/api/inbox/${enc(me)}/read`, { method: 'POST', body: { ids: items.map((i) => i.id) } });
    return formatInbox(items, now());
  });

  if (role === 'research') {
    registerResearch();
    return server;
  }

  // ---- shared tools (captain, crew, design) ---------------------------------------

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

  tool(
    'add_evidence',
    'Attach proof that a task works, so the Captain and the user can see it: files in your worktree (screenshots, test output, assertions.md; a folder adds every file in it) and/or text (saved as notes.md). The Captain cannot flag a task ready for merge without evidence. task defaults to the task you hold.',
    {
      files: z.array(z.string()).optional().describe('Paths relative to your worktree, e.g. [".muster-evidence/T3"]'),
      text: z.string().optional().describe('Inline evidence, e.g. test output or a checklist'),
      summary: z.string().min(1).describe('What the evidence shows, in a line or two'),
      task: z.string().optional(),
    },
    async ({ files, text, summary, task }) => {
      const t = task ? await findTask(task) : await myTask();
      const e = await api<Evidence>(`/api/tasks/${enc(t.id)}/evidence`, { method: 'POST', body: { actor: me, files: files ?? [], text, summary } });
      return `Attached ${e.id} to ${t.id}: ${e.files.map((f) => f.name).join(', ')}.`;
    },
  );

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
      'Post a task to the board. Keep tasks small (one branch, one reviewable change). goal = the roadmap goal it belongs to (G3). dependsOn = task ids that must be done first. stations = ordered stations, e.g. ["build","test","design"] ("review" is appended); or line = a line preset name (standard, tested, designed, planning, or a custom one) instead. assignee = agent id to hand it to directly.',
      {
        title: z.string().min(1),
        description: z.string().min(1).describe('What to build, acceptance criteria, files/areas involved'),
        dependsOn: z.array(z.string()).optional(),
        stations: z.array(z.string()).optional(),
        line: z.string().optional().describe('Name of a line preset; used instead of stations'),
        assignee: z.string().optional(),
        goal: z.string().optional().describe('Roadmap goal this task delivers, e.g. G3. Set it on every task once there is a roadmap'),
      },
      async ({ title, description, dependsOn, stations, line, assignee, goal }) => {
        const goalId = goal?.trim() ? upId(goal) : undefined;
        const t = await api<Task>('/api/tasks', { method: 'POST', body: { title, description, dependsOn, stations, line, assignee, goalId, actor: me } });
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
      'get_evidence',
      "Show a task's evidence: each add_evidence entry, the text files inline, and the absolute path of every image or video so you can open it with Read. Check it before request_review.",
      { task: z.string() },
      async ({ task }) => {
        const state = await getState();
        const t = state.tasks.find((x) => x.id.toUpperCase() === task.trim().toUpperCase());
        if (!t) throw new Error(`No task ${task}.`);
        if (!t.evidence?.length) return `${t.id} has no evidence yet. Its last working station attaches it with add_evidence; or test it yourself and call add_evidence(task: "${t.id}", text, summary).`;
        const root = state.repoRoot.replace(/\\/g, '/');
        const out: string[] = [formatEvidence(t)];
        let budget = 12_000;
        for (const e of t.evidence) {
          for (const f of e.files) {
            const path = `${root}/.muster/evidence/${t.id}/${e.id}/${f.name}`;
            if (f.kind !== 'text' || budget <= 0) {
              out.push(`${e.id} ${f.kind}: ${path}`);
              continue;
            }
            let body = '';
            try {
              body = readFileSync(path, 'utf8');
            } catch {
              body = '(missing on disk)';
            }
            const text = truncateHead(body.trim(), Math.min(budget, 4000));
            budget -= text.length;
            out.push(`--- ${e.id} ${f.name} (${path})`, text);
          }
        }
        return out.join('\n');
      },
    );

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

    tool(
      'merge_task',
      'Merge a task the user approved (their Approve button sends you a message) into the base branch, then push it to GitHub. Merges exactly the commit you reviewed. Refused until the user approves.',
      { task: z.string() },
      async ({ task }) => {
        const t = await findTask(task);
        const r = await api<{ output: string; pushed?: boolean }>(`/api/tasks/${enc(t.id)}/merge`, { method: 'POST', body: { actor: me } });
        const push = r.pushed === undefined ? ' No GitHub remote, so nothing was pushed.' : r.pushed ? ' Pushed to GitHub.' : ' The push to GitHub failed; tell the user.';
        return `Merged ${t.id} (${t.branch}).${push}
${r.output}`;
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

    // ---- roadmap ----

    tool(
      'roadmap',
      'Read the roadmap: stages with dates, status, progress and health, the current stage with its goals and unticked exit criteria. Read it every turn alongside the board.',
      {},
      async () => formatRoadmap(await api<RoadmapView>('/api/roadmap')),
    );

    const goalShape = z.object({
      id: z.string().optional().describe('Existing goal id (G3) to keep it; omit for a new goal'),
      title: z.string().min(1).max(120),
      description: z.string(),
      start: day.optional(),
      due: day.optional(),
    });
    const stageShape = z.object({
      id: z.string().optional().describe('Existing stage id (M2) to keep it; omit for a new stage'),
      title: z.string().min(1).max(120),
      description: z.string(),
      start: day.optional(),
      due: day.optional(),
      exitCriteria: z.array(z.string().min(1)).describe('Checkable conditions that prove the stage is done'),
      goals: z.array(goalShape).max(12),
    });

    tool(
      'set_roadmap',
      'Draft or replan the whole roadmap: 1-12 stages in order, each with dates, exit criteria and up to 12 goals. Replaces the plan; pass the existing ids (M2, G3) of stages and goals you keep. Saving sends it to the user for approval; adding/removing stages or goals or changing dates on an approved roadmap makes it a draft again.',
      {
        title: z.string().min(1).max(120).describe('e.g. "wall-education v1.0"'),
        summary: z.string().min(1).describe('What the product is, one paragraph'),
        launchDate: day.optional(),
        stages: z.array(stageShape).min(1).max(12),
      },
      async ({ title, summary, launchDate, stages }) => {
        const body = {
          actor: me,
          title,
          summary,
          launchDate,
          stages: stages.map((s) => ({ ...s, id: s.id ? upId(s.id) : undefined, goals: s.goals.map((g) => ({ ...g, id: g.id ? upId(g.id) : undefined })) })),
        };
        const v = await api<RoadmapView>('/api/roadmap', { method: 'PUT', body });
        const r = v?.roadmap;
        const head =
          r?.status === 'draft'
            ? `Saved roadmap draft rev ${r.revision}. The user has been asked to approve it; post no build tasks for new goals until then.`
            : 'Saved the roadmap.';
        return `${head}\n${formatRoadmap(v)}`;
      },
    );

    tool(
      'update_stage',
      'Edit one stage: title, description, dates or status. Changing dates on an approved roadmap sends it back for approval.',
      {
        stage: z.string().describe('Stage id, e.g. M2'),
        title: z.string().min(1).max(120).optional(),
        description: z.string().optional(),
        start: day.optional(),
        due: day.optional(),
        status: z.enum(['planned', 'active', 'done']).optional(),
      },
      async ({ stage, ...patch }) => {
        const id = upId(stage);
        const v = await api<RoadmapView>(`/api/roadmap/stages/${enc(id)}`, { method: 'PATCH', body: { actor: me, ...patch } });
        const s = v?.roadmap?.stages.find((x) => x.id === id);
        return `Updated ${id}${s ? ` ${clip(s.title, 60)} [${s.status}]` : ''}.${draftNote(v?.roadmap)}`;
      },
    );

    tool(
      'check_criterion',
      "Tick (or untick with done=false) one exit criterion of a stage. index is 1-based, as numbered in roadmap(). Tick only with evidence: merged tasks, test output, the user's sign-off.",
      { stage: z.string().describe('Stage id, e.g. M2'), index: z.number().int().min(1), done: z.boolean().optional() },
      async ({ stage, index, done }) => {
        const id = upId(stage);
        const v = await api<RoadmapView>(`/api/roadmap/stages/${enc(id)}/criteria/${index - 1}`, { method: 'POST', body: { actor: me, done: done ?? true } });
        const s = v?.roadmap?.stages.find((x) => x.id === id);
        const c = s?.exitCriteria[index - 1];
        if (!s || !c) return `${done === false ? 'Unticked' : 'Ticked'} ${id} criterion ${index}.`;
        const n = s.exitCriteria.filter((x) => x.done).length;
        const all = n === s.exitCriteria.length && s.status !== 'done' ? ` All ticked: complete_stage(${id}).` : '';
        return `${c.done ? 'Ticked' : 'Unticked'} ${id} criterion ${index} (${n}/${s.exitCriteria.length}): ${clip(c.text, 120)}.${all}`;
      },
    );

    tool(
      'complete_stage',
      'Mark a stage done once every exit criterion is ticked. The next stage and its first goal become active. Refused while criteria are open.',
      { stage: z.string().describe('Stage id, e.g. M2') },
      async ({ stage }) => {
        const id = upId(stage);
        const v = await api<RoadmapView>(`/api/roadmap/stages/${enc(id)}/complete`, { method: 'POST', body: { actor: me } });
        const r = v?.roadmap;
        const next = r?.stages.find((s) => s.status === 'active');
        const goal = next && r?.goals.find((g) => g.stageId === next.id && g.status === 'active');
        if (!next) return `Completed ${id}.${r ? ' Every stage is done.' : ''}`;
        return `Completed ${id}. Now ${next.id} ${clip(next.title, 60)}${goal ? `: break ${goal.id} ${clip(goal.title, 60)} into tasks (post_task with goal: "${goal.id}")` : ''}.`;
      },
    );

    tool(
      'add_goal',
      "Add a goal at the end of a stage, e.g. a goal the user gave that isn't on the roadmap yet. It is a plan change: an approved roadmap goes back to the user for approval. idea = the approved research idea (R7) this goal delivers: that change is already approved, so the roadmap stays approved.",
      {
        stage: z.string().describe('Stage id, e.g. M2'),
        title: z.string().min(1).max(120),
        description: z.string().min(1),
        start: day.optional(),
        due: day.optional(),
        idea: z.string().optional().describe('Approved research idea id, e.g. R7'),
      },
      async ({ stage, title, description, start, due, idea }) => {
        const id = upId(stage);
        const ideaId = idea?.trim() ? upId(idea) : undefined;
        const body: Record<string, unknown> = { actor: me, stageId: id, title, description, start, due };
        if (ideaId) body.ideaId = ideaId;
        const v = await api<RoadmapView>('/api/roadmap/goals', { method: 'POST', body });
        const g = v?.roadmap?.goals.filter((x) => x.stageId === id && x.title === title).at(-1);
        return `Added ${g ? `${g.id} ` : 'goal '}${clip(title, 60)} to ${id}${ideaId ? ` for idea ${ideaId}` : ''}.${draftNote(v?.roadmap)}`;
      },
    );

    tool(
      'update_goal',
      'Edit one goal: title, description, dates or status (planned, active, done, cancelled). Goals normally finish on their own when all their tasks are merged.',
      {
        goal: z.string().describe('Goal id, e.g. G3'),
        title: z.string().min(1).max(120).optional(),
        description: z.string().optional(),
        status: z.enum(['planned', 'active', 'done', 'cancelled']).optional(),
        start: day.optional(),
        due: day.optional(),
      },
      async ({ goal, ...patch }) => {
        const id = upId(goal);
        const v = await api<RoadmapView>(`/api/roadmap/goals/${enc(id)}`, { method: 'PATCH', body: { actor: me, ...patch } });
        const g = v?.roadmap?.goals.find((x) => x.id === id);
        return `Updated ${id}${g ? ` ${clip(g.title, 60)} [${g.status}]` : ''}.${draftNote(v?.roadmap)}`;
      },
    );

    tool(
      'link_tasks',
      'Put existing tasks on the goal they deliver (or take them off with unlink: true), e.g. work merged before the roadmap existed or a task posted without a goal. Progress is counted from linked tasks; a goal whose linked tasks are all merged finishes. No approval needed.',
      { goal: z.string().describe('Goal id, e.g. G3'), tasks: z.array(z.string()).min(1).describe('Task ids, e.g. ["T21", "T26"]'), unlink: z.boolean().optional() },
      async ({ goal, tasks, unlink }) => {
        const id = upId(goal);
        const v = await api<RoadmapView & { linked?: string[] }>(`/api/roadmap/goals/${enc(id)}/tasks`, { method: 'POST', body: { actor: me, taskIds: tasks.map(upId), unlink: unlink === true } });
        const g = v?.roadmap?.goals.find((x) => x.id === id);
        const p = v?.progress?.goals[id];
        const ids = (v?.linked ?? tasks.map(upId)).join(', ');
        return `${unlink ? 'Took' : 'Put'} ${ids} ${unlink ? 'off' : 'on'} ${id}${g ? ` ${clip(g.title, 60)} [${g.status}]` : ''}${p ? ` · ${p.done}/${p.total} merged` : ''}.`;
      },
    );

    // ---- research ideas ----

    tool(
      'list_ideas',
      "List the research ideas scout found: status, impact, effort, the stage it fits, and whether a question from the user waits for your advice. status = new, approved or rejected (default: all).",
      { status: z.enum(IDEA_STATUSES).optional() },
      async ({ status }) => {
        const ideas = (await getResearch()).ideas;
        return formatIdeas(status ? ideas.filter((i) => i.status === status) : ideas);
      },
    );

    tool(
      'get_idea',
      'Read one research idea in full: summary, evidence (quotes and links), the thread with the user, and your plan for it.',
      { idea: z.string().describe('Idea id, e.g. R7') },
      async ({ idea }) => formatIdeaDetail(await findIdea(idea), now()),
    );

    tool(
      'advise_idea',
      'Answer the user about a research idea: honest cost, where it fits on the roadmap, what it moves. plan = the roadmap changes you will make if they approve, one per item, e.g. ["+ Add goal Moderation queue to M3 (Oct 13-17)", "~ Move M3 due Oct 17 -> 20"].',
      { idea: z.string().describe('Idea id, e.g. R7'), text: z.string().min(1), plan: z.array(z.string().min(1)).optional() },
      async ({ idea, text, plan }) => {
        const body: Record<string, unknown> = { actor: me, text };
        if (plan) body.plan = plan;
        const i = await api<ResearchIdea>(`/api/research/ideas/${enc(upId(idea))}/advice`, { method: 'POST', body });
        return `Advised on ${i?.id ?? upId(idea)}${i?.title ? ` ${clip(i.title, 60)}` : ''}${plan?.length ? ` with a ${plan.length}-step plan` : ''}. The user sees it on the Research page.`;
      },
    );
  }

  async function getResearch(): Promise<ResearchState> {
    const r = await api<ResearchState | null>('/api/research');
    return { runs: r?.runs ?? [], ideas: r?.ideas ?? [] };
  }

  async function findIdea(id: string): Promise<ResearchIdea> {
    const want = upId(id);
    const i = (await getResearch()).ideas.find((x) => x.id.toUpperCase() === want);
    if (!i) throw new Error(`No idea ${id}. list_ideas shows them.`);
    return i;
  }

  // ---- research (scout) ---------------------------------------------------------

  function registerResearch() {
    tool(
      'research_brief',
      'Read the brief for the running research run: the sources to study, focus, depth, the product and its roadmap stages and goals (ids for stage/overlaps), ideas already found (do not repeat them), and the rules. Call it first.',
      {},
      async () => (await api<{ text: string }>('/api/research/brief'))?.text?.trim() || 'No brief: no research run is running.',
    );

    tool(
      'add_idea',
      'Post one idea: a user problem or opportunity backed by evidence, not a feature wish. One call per idea. impact: high, medium, low, or business (helps the business more than users). effort: S, M or L. stage = the roadmap stage it fits (M3); overlaps = an existing goal it overlaps (G9). evidence: 1-8 items, each with kind, source, a short quote (at most 300 chars), url, and count of similar reports.',
      {
        title: z.string().min(1).max(120).describe('The problem in a few words, e.g. "No way to hold posts for review"'),
        summary: z.string().min(1).describe('The problem or opportunity in one or two sentences'),
        impact: z.enum(['high', 'medium', 'low', 'business']),
        effort: z.enum(['S', 'M', 'L']),
        evidence: z.array(evidenceShape).min(1).max(8),
        stage: z.string().optional().describe('Stage id from the brief, e.g. M3'),
        overlaps: z.string().optional().describe('Goal id from the brief it overlaps, e.g. G9'),
      },
      async ({ title, summary, impact, effort, evidence, stage, overlaps }) => {
        const body: Record<string, unknown> = { actor: me, title, summary, impact, effort, evidence };
        if (stage?.trim()) body.stageId = upId(stage);
        if (overlaps?.trim()) body.overlapsGoalId = upId(overlaps);
        const i = await api<ResearchIdea>('/api/research/ideas', { method: 'POST', body });
        return `Added ${formatIdeaLine(i)}`;
      },
    );

    tool(
      'finish_research',
      'End the run once your ideas are posted. summary = one paragraph on what you read and what stood out; sourcesRead = how many pages you read. Muster stops you afterwards.',
      { summary: z.string().min(1), sourcesRead: z.number().int().min(0).optional() },
      async ({ summary, sourcesRead }) => {
        const { runs } = await getResearch();
        const run = runs.find((r) => r.status === 'running' && r.agentId === me) ?? runs.find((r) => r.status === 'running');
        if (!run) throw new Error('No research run is running.');
        const body: Record<string, unknown> = { actor: me, summary };
        if (sourcesRead !== undefined) body.sourcesRead = sourcesRead;
        const r = await api<ResearchRun>(`/api/research/runs/${enc(run.id)}/finish`, { method: 'POST', body });
        const n = (r ?? run).ideaIds?.length ?? 0;
        return `Finished ${r?.id ?? run.id}: ${n} idea${n === 1 ? '' : 's'}. The user has been told. You are done; stop here.`;
      },
    );
  }

  // ---- crew / design ------------------------------------------------------------

  function registerCrew() {
    tool('claim_task', 'Claim the next ready task for your role (oldest first). Returns the task, or nothing if none is ready.', {}, async () => {
      const t = await api<Task | null>('/api/tasks/claim', { method: 'POST', body: { actor: me } });
      if (!t) return 'No ready task for you right now. Check read_board for questions you can answer, or wait for an assignment.';
      // The brief carries the guideline, the station's skills and (at the last working station) the evidence ask.
      const brief = await api<{ text: string }>(`/api/tasks/${enc(t.id)}/brief`).then((b) => b?.text ?? '').catch(() => null);
      const st = brief === null ? await api<StationDef | null>(`/api/stations/${enc(t.stations[t.stationIndex] ?? 'build')}`).catch(() => null) : null;
      const guide = brief ?? (typeof st?.guideline === 'string' ? formatGuideline(st.name, st.guideline, st.skills ?? []) : '');
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
