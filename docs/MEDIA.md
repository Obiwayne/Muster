# Media

The Media page is where herald, the media crew member, writes content about the project's progress: social posts,
articles, website text and video scripts. herald writes only from things that really happened (the roadmap, merged
tasks, task evidence, intel and crew chat), and every claim it makes points back to its source. You review the draft,
edit it, approve it, copy it out and mark it used. **Muster never posts anything anywhere.**

The design is the "Media" page of the Vellum file "Muster" (28BUsqILtGqq, page p-13262-0). It has five artboards:
the library, the new piece dialog, the social post editor, the article editor and the video script screen.
Types live in `src/types.ts` under "Media".

## Rules (user decisions, 2026-10-07)

1. Outputs: social posts, articles, website content and video scripts.
2. **Plain text only.** No HTML or Markdown pages and no export files. Articles and website content are copied as
   plain text: the headings are on their own lines, with a blank line between paragraphs. The video script copies as
   plain text, and the shot list copies as CSV text to the clipboard. Social posts keep their attached evidence
   screenshots, which you can open full size and save yourself.
3. herald is a dedicated crew member with role `media`, id `herald` and colour rose `#F472B6`. It never edits code,
   never claims tasks and never posts.
4. Content gets written on demand (New piece) **and** from suggestions that you accept or dismiss.

## Storage

The store is `.muster/media.json` (`MediaStore`), owned by a `MediaFile` class that copies `IntelFile` in
`src/core/intel.ts`. Every commit does rev + 1 and an atomic write, then the server broadcasts
`{ type: 'media', rev, summary }`. The default `houseStyle` is: "Plain words, no hype, short sentences. Name the real
feature, show the screenshot, say who it helps. No em dashes, no 'not X but Y', no rule-of-three lists, no
'game-changer', 'seamless', 'unlock', 'elevate'."

Ids: pieces are MP1, MP2…; suggestions are MS1, MS2…; inside a piece, claims are C1… and sections are S1….

## Lifecycle

- **queued → drafting → review → approved → used.** `failed` happens when herald exits without finishing; Retry
  moves the piece back to `queued`.
- **Queue:** herald works on one piece at a time, oldest queued first. When a piece is created, or asked to change,
  while herald isn't running, the server starts herald (like scout: `agents.startHerald()` at the repo root). When
  the queue is empty after a finish, herald is stopped after a short delay (like `stopScout` / `scoutStopDelayMs`).
  herald doesn't run while usage is paused (`assertNotPaused` for starting; queued pieces wait).
- **Ask herald to change it** (`/ask`) adds a `MediaRequest` and moves an approved, review or failed piece back to
  `queued`. Requests where `doneAt` is unset are herald's to-do list. Finishing sets `doneAt` on all of them.
- **Your edits:** you can edit the text in any status except `drafting` (the editor is read-only while herald
  writes). Editing an approved piece moves it back to `review`.
- **Approve** is blocked (409) while any claim has `sources: []`. You either **Confirm** a claim (it gets a
  `{kind:'opinion', ref:'', label:'opinion · your voice'}` source) or **Ask herald to cut it** (this adds a request).
- **Mark used** sets `usedAt`. Pieces in `review` count towards the nav badge.
- Finishing a draft creates a board note with topic `'media'` ("herald finished MP3 · Teachers now approve…",
  Open link `#/media/MP3`). The server dismisses that note on approve, delete or used. The finish also sends a toast
  and a Windows notification, like research finish.

## Suggestions

The server creates suggestions (`MediaSuggestion`, status `open`). Nothing is written until you click **Write it**.

- **stage:** a roadmap stage completes (wherever `complete_stage` / auto-complete marks a stage done). The plan is an
  article, a social post on [x, linkedin, bluesky] and a website changelog entry. `about` is the stage.
- **feature:** the Captain calls the MCP tool `suggest_media(task, title, why)` after merging a user-visible feature.
  The plan is a social post on [x, linkedin] and a website section. The Captain prompt gets one line: "When a merged
  task is something users will notice, call suggest_media once for it."
- **weekly:** when the server starts, and then hourly, for the ISO week that just ended (Mon–Sun), if `lastWeekly`
  is not that week and 5 or more tasks merged that week. The plan is an article and a video script, and `about` is a
  range. It always sets `lastWeekly` (even when there are fewer than 5).
- Don't create duplicates: skip it when an open or accepted suggestion with the same trigger and ref exists.
- **Write it** (`accept`) creates one queued piece per plan item, with `suggestionId` set. **Change the plan** opens
  New piece pre-filled from the suggestion; creating a piece from it with `suggestionId` accepts the suggestion.
  **Dismiss** and **Dismiss all** are also available.

## HTTP API (orchestrator, `src/orchestrator/api.ts`; core logic pure in `src/core/media.ts`)

All write routes take `actor` like the other routes. "you" means `HUMAN` only, and "herald" means an agent with role
`media` only. The Captain-only route takes the Captain. On a wrong actor the route returns 403 with plain words.

| Route | Who | Does |
|---|---|---|
| `GET /api/media` | any | `MediaStore` |
| `GET /api/media/summary` | any | `MediaSummary` |
| `POST /api/media/pieces` `{kind, about: [{kind, ref}], note?, platforms?, suggestionId?}` | you | new queued piece; title = placeholder from about until herald sets it; starts herald |
| `POST /api/media/pieces/:id/edit` `{title?, posts?, sections?, hooks?, hookChosen?, shots?, target?, images?}` | you | replaces those fields (validated, lengths capped); not while drafting (409) |
| `POST /api/media/pieces/:id/ask` `{text}` | you | adds request → queued; starts herald |
| `POST /api/media/pieces/:id/claims/:cid/confirm` | you | marks claim as your opinion |
| `POST /api/media/pieces/:id/approve` | you | review → approved (409 when unsourced claims) |
| `POST /api/media/pieces/:id/used` | you | approved → used |
| `POST /api/media/pieces/:id/retry` | you | failed → queued; starts herald |
| `DELETE /api/media/pieces/:id` | you | removes it (stops herald if it was on it, moves on to the next) |
| `PUT /api/media/style` `{text}` | you | house style (≤ 4000) |
| `POST /api/media/suggestions/:id/accept` / `dismiss`, `POST /api/media/suggestions/dismiss-all` | you | see above |
| `GET /api/media/brief` | herald | plain-text brief for the current piece (below) |
| `POST /api/media/pieces/:id/draft` `{title?, posts?, images?, sections?, hooks?, shots?, target?, claims?, progress?}` | herald | save a partial draft (status drafting); validates like edit |
| `POST /api/media/pieces/:id/finish` `{summary?}` | herald | drafting → review; board note, toast, notify; next queued piece or stop |
| `POST /api/media/suggestions` `{task, title, why}` | Captain | feature suggestion |

Validation limits: post version ≤ 3000 chars (with X ≤ 280, Bluesky ≤ 300 and Threads ≤ 500 shown as warnings in
the UI and not rejected); up to 3 versions per platform; section text ≤ 8000; up to 20 sections; up to 40 shots;
up to 60 claims; up to 6 images. Images must name an existing evidence file of that task (400 otherwise).

### herald's brief (`GET /api/media/brief`)

The brief is plain text and covers:
- the current piece: kind, platforms, target, `about` labels, your note and open requests;
- the house style;
- for each stage, goal or task in `about` (a range expands to the tasks merged in it): the title, summary or goal
  text, merge date, and the task's evidence list as `T38/E2 · after-queue.png · <absolute path>`, so herald can open
  screenshots with Read;
- intel edges and gaps that relate (titles only, with ids);
- the last 40 crew chat lines that mention those task ids;
- the rules: plain text; every factual sentence needs a claim with sources; anything you can't source is either left
  out or recorded as a claim with `sources: []`; save often with `media_draft` (sections one at a time, with
  `progress`); call `media_finish` when done. For social posts write 3 versions per platform within that platform's
  limit. For a video, write 3 hooks and a shot table that uses evidence screenshots where they exist and marks
  `record: true` where they don't.

## MCP tools (`src/mcp/server.ts`)

herald gets its own tool set (like scout): `media_brief()`, `media_draft(piece, …fields)`,
`media_finish(piece, summary?)`, plus the read-only crew chat and roadmap tools that scout has, if those exist.
herald gets no board, task, merge or code tools. The Captain gets `suggest_media(task, title, why)`.

## Agent (`src/orchestrator/agents.ts`, `src/prompts/index.ts`)

herald is spawned like scout: it runs at the repo root with read-only intent, `--permission-mode auto`, and the same
shell guard scout has. Its prompt says who it is, that it writes for the person running Muster in their house style,
that it must call `media_brief` first, and that it must never post, push, edit files or claim tasks. The agent list
shows herald with the rose dot and status text "drafting" or "idle". herald is not counted in maxCrew.

## UI (`ui/src/pages/media.ts`, `ui/src/media.css`, `ui/src/mediamodel.ts` with tests)

- Nav item **Media** (icon: megaphone) goes after Intel. Its rose badge = `summary.review`. The routes are
  `#/media` and `#/media/MP3`.
- The **library** has a sub bar (title, counts, House style, New piece), type tabs (All / Social posts / Articles /
  Website / Video scripts, with counts) and the status legend. **HERALD SUGGESTS** holds the open suggestion cards
  (the newest stage card gets the rose highlight) with Write it / Change the plan / Dismiss, and Dismiss all. The
  pieces table is sorted review → drafting/queued → failed → approved → used, then newest first. The right rail is
  "What herald writes from" with counts, House style and the "Muster never posts for you" line. The empty state is
  one line plus New piece.
- **New piece** is a dialog with the kind cards, About chips (picker: stages, goals, tasks, date range), the
  optional note and the platforms line (social only; defaults to x, linkedin and bluesky), then "Ask herald to
  write it".
- **House style** opens a dialog with a textarea that saves to `PUT /api/media/style`.
- **Editor bar** (all kinds): back to Media, title (editable), meta line, status chip and actions. The actions depend
  on the status: drafting shows herald's progress and disables Approve; review shows Approve; approved shows Mark
  used; failed shows Retry. A Delete action lives in an overflow menu.
- **Social:** platform tabs with character counts (green when within the limit, the stuck colour when over),
  versions A/B/C, an editable textarea, attachments (evidence images, "+ Pick from N" opens a picker of the evidence
  of the `about` tasks), the Ask herald box with chips (Shorter / More personal / Make a thread / Another version),
  and the claims rail "Where every line comes from" with source chips coloured by kind (intel blue, task teal,
  opinion amber, unsourced red with Confirm / Ask herald to cut). Copy text copies the chosen version of the current
  platform.
- **Article / website:** the outline (section status: done tick, writing rose dot, todo ring), the document (title,
  then sections, each editable), herald's live line "herald is writing · <progress>" while drafting, and the claims
  rail. Copy text copies the plain text. Website also shows the `target` path, editable, in the meta line.
- **Video:** the shot table (time, shot thumbnail from evidence or a dashed "record" box, voiceover, on screen),
  "Show all", the hook picker rail, shot counts and Copy script / Copy shot list (CSV).
- **Live updates:** listen to the `media` event (events.ts `onMedia`, like `onIntel`) and refetch.
