// Shared types for Muster. This file is the contract between the orchestrator,
// the CLI, muster-mcp, the hooks and the dashboard. Change it deliberately.

export type Role = 'captain' | 'crew' | 'design' | 'human' | 'research'; // research = the scout: reads public pages, posts ideas, never edits code or takes tasks // human = an approval station: nobody claims it, you Approve or Send back from the board

export type AgentStatus =
  | 'starting' // PTY spawned, claude booting
  | 'working' // a prompt is being processed
  | 'idle' // claude finished its turn and waits for input
  | 'waiting' // blocked on another agent (has an open Waiting note)
  | 'stuck' // has an open Stuck note, or is waiting for a permission prompt
  | 'done' // reported its task done, nothing new assigned
  | 'stopped'; // process exited or was stopped

export interface Agent {
  id: string; // "captain", "design", a crew name ("ada", "bea"… or "crew-2" with crewNames "numbers"), or the name given to `muster add <name>`
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
  | 'awaiting_approval' // at a 'human' station: you Approve or Reject from the board
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
  line?: string; // the line preset it was created from
  stations: string[]; // e.g. ["build", "test", "design", "review"]; always ends with "review"
  stationIndex: number; // current station
  status: TaskStatus;
  assignee?: string; // agent id
  branch?: string; // branch that currently carries the work
  reviewedSha?: string; // head commit of `branch` when the Captain requested review; merge merges exactly this commit
  mergeApproval?: { at: string; sha?: string }; // you approved the reviewed commit; the Captain may merge it (merge_task)
  goalId?: string; // roadmap goal this task delivers ("G3"); progress on the roadmap is counted from these
  inputs?: TaskBranchInput[]; // commits the task branch must contain (earlier stations, dependencies); checked before done/review
  evidence?: Evidence[]; // proof the work does what it should (screenshots, test output…); required before ready_for_merge
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  history: TaskEvent[];
}

/** One add_evidence call: files copied from the agent's worktree to .muster/evidence/<task>/<id>/. */
export interface Evidence {
  id: string; // "E1", "E2"… within the task
  station: string; // station the task was at
  by: string; // agent id
  at: string;
  summary: string;
  sha?: string; // HEAD of the agent's worktree when it was attached
  files: EvidenceFile[];
}

export interface EvidenceFile {
  name: string; // file name inside the evidence folder
  kind: 'image' | 'video' | 'text' | 'other';
  bytes: number;
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
  topic?: 'weekly_usage' | 'five_hour' | 'roadmap' | 'research'; // what a system/approval note is about, so the UI can offer the right controls
  dismissed?: boolean; // you removed it from the board (POST /api/notes/:id/dismiss); kept in state for history, hidden by default
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
  weeklyWarned: boolean; // the weekly alert for the current threshold was already posted
  weeklyRemindAt?: number; // "remind me again at N%": the next threshold this week (overrides warnAtWeeklyPct until the reset)
  weeklySnoozedUntil?: string; // "don't remind me again this week": ISO time of the reset; no weekly alerts before it
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
  weeklyAlerts: boolean; // default true; false = "never remind me" (the 5-hour pause still applies)
  shutdownIdleCrew: boolean; // default true: stop a crew agent once its task reaches review and it has nothing else
  defaultStations: string[]; // alias for the default line's stations + review (PATCHing it edits that line)
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
  defaultLine: string; // name of the line new tasks use; default "feature"
  lines: Record<string, { label: string; stations: string[] }>; // your edits and custom lines, merged over the built-ins (no "review")
  crewNames: 'names' | 'numbers'; // new crew are called ada, bea, cleo… ('names') or crew-2, crew-3… ('numbers')
  requireEvidence: boolean; // default true: the Captain can't flag a task ready for merge until it has evidence (add_evidence)
  githubOffer: 'ask' | 'never'; // whether the dashboard offers a GitHub backup once work is merged and there is no remote
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
  roadmap?: Roadmap; // drafted by the Captain before work starts, approved by you
  research?: ResearchState; // scout runs and the ideas they found
  nextIds: { agent: number; task: number; note: number; feed: number; inbox: number; stage: number; goal: number; idea: number; run: number };
}

// ---- Roadmap (src/core/roadmap.ts) ----
// Stage ("M1"…) → goal ("G1"…) → task. The Captain drafts it, you approve it, the
// orchestrator counts progress from tasks and tells the Captain when goals finish.

export type RoadmapStatus = 'draft' | 'approved';
export type StageStatus = 'planned' | 'active' | 'done';
export type GoalStatus = 'planned' | 'active' | 'done' | 'cancelled';

export interface ExitCriterion {
  text: string;
  done: boolean;
  doneAt?: string;
  by?: string; // who ticked it
}

export interface RoadmapStage {
  id: string; // "M1", "M2"…
  title: string;
  description: string;
  start?: string; // planned start, YYYY-MM-DD
  due?: string; // planned end, YYYY-MM-DD
  status: StageStatus;
  exitCriteria: ExitCriterion[];
  goalIds: string[]; // in order
  completedAt?: string;
}

export interface RoadmapGoal {
  id: string; // "G1", "G2"…
  stageId: string;
  title: string;
  description: string;
  status: GoalStatus;
  start?: string; // YYYY-MM-DD
  due?: string; // YYYY-MM-DD
  activatedAt?: string;
  completedAt?: string;
}

export interface Roadmap {
  title: string; // e.g. "wall-education v1.0"
  summary: string; // what the product is, one paragraph
  launchDate?: string; // YYYY-MM-DD
  status: RoadmapStatus;
  revision: number; // bumps on every approval; edits to an approved roadmap that change stages/goals/dates make it a draft again
  approvedAt?: string;
  noteId?: string; // the open approval note while it is a draft waiting for you
  stages: RoadmapStage[]; // in order
  goals: RoadmapGoal[];
  createdBy: string;
  updatedAt: string;
}

export type RoadmapHealth = 'on_track' | 'at_risk' | 'late' | 'not_started' | 'done';

/** Counted by the orchestrator (never stored): GET /api/roadmap → { roadmap, progress }. */
export interface RoadmapProgress {
  overall: { done: number; total: number; percent: number; unlinked?: number }; // done/total = tasks on the roadmap (merged / not cancelled); percent = the stages' percents weighted by goal count; unlinked = live tasks with no goal
  health: RoadmapHealth;
  daysToLaunch?: number;
  currentStageId?: string; // first stage not done
  currentGoalId?: string; // first active goal of the current stage
  // percent: 100 when done; else from its tasks; with no tasks, from ticked exit criteria; else from its goals. basis says which
  stages: Record<string, { done: number; total: number; percent: number; health: RoadmapHealth; criteriaDone: number; criteriaTotal: number; basis?: 'done' | 'tasks' | 'criteria' | 'goals' }>;
  goals: Record<string, { done: number; total: number; percent: number; agents: string[] }>; // percent: from tasks; with none, 100 if the goal is done; agents = holders of its open tasks
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
  defaultStations: ['plan', 'build', 'test', 'review'],
  defaultLine: 'feature',
  lines: {},
  testCommand: 'npm test',
  baseBranch: 'main',
  permissionMode: 'auto',
  vellumEdit: 'ask',
  githubOffer: 'ask',
  crewNames: 'names',
  requireEvidence: true,
  notify: true,
  weeklyAlerts: true,
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
  approval: 'human',
  discover: 'crew',
  concept: 'crew',
  plan: 'crew',
  reproduce: 'crew',
  fix: 'crew',
  'design-check': 'design',
};

/** One station as defined on this machine (GET /api/stations). */
export interface StationDef {
  name: string; // lowercase, e.g. "build"
  role: Role; // which role works it
  builtin: boolean; // build, test, design, review
  guideline: string; // Markdown shown to the agent working the station; '' when none
  skills: string[]; // skills of the Muster plugin (plugin/skills) the worker should use there, e.g. ["evidence-driven-testing"]
}

/** A skill in Muster's plugin (GET /api/skills). */
export interface SkillInfo {
  name: string;
  description: string;
}

/** A line preset: a named station order (GET /api/lines). stations always ends with "review". */
export interface LineDef {
  name: string;
  label: string;
  stations: string[];
  builtin: boolean; // shipped with Muster (edits are still saved per machine)
}

// ---- Research (src/core/research.ts) ----
// You start a run from the Roadmap page; the orchestrator spawns the research agent "scout", which reads public pages
// and posts ideas. You approve, reject, or ask the Captain for advice; an approved idea goes onto the roadmap through
// the Captain without a second roadmap approval.

export interface ResearchSources {
  competitors: string[]; // similar apps to study (names or URLs), e.g. ["Padlet", "Wakelet"]
  reviews: boolean; // app-store / G2 reviews of those apps, low ratings first
  forums: string[]; // e.g. ["r/Teachers", "r/edtech"]; empty = skip Reddit and forums
  ownApp: boolean; // read our own code and roadmap for rough edges
}

export type ResearchRunStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface ResearchRun {
  id: string; // "RR1"
  status: ResearchRunStatus;
  sources: ResearchSources;
  focus?: string; // optional question from you
  depth: 'quick' | 'thorough';
  agentId: string; // "scout"
  startedAt: string;
  finishedAt?: string;
  summary?: string; // scout's one-paragraph wrap-up
  sourcesRead?: number;
  ideaIds: string[];
}

export type IdeaImpact = 'high' | 'medium' | 'low' | 'business';
export type IdeaStatus = 'new' | 'approved' | 'rejected';

export interface IdeaEvidence {
  kind: 'review' | 'forum' | 'competitor' | 'app' | 'web';
  source: string; // "App Store review · Padlet · 2★", "r/Teachers · 412 upvotes", "Wakelet public roadmap"
  text?: string; // a short quote or finding (≤ 300 chars)
  url?: string;
  count?: number; // "+37 similar"
}

export interface IdeaMessage {
  at: string;
  from: string; // "you" or "captain"
  text: string;
}

export interface ResearchIdea {
  id: string; // "R1", "R2"…
  runId: string;
  title: string;
  summary: string; // the problem/opportunity in one or two sentences
  impact: IdeaImpact;
  effort: 'S' | 'M' | 'L';
  stageId?: string; // stage it fits, as scout suggests
  overlapsGoalId?: string; // an existing goal it overlaps
  evidence: IdeaEvidence[];
  status: IdeaStatus;
  thread: IdeaMessage[]; // your questions and the Captain's advice
  plan?: string[]; // Captain's proposed roadmap changes on approve, e.g. ["+ Add goal Moderation queue to M3 (Oct 13–17)", "~ Move M3 due Oct 17 → 20"]
  goalId?: string; // the goal the Captain created for it after you approved
  decidedAt?: string;
  createdAt: string;
}

export interface ResearchState {
  runs: ResearchRun[];
  ideas: ResearchIdea[];
}
