# Muster — Architecture (build contract)

> **Changes after the first live run (30 Sep):**
> - Agents default to `--permission-mode auto`; `acceptEdits` left crews stuck on shell-safety prompts overnight. The worktree guard hook applies in every mode.
> - `muster init` ignores `.muster/` via `.git/info/exclude`, not `.gitignore`, so the main checkout stays clean for `muster merge`.
> - The folder-trust dialog pre-selects "No, exit": the orchestrator moves to "Yes" with arrow keys, then presses Enter.
> - Claude fires no hook when a turn is interrupted (e.g. a permission prompt answered "No"). A watchdog reads quiet terminals and settles the agent to resting when "Interrupted" is the latest thing on screen.
> - A one-time notice can swallow the Enter after typed text; if no prompt hook arrives within 4 s and the line is still on screen, Enter is pressed again (max twice).
> - Open "Waiting for permission" notes close when the agent's process restarts.
> - `GET /api/agents/:id/diff` takes `?branch=`; `POST /api/agents/:id/merge` takes `branch` or `taskId`; `PATCH /api/config` treats `null` as unset.
> - Agents get `MUSTER_BASE_BRANCH` in their environment; parent Claude Code session variables are stripped from it.

> **Design crew and Vellum edits (1 Oct):** `config.vellumEdit` is `ask` (default: change designs only when the Captain asks), `always`, or `never`. The design prompt follows it; `never` is enforced by adding Vellum's editing tools to the design crew's `permissions.deny` (`VELLUM_EDIT_TOOLS` in core/claude.ts). Changing it restarts a running design crew (same session) to apply.
>
> **Correctness changes (1 Oct), these override the sections below:**
> - Tasks record `reviewedSha` when review is requested; `merge` (body normally `{ taskId }`) merges exactly that commit and returns 409 if the branch moved since ("ask the Captain to re-review"). Re-review is allowed from `ready_for_merge`.
> - One branch per task: taking a task gives the agent a fresh `<id>/<slug>` from base (or renames an unused `<id>/work`); a dirty worktree refuses with 409. An agent holds one open task at a time (409 otherwise). `request_review` only from `in_progress`/`review`.
> - Tasks record `inputs` (branches/commits they must contain: earlier stations, `ready_for_merge` dependencies, merged in when the task is taken). handoff/done/review return 409 naming any input that isn't an ancestor. A conflicting handoff merge keeps `task.branch` on the sender and posts a stuck note for the receiver.
> - Nudges are confirmed by the next `prompt` hook; unconfirmed nudges repeat (20 s doubling to 5 min). Automated typing waits 5 s after a human keystroke. Typed text is sanitised (no control characters).
> - Resumed agents holding a task get "[muster] You were restarted. Continue …". One failed start doesn't stop the others; a missing worktree is recreated. `down --clean` removes only worktrees (and records) of crew that aren't running, hold no task and whose branch is merged.
> - State saves retry the rename on Windows file locks; handlers validate before mutating. Terminal listeners are per agent and survive restarts. Agent records are reserved before any await, so parallel spawns respect `maxCrew`.
>
> **Security changes (1 Oct), these override the sections below:**
> - **Identities come from tokens.** The human token ("you") is written only to `%LOCALAPPDATA%/muster/<sha256(repo)[0:16]>/token` (posix `~/.muster/<hash>/token`; `MUSTER_SECRETS_DIR` overrides the base, for tests). `.muster/server.json` is `{ port, pid, startedAt }`. Each agent's `MUSTER_TOKEN` (PTY env and mcp.json) is `HMAC(agentSecret, id)`; the secret lives only in orchestrator memory. The server resolves the caller from the token and **overwrites `actor`** in every body (and `agentId` in `/api/usage` for agents) — see `src/orchestrator/auth.ts`.
> - Agent tokens get 403 on: `PATCH /api/config`, `/api/shutdown`, `/api/ask`, `/role`, `DELETE /api/agents/:id`, `/input` (any agent), `/merge`, start/stop/event/inbox-read of *another* agent, `/tests` and `GET /output` of another agent unless Captain. Terminal WebSocket input from an agent token is ignored.
> - `src/client.ts`: with `MUSTER_AGENT` set, only the env `MUSTER_URL`/`MUSTER_TOKEN` are used (never the human token); otherwise port from server.json + the human token file.
> - HTTP requests need `Host: 127.0.0.1:<port>` or `localhost:<port>` (else 421); WebSocket upgrades also need no `Origin` or `http://127.0.0.1:<port>`/`http://localhost:<port>` (else 403). The Vite dev proxy (`npm run dev:ui`) sends its own Origin on `/ws` and is refused; use the built dashboard.
> - **Git ref guard.** On start the orchestrator installs a `reference-transaction` hook (marked `muster-ref-guard`) in `git rev-parse --git-path hooks` (so `core.hooksPath` is respected; a foreign hook is renamed `reference-transaction.pre-muster` and chained). When `MUSTER_AGENT` is set it runs `dist/hooks/ref-hook.js`, which refuses updates to `refs/heads/<baseBranch>` and to `refs/heads/<other agent id>[/...]`. No-op for humans and the orchestrator (no `MUSTER_AGENT`).
> - Guard hook (`PreToolUse` matcher `Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|Read|Grep|Glob`): PowerShell gets the Bash rules; all agents are denied `--git-dir/--work-tree`, `GIT_DIR=`-style env, `-c core.hooksPath`, `update-ref`, `symbolic-ref`, `branch -f/-M/-C`, hooksPath/alias config, `push --no-verify`, `bash -c`/`sh -c`/`powershell -c`/`cmd /c` with git, `$(git …)`, changing `MUSTER_*` env, links/junctions, and any mention of the token folder or `.muster/agents`. Captain also: pull, reset, rebase, cherry-pick, am, revert, `checkout -B`, `switch -C`, branch delete/rename. Edits resolve junctions/symlinks (nearest existing ancestor) and deny `.git`, `.claude`, `.mcp.json`, `.muster` inside the worktree. Reads of the token folder and other agents' `.muster/agents/<id>` are denied.
> - Agents launch with `--setting-sources user` (a worktree's `.claude/settings*.json` can't loosen them). Their `--settings` file sets `disableAllHooks: false`, so a user-level `disableAllHooks: true` (e.g. to mute sound hooks) can't switch off Muster's hooks and status line; without them agents sit on "starting", never get a resumable marker, and a restart dies on "Session ID … is already in use" (now retried once with `--resume`). `DEFAULT_CONFIG.allowedTools` no longer has `Bash(node *)`/`Bash(npx *)`.
> - A `.cmd` claude path is resolved to the exe/script behind the npm shim; if that fails it runs through `cmd.exe /d /s /c "<quoted line>"` and the role prompt is never passed inline through cmd.

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
  config.json          MusterConfig (partial; merged over DEFAULT_CONFIG). `vellumFile` = id of the Vellum design framework file; rolePrompt passes it to designPrompt (unset → the design crew finds it with list_files)
  state.json           MusterState (written atomically: write tmp + rename)
  server.json          { port, pid, token, startedAt }  (present while the orchestrator runs)
  logs/orchestrator.log
  logs/<agentId>.log   raw PTY output (append)
  agents/<agentId>/mcp.json        --mcp-config for that agent
  agents/<agentId>/settings.json   --settings for that agent (hooks, statusLine, permissions)
  agents/<agentId>/prompt.md       --append-system-prompt-file (role instructions)
  worktrees/<agentId>/             git worktree for crew/design agents
  stations/<name>.md               station role, skills and guideline (src/core/stations.ts)
  evidence/<task>/<E#>/<file>      evidence copied from an agent's worktree by add_evidence
```
Agents save evidence in `<worktree>/.muster-evidence/<task>/`; the orchestrator adds `.muster-evidence/` to the shared `.git/info/exclude` at startup, so it never shows as a change.
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
| GET | /api/health | – | `{ ok: true, version, build }` (no token). `build` is the newest mtime (ms) of the dist/ server .js files this process loaded (core/build.ts). Every 60 s the server compares it with dist/ and, after a rebuild, posts one open system note to "you" ("Needs you") plus a Windows notification; `muster up` (already running) and `muster status` print the same warning. |
| GET | /api/state | – | `{ state: MusterState, config: MusterConfig, paused: boolean }` |
| GET | /api/config | – | `MusterConfig` |
| PATCH | /api/config | partial MusterConfig | `MusterConfig` (saved to config.json) |
| GET | /api/stations | | `StationDef[]` — `{ name, role, guideline, builtin }`, in `config.defaultStations` order, then other defined stations, `review` last. Backed by `.muster/stations/<name>.md` (per machine): optional `role:` frontmatter, the rest is the Markdown guideline. build/test/design/review.md are seeded at startup, only when the folder is missing, never overwritten |
| GET / PUT | /api/stations/:name | `{ role?: 'captain', 'crew', 'design' or 'human', guideline? }` | `StationDef` — PUT creates or updates (human only); omitted fields keep their value. `review` stays with the captain; names `[a-z0-9-]{1,30}`, guideline ≤ 20000 chars |
| DELETE | /api/stations/:name | | `StationDef[]` — human only; also removed from `config.defaultStations`; `review` is refused (400), unknown is 404. Claiming and handoff resolve a station's role from these files (tasks.ts stays pure: roles are passed in) |
| POST | /api/shutdown | `{ clean?: boolean }` | `{ ok }` — stops every agent, removes merged worktrees if clean, exits |

Station guidelines are delivered where an agent picks up work: `claim_task` appends the current station's guideline to its result; assignment, handoff-to-an-agent and review inbox items carry it (the inbox text, not the terminal nudge); the Captain's launch prompt lists the stations and the review guideline.

### Factory lines (src/core/lines.ts, src/core/starters.ts)

A line is a named station order. Built-in lines: `new-app` "New app / big feature" (discover, concept, design, plan, approval), `feature` "Feature" (plan, build, test), `ui` "UI change" (design, build, design-check), `bugfix` "Bug fix" (reproduce, fix, test). `review` is appended to every line when it is returned. Your edits and custom lines are `config.lines` (`{ label, stations }`, no `review`, in config.json), merged over the built-ins. `config.defaultLine` (default `feature`; unknown falls back to `feature`) names the line new tasks use.

`config.defaultStations` is an alias for the default line's stations + `review`: it is derived when the config is loaded, and PATCH /api/config `{ defaultStations }` edits the default line (the line named in the same patch, else the current one). The UI's "Make default" sends both `{ defaultLine, defaultStations }`. A config.json from before lines (defaultStations, no lines or defaultLine) becomes an edit of `feature`. PATCH also accepts `lines` and `defaultLine` (400 for an unknown line or an invalid entry).

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/lines | | `{ lines: { name, label, stations, builtin }[], defaultLine }` — built-ins first, then custom lines alphabetically; `stations` ends with `review` |
| PUT | /api/lines/:name | `{ stations, label? }` | The line — human only; creates or edits (a built-in keeps `builtin: true`). 1-12 stations, each must exist (a station file or a built-in station), `review` is implied; 400 otherwise |
| DELETE | /api/lines/:name | | `{ lines, defaultLine }` — human only; resets a built-in line to its stations, removes a custom one (the default falls back to `feature`); 404 for an unknown line |

POST /api/tasks and the Captain's `post_task` take `line?`: the line's stations are used and `task.line` records it. Explicit `stations` win over `line`; with neither, the default line is used. An unknown line is 404.

Starter stations: every station of the built-in lines has a starter role and guideline (src/core/starters.ts). `seedStations` runs at startup and writes each missing `.muster/stations/<name>.md` (also when the folder already exists), never overwriting a file. Roles: discover, concept, plan, reproduce, fix, build, test are `crew`; design and design-check are `design`; approval is `human` (an approval station, see tasks). Each guideline has the sections Purpose / Read first / Produce / Done when / Hand on. discover, concept and plan write `docs/factory/<T#>-discovery.md`, `-concept.md` and `-plan.md` on the task branch; plan ends with a task breakdown (acceptance criteria and a suggested line per item); reproduce writes a failing test first; design-check reports PASS/DRIFT lines. The Captain's prompt lists the lines, when to use each, and tells it to post the build tasks from a merged new-app plan.

### Vellum status (src/core/vellum.ts)
| Method | Path | Returns |
|---|---|---|
| GET | /api/vellum | `VellumStatus` (src/types.ts) = `{ status: 'connected' \| 'not_configured' \| 'unreachable' \| 'error', message?, checkedAt, files: { id, name, pages, updated? }[] }` |
| GET | /api/vellum?refresh=1 | same, bypassing the cache (the "Test connection" button) |

Muster acts as a read-only MCP client to the Vellum server (`vellumServer(config)`: `config.vellum`, else the default `F:/Vellum/mcp/dist/index.js` if it exists). It spawns it over stdio, calls **only `list_files`**, then closes it; no other tool is ever called.
- `not_configured`: no `config.vellum` and no default entry (`files: []`, never spawns). `unreachable`: spawn, connect or deadline failure. `error`: Vellum answered with a tool error (e.g. its app is not running) or text that isn't a file list. `message` explains any non-`connected` status.
- Mapping: `pages` = length of the `pages` array (or the count), `updated` = ISO of `updatedAt` (epoch ms or ISO string); unknown fields are dropped.
- One overall 5s deadline across connect + call; on expiry the child process is killed. The result is cached ~30s (keyed by the server command, so changing the Vellum setting invalidates it); concurrent requests share one in-flight check. The cache is also used for failures.
- Tests inject the call through `startOrchestrator({ vellumCall })` / `createVellumChecker({ call, defaultEntry })`.

### Agents
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /api/agents | `{ name?, role?: Role, taskId?, actor }` | `Agent` — creates worktree + branch (crew/design) and starts claude. Refuses when paused, or when crew ≥ maxCrew, counting running crew and stopped crew that still hold an unfinished task (design doesn't count). New crew are named from a fixed list (ada, bea, cleo…, then ada-2…) unless `crewNames: "numbers"` (crew-2, crew-3…). Only one design agent. Only the Captain or "you" may spawn. |
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

### New apps (src/core/newproject.ts, src/core/github.ts, src/cli/newapp.ts)

Renamed or moved project folder: `state.json` stores absolute paths (`repoRoot`, each `agent.worktree`). On start the Store notes when the saved `repoRoot` differs from the current root (`store.movedFrom`); `relocateState` (`src/orchestrator/relocate.ts`) then rewrites `repoRoot` and every worktree under the old root (case-insensitive on Windows), logs it once and commits. `repairWorktrees` always runs `git worktree repair <each existing crew worktree>` from the root (idempotent, so a folder moved by hand works too), and after a move `AgentManager.rewriteAgentFiles` regenerates every agent's mcp.json, settings.json and prompt.md. All of this runs before `resumeAll`, so nothing is created under the old root.

Any folder: Muster needs a git repo with a commit (worktrees branch from it). `muster up --create` / `muster init --create` call `prepareRepo` (`src/cli/setup.ts`): not a repo → `git init -b main`; empty folder → `README.md` (`# <folder>`); no `.gitignore` → node_modules, dist, .env, .muster/; then `git add -A` and `Initial commit (set up by Muster)` (placeholder identity for that commit only if none is set, never global config). A subfolder of a repo resolves to the repo root, nothing is nested. Without the flag the old errors stay. `muster init --inspect` prints JSON `{state, root, files, bytes, large}` (large = over 5,000 files or 200 MB, ignored files not counted); the desktop app runs `muster up --create` without asking, and only shows a confirm dialog when the folder is large. Once a task is merged and there is no `origin` remote, the dashboard shows a banner offering a private GitHub backup (`POST /api/project/github`, via `gh`); "Don't ask again" sets `githubOffer: "never"`, and Settings → GitHub has the same button and the toggle.

Start from nothing: `muster new "<idea>" [--dir <parent>] [--title <t>] [--no-open]` calls `createNewProject({ parentDir, idea, title? })`, which makes `<parent>/<slug>` (slug from the title, else `idea-YYYY-MM-DD`; `-2`, `-3`… on a clash), runs `git init -b main`, writes `README.md` (`# <title|Untitled idea>` + the idea) and `.gitignore` (node_modules, dist, .env), makes the first commit (your git identity; if none is set, `-c user.name=Muster -c user.email=muster@localhost` for that one commit only), runs `initMuster` and returns `{ root, slug }`. The CLI then starts the orchestrator like `muster up`, POSTs the idea to `/api/ask` (retrying while the Captain starts) and prints the path.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/project | – | `{ name, root, remoteUrl?, gh: { installed, authed, user? } }` (`remoteUrl` = origin) |
| POST | /api/project/github | `{ name, private? = true, description? }` | `{ url }`. Human only (403 for agents). 400 bad name (letters, digits, `.` `_` `-`, optional `owner/`), 409 origin already exists, 424 gh missing or not signed in (message says to run `gh auth login`), 502 if `gh` itself fails |

The route runs `gh repo create <name> --private|--public --source <root> --remote origin --push [--description d]` through an injectable `GhRunner` (`OrchestratorOptions.ghRunner`, used by tests), and sets `config.projectName` to the repo name if config.json has none.

### Tasks
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/tasks | – | `Task[]` |
| POST | /api/tasks | `{ title, description, dependsOn?, stations?, line?, assignee?, actor }` | `Task` — stations default to the default line (config.defaultStations); `line` picks another; always end with "review" |
| POST | /api/tasks/claim | `{ actor }` | `Task \| null` — next `ready` task whose current station's role matches the actor's role, oldest first. Refused when paused. |
| POST | /api/tasks/:id/assign | `{ agentId, actor }` | `Task` — refused when paused |
| POST | /api/tasks/:id/handoff | `{ actor, to?, note }` | `Task` — advances stationIndex; `to` = agent id, or omitted = task becomes `ready` for any agent of the next station's role. Receiver's worktree merges the sender's branch (orchestrator runs `git merge --no-edit <senderBranch>` in the receiver worktree). Next station "review" → status `review`, assignee = captain. |
| POST | /api/tasks/:id/done | `{ actor, summary }` | `Task` — shortcut: jump to the review station (status review, assignee captain), posts a Done note |
| POST | /api/tasks/:id/approve | `{ actor: "you", note? }` | `Task` — human only. A task at a station whose role is `human` has status `awaiting_approval`, no assignee (nobody can claim it) and an open `approval` note to you (toast + notification). Approve closes the note and moves the task to the next station (a free agent of its role, another approval, or the Captain's review); the Captain gets an inbox item. 409 unless `awaiting_approval`. A human station can be a task's first station: the task is created `awaiting_approval` |
| POST | /api/tasks/:id/reject | `{ actor: "you", note }` | `Task` — human only, note required (400). Sends the task back to the previous station (stationIndex − 1) and the agent that last handed it in; if that agent is gone, stopped or busy, or the previous station is human, the task is `ready` for the role (or awaiting approval again). Replies on and closes the approval note; the Captain gets an inbox item. 409 unless `awaiting_approval`, or when there is no earlier station. `sendback` still jumps to `build` |
| POST | /api/tasks/:id/review | `{ actor, summary }` | `Task` — Captain only: status `ready_for_merge`, posts a `review` note (open, "Needs you"), notifies you. 409 while the task has no evidence and `config.requireEvidence` (default true) |
| GET | /api/tasks/:id/brief | – | `{ text }` — what the worker of the current station is told: its guideline, its skills, and at the evidence station (the last one before review an agent works; review itself when there is none) the evidence ask |
| POST | /api/tasks/:id/evidence | `{ actor, files?: string[], text?, summary }` | `Evidence` — files are paths in the caller's worktree (folders expand; must stay inside it; ≤40 files, ≤100 MB each, ≤500 MB per task); `text` is saved as `notes.md` (the Captain can't write files). Copied to `.muster/evidence/<task>/<E#>/`, appended to `task.evidence` with the station, the caller and its worktree HEAD. Only the task's current worker, the agent on its branch, the Captain or you |
| GET | /api/tasks/:id/evidence/:entry/:file | – | the file (images, video, text as text/plain; sandboxed CSP) |
| GET | /api/skills | – | `SkillInfo[]` — the skills in `plugin/skills`; `PUT /api/stations/:name` takes `skills: string[]` (unknown names → 400) |
| POST | /api/tasks/:id/sendback | `{ actor, note }` | `Task` — Captain or you: back to the build station, assignee = previous builder, note delivered |

Task readiness: `blocked` while any `dependsOn` task is not `ready_for_merge`/`merged`; recomputed after every change.

### Roadmap (src/core/roadmap.ts — added 2 Oct)

Types: `Roadmap`, `RoadmapStage`, `RoadmapGoal`, `RoadmapProgress` in src/types.ts; stored as `state.roadmap`; ids from `nextIds.stage` ("M1"…) and `nextIds.goal` ("G1"…). Design: Vellum file "Muster", artboards "Roadmap" and "Roadmap — stage detail".

**Process.** (1) Before any build work, the Captain drafts the roadmap (`set_roadmap`) — stages with dates and exit criteria, goals per stage. Saving a draft opens an `approval` note to you ("Roadmap ready for your approval", Needs you, toast + notification); re-saving a draft updates that note instead of opening another. (2) You approve (`POST /api/roadmap/approve`) or send it back with a note (`/reject`). Approve: status `approved`, revision+1, closes the note, first stage → `active`, its first goal → `active`, Captain inbox: "Roadmap approved. Start M1 <title>: break G1 <title> into tasks (post_task with goal: G1)." Reject: replies on/closes the note, stays draft, Captain inbox with your note. (3) While approved, every `post_task` should name a goal. After any task change the orchestrator recomputes: a goal whose tasks (≥1, not cancelled) are all `merged` → `done` + feed event + Captain inbox "G2 done. Next: G3 <title> — break it into tasks." (activates the next planned goal of the stage); when every goal of the active stage is done → Captain inbox "All goals of M3 are done. Check its exit criteria (check_criterion) and complete_stage." Completing a stage (all criteria done, or `force` by you) → `done`, next stage `active` with its first goal `active`, feed event, toast. (4) Replanning: any edit through `set_roadmap`/stage/goal routes that adds/removes stages or goals or changes dates on an approved roadmap turns it back into a `draft` (approval note again); status/criteria ticks don't. Work keeps running while a revision waits.

Progress (`computeProgress(state, today)`, pure, exported): task counts per goal/stage/overall exclude cancelled; percent = round(done/total*100), 0 when total 0. Stage health: `done` if stage done; `not_started` if planned and start in the future or unset; else expected = fraction of [start, due] elapsed; `late` if today > due; `at_risk` if percent/100 < expected − 0.15; else `on_track`. Overall health = worst of the non-done stages (late > at_risk > on_track > not_started), `done` when all are done. `daysToLaunch` = whole days from today to launchDate.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/roadmap | – | `{ roadmap: Roadmap \| null, progress: RoadmapProgress \| null }` |
| PUT | /api/roadmap | `{ actor, title, summary, launchDate?, stages: [{ id?, title, description, start?, due?, exitCriteria: string[] \| ExitCriterion[], goals: [{ id?, title, description, start?, due? }] }] }` | `{ roadmap, progress }` — Captain or you. Replaces the plan; entries with a known `id` keep id, status and timestamps; new ones get fresh ids; dropped goals with tasks are refused (409, name them). 1–12 stages, ≤12 goals each, titles ≤120 chars, dates YYYY-MM-DD with start ≤ due (400). Becomes/stays `draft` per rule (4) |
| POST | /api/roadmap/approve | `{ actor: "you" }` | `{ roadmap, progress }` — human only (403), 409 unless draft |
| POST | /api/roadmap/reject | `{ actor: "you", note }` | `{ roadmap, progress }` — human only, note required |
| PATCH | /api/roadmap/stages/:id | `{ actor, title?, description?, start?, due?, status? }` | Captain or you |
| POST | /api/roadmap/stages/:id/criteria/:index | `{ actor, done: boolean }` | Captain or you; ticks one exit criterion |
| POST | /api/roadmap/stages/:id/complete | `{ actor, force? }` | Captain or you; 409 unless all criteria are done (force: you only) |
| POST | /api/roadmap/goals | `{ actor, stageId, title, description, start?, due? }` | Captain or you; new goal at the end of the stage (counts as a plan change) |
| PATCH | /api/roadmap/goals/:id | `{ actor, title?, description?, status?, start?, due? }` | Captain or you |

`POST /api/tasks` and `post_task` take `goalId?` (404 for an unknown goal; a task posted to a `planned` goal activates it). `GET /api/state` carries `state.roadmap`; the dashboard computes nothing itself except via `GET /api/roadmap` (re-fetched on each state event).

**MCP (Captain only):** `roadmap()` — plain-text outline with progress, health, the current stage/goal and unticked criteria; `set_roadmap(title, summary, launchDate?, stages)` (same shape as PUT); `update_stage(stage, …)`, `check_criterion(stage, index, done)` (index 1-based in the tool, 0-based in the API), `complete_stage(stage)`, `add_goal(stage, title, description, start?, due?)`, `update_goal(goal, …)`; `post_task` gains `goal?`. Crew/design: `list_tasks` shows each task's goal; no roadmap writes.

**Captain prompt:** at the start of a project (no roadmap, or a goal from you that describes a whole product) draft the roadmap first and wait for approval before posting build tasks — the new-app line's discover/concept work may run first to inform it. Every turn, read the roadmap with the board; post every task with its goal; work the current goal; when told a goal is done, start the next; tick exit criteria only with evidence; propose replans with set_roadmap instead of silently changing scope. A goal you give that isn't on an approved roadmap: add it to the right stage with add_goal (that sends the change to you).

**Dashboard:** nav item "Roadmap" (2nd, under Dashboard; trailing text = current stage id) on every page. `#/roadmap` = overview (summary strip, stage timeline by week with a today line, the current stage expanded to its goals, panels: recently landed, tasks merged per day, up next). `#/roadmap/M3` = stage detail (breadcrumb, stage stepper, header + stats, goal groups → task table, exit criteria, stage activity from the feed). Empty state: "No roadmap yet" + "Ask the Captain to draft one" (POST /api/ask). Draft state: banner "Roadmap draft · revision n — waiting for your approval" with Approve / Send back (note).

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

"Needs you" = open notes of type `escalation`, `review` or `approval` (and any note addressed `to: "you"`).

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
- **Everyone:** `add_evidence(files?, text?, summary, task?)` (task defaults to the one you hold). **Captain also:** `get_evidence(task)` (entries, text files inline, absolute paths of images and videos to open with Read).
- `claim_task` returns the task plus its station brief (`GET /api/tasks/:id/brief`; falls back to the station file on an older orchestrator).
- Tool results are short plain text (not raw JSON dumps) — agents read them.

## Skills plugin (plugin/)
Every agent launches with `--plugin-dir <MUSTER_HOME>/plugin`, a Claude Code plugin named `muster`, so its skills reach agents as `muster:<name>` without touching the user's `~/.claude/skills`: `evidence-driven-testing`, `before-and-after` (with `scripts/shot.mjs`, a headless Chrome/Edge screenshot), `code-structure`, `unslop`, `web-research` (public-web research through Agent Reach's no-login tools; setup in `plugin/README.md`, which also lists sources and local edits). `ptyEnv` appends `~/.agent-reach/venv/Scripts` to the end of PATH and sets `AGENT_REACH_PYTHON` when that venv exists. A station's `skills:` frontmatter line names the ones its worker loads (absent = `DEFAULT_SKILLS`: discover/concept → web-research, plan/build/fix → code-structure, reproduce/test → evidence-driven-testing, design-check → + before-and-after, review → unslop; an empty line = none). The station brief tells the worker to load them.

## Role prompts (src/prompts)

`captainPrompt(ctx)`, `crewPrompt(ctx)`, `designPrompt(ctx)` where `ctx = { agentId, repoRoot, worktree, branch, baseBranch, testCommand, projectName, vellumFile? }` → markdown string. Must encode the SPEC rules: Captain checks the board first every turn, never writes code or merges, crew answer each other first, escalate only decisions only the human can make, request_review when a branch is tested; Crew work only in their worktree, commit on their branch, post progress, ask other crew before the Captain, never merge or push; Design crew read the Vellum design framework (read-only unless the Captain asks) and flag drift with notes/messages.

### Design check reporting (designPrompt; parsed by the Vellum page's Design checks list)
Every design check the design crew posts, as a `done` note or a `report_done`/`handoff` summary, starts with a line `PASS T# <summary>` or `DRIFT T# <summary>`. For drift, one line per difference follows: `path:line — what differs` (e.g. `ui/src/pages/vellum.ts:42 — card radius 8px, design says 12px`). `config.vellumFile` (string; `null` or `""` clears it, other types get 400) names the framework file in that prompt.

## Dashboard (ui/)

Vite + TypeScript, no framework needed (vanilla TS + small render helpers), `@xterm/xterm` + `@xterm/addon-fit`. Must match the approved Vellum design (file "Muster", id `28BUsqILtGqq`): 7 screens (Dashboard, Bulletin board, Crew chat, Tasks, Branches, Vellum boards, Settings) + the "Design system" page tokens. Uses only the HTTP API and WebSockets above. Hash routing (`#/board`, `#/chat`, ...). Grid layouts: 1 → full, 2 → side by side, 3 → two on top + one wide, 4 → 2×2, >4 → pages. Right-click a tile (or ⋯): Set as Captain / Crew / Vellum design crew, View diff, Close.
