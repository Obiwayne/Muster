# Muster — Product & CLI Spec

Sep 30, 2026 · Wayne Hewitt

> **Platform change (agreed 30 Sep):** Muster runs natively on Windows, **not in WSL2 and not on Claude Code agent teams/tmux**. Muster spawns each `claude` session itself in a pseudo-terminal (node-pty), and its own orchestrator + `muster-mcp` provide the task board, stations, messaging and bulletin board. Everything else in this spec stands. See `ARCHITECTURE.md`.

## Overview

Muster runs a crew of Claude Code agents in parallel on one project, led by a Captain agent you talk to. You give the Captain a goal; it splits the work, hands each task to a Crew agent on its own git branch, answers their questions, checks their work and tells you when it is ready to merge.

- **Problem:** running several agents by hand means juggling terminals, and agents in the same folder overwrite each other's files.
- **Fix:** every agent works in its own git worktree (a separate folder on its own branch), so they can't collide. Only you merge into main, after the Captain has reviewed the work.
- **Shape:** a CLI (`muster`) that does the work, and a dashboard UI that shows up to four terminals in a grid. The UI is a front end to the CLI, never the other way round.
- **Vellum link:** one Crew agent can be pointed at Vellum (the user's local design app, F:\Vellum, with its own MCP server) to learn the design framework and check that the design process stays on track. The dashboard itself is a standalone app, not part of Vellum.

## Roles

There is exactly one Captain; everything else is Crew. Any terminal can take any role, set by right-clicking it in the UI or with `muster role`.

| Role | Works in | Does | Never does |
|---|---|---|---|
| Captain | Main checkout (main) | Takes your goal, breaks it into tasks, assigns Crew, answers questions, reviews diffs, runs tests, flags ready branches to you | Writes feature code itself, or merges into main |
| Crew | Own worktree + branch (crew-2/share-dialog) | Claims tasks from the board, works with other Crew, hands work on, reports done | Merges, or edits another Crew's branch |
| Vellum design crew | Own worktree, connected to Vellum through its MCP | Reads the design framework in Vellum and checks that UI work follows it; flags drift to the Captain and the Crew involved | Changes Vellum boards unless the Captain asks |

Colours in the UI: amber = Captain, teal = Crew, lavender = Vellum design crew.

## Factory model

The crew works like a factory line: you can add as many agents as you like, and they collaborate on one shared task board instead of working in isolation.

- **Shared task board:** the Captain posts tasks with dependencies ("tests need the API first"). Free Crew agents claim the next task that is ready.
- **Stations:** a task can pass through stations in order, for example build → test → design check → Captain review. Each station is a Crew agent or the Vellum design crew.
- **Crew talk to each other:** Crew can message each other through the orchestrator ("I changed the invite API shape"), not only the Captain. The Captain sees every message.
- **Hand-offs:** when one agent finishes its station, it hands the branch on to the next station with a short note.
- **Scale:** add terminals at any time with the Add button or `muster add`. New agents join the board and start claiming work.

## Bulletin board

The bulletin board is where the whole crew talks: every agent pins notes there, and every agent and the Captain can read and reply. It is the one place to see who is stuck, who is waiting and how far each task has got.

| Note type | Posted when | Who acts on it |
|---|---|---|
| Stuck | An agent can't move forward; it says what it tried | Captain, or any Crew who knows the answer |
| Question | An agent needs a decision to carry on | Captain answers, or escalates to you |
| Waiting | An agent is blocked on another agent's work ("need the invite API") | The agent it is waiting on |
| Progress | A step is done, or at regular points during a task | Everyone, for awareness |
| Done | A task or station is finished and handed on | Next station, then the Captain |

- Each note carries the agent, its task and branch, the time, and a thread of replies.
- A note stays open until it is answered or cleared, so nothing gets lost.
- The Captain checks the board first on every turn and clears stuck and question notes before assigning new work.
- **Crew-first answering (agreed 30 Sep):** stuck and question notes go to the crew, not to you. The Captain and any Crew who knows the answer reply in the thread and work it out together. A note only reaches you when the Captain calls `escalate` (e.g. a product decision only you can make). The board has a **Needs you** filter that shows only escalations and Ready-for-review notes, and those are the only notes that trigger a notification. Threads show "Being handled by the crew" until then. You can still reply to any thread yourself.
- In the dashboard the board is its own page in the left menu, and open stuck notes show as a badge on that agent's terminal tile.

## Usage and limits

The user is on Max 5x, so a team shares one allowance: a 5-hour window and a weekly window, shared with claude.ai and Cowork. Every Crew agent is a full Claude session, so usage grows roughly in line with team size.

| Setting | Default | Why |
|---|---|---|
| Captain model | Opus | Planning and review need the best judgement |
| Crew model | Sonnet | Much cheaper per task |
| Crew running at once | 3, plus the Vellum design crew | Start low on Max 5x |
| Pause new work | 5-hour window at 80% | Stops the Captain spawning or assigning until the window resets |
| Warn you | Weekly window at 75% | Time to slow down before you run out mid-week |
| Idle Crew | Shut down after their task | An idle agent still holds a session open |

- **Where the numbers come from:** Claude Code's status line input JSON includes `rate_limits.five_hour` and `rate_limits.seven_day`, each with a percentage used and a reset time, plus `cost.total_cost_usd` for the session. Muster installs its own status line command for every agent, reads these and shows them in the dashboard.
- **In the dashboard:** a usage bar for each window at the top, plus a per-agent share.
- **In the terminal:** `muster usage`, and Claude Code's own `/usage` for detail.

## How it works

You talk only to the Captain. The orchestrator is a small local server that tracks every agent and passes tasks, questions and results between them. Each Crew agent works on its own branch in its own folder, and nothing reaches main until the Captain has reviewed and tested it and you have approved it.

## CLI commands

The `muster` CLI is the product; the dashboard calls the same API. Everything runs from inside the project's git repo.

| Command | What it does |
|---|---|
| `muster init` | Sets up `.muster/` in the repo (config, state, logs) and adds it to `.gitignore` |
| `muster up` | Starts the orchestrator and the Captain in the main checkout |
| `muster add [name]` | Creates a worktree + branch and starts a Crew agent in it (`--role design` for the design crew) |
| `muster role <agent> captain\|crew\|design` | Changes an agent's role; a new Captain demotes the old one |
| `muster ask "<goal>"` | Sends a goal to the Captain (same as typing in its terminal) |
| `muster status` | Lists agents, branch, task and state (working, stuck, done) |
| `muster attach <agent>` | Opens that agent's live terminal |
| `muster diff <agent>` | Shows the agent's changes against main |
| `muster merge <agent>` | Merges a finished branch (only you run this, after the Captain flags it ready) |
| `muster stop <agent>` / `muster down` | Stops one agent / everything; `--clean` removes merged worktrees |
| `muster ui` | Opens the dashboard |

Additions (native build): `muster board` (list open notes), `muster reply <note> "<text>"` (answer a note as "you"), `muster tasks`, `muster usage`.

## Agent tools (muster-mcp)

Captain: `spawn_crew(task, role?)`, `post_task(title, description, dependsOn?, stations?)`, `assign(agent, task)`, `read_board(filter?)`, `reply(note, text)`, `message(agent, text)`, `read_output(agent, lines?)`, `get_diff(agent)`, `run_tests(agent)`, `request_review(agent, summary)`, `escalate(text)`, `list_agents()`, `list_tasks()`.

Crew: `claim_task()`, `post_note(type, text)`, `read_board(filter?)`, `reply(note, text)`, `ask_captain(question)`, `message_crew(agent, text)`, `handoff(agent, note)`, `report_done(summary)`, `list_agents()`, `list_tasks()`.

Vellum design crew: the Crew tools plus the Vellum MCP.

Hooks: when an agent goes idle or waits for permission, the hook flags it so the Captain and the dashboard see it.

## Dashboard UI

- Charcoal and slate base, amber for the Captain, teal for Crew, lavender for the design crew.
- **Crew chat page (agreed 30 Sep):** one chronological chat log of everything the agents say to each other: direct messages, broadcasts, note replies (shown as "↳ N14"), plus quieter event lines for claims, hand-offs and pinned notes (toggle "Show hand-offs and notes"). Filter by agent. A composer at the bottom lets you message everyone or one agent as "you". Every message is stored by the orchestrator in `.muster/state.json`, so the log survives restarts.
- **Left menu:** Dashboard, Bulletin board, Crew chat, Tasks, Branches, Vellum boards, Settings, plus a live list of agents with role and status.
- **Main area:** a grid that rearranges itself as you add terminals: one fills the screen, two sit side by side, three are two on top and one wide below, four make a 2×2. Past four, new terminals go onto further pages; the agent list in the left menu shows them all.
- **Right-click a terminal (or its ⋯ button):** Set as Captain, Set as Crew, Set as Vellum design crew, Close.
- **Each tile:** role badge, name, branch, status, the live terminal, and a prompt line at the bottom.
- **Built with:** a standalone local web app that `muster ui` opens in the browser, with xterm.js for each terminal over a local WebSocket.

## Build plan

1. Baseline: role definitions, per-agent worktrees, a hook that blocks edits outside the worktree.
2. CLI: init, up, add, status, attach, stop, down.
3. muster-mcp: bulletin board (post_note, read_board, reply), request_review, escalate.
4. Factory line: stations and handoff on the task board.
5. Review gate: diff and test checks, Ready for review notes, notification, `muster merge`.
6. Usage guard: read the 5-hour and weekly limits, pause at thresholds, `muster usage`.
7. Dashboard: `muster ui`, grid, pages past four, right-click roles, bulletin board page, usage bars.
8. Vellum design crew: an agent pointed at Vellum through its MCP.
