# Muster remote connector: control the Captain from claude.ai

Goal: from the Claude app (phone or web) say "tell Muster to do X", "what's the status?", "what needs me?", and have
Claude call Muster. Sending a goal needs an explicit yes from the user before it runs.

Status: spec only, nothing built. Contract for the Captain; read docs/PHONE.md first, this builds on it.

## Decision: extend the phone gateway, don't write a new server

`src/phone/` already has what a remote connector needs: one process per PC, per-device keys (hash only on disk),
project discovery, and a proxy to each orchestrator that uses the human token. The Android API already covers
needs/approve/send-back/reply/answer. So the connector is **one more door into the gateway**: an MCP endpoint at
`/mcp`, served by the same code paths as the phone routes. No new token store, no second copy of project discovery.

`src/mcp/` is the agents' stdio MCP (Captain/crew tools). **Do not reuse or extend it**; a remote connector must never
expose agent tools such as merge_task or set_roadmap.

## Pieces

1. **MCP endpoint** in the gateway: Streamable HTTP (`@modelcontextprotocol/sdk`, already a dependency), stateless,
   path `/mcp`. Listens on a **second, plain-HTTP listener bound to 127.0.0.1 only** (default `:47911`,
   `MUSTER_REMOTE_PORT`). The tunnel terminates TLS, so the self-signed phone cert is not involved and the LAN port
   stays unchanged. Off by default; enabled from Settings → Phone → "Remote access" (or `muster remote on|off`).
2. **Auth** (see below): OAuth for claude.ai, one owner, no accounts.
3. **Tunnel**: Cloudflare Tunnel as the default, Tailscale Funnel as the alternative. Muster does not bundle either;
   Settings shows the exact command and the public URL to paste into claude.ai, and a "Test" that calls `/mcp`
   `initialize` through the public URL.
4. **Audit log**: `secretsBase()/phone/remote.log`, one JSON line per tool call (time, tool, project, args summary,
   result, confirmed y/n). Shown in Settings under Remote access (last 50).

## Remote messages live in crew chat

Everything sent through the connector (goals, replies, answers) is posted to **crew chat as a normal message from
you**, so the whole conversation stays in one place. `remote.log` stays as the security record (refusals, held and
discarded items, the confirm switch), but crew chat is where the conversation is read.

- **When:** at the moment it is really sent, i.e. after your tap on Send (or straight away if the hold is off). A held
  or discarded item never appears in crew chat; it lives in Needs you until then.
- **Data (as built):** `FeedItem.via?: RemoteVia = { client, approvedOn: 'phone' | 'desktop' | 'not held', approvedAt }`
  (types.ts); its presence means "came through the connector". The gateway passes `via` on `POST /api/ask`,
  `/api/notes/:id/reply` and `/api/notes/:id/answer`. The orchestrator (`remoteVia` in api.ts) accepts it only from the
  human token (an agent token → 403, nothing posted), sanitises the client name (control characters stripped, 80
  characters, default "Claude") and normalises the date, and `board.addFeed` / `replyNote` put it on the feed item.
- **Side:** on the **right**, as your own messages (`.cmsg.mine`, blue), never on the left with the agents. Goals
  already render there (`from: 'you'`). Replies and answers from you currently only show inside the note card's
  thread; a reply or answer with `via: 'remote'` **also** renders as its own right-side bubble with a `↳ N12` link to
  the note (the card thread keeps showing it too, so the note history stays complete).
- **Tag:** a small muted chip in the bubble head after your name: "via Claude" (title: "Sent from the Claude app
  through the remote connector, approved on <phone/desktop> at 14:02"). Same chip on the phone app's Crew tab.
- **Answers** render as one line per question (`Export format: MP4`), like the note thread does today.
- Tests: feed item carries `via`, an agent token can't set it, held → not in feed, sent → in feed once, chat renders a
  remote reply on the right with the chip and the note link.

## Tools

All take optional `project` (id or name; default = the only running project, else an error listing running ones).
Each tool wraps an existing gateway/orchestrator call; no new orchestrator routes except where noted.

| Tool | Does | Backed by | readOnlyHint |
|---|---|---|---|
| `muster_status` | Projects (running or not), Captain state, paused/usage, task counts by status, roadmap `statusLine` | `GET /api/state` | true |
| `muster_needs` | What needs the user now (same list as the phone's Needs you) | gateway `GET /api/needs` logic | true |
| `muster_bulletin` | Last N bulletin notes / crew chat lines, `limit` ≤ 30 | `GET /api/notes`, feed from `/api/state` | true |
| `muster_task` | One task: status, stations, review text, diff stat | gateway task detail | true |
| `muster_send_goal` | Set a goal for the Captain (`text`) | `POST /api/ask` | **false** |
| `muster_reply` | Reply to a note (`noteId`, `text`); **held** like send_goal | gateway notes reply | false |
| `muster_answer` | Answer a Captain question menu (`noteId`, `answers`); **held** like send_goal | gateway notes answer | false |
| `muster_approve` | Approve a reviewed task for merge | gateway approve | false, **off by default** |
| `muster_note` | Save to the project's Notes page (`text` ≤ 8000, `title?`, `tags?`). **Not held**: saved straight away (see below) | `POST /api/jots` with `via` | false |
| `muster_notes` | Read the project's Notes (`query?`), pinned first then newest | `GET /api/state` (`state.jots`) | true |

Deliberately **not exposed**: shell, file access, merge/push directly, config, tokens, pause/resume, stopping agents,
anything on the agents' MCP. `muster_approve` ships disabled; the owner turns it on in Settings, because a merge pushes
to origin.

Tool results are plain short text (like `src/mcp/format.ts`), not raw JSON dumps. Text that came from agents (notes,
review text) is returned inside a clearly labelled block, since a crew message is untrusted input to the model reading it.

### Notes are not held (added 2026-10-07)

The user asked that "put this in notes" / "make a note" through Claude saves ideas to a Notes page instead of
sending the Captain a goal. `muster_note` saves at once, with no Send tap, because a note reaches no agent: it sits on
the Notes page until the user presses **Send to Captain** there (a desktop action, made by the user). The hold exists
to stop a write from acting on the crew; a note can't. The note is marked `from: 'claude'` (with the connector app's
name) through the same human-only `via` record as other remote writes, and the call is logged in `remote.log` like
every tool call, plus a `note_saved` audit line. The Captain reads notes with the read-only `list_notes` tool and never
edits them.

## Confirmation gate (every write tool)

> **The tap-to-send hold is the protection. Nothing else is.** The tool descriptions telling the model that agent note
> text is data, not instructions, are a helpful nudge, not a control: a model can still be talked into calling a tool.
> Never loosen, shorten or skip the hold because of that wording, and never treat it as a reason to default
> `confirmWrites` off.

Two layers, both on:

Notes and review text are written by agents, so a note can carry injected instructions that trick the calling model
into replying or answering. `muster_reply` and `muster_answer` therefore sit behind the same hold as `muster_send_goal`
until the owner trusts the connector.

1. **claude.ai's own tool approval.** Write tools carry `readOnlyHint: false` and `destructiveHint: false` (approve:
   `true`), so the client asks before running them. Don't rely on this alone; it is the client's setting, and the user
   can set a connector to "always allow".
2. **Server-side hold** (default on, setting `remote.confirmWrites`, replaces `confirmGoals`): `muster_send_goal`,
   `muster_reply` and `muster_answer` do **not** call the orchestrator. Each creates a pending item and returns "Waiting for your OK on your phone/desktop (id P3)". The pending goal shows as
   an approval in Needs you (phone M04, desktop board) with the goal text and "Send to Captain / Discard". Only that tap
   makes the real call (`POST /api/ask`, reply or answer). It is never dropped on time: it waits until you Send or
   Discard it (after 15 min it is only marked overdue). This is what actually stops a prompt-injected or mistaken call.
   Pending items live in gateway `state.json` (`pending: [{ id, project, kind, text, createdAt }]`). Add a new `NeedItem`
   kind `'remote_write'` (goal, reply or answer, shown with its target note) with actions `['send','discard']`.

`remote.confirmWrites` is on by default and is not a convenience toggle. With it off, an injected bulletin note can get a
reply sent with no tap. Turning it off needs a confirm dialog that says exactly that; it can only be changed from the
desktop (never through `/mcp` or the phone), it is written to the audit log, and Settings shows a warning banner while
it is off.

If layer 2 is off, the write runs immediately and the audit log still records it.

## Auth

**Checked 2026-10-05** against claude.com/docs/connectors/building/authentication, .../custom/add-unlisted and
support.claude.com 11175166 / 11176164:

- Supported by default: OAuth 2.0 with DCR (`oauth_dcr`), OAuth with a Client ID Metadata Document (`oauth_cimd`,
  recommended; picked only when the AS metadata has `"client_id_metadata_document_supported": true` and `"none"` in
  `token_endpoint_auth_methods_supported`), and authless. A static header/API key is **beta for a limited set of
  organizations**, so it is not a plan. "Use your own OAuth client" (manual client ID, secret optional) also exists.
- PKCE S256 required; no `client_credentials`. Auth specs 2025-03-26, 2025-06-18, 2025-11-25. Streamable HTTP.
- Discovery: an unauthenticated request must get **401** (not 200) with
  `WWW-Authenticate: Bearer resource_metadata="..."`; only the first `authorization_servers` entry is used; the
  metadata `resource` must equal the URL the user enters.
- Redirect URI to allow: `https://claude.ai/api/mcp/auth_callback` (web, Desktop, mobile). Claude Code uses
  `http://localhost:<any port>/callback` (allow `127.0.0.1` too).
- Calls come from Anthropic's cloud, outbound range **`160.79.104.0/21`**, for every client including mobile. So the
  server must be public (tunnel), and the tunnel can allowlist that range as an extra layer.
- Custom connectors added on the web show up in the iOS/Android apps.
- Tool limits: ~150,000 characters per result, 240 s per call. Per-tool "Always allow / Needs approval / Blocked"
  exists in Customize → Connectors, which is why the server-side hold matters.

Plan: OAuth with **CIMD first, DCR as fallback**, as below.

Plan assuming OAuth is required (the safe default):

- Minimal single-owner OAuth 2.1 authorization server in the gateway: `/.well-known/oauth-protected-resource`,
  `/.well-known/oauth-authorization-server`, dynamic client registration, `/authorize`, `/token`, PKCE (S256) mandatory,
  refresh tokens. Use the SDK's server auth helpers if they fit; otherwise hand-roll, it's small.
- `/authorize` shows a page that asks for a **pairing code** generated on the desktop (same 6-char, 2-minute,
  single-use format as phone pairing, shown in Settings → Remote access). No code, no token. Rate-limit 5 tries/min
  then lock for 10 min.
- Access tokens 1 h, refresh tokens 30 d, only hashes stored. "Disconnect" in Settings revokes all. Tokens are scoped
  `muster:read` and `muster:write`; `muster_approve` also needs the owner toggle.
- All of it is reachable only through the tunnel; the `/mcp` listener refuses requests without a valid bearer (401 with
  `WWW-Authenticate` pointing at the metadata).
- Fallback if claude.ai accepts a static secret: long random path segment + bearer. Only as a fallback; never a
  guessable URL as the sole protection.

## Tunnel notes

- Cloudflare Tunnel: needs a named tunnel and a hostname on a domain the user owns (free quick tunnels get a new random
  URL each run, which breaks the saved connector). Command shown in Settings:
  `cloudflared tunnel run --url http://127.0.0.1:47911 <name>`. Optionally put Cloudflare Access in front, but then
  claude.ai can't reach it unless it supports the Access flow, so default is Muster's own OAuth only.
- Tailscale Funnel: `tailscale funnel 47911`, URL `https://<pc>.<tailnet>.ts.net`. Funnel is public; same auth applies.
- Muster only **detects and prints**. It never installs, logs in to, or runs a tunnel on its own.
- If the tunnel is down the connector simply fails; nothing else in Muster depends on it.

## Hardening checklist

- Bind `127.0.0.1` only; never `0.0.0.0` (tunnel connects locally).
- Reject non-JSON/oversized bodies (64 KB), per-token rate limit 30 calls/min, goal text ≤ 4000 chars.
- Check `Host` header equals the configured public hostname (set in Settings) to stop DNS-rebinding tricks.
- Never log tokens; audit log stores goal text truncated to 200 chars.
- Revocation: Settings button and `muster remote revoke`; also revoke on gateway state wipe.
- A project that isn't running returns "not running, start it on the PC" (no auto-start from remote).

## UI (needs a Vellum design before building, user signs off)

### Needs-you Send card (desktop board and phone), requirements

The Send button is the only thing between a held item and the Captain, so the card must:

1. **Show the full text, never truncated**: exactly what will be sent (`remote.text`, or every answer in
   `remote.answers`), which **project** it goes to (`remote.projectName`), and for a reply/answer **which note** it
   answers, with that note's author and text (`remote.replyTo`, agent-written, shown as a quote, not as a heading). For
   approve: task id and title. Long text scrolls inside the card; it is never clipped or "…".
2. **Send sends exactly what's shown**: the card holds `remote.digest` and Send posts it back
   (`{ digest }` on `.../pending/:id/send`). The gateway refuses (409, nothing sent) if it doesn't match, so a stale card
   can never send something else. Held writes never change (built in milestone 3).
3. **Visible countdown**: "12:00 left" from `remote.expiresAt`, ticking. At 0 the write is only *overdue*: the card
   stays as it is (not greyed, Send and Discard unchanged) and says "Waiting since HH:MM · still not sent" in the warm
   colour. A held write never expires; `expiresAt` keeps its name on the wire but means "overdue from".
4. **Discard is one tap and as easy to hit as Send**: same size, side by side, no confirm dialog on either. (Send is
   the primary colour, Discard the neutral one; neither is hidden in a menu.)
5. Says who asked (`remote.client`) and when.
6. **Send, Discard and the "Nothing has been sent yet" callout are pinned** (desktop: the detail panel's footer; phone:
   a bar above the tab bar whenever the card is taller than the screen). Long text scrolls *behind* them with a fade
   and a "scroll to read the rest" hint; they never scroll out of reach. The callout is the card's most prominent
   sentence after the title, not a footnote: "Nothing has been sent yet. … only when you press Send."
7. **Other states**: *send failed* keeps the card held and unchanged, shows a red "Send failed. Nothing was sent."
   callout with the orchestrator's reason, and offers Try again / Discard at equal size; *overdue* is described in 3 and counts in Needs you like any held write;
   *gone* (Send got 404: it was already sent or discarded, e.g. on the phone) greys the card and offers only Dismiss.

Crew chat: a message sent via the connector is identical to one you typed except for the "via Claude" chip (and the
`↳ N12` link for replies); hovering the chip says "Sent from the Claude app · held as P8 · you approved it on your
phone at 22:06".

Designs (Vellum file "Muster"): Dashboard page y 3980: "Bulletin board — held reply from Claude", "Crew chat — via
Claude", "Bulletin board — held answer, long", "Send card — failed and expired states". Tablet page y 2280: T07 landscape Needs you with a held answer (list + Send pane, pinned footer), T08 portrait
full-screen held reply (tap from the list), T09 Needs you and T10 Crew with the hold-off banner (no toggle).
Mobile page y 2080: M10, M11,
M12 (long, pinned Send bar), "PC — Settings › Remote access", "PC — Remote access — warnings", "Dialog — turn off the
hold".

### Settings → Remote access card, requirements

- Connection status (Connected / Not connected / Off) and the last successful call through the tunnel, plus the last
  tunnel error (below).
- **Connections list** with one-click Disconnect per row and "Disconnect all" (`DELETE /admin/remote/connections[/:id]`).
- **Login lockout state**: "Logins locked until 14:32 after 5 wrong codes" while `loginLocked`.
- **Warning when the tunnel type isn't set** (`tunnel: null`): "Set the tunnel type, or failed-login IPs will all show
  as 127.0.0.1".
- **Standing banner while the hold is off** (`confirmWrites: false`), on this card and at the top of Settings, until
  it's back on; turning it off goes through the warning dialog (`confirm: true`).
- Login code: **no code is shown until you press New code** (the tab opens on "No code is active"). The code appears
  only in the `POST /admin/remote/code` reply, with a 2-minute bar and Cancel code (`DELETE /admin/remote/code`), and
  disappears when used, cancelled or expired. `GET /admin/remote` only says `codeActiveUntil`, never the code, so a
  reload or a screen share of the tab can't reveal a working code next to the public address.
- **The phone shows the hold-off banner too** (M13 Needs you, M14 Crew): with the hold off nothing lands in Needs you,
  so the phone would otherwise look normal. No toggle on the phone; it says only the desktop can turn the hold back
  on, with "off since 14:40 · 3 sent without your tap". Data: `GET /api/needs` → `hold: { on, offSince,
  sentWithoutTap }` (same object in `GET /admin/remote`); the count resets when the hold goes back on.
- Public URL + Test, the approve-merges switch, last 50 audit lines.

Settings → Phone gets a **Remote access** card. Its header carries a **connection indicator**, so you can see at a
glance whether the link actually works, not just that it's configured:

- **Connected** (green dot): an authenticated MCP call came **through the tunnel** and succeeded in the last 15 min.
  Subtext "Last call through the tunnel 3m ago (muster_status)".
- **Not connected** (grey): remote is on but no successful tunnel call in 15 min, or ever. Subtext shows the last
  success ("Last call 2h ago" / "No call through the tunnel yet"), plus the last tunnel failure when it is newer
  ("Refused 401, wrong token, 5m ago"; a 421 means the public-host setting doesn't match the tunnel).
- **Off** when remote is disabled.
- A call counts as "through the tunnel" only when its `Host` is the configured public hostname. Calls from this PC
  (inspector, tests) are shown separately as "Last local test" and never turn the dot green.
- Data: `GET /admin/remote` → `{ enabled, port, publicHost, connected, lastTunnelOkAt, lastTunnelError, lastLocalOkAt }`
  (built in milestone 1, in memory; resets when the gateway restarts). The card polls it every 10 s while open.
  The "Test" button goes out through the public URL, so a passing Test also turns the dot green.

The rest of the card: on/off, public URL field + Test, pairing code for the connector,
connected clients with Disconnect, toggles (Hold goals for my OK: on, Allow approving merges: off, Hold replies and answers: on),
last 50 audit lines. Needs you gets the `remote_write` card (goal text, Send to Captain / Discard). Phone app gets the
same card on M04 with an approve notification action.

## Milestone 4 API contract (as built; UI and app code against exactly this)

All admin routes are on the gateway (`/admin/remote/...`, loopback + admin token). The desktop UI reaches them through
its own orchestrator as `/api/phone/remote/...` (handlePhone forwards `/api/phone/<rest>` → `/admin/<rest>` as-is).

| Route | Body / reply |
|---|---|
| `GET /admin/remote` | Remote off: `{ enabled: false, config, hold, settings }`. On: `RemoteStatus` (`enabled, port, publicHost, connected, lastTunnelOkAt, lastTunnelError, lastLocalOkAt, connections[], loginLocked, loginLockedUntil, codeActiveUntil, tunnel`) plus `hold, settings, config, lastTest`. |
| `GET /admin/remote/config` / `PUT` | `{ enabled: boolean, port: number, publicHost: string \| null, tunnel: 'cloudflare' \| 'tailscale' \| null }`. PUT merges, saves to state.json `remote.config`, restarts (or stops) the `/mcp` listener, logs `config_changed`. Env vars only seed it when nothing is saved. |
| `POST /admin/remote/test` | Fetches `https://<publicHost>/.well-known/oauth-protected-resource/mcp` from this PC through the public internet. `{ ok, status?, error?, at }` (`ok` = 200 and `resource` = `https://<publicHost>/mcp`). Stored as `lastTest`. Doesn't count as "connected" (that needs an authenticated call). |
| `GET /admin/remote/log?limit=50` | Newest-first remote.log entries (each the stored JSON line), limit ≤ 200. |
| `POST /admin/remote/code` | `{ code, display, expiresAt }` (the only place the code appears). `DELETE` cancels: `{ ok, cancelled }`. |
| `DELETE /admin/remote/connections[/:id]` | `{ ok, revoked }` |
| `GET /admin/remote/pending` | `[{ id, projectId, noteId?, ...RemoteWriteView, title, summary }]` |
| `POST /admin/remote/pending/:id/send` | body `{ digest }` → `{ ok, id, summary }`; 400 no digest, 409 mismatch / failed send (`{ error }`), 404 already sent or discarded. `.../discard` → `{ ok, id }`. |
| `GET/PUT /admin/remote/settings` | `{ confirmWrites, allowApprove }`; PUT `{ confirmWrites: false }` needs `confirm: true` (400 otherwise). |

Phone API (bearer = device key): `GET /api/needs` → `{ pcName, projects, items, hold: { on, offSince, sentWithoutTap } }`;
held items are `kind: 'remote_write'`, `actions: ['send','discard']`, with `remote: RemoteWriteView` (full text, `digest`,
`expiresAt`, `replyTo` = { id, from, type, text, questions?: [{ header, question, multiSelect, options: string[] }] } (questions
only for a question menu, so each answer shows under its question), `answers`, `taskTitle`). `POST /api/projects/:pid/pending/:id/send` `{ digest }` and
`.../discard`. Push: the events socket sends `{ type: 'need', item }` for new held items (pref "question", ignores quiet
hours) and `{ type: 'resolved', id }` when sent or discarded.

Crew chat: `FeedItem.via = { client, approvedOn, approvedAt }` on goal messages (`kind: 'message'`, from you) and on
replies/answers (`kind: 'reply'`, from you, `noteId`).

## App allow-list (connector apps must be approved on the desktop)

Asked for 2026-10-05: a correct login code is not enough; the app itself must be on an allow-list. "Device" here means
the **connector app** (Claude, Claude Code), not a physical device: claude.ai's calls all come from Anthropic's cloud, so
web, Desktop and mobile are one app. Its ID is the OAuth `client_id` it got at registration (DCR id or CIMD URL), which
the client stores and sends at sign-in and on every token request; every `/mcp` call carries a token bound to it.

- **Sign-in:** after a correct code, an app that isn't approved gets no authorization code. It goes on the waiting list
  (`app_waiting` in the log, a Bulletin-board alert + toast "Claude is asking to connect; approve it in Settings ›
  Remote access") and the consent page shows "Waiting for approval on <pc>". The page refreshes itself (meta refresh,
  no script) on `GET /authorize/wait?r=<request id>`: approved → 302 to the client with the code; denied →
  `error=access_denied`; after 10 minutes → "Timed out". The code you typed is used up either way.
- **Tokens and calls:** `/token` (both grants) and every `/mcp` call require the grant's app to be approved. Removing
  an app revokes all its grants at once (access and refresh), so its next call gets 401 and its refresh fails.
- **Upgrade:** apps that already hold a grant when this ships are approved automatically (`approvedBy: 'existing'`).
- **Admin API** (desktop only, Settings reaches it as `/api/phone/remote/apps…`):

| Route | Reply |
|---|---|
| `GET /admin/remote/apps` | `[{ id, clientId, name, kind: 'dcr' \| 'cimd', status: 'waiting' \| 'approved', requestedAt, approvedAt?, approvedBy?, lastUsedAt?, connections, ip? }]` (`id` = `app_<16 hex>`, URL-safe; waiting first) |
| `POST /admin/remote/apps/:id/approve` | `{ ok, app }`; a waiting sign-in continues on its next refresh |
| `DELETE /admin/remote/apps/:id` | Deny (waiting) or Remove (approved): `{ ok, removed: 1, revoked: n }` |
| `DELETE /admin/remote/apps` | Remove all: `{ ok, removed, revoked }` |

  `GET /admin/remote` adds `apps` (same list) and `appsWaiting` (count). `connections` stays as before (grants).
- **Settings:** the "Signed-in apps" card becomes **Approved apps**: a "Waiting for approval" block on top (app name,
  kind, when, from which IP; **Approve** primary / **Deny**), then approved apps (name, approved when, last used,
  N connections) with **Remove** per row and **Remove all**, the same one-click pattern as Disconnect.

## Milestones

1. **Done 2026-10-05** (`src/phone/remote.ts`): `/mcp` listener + `muster_status` + `muster_needs` read-only, dev
   bearer token (`secretsBase()/phone/remote-dev-token`), Host guard, 30/min rate limit, audit log `remote.log`,
   connection status + `GET /admin/remote`. Opt-in: `node dist/phone/index.js --remote-port 47911` or
   `MUSTER_REMOTE_PORT`, `MUSTER_REMOTE_HOST=<public hostname>`. Auth docs checked (see Auth).
2. **Done 2026-10-05** (`src/phone/oauth.ts`): OAuth + login-code consent page + token store + revoke. User's
   acceptance criteria, all tested (`oauth.test.ts`, 15 tests) and checked with the MCP SDK's own client auth helpers:
   - **The login code is single use and expires quickly**: 6 characters, 2 minutes, consumed on first use, a new code
     kills the old one (`POST /admin/remote/code`). 5 wrong codes in a minute lock logins for 10 minutes.
   - **Tokens are revoked from the desktop in one click**: `DELETE /admin/remote/connections/:id` (one connection) or
     `DELETE /admin/remote/connections` (all); the next call with that token gets 401 and its refresh token is dead.
     `GET /admin/remote` lists `connections` (client name, connected, last used) for the Settings card.
   - **Failed logins are logged** in `remote.log` as `event: "login_failed"` with `reason` (wrong, expired, locked,
     bad_request, bad_code, bad_pkce, client_mismatch, redirect_mismatch, bad_refresh, refresh_reused) and the caller's IP
     (`cf-connecting-ip` / `x-forwarded-for`), plus `refused: 401` for bad bearer tokens on `/mcp`.
   Also: CIMD + DCR, redirect allowlist (claude.ai callback, loopback), PKCE S256 required, auth codes 60 s single use,
   access 1 h / refresh 30 d rotated with reuse detection (reuse revokes the connection), tokens bound to their resource
   (a token issued for the local URL doesn't work through the tunnel), only hashes on disk (`remote.json`), consent page
   escapes the client name and can't be framed. The dev token is now off unless `MUSTER_REMOTE_DEV=1`.
   Not yet verified: claude.ai's real CIMD document (needs the tunnel, milestone 5).

   Follow-ups from review (2026-10-05):
   - **Real client IPs behind the tunnel.** Both tunnels connect to the gateway from 127.0.0.1, so the socket address
     is useless. `realClientIp` (remote.ts) reads a forwarded header **only for requests that came through the tunnel**
     (Host = the public hostname) and **only the header the configured tunnel guarantees**: Cloudflare →
     `CF-Connecting-IP` (Cloudflare *appends* to `X-Forwarded-For`, so its left side can be forged); Tailscale Funnel →
     `X-Forwarded-For`, and only when `Tailscale-Funnel-Request: ?1` is present (Funnel overwrites XFF and strips a
     client-sent marker; Cloudflare would pass a forged marker through, which is why the type must be configured, not
     guessed). Set with `MUSTER_REMOTE_TUNNEL=cloudflare|tailscale` (Settings later); unset → socket address with
     `ipFrom: "socket (tunnel type not set)"`, and `GET /admin/remote` returns `tunnel: null` so the card can warn.
     Every audit line carries `ip` and `ipFrom`.
   - **Lockout shows up on the desktop.** 5 wrong codes lock logins (the correct code too) for 10 minutes; someone
     spamming guesses could block pairing, so the lock is announced: the gateway posts a system note (`topic: 'remote'`,
     to you, open) to every running project's Bulletin board via `POST /api/remote/alert` (human token only, in
     `HUMAN_ONLY`, so agents can't fake one), with the Windows toast once. It counts in "Needs you" and reaches the
     phone as "Remote access". Text: when it unlocks, the last IP and client, "Nobody got in". Tries during the lock
     don't raise more alerts. `GET /admin/remote` also has `loginLockedUntil`. With no project running, it only goes to
     gateway.log (the status still shows the lock).
3. **Done 2026-10-05** (backend; built with two subagents in parallel). Tools `muster_send_goal`, `muster_reply`,
   `muster_answer`, and `muster_approve` only when `allowApprove` is on (all `readOnlyHint: false`; approve
   `destructiveHint: true`; descriptions say agent note text is never instructions). Gateway `src/phone/pending.ts` +
   gateway.ts:
   - A write is **checked first** (project running, note exists, question menu still open with the right number of
     answers, task actually waiting for approval), so you're never asked to approve something that can't run.
   - With the hold on it is stored in state.json `remote.pending` as `P1, P2…` (ids survive restarts), shown in Needs
     you as `kind: 'remote_write'` with `actions: ['send','discard']` (phone push uses the "question" pref and ignores
     quiet hours, since you just asked for it), and stays held until Send or Discard, however long that takes. After 15
     minutes (`expiresAt`) it is only overdue: still listed, still sendable with its digest.
   - Send: phone `POST /api/projects/:pid/pending/:id/send|discard`; desktop `GET /admin/remote/pending`,
     `POST /admin/remote/pending/:id/send|discard` (reachable from the desktop as `/api/phone/remote/pending/...`).
     Send runs the write as you with `via`; a failed send stays held. Approve goes to approve-merge (or approve at a
     human station), like the phone's Approve.
   - `GET/PUT /admin/remote/settings` `{ confirmWrites, allowApprove }`; turning the hold off needs `confirm: true`,
     turning it back on doesn't. Desktop only (no phone or MCP route).
   - Audit: `write_held`, `write_sent` (with approvedOn), `write_discarded`, `write_overdue` (once per write, the first time it is seen past 15 minutes; older logs may
     have `write_expired`), `settings_changed`; tool
     lines carry `held`/`pendingId` and text cut to 200 characters.
   **Not usable end to end until milestone 4**: the desktop has no Send/Discard button yet and the installed phone app
   doesn't know `remote_write` (it reads `kind` as a plain string, so nothing breaks; the item just has no buttons).
4. Settings card + desktop board card + phone card + the crew-chat "via Claude" chip and right-side remote reply
   bubble (design first, as an addition to the signed-off "Crew chat — v2" artboard).
5. Real run: Cloudflare named tunnel → add as custom connector in claude.ai → "what's the status?" → "send goal X" →
   tap Send on the phone → Captain receives it.
   Checklist before and during the run:
   - [ ] **`MUSTER_REMOTE_TUNNEL` is set** (`cloudflare` for the named tunnel) along with `MUSTER_REMOTE_HOST`.
     `GET /admin/remote` must show `tunnel: "cloudflare"`, not `null`; unset, every logged IP is the tunnel's
     127.0.0.1 and the failed-login log loses its point.
   - [ ] After the first call through the tunnel, `remote.log` lines show `ipFrom: "cf-connecting-ip"` with a real
     public IP, and `/admin/remote` shows `connected: true`.
   - [ ] One wrong code on the consent page → a `login_failed` line with the browser's public IP.
   - [ ] Lockout end to end: 5 wrong codes → the Bulletin board note **and the Windows toast actually appear on screen**.
   - [ ] Desktop revoke → claude.ai's next call fails and it asks to reconnect.
   - [ ] claude.ai picked CIMD (or DCR): note which in this doc.

Tests follow the existing gateway tests (`src/phone/gateway.test.ts`, `testfakes.ts`); set `MUSTER_SECRETS_DIR` in tests.
