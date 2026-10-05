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
| `muster_reply` | Reply to a note (`noteId`, `text`) | gateway notes reply | false |
| `muster_answer` | Answer a Captain question menu (`noteId`, `answers`) | gateway notes answer | false |
| `muster_approve` | Approve a reviewed task for merge | gateway approve | false, **off by default** |

Deliberately **not exposed**: shell, file access, merge/push directly, config, tokens, pause/resume, stopping agents,
anything on the agents' MCP. `muster_approve` ships disabled; the owner turns it on in Settings, because a merge pushes
to origin.

Tool results are plain short text (like `src/mcp/format.ts`), not raw JSON dumps. Text that came from agents (notes,
review text) is returned inside a clearly labelled block, since a crew message is untrusted input to the model reading it.

## Confirmation gate (send_goal and the other write tools)

Two layers, both on:

1. **claude.ai's own tool approval.** Write tools carry `readOnlyHint: false` and `destructiveHint: false` (approve:
   `true`), so the client asks before running them. Don't rely on this alone; it is the client's setting, and the user
   can set a connector to "always allow".
2. **Server-side hold** (default on, setting `remote.confirmGoals`): `muster_send_goal` does **not** call `/api/ask`.
   It creates a pending item and returns "Waiting for your OK on your phone/desktop (id P3)". The pending goal shows as
   an approval in Needs you (phone M04, desktop board) with the goal text and "Send to Captain / Discard". Only that tap
   calls `POST /api/ask`. It expires after 15 min. This is what actually stops a prompt-injected or mistaken call.
   Pending items live in gateway `state.json` (`pending: [{ id, project, kind, text, createdAt }]`). Add a new `NeedItem`
   kind `'remote_goal'` with actions `['send','discard']`.

If layer 2 is off, `muster_send_goal` runs immediately and the audit log still records it.

## Auth

Open question to verify first, because it decides the work: **check the current claude.ai custom-connector docs** for
which auth modes remote MCP servers support (OAuth 2.1 with dynamic client registration, authless, static header).
Don't build from memory; also confirm whether the connector is called from Anthropic's cloud (it is expected to be, which
is why a tailnet-only address cannot work and Funnel/Cloudflare is needed).

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

Settings → Phone gets a **Remote access** card: on/off, public URL field + Test, pairing code for the connector,
connected clients with Disconnect, toggles (Hold goals for my OK: on, Allow approving merges: off, Allow replies: on),
last 50 audit lines. Needs you gets the `remote_goal` card (goal text, Send to Captain / Discard). Phone app gets the
same card on M04 with an approve notification action.

## Milestones

1. Spike: `/mcp` listener + `muster_status` + `muster_needs` read-only, bearer from a dev token, test with the MCP
   inspector. Confirm the claude.ai auth mode from the docs before step 2.
2. OAuth + pairing-code consent page + token store + revoke. Tests: PKCE, wrong code, lockout, expired/revoked token.
3. Write tools with the server-side hold, pending store, `remote_goal` NeedItem, audit log. Tests: send_goal creates
   pending and does not call `/api/ask`; discard; expiry; approve disabled by default.
4. Settings card + desktop board card + phone card (design first).
5. Real run: Cloudflare named tunnel → add as custom connector in claude.ai → "what's the status?" → "send goal X" →
   tap Send on the phone → Captain receives it.

Tests follow the existing gateway tests (`src/phone/gateway.test.ts`, `testfakes.ts`); set `MUSTER_SECRETS_DIR` in tests.
