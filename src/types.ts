// Shared types for Muster. This file is the contract between the orchestrator,
// the CLI, muster-mcp, the hooks and the dashboard. Change it deliberately.

export type Role = 'captain' | 'crew' | 'design' | 'human' | 'research' | 'qa'; // qa = the standing QA agent (id "qa", outside maxCrew): scores a task's diff at the locked qa station before review, never edits code // research = the scout: reads public pages, posts ideas, never edits code or takes tasks // human = an approval station: nobody claims it, you Approve or Send back from the board

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
  qa?: TaskQa; // the QA gate's state: rounds run and the latest verdict
  evidence?: Evidence[]; // proof the work does what it should (screenshots, test output…); required before ready_for_merge
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  history: TaskEvent[];
}

/** One thing the QA agent wants changed. */
export interface QaFinding {
  file: string;
  line?: number;
  problem: string;
  fix: string;
}

export interface QaRubric {
  correct: number;
  tested: number;
  clean: number;
  scoped: number;
  safe: number;
}

/** The QA agent's verdict on one pass: `score` is the lowest rubric score (1-5; 5 passes). */
export interface QaVerdict {
  score: 1 | 2 | 3 | 4 | 5;
  at: string;
  findings: QaFinding[];
  rubric: QaRubric;
}

/** One finished QA round, kept in Task.qa.history. */
export interface QaRound {
  round: number;
  score: number;
  at: string;
}

/** The QA gate on a task: `round` counts QA passes, `escalated` is set when the builder and QA could not agree, `last` is the latest verdict. */
export interface TaskQa {
  round: number;
  escalated?: boolean;
  last?: QaVerdict;
  history: QaRound[]; // empty by default; one entry per verdict
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
  topic?: 'weekly_usage' | 'five_hour' | 'roadmap' | 'research' | 'intel' | 'checkout' | 'stale_build' | 'remote'; // what a system/approval note is about, so the UI can offer the right controls
  dismissed?: boolean; // you removed it from the board (POST /api/notes/:id/dismiss); kept in state for history, hidden by default
  closedAt?: string;
  replies: NoteReply[];
  intel?: IntelJobNote; // topic 'intel': the "research is ready" / "stopped early" note of a finished intel job (the board shows its chips and actions)
  ask?: AskQuestion[]; // an escalation made from the Captain's AskUserQuestion menu (POST /api/ask-user), answered with POST /api/notes/:id/answer
  answers?: AskAnswer[]; // set once you answered the ask
}

/** Claude Code's AskUserQuestion menu as the Captain asked it, turned into a Needs-you note. See docs/ASK.md. */
export interface AskOption { label: string; description?: string }
export interface AskQuestion { header: string; question: string; multiSelect: boolean; options: AskOption[] }
export interface AskAnswer { header: string; choices: string[]; other?: string }

/** What a finished (or stopped) competitor / sweep / watch job found, carried by its Bulletin board note. Counts are taken when it ended. */
export interface IntelJobNote {
  jobId: string; // "IJ3"
  kind: IntelJobKind;
  outcome: 'ready' | 'stopped'; // done → ready; failed, or cancelled by the Captain → stopped
  competitorIds: string[];
  names: string[]; // their names, for the title
  sources: number; // sourcesRead, else pages browsed
  durationMs: number; // startedAt → finishedAt
  claims: number; // records this job wrote
  areas: number; // research areas it covered (with at least one claim)
  gaps: number; // feature-matrix verdicts vs these competitors
  edges: number;
  open: number;
  ideas: number; // intel ideas (opportunities) this job raised
  reasons?: string[]; // stopped: honest reasons ("g2.com blocked the research browser; read its public page instead", "Reddit not signed in")
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
  reactions?: FeedReaction[]; // emoji reactions from agents and you (POST /api/feed/:id/react toggles one)
  readBy?: string[]; // agents that read the inbox item(s) this message produced (read_inbox / mark read), in order
  via?: RemoteVia; // sent through the remote connector (docs/REMOTE.md): crew chat shows it as yours with a "via Claude" chip
}

/** A message you sent from the Claude app through the remote connector. Only your own token may set it. */
export interface RemoteVia {
  client: string; // the connector client's name, e.g. "Claude"
  approvedOn: 'phone' | 'desktop' | 'not held'; // where you tapped Send ('not held' = the hold was switched off)
  approvedAt: string;
  pendingId?: string; // the held write it was ("P8"), for the chip's tooltip
}

/** The emoji agents and you can react with; each means something on the crew chat. */
export const REACTION_EMOJI = ['👍', '👀', '✅', '🙌', '❓'] as const; // read · looking into it · done/resolved · thanks · unclear
export type ReactionEmoji = (typeof REACTION_EMOJI)[number];

export interface FeedReaction {
  emoji: ReactionEmoji;
  by: string; // agent id or "you"
  at: string;
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
  feedId?: string; // the crew-chat line it came from (messages, replies, notes), so reading it marks feed.readBy
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
  researchBrowser: ResearchBrowserConfig; // how scout browses (src/browser); loadConfig deep-merges it over the default
  intel: IntelConfig; // competitive intelligence settings; loadConfig deep-merges it over the default
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
  intelCheckId?: string; // the intel check (IC4) of the idea this goal delivers; set when add_goal/update_goal links an idea that has one
}

export interface Roadmap {
  title: string; // e.g. "wall-education v1.0"
  summary: string; // what the product is, one paragraph
  launchDate?: string; // YYYY-MM-DD
  status: RoadmapStatus;
  revision: number; // bumps on approval and on every replan after it (once approved, the Captain's changes apply without asking)
  approvedAt?: string;
  noteId?: string; // the open approval note while it is a draft waiting for you
  stages: RoadmapStage[]; // in order
  goals: RoadmapGoal[];
  createdBy: string;
  updatedAt: string;
  statusLine?: RoadmapStatusLine; // the Captain's latest "where we are" line (roadmap_status), shown on the Roadmap page and phone
}

/** One or two plain sentences from the Captain on where the project stands; replaced on every post. */
export interface RoadmapStatusLine {
  text: string;
  at: string;
  by: string;
  taskId?: string; // the merged task that prompted it
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
  | { type: 'toast'; level: 'info' | 'warn'; text: string }
  | { type: 'intel'; rev: number; summary: IntelSummary }; // .muster/intel.json changed: refetch GET /api/intel if you show it

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
  researchBrowser: { mode: 'profile', channel: 'chrome', operaAllow: [], minDelayMs: 3000, maxPagesPerJob: 150, visibleSites: [] },
  intel: { recheck: 'weekly', checkMaxAgeDays: 14 },
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
  qa: 'qa',
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
  locked?: boolean; // qa and review: always on every line, role fixed, can't be removed
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
  browse?: BrowseMode; // how scout may browse in this run (absent on runs from before the research browser = 'public')
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
  origin?: 'research' | 'intel'; // absent = 'research'. 'intel' = a gap / open space / edge scout raised from competitive intelligence (runId is then the intel job, IJ3)
  opportunity?: IntelOpportunity; // origin 'intel' only: the opportunity fields shown on Intel → Opportunities
  checkId?: string; // the latest intel check of this idea (IC4); approving needs a done, fresh one (see Competitive intelligence)
  watchId?: string; // the re-check watch set up when it was approved (W2)
  decidedAt?: string;
  createdAt: string;
}

export interface ResearchState {
  runs: ResearchRun[];
  ideas: ResearchIdea[];
}

// ---- Competitive intelligence (src/core/intel.ts, src/core/intelcheck.ts, src/browser/*) ----
// You track competitors on the Intel page; scout researches them (intel jobs) and records labelled, sourced, dated
// findings through MCP tools. Everything lives in .muster/intel.json (IntelStore), not in state.json, so the state
// snapshot stays small; a `{ type: 'intel' }` event tells the dashboard to refetch. Gaps and open spaces become
// research ideas (origin 'intel'); every idea approval needs one shared intel check, and approved ideas are re-checked.

/** How scout may browse: Muster's own research browser profile (signed in to sites you chose), anonymous public pages, or cookies imported from Opera for allow-listed sites. */
export type BrowseMode = 'profile' | 'public' | 'opera';

/** config.researchBrowser */
export interface ResearchBrowserConfig {
  mode: BrowseMode; // the default answer to "How should scout browse?" (default 'profile')
  channel: 'chrome' | 'msedge'; // installed browser playwright-core launches (default 'chrome'); Muster never downloads one
  operaAllow: string[]; // registrable domains whose Opera cookies may be imported, e.g. ["reddit.com"]; empty = Opera mode imports nothing
  minDelayMs: number; // at least this long between two page loads on the same domain (default 3000)
  maxPagesPerJob: number; // browse calls allowed per intel job or research run (default 150)
  /**
   * Deprecated input only: the visible-window list is shared by every project on this PC (ResearchBrowserStatus.visibleSites,
   * POST /api/browser/visible). A ResearchBrowser takes these domains over once when it starts; PATCH /api/config still
   * accepts the field and applies its changes to the shared list.
   */
  visibleSites: string[];
}

/** config.intel */
export interface IntelConfig {
  recheck: WatchCadence; // cadence of the re-check watch set up when an idea is approved (default weekly)
  checkMaxAgeDays: number; // an intel check older than this is stale: approval asks for a fresh one (default 14)
  companiesHouseKey?: string; // optional Companies House API key; without it the probe reads the public search pages
}

export type IntelLabel = 'fact' | 'opinion' | 'prediction'; // Fact / Customer opinion / Prediction (the legend on every Intel tab)
export type IntelConfidence = 'high' | 'medium' | 'low';
export type IntelArea =
  | 'features' | 'roadmap' | 'reviews' | 'gaps' | 'audience' | 'pricing' | 'marketing' | 'team' | 'ai' | 'financials' | 'org';
/** The research areas you can tick in "Add a competitor", in display order. */
export const INTEL_AREAS: IntelArea[] = ['features', 'roadmap', 'reviews', 'gaps', 'audience', 'pricing', 'ai', 'financials', 'team', 'marketing', 'org'];
export type WatchCadence = 'off' | 'daily' | 'weekly' | 'monthly';

export type IntelSourceKind =
  | 'site' | 'pricing' | 'roadmap' | 'changelog' | 'help' | 'app_store' | 'google_play' | 'g2' | 'capterra' | 'reddit' | 'forum'
  | 'linkedin' | 'youtube' | 'tiktok' | 'instagram' | 'x' | 'facebook' | 'companies_house' | 'jobs' | 'press' | 'rss' | 'own_app' | 'other';

/** Where a claim comes from. A claim with no source is refused (400). */
export interface IntelSource {
  kind: IntelSourceKind;
  title: string; // "App Store · Padlet · 2★", "Wakelet public roadmap", "Companies House filing history"
  url?: string; // required unless kind is 'own_app'
  publishedAt?: string; // YYYY-MM-DD the source itself carries (review date, post date), when it has one
  seenAt: string; // YYYY-MM-DD scout read it (server fills today when missing)
  via?: BrowseMode; // how it was read: 'profile'/'opera' = behind a login
}

/**
 * The rule for every significant conclusion: label, confidence, sources, date and what it means for us.
 * Predictions also need `prediction` (signals, timeframe, what would change it), else 400.
 */
export interface IntelClaim {
  label: IntelLabel;
  confidence: IntelConfidence;
  sources: IntelSource[]; // 1–12
  asOf: string; // YYYY-MM-DD the claim holds for
  implication?: string; // "what it means for us": required on insights, changes, opportunities and check verdicts
  prediction?: { signals: string[]; timeframe: string; wouldChange: string }; // label 'prediction' only
}

/** A tracked company. "us" (id 'us', isUs) is created automatically from config.projectName and the roadmap. */
export interface IntelCompetitor {
  id: string; // slug: "padlet", "wakelet"; 'us' is reserved
  name: string;
  url: string; // home page
  isUs?: boolean;
  colour: number; // chart/chip colour slot 0–7, assigned on add so every chart keeps the same colour per company
  tagline?: string;
  identity?: {
    legalName?: string; // "Boardly Learning Ltd"
    matchedFrom?: string; // "site footer and privacy policy"
    companiesHouse?: { number: string; status: string; incorporated?: string; registeredOffice?: string; url: string };
  };
  sources: IntelSiteSource[]; // where scout will look ("Public roadmap · Canny")
  areas: IntelArea[]; // what to research
  watch: WatchCadence; // keep watching: scheduled re-sweeps for changes
  browse: BrowseMode;
  addedAt: string;
  lastSweptAt?: string;
  removed?: boolean; // DELETE keeps its findings for history; hidden from chips and the matrix
}

/** A place to look for one competitor (found by the probe or added by you). */
export interface IntelSiteSource {
  kind: IntelSourceKind;
  url: string;
  label?: string; // "Public roadmap"
  note?: string; // "Canny", "4.1★ · 2.3k", "41 mentions"
}

/** What POST /api/intel/probe finds from a pasted URL in a few seconds, without an agent. Nothing is saved. */
export interface IntelProbe {
  url: string; // normalised home page
  found: boolean;
  name?: string;
  tagline?: string;
  suggestedId?: string;
  legal: { name: string; matchedFrom: string }[]; // legal names seen on the site (footer, privacy, terms)
  companies: { number: string; name: string; status: string; incorporated?: string; address?: string; url: string }[]; // Companies House candidates, best first
  sources: IntelSiteSource[]; // links found: pricing, roadmap, changelog, store pages, socials
  notes: string[]; // what failed or was skipped ("site blocks anonymous requests")
}

/** Per-cell status in the feature matrix. 'planned' needs `stageId` for us or `planNote` for them. */
export type CapabilityStatus = 'yes' | 'partial' | 'paid' | 'none' | 'planned' | 'missing'; // missing = we checked and it isn't there; none = no sign of it
/** Gap = they have it, we don't (red). Edge = we have it (or have it planned) and they don't (green). Open = nobody has it (blue, be first). */
export type CapabilityVerdict = 'gap' | 'edge' | 'open' | 'parity';

export interface CapabilityCell extends IntelClaim {
  status: CapabilityStatus;
  note?: string; // "3 walls", "Credits"
  stageId?: string; // us + planned: the roadmap stage (from the linked goal)
  planNote?: string; // them + planned: "public roadmap, Q1"
}

/** One row of the feature matrix. `verdict*` are computed (capabilityVerdict in core/intelcheck.ts), never sent by scout. */
export interface IntelCapability {
  id: string; // "F1"
  name: string; // "Approve posts before live"
  group?: string; // "Moderation", "Sharing"
  cells: Record<string, CapabilityCell>; // competitor id → cell; 'us' included
  goalId?: string; // our roadmap goal for it; the us cell follows the goal (planned while open, yes when done)
  ideaId?: string; // the idea (R12) raised for a gap/open row
  verdict: CapabilityVerdict;
  verdictVs: string[]; // gap: competitors that have it; edge: competitors that lack it
  verdictStage?: string; // gap we plan to close ("M5") / edge we are building and nobody has ("M3")
  updatedAt: string;
}

/** A complaint (or "what they love") theme across reviews, forums and social comments. Customer opinion by definition. */
export interface IntelTheme extends IntelClaim {
  id: string; // "TH1"
  title: string;
  love?: boolean; // a "What they love" theme
  mentions: number; // mentions in the reviewed sample
  sampleSize: number; // size of that sample (IntelStore.sample.total); share = mentions / sampleSize
  independentSources: number; // distinct authors/threads; under 5 the UI shows it as "thin evidence", never as a finding
  byCompetitor: Record<string, number>; // competitor id → mentions
  severity: 'severe' | 'high' | 'medium' | 'low';
  trend: 'rising' | 'steady' | 'easing' | 'new';
  trendNote?: string; // "rising since Jun"
  who?: string; // affected customer type
  workaround?: string;
  quotes: { text: string; source: IntelSource }[]; // ≤ 300 chars each, ≤ 6
  ourAnswer?: { kind: 'edge' | 'opportunity' | 'watch' | 'win_over'; text: string; ideaId?: string; goalId?: string };
}

/** The reviewed sample themes are counted against ("412 reviews + 63 threads, last 12 months"). */
export interface IntelSample {
  window: string; // "last 12 months"
  counts: { kind: IntelSourceKind | 'social_comments'; label: string; n: number }[];
  total: number;
  asOf: string;
}

export interface IntelSocialChannel extends IntelClaim {
  competitorId: string;
  channel: 'youtube' | 'tiktok' | 'instagram' | 'linkedin' | 'reddit' | 'x' | 'facebook';
  presence: 'active' | 'dormant' | 'absent';
  url?: string;
  followers?: number;
  cadence?: string; // "2 / wk"
  contentType?: string; // "tutorials", "hacks", "district sales"
  replies?: string; // Reddit/comment behaviour: "Staff reply ~2 days", "41 unanswered"
  dormantFor?: string; // "14 mo"
}

/** Social insights; engagement is attention, not sales (the UI says so under the panel). */
export interface IntelSocialInsight extends IntelClaim {
  id: string; // "SO1"
  kind: 'engagement' | 'comment_complaint' | 'win';
  text: string;
  competitorId?: string;
  metric?: string; // "8× avg views", "1.2k likes"
}

/** A competitor's plan: a public commitment (roadmap, announcement) or our prediction (needs signals, confidence, timeframe, what would change it). */
export interface IntelPlan extends IntelClaim {
  id: string; // "PL1"
  competitorId: string;
  title: string;
  kind: 'commitment' | 'prediction'; // commitment ⇒ label 'fact'; prediction ⇒ label 'prediction'
  status?: 'planned' | 'in_progress' | 'shipped' | 'dropped';
  timeframe?: string; // "Q1 2027"
  capabilityIds: string[];
}

/** Anything else scout learned, per area: audience (claimed vs evidenced), pricing tiers, team & hiring, AI claims, marketing, org. */
export interface IntelFinding extends IntelClaim {
  id: string; // "IF1"
  competitorId?: string; // absent = market-wide
  area: IntelArea;
  title: string;
  detail?: string;
  facts?: Record<string, string>; // small key/value table: { "Claimed": "teachers", "Evidenced": "district buyers" }, { "Price": "£8/mo", "Limit": "3 walls" }
  aiStatus?: 'verified' | 'claimed'; // area 'ai': seen working vs marketing claim only
  partial?: boolean; // team/org: public view only (the server sets it for those areas)
}

/** A realistic cost scenario ("30-teacher school for a year") with its assumptions. */
export interface IntelScenario extends IntelClaim {
  id: string; // "PS1"
  name: string;
  assumptions: string[];
  costs: Record<string, { amount?: number; currency: string; period: 'month' | 'year' | 'once'; note?: string }>; // competitor id → cost; no amount = not sold / needs a quote
}

/** UK public filings (Companies House). Shown with its limits: small companies file abridged accounts, no revenue. */
export interface IntelFiling extends IntelClaim {
  competitorId: string;
  companyNumber: string;
  status: string; // "Active", "Active · proposal to strike off"
  incorporated?: string;
  accountsType?: string; // "micro-entity", "small", "full"
  accountsMadeUpTo?: string;
  accountsDue?: string;
  overdue?: boolean;
  officers?: number;
  pscs?: string[]; // persons with significant control, names only
  figures?: Record<string, string>; // what the accounts actually show: { "Net assets": "£412k" }
  limits: string; // what this data can't tell you
}

/** The positioning map: scout's axes, points and assumptions. */
export interface IntelPositioning extends IntelClaim {
  title: string; // "Price for a 30-teacher school vs. classroom safety"
  x: { label: string; min: string; max: string };
  y: { label: string; min: string; max: string };
  points: { competitorId: string; x: number; y: number; future?: boolean; label?: string }[]; // 0..1; future = "us after M3"
  openSpace?: { x0: number; y0: number; x1: number; y1: number; label: string };
  assumptions: string[];
}

/** "What this means for us" decision cards on the overview. */
export interface IntelInsight extends IntelClaim {
  id: string; // "IN1"
  kind: 'match' | 'advantage' | 'audience' | 'test'; // Match · customers expect it / Clear advantage / Underserved audience / Test before building
  title: string;
  detail: string;
  ideaId?: string;
}

/** Dated change log: what changed, why it matters, does the plan need to respond. */
export interface IntelChange extends IntelClaim {
  id: string; // "IX1"
  at: string; // YYYY-MM-DD it changed (or was noticed)
  competitorId: string;
  area: IntelArea;
  title: string; // "Padlet raised Pro to £8/mo"
  planImpact: 'none' | 'watch' | 'respond';
  suggestion?: string; // the Captain's suggestion when planImpact is 'respond'
  ideaId?: string; // the idea/goal it threatens or supports
  goalId?: string;
  seen: boolean; // you opened it (POST /api/intel/changes/seen); unseen 'respond' changes count toward the nav badge
  jobId?: string;
}

/** The opportunity fields on an intel idea (ResearchIdea.opportunity). */
export interface IntelOpportunity {
  kind: 'gap' | 'open' | 'edge'; // edge = "where we win · protect this"
  capabilityIds: string[];
  problem: string; // customer problem
  alternatives: string; // what they do today
  proposal: string; // proposed improvement
  value: string; // customer value
  effortNote: string; // effort & dependencies ("Medium · ~5 tasks · needs Google OAuth review")
  priority: 'now' | 'next' | 'later' | 'parked';
  validation: string; // how we'd validate before/while building
  valueScore: number; // 1–5, scout's estimate from evidence (value-vs-effort matrix)
  effortScore: number; // 1–5, scout's estimate until the Captain advises (advise_idea effort)
  testFirst?: boolean; // "Test before building"
  atRisk?: string; // edge only: who threatens it ("Wakelet building it")
  claim: IntelClaim; // label/confidence/sources/implication of the opportunity as a whole
}

export type IntelCheckArea = 'features' | 'complaints' | 'social' | 'plans' | 'pricing' | 'audience' | 'ai';
export const INTEL_CHECK_AREAS: IntelCheckArea[] = ['features', 'complaints', 'social', 'plans', 'pricing', 'audience', 'ai'];
export type IntelVerdict = 'gap' | 'edge' | 'edge_at_risk' | 'open' | 'parity' | 'unclear';

/** One row of an intel check: what scout found for one area, with its label and sources. */
export interface IntelCheckRow extends IntelClaim {
  area: IntelCheckArea;
  finding: string; // "Padlet partial · Linoit none", "#1 theme · 22% · rising"
  signal: 'supports' | 'against' | 'neutral' | 'threat'; // threat = a competitor is heading there (their plans)
  changed?: boolean; // re-check: differs from the previous revision
}

/**
 * The one shared intel check every idea passes before you approve it (Research ideas and Intel → Opportunities alike).
 * Written by scout with intel_check; re-checked by the watch after approval.
 */
export interface IntelCheck {
  id: string; // "IC1"
  ideaId: string;
  revision: number; // 1, then +1 per re-check (earlier revisions are summarised in `history`)
  status: 'queued' | 'running' | 'done' | 'skipped' | 'failed';
  rows: IntelCheckRow[]; // at most one per INTEL_CHECK_AREAS; coverage = rows.length of 7
  verdict: IntelVerdict; // computed from capabilityIds when given (core/intelcheck.ts), else scout's
  verdictText: string; // "Build before Wakelet ships, or lose the edge."
  confidence: IntelConfidence;
  sourceCount: number; // distinct source urls across rows
  capabilityIds: string[];
  watchFor?: string; // what would change the verdict; becomes the watch's alert line ("Wakelet ships post approval")
  skippedReason?: string; // status 'skipped': e.g. "no competitors tracked"
  jobId?: string;
  createdAt: string;
  doneAt?: string;
  goalId?: string; // set when the idea's goal is created
  history: { revision: number; verdict: IntelVerdict; confidence: IntelConfidence; doneAt: string; changedAreas: IntelCheckArea[] }[];
}

/** A scheduled re-check of an approved idea, or a competitor's keep-watching sweep. */
export interface IntelWatch {
  id: string; // "W1"
  subject: { kind: 'idea'; ideaId: string } | { kind: 'competitor'; competitorId: string };
  cadence: WatchCadence;
  alertOn?: string; // "alert if Wakelet changes"
  nextAt: string; // ISO
  lastAt?: string;
  lastJobId?: string;
  active: boolean;
}

export type IntelJobKind = 'competitor' | 'sweep' | 'check' | 'recheck' | 'watch';
export type IntelJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** One piece of scout work. Jobs run one at a time, never alongside a research run, never while paused. */
export interface IntelJob {
  id: string; // "IJ1"
  kind: IntelJobKind; // competitor = first research of a new competitor; sweep = "Run sweep" over all; check/recheck = an intel check; watch = a cadence re-sweep for changes
  status: IntelJobStatus;
  competitorIds: string[];
  areas: IntelArea[];
  ideaId?: string; // check / recheck
  checkId?: string;
  watchId?: string;
  browse: BrowseMode;
  depth: 'quick' | 'thorough';
  by: string; // "you", "captain" or "schedule"
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  sourcesRead?: number;
  pagesBrowsed: number; // research browser calls so far (capped by researchBrowser.maxPagesPerJob)
  error?: string;
  progress?: IntelJobProgress; // what this job has written and read so far (the Intel page's research-in-progress overlay)
}

/** Per-job progress counters, kept by the server as scout records and browses (cheap: counts, the latest claim, the last page). */
export interface IntelJobProgress {
  claims: number; // record_intel / add_opportunity calls during this job
  areas: Partial<Record<IntelArea, number>>; // claims per research area (capability → features, theme → reviews, plan → roadmap, …)
  current?: IntelArea; // the area of the latest claim: the "current" chip
  latest?: { text: string; label: IntelLabel; at: string }; // "Latest: “Figma Dev Mode moved to paid seats” · fact"
  reading?: { url: string; site: string; at: string }; // the last page browsed ("App Store")
  blocked?: string[]; // domains that answered with a bot check during this job
  notSignedIn?: string[]; // known login sites (labels) read without a login during this job
}

/** .muster/intel.json */
export interface IntelStore {
  version: 1;
  rev: number; // +1 on every save; carried by the 'intel' event
  competitors: IntelCompetitor[];
  capabilities: IntelCapability[];
  themes: IntelTheme[];
  sample?: IntelSample;
  social: IntelSocialChannel[];
  socialInsights: IntelSocialInsight[];
  plans: IntelPlan[];
  findings: IntelFinding[];
  scenarios: IntelScenario[];
  filings: IntelFiling[];
  positioning?: IntelPositioning;
  insights: IntelInsight[];
  changes: IntelChange[];
  checks: IntelCheck[];
  watches: IntelWatch[];
  jobs: IntelJob[];
  captainThread: IdeaMessage[]; // "Talk to Captain" about the gaps in general (per-idea talk uses the idea's thread)
  nextIds: { capability: number; theme: number; insight: number; plan: number; finding: number; scenario: number; social: number; change: number; check: number; watch: number; job: number };
}

/** Small counts for the nav badge and headers, carried by the 'intel' event and GET /api/intel/summary. */
export interface IntelSummary {
  rev: number;
  competitors: number; // tracked, not counting us
  lastSweptAt?: string;
  sources: number; // distinct source urls in the store
  gaps: number;
  edges: number;
  open: number;
  newIdeas: number; // intel ideas still 'new'
  alerts: number; // unseen changes with planImpact 'respond' + re-checks whose verdict changed since you looked: the nav badge
  runningJob?: { id: string; kind: IntelJobKind; label: string; startedAt: string } & IntelJobView;
  queuedJobs: number;
  queue?: ({ id: string; kind: IntelJobKind; label: string; queuedAt: string } & IntelJobView)[]; // queued jobs, oldest first
  waitingOn?: string; // why queued jobs wait: "IJ3 Sweep of 3 competitors", "research run RR2", "paused by the 5-hour limit"
}

/** The parts of a job the research-in-progress overlay needs (summary.runningJob / summary.queue). */
export interface IntelJobView {
  competitorIds: string[];
  names: string[];
  areas: IntelArea[];
  depth: 'quick' | 'thorough';
  by: string;
  pages: number;
  progress?: IntelJobProgress;
}

// ---- Research browser (src/browser/*) ----

/** A site scout may need to be signed in to, as shown in Settings → Research browser. */
export interface ResearchSiteStatus {
  site: string; // 'reddit' | 'linkedin' | 'x' | 'youtube' | 'instagram' | 'tiktok' | 'facebook' | 'g2' (src/browser/sites.ts)
  label: string; // "Reddit"
  domain: string; // "reddit.com"
  loginUrl: string;
  connected: boolean; // a login cookie for the domain is in the research profile (e.g. reddit_session, li_at, auth_token)
  via?: 'login' | 'opera'; // how it got there
  checkedAt: string;
  warning?: string; // LinkedIn: "restricts automated accounts; use a separate account"
  limits?: string; // honest limits: "Reddit's anonymous JSON is blocked; reads need the login"
  blocked?: { reason: string; at: string; visible?: boolean }; // the site answered the research browser with a bot check last time (src/browser/botcheck.ts); visible: that read was in the visible window (absent = hidden)
  visible?: boolean; // the shared visible-window list has it (every project on this PC): the profile reads it in a visible window
}

/** GET /api/browser: what the research browser can do on this PC. */
export interface ResearchBrowserStatus {
  available: boolean; // playwright-core loads and the channel's browser is installed
  problem?: string; // "playwright-core is not installed", "Chrome not found"
  channel: 'chrome' | 'msedge';
  profileDir: string; // under the secrets base (the agents' guard refuses to touch it)
  state: 'idle' | 'browsing' | 'login_open'; // the profile is single-use: a login window and browsing never overlap
  loginSite?: string;
  sites: ResearchSiteStatus[];
  tools: { name: string; ok: boolean; note?: string }[]; // yt-dlp, Agent Reach python, browser_cookie3, Opera profile
  opera: { found: boolean; profileDir?: string; allow: string[]; lastImportAt?: string; imported?: Record<string, number> }; // imported: domain → cookie count (never values)
  /** Domains whose last load was a bot check or block ("Just a moment…", 429); cleared by the next good load. Scout reads them via the public reader. */
  blocked?: { domain: string; reason: string; at: string; visible?: boolean }[];
  /** Domains read in a visible window, shared by every project on this PC (<secretsBase()>/research-browser/visible.json). */
  visibleSites?: string[];
}

/** What the read-only browse tool returns to scout (POST /api/browser/read). */
export interface BrowseResult {
  url: string; // final URL after redirects
  title: string;
  status: number; // HTTP status of the document
  text?: string; // action 'read': visible text, ≤ 40000 chars, then "[… truncated]"
  links?: { text: string; url: string }[]; // action 'read' with links: true; ≤ 200
  screenshot?: string; // action 'screenshot': absolute path of the PNG under .muster/intel/shots/ (scout opens it with Read)
  scrolled?: { y: number; height: number }; // action 'scroll'
  loggedIn?: boolean; // a login cookie for this domain was present
  via: BrowseMode;
  pagesLeft: number; // of this job's budget
  blocked?: string; // the site answered with a bot check / block instead of the page: "bot check (Cloudflare)", "rate limited (429)"
  readVia?: 'public_reader'; // set when `text` came from the public reader (r.jina.ai, else a plain cookie-less request) because the site blocked the browser
  note?: string; // for scout: "read via public reader (site blocked the research browser)"; put it on the source title
}
