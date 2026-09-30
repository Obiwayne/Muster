# Muster

Run a crew of Claude Code agents in parallel on one project, led by a **Captain** agent you talk to. You give the Captain a goal; it splits the work into tasks, spawns **Crew** agents that each work in their own git worktree and branch, answers their questions, reviews and tests their work, and tells you when a branch is ready. Nothing reaches `main` until you merge it.

Runs natively on Windows (no WSL, no tmux). macOS and Linux work too.

![Dashboard](docs/screenshots/dashboard.png)

## Install

```powershell
git clone https://github.com/Obiwayne/Muster.git
cd Muster
npm install
npm run build
npm link          # puts `muster` on your PATH
```

Needs Node 22+, git, and Claude Code (`claude`) logged in.

## Use

From inside any git repo with at least one commit:

```powershell
muster up                      # starts the orchestrator + the Captain, opens the dashboard
muster ask "Build the invite-link sharing flow"
muster status                  # who is doing what
muster board --needs-you       # escalations and branches ready for you
muster merge crew-2            # merge a branch the Captain flagged ready
muster down --clean            # stop everything, remove merged worktrees
```

| Command | What it does |
|---|---|
| `muster init` | Sets up `.muster/` (config, state, logs) and ignores it via `.git/info/exclude` |
| `muster up [--no-ui]` | Starts the orchestrator and the Captain in the main checkout |
| `muster add [name] [--role crew\|design] [--task T3]` | Adds an agent in its own worktree + branch |
| `muster role <agent> captain\|crew\|design` | Changes an agent's role (a new Captain demotes the old one) |
| `muster ask "<goal>"` | Sends a goal to the Captain |
| `muster status` / `tasks` / `usage` | Agents, the task board, the 5-hour and weekly usage windows |
| `muster board` / `reply <note> "<text>"` | The bulletin board; answer a note as you |
| `muster chat [--follow]` / `say <agent\|everyone> "<text>"` | The crew chat log; message agents |
| `muster attach <agent>` | That agent's live terminal (Ctrl+] to detach) |
| `muster diff <agent>` / `merge <agent>` | Review and merge a finished branch |
| `muster stop <agent>` / `start <agent>` / `down [--clean]` | Stop or restart agents, or everything |
| `muster ui` | Opens the dashboard |

## How it works

- **Orchestrator:** a small local server (`127.0.0.1`, token-protected) per repo. It runs every agent's `claude` in a pseudo-terminal, keeps the task board, bulletin board, crew chat and inboxes in `.muster/state.json`, and serves the dashboard.
- **Roles:** the Captain works in the main checkout but never writes code or merges. Crew work only inside `.muster/worktrees/<agent>` on their own branch; a PreToolUse hook blocks edits outside it and git commands that touch the base branch. The **Vellum design crew** also gets the Vellum MCP to check UI work against the design framework (read-only).
- **Factory line:** tasks have dependencies and stations (for example `build → test → design → review`; the default is `build → review`). Agents claim ready tasks, hand branches on with a note, and the Captain reviews (`get_diff`, `run_tests`) before flagging a branch **ready for merge**.
- **Crew answer each other first:** stuck and question notes go to the crew and the Captain; only the Captain's escalations and ready branches reach you ("Needs you", plus a Windows notification).
- **Usage guard:** every agent's status line reports the 5-hour and weekly rate limits. New work pauses at 80% of the 5-hour window; you're warned at 75% of the weekly one. The Captain runs on Opus, crew on Sonnet, 3 crew at once by default (Settings or `.muster/config.json`).
- **Permissions:** agents run in Claude Code's `auto` permission mode so they can work unattended; the worktree guard hook applies regardless.

See [`docs/SPEC.md`](docs/SPEC.md) for the product spec and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the internals. The dashboard design (made in Vellum) is in [`docs/design/`](docs/design/).

## Develop

```powershell
npm test                          # vitest, 140+ tests
npm run build                     # tsc → dist/, vite → dist/ui/
node ui/dev/mock-server.mjs       # dashboard against a mock orchestrator (token: dev-token)
```
