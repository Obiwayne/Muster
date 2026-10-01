// Shared types for Muster. This file is the contract between the orchestrator,
// the CLI, muster-mcp, the hooks and the dashboard. Change it deliberately.

export type Role = 'captain' | 'crew' | 'design' | 'human'; // human = an approval station: nobody claims it, you Approve or Send back from the board

export type AgentStatus =
  | 'starting' // PTY spawned, claude booting
  | 'working' // a prompt is being processed
  | 'idle' // claude finished its turn and waits for input
  | 'waiting' // blocked on another agent (has an open Waiting note)
  | 'stuck' // has an open Stuck note, or is waiting for a permission prompt
  | 'done' // reported its task done, nothing new assigned
  | 'stopped'; // process exited or was stopped

export interface Agent {
  id: string; // "captain", "crew-2", "crew-3", or the name given to `muster add <name>`
  role: Role;
  model: string; // "opus" | "sonnet" | full model id
  branch: string; // "main" for the captain, "<id>/<slug>" for crew
  worktree: string; // absolute path; the repo root for the captain
  status: AgentStatus;
  taskId?: string; // task currently held
  sessionId: string; // claude --session-id, reused with --resume on restart
  pid?: number;
  startedAt: string; // ISO time
  lastActivityAt: string; // ISO time of last PTY output or hook event
  lastPromptAt?: string; // ISO time of the last UserPromptSubmit hook
  costUsd: number; // latest cost.total_cost_usd reported by this agent's status line
}

export type TaskStatus =
  | 'blocked' // waiting on dependsOn tasks
  | 'ready' // can be claimed
  | 'in_progress' // held by an agent at stations[stationIndex]
  | 'review' // at the Captain's review station
  | 'ready_for_merge' // Captain called request_review; waiting for the human
  | 'merged'
  | 'cancelled';

export interface TaskEvent {
  at: string;
  agentId: string;
  kind: 'created' | 'claimed' | 'assigned' | 'handoff' | 'done' | 'review_requested' | 'merged' | 'cancelled' | 'note';
  text?: string;
}

export interface Task {
  id: string; // "T1", "T2", ...
  title: string;
  description: string;
  dependsOn: string[]; // task ids that must be ready_for_merge or merged first
  stations: string[]; // e.g. ["build", "test", "design", "review"]; always ends with "review"
  stationIndex: number; // current station
  status: TaskStatus;
  assignee?: string; // agent id
  branch?: string; // branch that currently carries the work
  reviewedSha?: string; // head commit of `branch` when the Captain requested review; merge merges exactly this commit
  inputs?: TaskBranchInput[]; // commits the task branch must contain (earlier stations, dependencies); checked before done/review
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  history: TaskEvent[];
}

/** Work a task branch has to contain: the branch of an earlier station, or a dependency's reviewed commit. */
export interface TaskBranchInput {
  branch: string;
  sha: string;
  kind: 'station' | 'dependency';
  taskId?: string; // the dependency's task id
}

export type NoteType =
  | 'stuck'
  | 'question'
  | 'waiting'
  | 'progress'
  | 'done'
  | 'review' // Ready for review: posted by the Captain, acted on by the human
  | 'approval' // a task waits at a 'human' station: acted on by the human (Approve / Send back)
  | 'escalation' // Captain asking the human
  | 'message' // direct message between agents; shown on the board, never "open"
  | 'system'; // posted by the orchestrator (usage warnings, pauses, crashes)

export interface NoteReply {
  at: string;
  from: string; // agent id, or "you" for the human
  text: string;
}

export interface Note {
  id: string; // "N1", "N2", ...
  type: NoteType;
  from: string; // agent id, "you" or "muster"
  to?: string; // for message / waiting (the agent it waits on)
  taskId?: string;
  branch?: string;
  text: string;
  createdAt: string;
  open: boolean; // stuck/question/waiting/review/escalation start open; others start closed
  closedAt?: string;
  replies: NoteReply[];
}

// One line in the Crew chat log. Appended by the orchestrator for every message,
// note reply, note posted, task claim/assign/handoff/done/review, merge and agent start/stop.
export interface FeedItem {
  id: string; // "F1", "F2", ...
  at: string;
  kind: 'message' | 'reply' | 'note' | 'event';
  from: string; // agent id, "you" or "muster"
  to?: string; // agent id or "everyone" (messages)
  noteId?: string; // reply/note: the note it belongs to
  noteType?: NoteType; // note: the type of note posted
  taskId?: string;
  text: string;
}

// Something waiting to be delivered to an agent. Delivered by typing a short
// "[muster] ..." line into its terminal when it is idle, and returned by read_inbox().
export interface InboxItem {
  id: string; // "I1", ...
  at: string;
  agentId: string; // recipient
  from: string;
  kind: 'message' | 'reply' | 'note' | 'assignment' | 'handoff' | 'review' | 'system';
  text: string;
  noteId?: string;
  taskId?: string;
  read: boolean;
  delivered: boolean; // nudged into the terminal
}

export interface RateWindow {
  usedPercentage: number; // 0-100
  resetsAt?: string; // ISO time
}

export interface UsageState {
  fiveHour?: RateWindow;
  sevenDay?: RateWindow;
  updatedAt?: string;
  perAgentCostUsd: Record<string, number>;
  paused: boolean; // fiveHour >= config.pauseAtFiveHourPct
  weeklyWarned: boolean; // sevenDay >= config.warnAtWeeklyPct (warning note already posted)
}

/** One Vellum file as shown on the Vellum boards page. */
export interface VellumFile {
  id: string;
  name: string;
  pages: number;
  updated?: string; // ISO
}

/** GET /api/vellum: the Vellum MCP connection and its files. */
export interface VellumStatus {
  status: 'connected' | 'not_configured' | 'unreachable' | 'error';
  message?: string;
  checkedAt: string; // ISO
  files: VellumFile[];
}

/** Design crew and Vellum: edit only when the Captain asks (default), whenever the task needs it, or never (enforced). */
export type VellumEdit = 'ask' | 'always' | 'never';

export interface MusterConfig {
  port: number; // default 47800
  captainModel: string; // default "opus"
  crewModel: string; // default "sonnet"
  designModel: string; // default "sonnet"
  maxCrew: number; // default 3 (crew running at once, not counting the captain or design crew)
  pauseAtFiveHourPct: number; // default 80
  warnAtWeeklyPct: number; // default 75
  shutdownIdleCrew: boolean; // default true: stop a crew agent once its task reaches review and it has nothing else
  defaultStations: string[]; // default ["build", "review"]
  testCommand: string; // default "npm test"
  baseBranch: string; // default "main"
  permissionMode: string; // claude --permission-mode for every agent; default "auto" (handles prompts unattended; the worktree guard hook still applies)
  claudePath?: string; // absolute path to claude executable; auto-detected when missing
  vellum?: { command: string; args: string[]; env?: Record<string, string> }; // MCP server for the design crew
  notify: boolean; // default true: Windows toast when a branch is ready or the Captain escalates
  allowedTools: string[]; // passed as permissions.allow in each agent's settings so crew can work unattended
  projectName?: string; // shown under "Muster" in the dashboard; defaults to the repo folder name
  vellumEdit: VellumEdit; // whether the design crew may change Vellum designs; 'never' is enforced by denying Vellum's editing tools
  vellumFile?: string; // id of the Vellum file holding the design framework; the design crew's prompt names it (else it finds it with list_files)
  userName?: string; // what agents call the person running Muster; stored per OS user (core/user.ts), not in config.json
}

export interface MusterState {
  version: 1;
  repoRoot: string;
  agents: Agent[];
  tasks: Task[];
  notes: Note[];
  feed: FeedItem[];
  inbox: InboxItem[];
  usage: UsageState;
  goal?: { text: string; at: string }; // last goal given to the Captain (muster ask)
  nextIds: { agent: number; task: number; note: number; feed: number; inbox: number };
}

// Events pushed over ws://127.0.0.1:<port>/ws/events
export type MusterEvent =
  | { type: 'state'; state: MusterState; config: MusterConfig } // full snapshot, sent on connect and after every change
  | { type: 'toast'; level: 'info' | 'warn'; text: string };

// Messages on ws://127.0.0.1:<port>/ws/term/<agentId>
// server -> client: raw terminal output as text frames (a backlog replay first)
// client -> server: JSON text frames
export type TermClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export const OPEN_BY_DEFAULT: NoteType[] = ['stuck', 'question', 'waiting', 'review',  'approval', 'escalation'];

export const DEFAULT_CONFIG: MusterConfig = {
  port: 47800,
  captainModel: 'opus',
  crewModel: 'sonnet',
  designModel: 'sonnet',
  maxCrew: 3,
  pauseAtFiveHourPct: 80,
  warnAtWeeklyPct: 75,
  shutdownIdleCrew: true,
  defaultStations: ['build', 'review'],
  testCommand: 'npm test',
  baseBranch: 'main',
  permissionMode: 'auto',
  vellumEdit: 'ask',
  notify: true,
  allowedTools: [
    'Bash(npm *)', // no Bash(node *) / Bash(npx *): either runs arbitrary code without a prompt
    'Bash(git status*)',
    'Bash(git diff*)',
    'Bash(git log*)',
    'Bash(git add*)',
    'Bash(git commit*)',
    'Bash(git show*)',
    'Bash(git merge*)',
    'Bash(ls*)',
    'Bash(cat *)',
    'mcp__muster__*',
  ],
};

// Which role works each station. Unknown station names are worked by crew.
export const STATION_ROLE: Record<string, Role> = {
  build: 'crew',
  test: 'crew',
  design: 'design',
  review: 'captain',
};

/** One station as defined on this machine (GET /api/stations). */
export interface StationDef {
  name: string; // lowercase, e.g. "build"
  role: Role; // which role works it
  builtin: boolean; // build, test, design, review
  guideline: string; // Markdown shown to the agent working the station; '' when none
}
