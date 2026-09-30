# Muster — Architecture (build contract)

Read `SPEC.md` for the product. This file is the **contract** between the parts. Shared types live in `src/types.ts`. If you need to change the contract, say so in your report instead of silently diverging.

## Platform

- **Native Windows** (also works on macOS/Linux). No WSL, no tmux, no Claude Code agent teams.
- Node 22, TypeScript (ESM, `module: NodeNext` → imports use `.js` suffixes), built with `tsc` to `dist/`.
- The dashboard is a Vite app in `ui/`, built to `dist/ui/`, served by the orchestrator.
- Tests: `vitest` (`npm test`). Test files sit next to code as `*.test.ts` (excluded from tsc build).
- Dependencies already installed: `commander`, `ws`, `node-pty` (1.1, works on Windows with prebuilt binaries), `@modelcontextprotocol/sdk`, `zod`, `@xterm/xterm`, `@xterm/addon-fit`, `vite`, `vitest`. Do **not** add dependencies without saying why in your report; never edit `package.json` yourself (report what you need).

## Processes

```
you ──► muster CLI ──HTTP──►┐
you ──► browser dashboard ──HTTP/WS──► orchestrator (one per repo, 127.0.0.1:<port>)
                                         │  owns .muster/state.json, spawns agents in PTYs
                                         ├─ PTY: claude (captain)   cwd = repo root
                                         ├─ PTY: claude (crew-2)    cwd = .muster/worktrees/crew-2
                                         └─ PTY: claude (design)    cwd = .muster/worktrees/design
each claude ──stdio──► muster-mcp (node dist/mcp/index.js) ──HTTP──► orchestrator
each claude ──hooks──► node dist/hooks/hook.js <event>        ──HTTP──► orchestrator
each claude ──status line──► node dist/usage/statusline.js    ──HTTP──► orchestrator
design claude ──stdio──► Vellum MCP (node F:/Vellum/mcp/dist/index.js)
```

## Files on disk (in the target project repo)

```
<repo>/.muster/
  config.json          MusterConfig (partial; merged over DEFAULT_CONFIG)
  state.json           MusterState (written atomically: write tmp + rename)
  server.json          { port, pid, token, startedAt }  (present while the orchestrator runs)
  logs/orchestrator.log
  logs/<agentId>.log   raw PTY output (append)
  agents/<agentId>/mcp.json        --mcp-config for that agent
  agents/<agentId>/settings.json   --settings for that agent (hooks, statusLine, permissions)
  agents/<agentId>/prompt.md       --append-system-prompt-file (role instructions)
  worktrees/<agentId>/             git worktree for crew/design agents
```
`muster init` adds `.muster/` to `.gitignore`.

`MUSTER_HOME` = the Muster package root (resolve from `import.meta.url`: `dist/x/y.js` → `../..`). Agent configs reference `${MUSTER_HOME}/dist/...` with forward slashes.

## Source layout and owners

| Path | Owner | What |
|---|---|---|
| `src/types.ts` | lead | shared types (contract) |
| `src/core/*` | orchestrator agent | paths, config, store, tasks, board/feed/inbox, usage guard, git, claude launch args, notify |
| `src/orchestrator/*` | orchestrator agent | HTTP + WS server, API routes, AgentManager (PTYs), entry `index.ts` |
| `src/prompts/*` | tools agent | role prompts (captain, crew, design) as exported strings |
| `src/mcp/*` | tools agent | muster-mcp stdio server |
| `src/hooks/*` | tools agent | hook entry `hook.ts` |
| `src/usage/statusline.ts` | tools agent | status line command |
| `src/client.ts` | tools agent | tiny HTTP client used by mcp, hooks, statusline and CLI (`musterFetch`) |
| `src/cli/*` | CLI agent | `muster` command (commander) |
| `ui/*` | UI agent | dashboard |

## Discovery and auth

- Orchestrator binds `127.0.0.1` on `config.port` (default 47800; if busy, try the next 20 ports). It writes `.muster/server.json` `{port, pid, token, startedAt}`; token = 32 random hex chars, new each start. Deletes server.json on clean shutdown.
- Every `/api/*` request must send header `x-muster-token: <token>`, except `GET /api/health`. WebSocket URLs take `?token=`.
- Agents get `MUSTER_URL` (`http://127.0.0.1:<port>`), `MUSTER_TOKEN`, `MUSTER_AGENT`, `MUSTER_ROLE`, `MUSTER_WORKTREE`, `MUSTER_REPO` in their PTY environment; hooks, statusline and muster-mcp inherit them.
- The CLI finds the repo root (`git rev-parse --show-toplevel`), then reads `.muster/server.json`.
- `GET /` serves `dist/ui/index.html` with the token injected as `<meta name="muster-token" content="...">` (replace the placeholder `<meta name="muster-token" content="">`). Static assets under `/assets/*` are public.

`src/client.ts` exports:
```ts
export function serverInfo(repoRoot?: string): { url: string; token: string } | null // env first (MUSTER_URL/MUSTER_TOKEN), else .muster/server.json
export async function musterFetch<T>(path: string, opts?: { method?: string; body?: unknown; repoRoot?: string }): Promise<T> // throws Error(message from {error}) on non-2xx
```

## HTTP API (JSON in, JSON out; errors are `{ "error": "message" }` with 4xx/5xx)

`actor` = who is calling: an agent id, or `"you"` (CLI/dashboard). Agents send their own id.

### State
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/health | – | `{ ok: true, version }` (no token) |
| GET | /api/state | – | `{ state: MusterState, config: MusterConfig, paused: boolean }` |
| GET | /api/config | – | `MusterConfig` |
| PATCH | /api/config | partial MusterConfig | `MusterConfig` (saved to config.json) |
| POST | /api/shutdown | `{ clean?: boolean }` | `{ ok }` — stops every agent, removes merged worktrees if clean, exits |

### Agents
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /api/agents | `{ name?, role?: Role, taskId?, actor }` | `Agent` — creates worktree + branch (crew/design) and starts claude. Refuses when paused, or when running crew ≥ maxCrew (design doesn't count). Only one design agent. Only the Captain or "you" may spawn. |
| POST | /api/agents/:id/role | `{ role, actor }` | `Agent` — restarts the agent's claude with the new role (same session via `--resume`). Setting captain demotes the current captain to crew (it gets a worktree). |
| POST | /api/agents/:id/stop | `{ actor }` | `Agent` (status stopped; worktree kept) |
| POST | /api/agents/:id/start | `{ actor }` | `Agent` — restart a stopped agent (`--resume`) |
| DELETE | /api/agents/:id | `?removeWorktree=1` | `{ ok }` — stop and forget |
| POST | /api/agents/:id/input | `{ text, submit?: boolean }` | `{ ok }` — type into its terminal (submit = press Enter) |
| GET | /api/agents/:id/output | `?lines=80` | `{ text }` — last N lines, ANSI stripped |
| GET | /api/agents/:id/diff | `?stat=1` | `{ branch, base, stat, diff }` — `git diff <base>...<branch>` |
| POST | /api/agents/:id/tests | – | `{ command, exitCode, output }` — runs `config.testCommand` in its worktree (timeout 10 min, output tail 200 lines) |
| POST | /api/agents/:id/event | `{ event: 'prompt' \| 'stop' \| 'notification' \| 'permission' \| 'session-start', detail?, cwd? }` | `{ ok }` — from hooks |
| POST | /api/agents/:id/merge | `{ force?: boolean, actor }` | `{ ok, output }` — merges the agent's task branch into baseBranch in the repo root (`git merge --no-ff`). Refuses unless the task is `ready_for_merge` (or force). **Only actor "you".** |

### Goal
| POST | /api/ask | `{ text }` | `{ ok }` — records `state.goal`, types it into the Captain's terminal (submit), adds a feed item from "you" to captain |

### Tasks
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/tasks | – | `Task[]` |
| POST | /api/tasks | `{ title, description, dependsOn?, stations?, assignee?, actor }` | `Task` — stations default to config.defaultStations; always end with "review" |
| POST | /api/tasks/claim | `{ actor }` | `Task \| null` — next `ready` task whose current station's role matches the actor's role, oldest first. Refused when paused. |
| POST | /api/tasks/:id/assign | `{ agentId, actor }` | `Task` — refused when paused |
| POST | /api/tasks/:id/handoff | `{ actor, to?, note }` | `Task` — advances stationIndex; `to` = agent id, or omitted = task becomes `ready` for any agent of the next station's role. Receiver's worktree merges the sender's branch (orchestrator runs `git merge --no-edit <senderBranch>` in the receiver worktree). Next station "review" → status `review`, assignee = captain. |
| POST | /api/tasks/:id/done | `{ actor, summary }` | `Task` — shortcut: jump to the review station (status review, assignee captain), posts a Done note |
| POST | /api/tasks/:id/review | `{ actor, summary }` | `Task` — Captain only: status `ready_for_merge`, posts a `review` note (open, "Needs you"), notifies you |
| POST | /api/tasks/:id/sendback | `{ actor, note }` | `Task` — Captain or you: back to the build station, assignee = previous builder, note delivered |

Task readiness: `blocked` while any `dependsOn` task is not `ready_for_merge`/`merged`; recomputed after every change.

### Bulletin board, chat, inbox
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/notes | `?open=1&type=stuck&from=crew-2&to=crew-3&needsYou=1` | `Note[]` (stuck, then question, then others; newest first within type) |
| POST | /api/notes | `{ actor, type, text, taskId?, to? }` | `Note` — branch/taskId filled from the agent when missing. Stuck/question/waiting are delivered to the Captain's inbox (waiting also to `to`). |
| POST | /api/notes/:id/reply | `{ actor, text, close?: boolean }` | `Note` — reply delivered to the note's author (and to the Captain if the author isn't the captain). `close` closes it. |
| POST | /api/notes/:id/close | `{ actor }` | `Note` |
| POST | /api/escalate | `{ actor, text, noteId? }` | `Note` — Captain only: `escalation` note, open, needsYou, Windows notification |
| POST | /api/messages | `{ actor, to: agentId \| 'everyone', text }` | `FeedItem` — delivered to recipient inbox(es); the Captain sees every message in the feed (not inboxed unless addressed) |
| GET | /api/feed | `?limit=200&before=F120&agent=crew-2` | `FeedItem[]` oldest→newest |
| GET | /api/inbox/:agentId | `?unread=1` | `InboxItem[]`; `POST /api/inbox/:agentId/read { ids? }` marks read (all when ids missing) |

"Needs you" = open notes of type `escalation` or `review` (and any note addressed `to: "you"`).

### Usage
| POST | /api/usage | `{ agentId, rate_limits?, cost? }` | `UsageState` — raw status-line fields: `rate_limits.five_hour.used_percentage`, `.resets_at` (unix seconds or ISO), same for `seven_day`; `cost.total_cost_usd` |
| GET | /api/usage | – | `UsageState & { paused }` |

Guard: `paused = fiveHour.usedPercentage >= pauseAtFiveHourPct`. Entering/leaving paused posts a `system` note + feed event. Weekly ≥ warnAtWeeklyPct posts one `system` note addressed to you (needsYou) and a notification. When paused: spawn, assign, claim return 409 `{error: "Paused: 5-hour window at 83% (resets 21:40)"}`.

### WebSockets
- `ws://127.0.0.1:<port>/ws/events?token=` → `MusterEvent` JSON: a full `state` snapshot on connect and after every change (debounce 100 ms), plus `toast` events.
- `ws://127.0.0.1:<port>/ws/term/<agentId>?token=` → server sends raw PTY output text frames (first the backlog: last 200 KB), client sends `TermClientMessage` JSON (`input`, `resize`). Several clients may attach; the PTY takes the size of the most recent resize.

## Agent launch (AgentManager)

For each agent the orchestrator writes `.muster/agents/<id>/{mcp.json,settings.json,prompt.md}` and spawns with node-pty (cols 120, rows 32, `useConpty` default):

```
<claudePath> --session-id <uuid>            (first start; later: --resume <uuid>)
  --model <model>
  --permission-mode <captain: default config.permissionMode | crew/design: config.permissionMode>
  --mcp-config <.muster/agents/<id>/mcp.json>
  --settings   <.muster/agents/<id>/settings.json>
  --append-system-prompt-file <.muster/agents/<id>/prompt.md>   (fallback: --append-system-prompt "<text>" if the -file flag is rejected)
  --name "muster <id>"
```
- `claudePath`: `config.claudePath`, else resolve: on Windows find `claude.cmd` on PATH and read the real exe from it (`...\node_modules\@anthropic-ai\claude-code\bin\claude.exe`), else `claude.exe` on PATH; elsewhere `claude`.
- `mcp.json`: `{ "mcpServers": { "muster": { "command": "<process.execPath>", "args": ["<MUSTER_HOME>/dist/mcp/index.js"], "env": { MUSTER_URL, MUSTER_TOKEN, MUSTER_AGENT, MUSTER_ROLE } } } }`, plus `"vellum": config.vellum` for the design role (default `{ command: process.execPath, args: ["F:/Vellum/mcp/dist/index.js"] }` if that file exists).
- `settings.json`:
  ```json
  { "permissions": { "allow": config.allowedTools },
    "statusLine": { "type": "command", "command": "\"<node>\" \"<MUSTER_HOME>/dist/usage/statusline.js\"" },
    "hooks": {
      "PreToolUse":       [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash", "hooks": [{ "type": "command", "command": "\"<node>\" \"<MUSTER_HOME>/dist/hooks/hook.js\" pre-tool" }] }],
      "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "... hook.js prompt" }] }],
      "Stop":             [{ "hooks": [{ "type": "command", "command": "... hook.js stop" }] }],
      "Notification":     [{ "hooks": [{ "type": "command", "command": "... hook.js notification" }] }],
      "SessionStart":     [{ "hooks": [{ "type": "command", "command": "... hook.js session-start" }] }]
    } }
  ```
- First-run dialogs: watch PTY output; if it contains a folder-trust prompt ("trust the files" / "Do you trust"), send `\r` once. Log it.
- **Typing into an agent** (`input`, nudges, `muster ask`): collapse newlines to spaces, write the text, wait 120 ms, then write `\r` if submit.
- **Nudges:** when an agent becomes `idle` (Stop hook) and has undelivered inbox items, type one line: `[muster] You have 3 new items (reply from captain on N14; message from crew-2; task T5 assigned). Call read_inbox.` Mark delivered. Also nudge the Captain when a note is posted while it is idle. Never nudge while `working`. After spawning with a task, the first prompt is `[muster] You are <id> (<role>). Your task: T3 <title>. Call read_inbox and claim/confirm it, then start.`; without a task: crew → `[muster] You are <id>, crew. Call claim_task to pick up work.`; captain → nothing until `muster ask`.
- Status: `prompt` event → working; `stop` → idle (unless has open stuck note → stuck; unless the agent reported done → done); `notification` with a permission message → stuck + auto `stuck` note "Waiting for permission: <detail>" (closed automatically on the next `prompt` event); PTY exit → stopped.
- **Idle crew shutdown:** if `shutdownIdleCrew` and a crew agent is idle with no task and no unread inbox for 5 minutes, stop it (post feed event).
- Output: keep a 200 KB ring buffer per agent for WS backlog and `output`; append raw output to `logs/<id>.log`.

## Worktrees and branches (src/core/git.ts)

- Crew/design: `git worktree add -b <id>/work .muster/worktrees/<id> <baseBranch>`; if the branch exists, reuse it. When the agent first holds a task and its branch has no commits beyond base, rename to `<id>/<slug(task.title)>` (`git branch -m`, run inside the worktree).
- Captain: cwd = repo root on baseBranch; branch "main".
- The orchestrator never commits for agents. Crew are told to commit on their branch before handoff/report_done.
- `merge`: in the repo root: check clean tree, `git checkout <baseBranch>`, `git merge --no-ff <branch> -m "Merge <branch> (T3 <title>)"`. On conflict: `git merge --abort`, return 409 with the conflict list.
- `down --clean`: remove worktrees whose branch is merged into baseBranch (`git worktree remove`, then `git branch -d`).

## Hooks (src/hooks/hook.ts, `node hook.js <event>`; reads hook JSON on stdin)

- `pre-tool` (PreToolUse):
  - Crew/design: for Edit/Write/MultiEdit/NotebookEdit, deny if `tool_input.file_path` resolves outside `MUSTER_WORKTREE`. For Bash, deny `git push`, `git checkout <baseBranch>`/`git switch <baseBranch>`, `git merge` while on baseBranch, `git worktree`, `git branch -D`, and `cd` outside the worktree followed by git write commands (best effort).
  - Captain: deny Edit/Write/MultiEdit/NotebookEdit (message: "The Captain doesn't write code: post_task or assign it to crew"), and deny `git merge`/`git push`/`git commit` in Bash.
  - Deny = print JSON `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}` and exit 0.
  - Anything else: exit 0 with no output.
- `prompt`, `stop`, `notification`, `session-start`: POST `/api/agents/$MUSTER_AGENT/event` with the event and `detail` (notification: `message`), exit 0. Never block or fail the session: swallow all errors, 3 s timeout.

## Status line (src/usage/statusline.ts)

Reads the status-line JSON on stdin, POSTs `{agentId, rate_limits, cost}` to `/api/usage` (1.5 s timeout, errors ignored), prints one line: `muster · crew-2 · 5h 62% · wk 38%`.

## muster-mcp (src/mcp/index.ts)

Stdio MCP server named `muster`. Tools by role (`MUSTER_ROLE`):
- **Captain:** `spawn_crew(task?, role?)` (task = title or existing task id), `post_task(title, description, dependsOn?, stations?, assignee?)`, `assign(agent, task)`, `list_agents()`, `list_tasks()`, `read_board(filter?)`, `reply(note, text, close?)`, `message(agent, text)` (agent may be "everyone"), `read_inbox()`, `read_output(agent, lines?)`, `get_diff(agent)`, `run_tests(agent)`, `request_review(agent, summary)` (resolves the agent's task), `send_back(task, note)`, `escalate(text, note?)`.
- **Crew and design:** `claim_task()`, `list_agents()`, `list_tasks()`, `post_note(type, text, to?)` (stuck|question|waiting|progress|done), `read_board(filter?)`, `reply(note, text, close?)`, `ask_captain(question)` (posts a question note and waits up to 10 minutes for the first reply; returns the reply text, or "No answer yet — carry on with other work; the answer will arrive in your inbox"), `message_crew(agent, text)`, `handoff(agent?, note)`, `report_done(summary)`, `read_inbox()`.
- Tool results are short plain text (not raw JSON dumps) — agents read them.

## Role prompts (src/prompts)

`captainPrompt(ctx)`, `crewPrompt(ctx)`, `designPrompt(ctx)` where `ctx = { agentId, repoRoot, worktree, branch, baseBranch, testCommand, projectName, vellumFile? }` → markdown string. Must encode the SPEC rules: Captain checks the board first every turn, never writes code or merges, crew answer each other first, escalate only decisions only the human can make, request_review when a branch is tested; Crew work only in their worktree, commit on their branch, post progress, ask other crew before the Captain, never merge or push; Design crew read the Vellum design framework (read-only unless the Captain asks) and flag drift with notes/messages.

## Dashboard (ui/)

Vite + TypeScript, no framework needed (vanilla TS + small render helpers), `@xterm/xterm` + `@xterm/addon-fit`. Must match the approved Vellum design (file "Muster", id `28BUsqILtGqq`): 7 screens (Dashboard, Bulletin board, Crew chat, Tasks, Branches, Vellum boards, Settings) + the "Design system" page tokens. Uses only the HTTP API and WebSockets above. Hash routing (`#/board`, `#/chat`, ...). Grid layouts: 1 → full, 2 → side by side, 3 → two on top + one wide, 4 → 2×2, >4 → pages. Right-click a tile (or ⋯): Set as Captain / Crew / Vellum design crew, View diff, Close.
