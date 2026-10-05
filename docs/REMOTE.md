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
- **Data:** `FeedItem.via?: 'remote'` (types.ts). The gateway passes `via: 'remote'` on `POST /api/ask`,
  `/api/notes/:id/reply` and `/api/notes/:id/answer`. The orchestrator accepts `via` only from the human token (an agent
  token sending it → 403) and copies it onto the feed item that `board.addFeed` / `replyNote` makes. Held items record
  which client asked (`claude.ai`) so the tag can say so.
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

Deliberately **not exposed**: shell, file access, merge/push directly, config, tokens, pause/resume, stopping agents,
anything on the agents' MCP. `muster_approve` ships disabled; the owner turns it on in Settings, because a merge pushes
to origin.

Tool results are plain short text (like `src/mcp/format.ts`), not raw JSON dumps. Text that came from agents (notes,
review text) is returned inside a clearly labelled block, since a crew message is untrusted input to the model reading it.

## Confirmation gate (every write tool)

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
   makes the real call (`POST /api/ask`, reply or answer). It expires after 15 min. This is what actually stops a prompt-injected or mistaken call.
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

## Milestones

1. **Done 2026-10-05** (`src/phone/remote.ts`): `/mcp` listener + `muster_status` + `muster_needs` read-only, dev
   bearer token (`secretsBase()/phone/remote-dev-token`), Host guard, 30/min rate limit, audit log `remote.log`,
   connection status + `GET /admin/remote`. Opt-in: `node dist/phone/index.js --remote-port 47911` or
   `MUSTER_REMOTE_PORT`, `MUSTER_REMOTE_HOST=<public hostname>`. Auth docs checked (see Auth).
2. OAuth + pairing-code consent page + token store + revoke. Tests: PKCE, wrong code, lockout, expired/revoked token.
3. Write tools with the server-side hold, pending store, `remote_write` NeedItem, audit log. Tests: send_goal creates
   pending and does not call `/api/ask`; discard; expiry; approve disabled by default.
   Remote writes post to crew chat as yours (`FeedItem.via: 'remote'`, right side, "via Claude" chip); see
   "Remote messages live in crew chat".
4. Settings card + desktop board card + phone card + the crew-chat "via Claude" chip and right-side remote reply
   bubble (design first, as an addition to the signed-off "Crew chat — v2" artboard).
5. Real run: Cloudflare named tunnel → add as custom connector in claude.ai → "what's the status?" → "send goal X" →
   tap Send on the phone → Captain receives it.

Tests follow the existing gateway tests (`src/phone/gateway.test.ts`, `testfakes.ts`); set `MUSTER_SECRETS_DIR` in tests.
