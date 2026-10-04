# Muster for Android: phone gateway and app contract

Design: Vellum file "Muster" (28BUsqILtGqq), page "Mobile": M01–M09 phone screens and "PC — Settings › Phone".

## Pieces

1. **Phone gateway** (`src/phone/`, built to `dist/phone/index.js`): one process per PC, shared by every project.
   Listens on `0.0.0.0:47910` over **HTTPS with a self-signed certificate** (generated on first run, stored next to its
   state). The phone pins the certificate's SHA-256 fingerprint, which travels in the pairing QR code. It speaks to each
   project's orchestrator on 127.0.0.1 as "you", using that project's human token (`core/tokens.ts`, `humanTokenFile`).
2. **Desktop Settings → Phone** (`ui/src/pages/settings.ts` + `/api/phone/*` on each orchestrator, which forwards to
   the gateway's admin API).
3. **Android app** (`android/`): Kotlin + Jetpack Compose, minSdk 31, targetSdk 36, package `com.obiwayne.muster`.

## Gateway state and lifecycle

- Folder: `secretsBase()/phone/` (Windows: `%LOCALAPPDATA%\muster\phone\`), never inside a repo:
  - `state.json`: `{ pcName, devices: [{ id, name, keyHash, createdAt, lastSeenAt, prefs }], network: { mode: 'lan' | 'tailscale' } }`
  - `cert.pem`, `key.pem` (self-signed, CN = pcName, 10 years), `admin-token` (random, for the admin API), `server.json` `{ port, pid, startedAt, fingerprint }`.
- Started by `muster up` (and the desktop app on launch) when `server.json`'s pid isn't alive: spawn detached, hidden,
  `node dist/phone/index.js`. A second copy exits if the port is taken by a live gateway.
- Projects: the desktop app's recent list (`%APPDATA%\muster\settings.json` → `recent`) plus any root that registered
  itself through `POST /admin/projects` (each orchestrator registers its repo root on start). A project counts as running
  when `<root>/.muster/server.json` has a port answering `GET /api/health`. Project id = `repoKey(root)` from tokens.ts
  (export it); name = config `projectName` or the folder name.

## Pairing

1. Desktop asks the gateway for a code (`POST /admin/pair-code`): 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`,
   shown as `K7M-4QX`, valid 2 minutes, single use; a new code invalidates the old one.
2. The QR code text is `muster://pair?c=K7M4QX&p=47910&f=<sha256 hex of the cert DER>&n=<pcName>&h=<host1>,<host2>`
   where hosts are the PC's LAN IPv4 addresses, and in tailscale mode also its Tailscale IP (100.64.0.0/10) and MagicDNS
   name (from `tailscale status --json` when the CLI exists). The gateway renders the QR as SVG (`qrcode` npm package).
3. The phone calls `POST https://<host>:47910/pair` `{ code, deviceName }` trying hosts in order, pinning `f`.
   Response `{ deviceId, key, pcName, hosts }`. `key` is 32 random bytes base64url, stored on the phone in
   EncryptedSharedPreferences; the gateway keeps only `sha256(key)`. Wrong or expired code → 401 `{ error }`;
   5 wrong codes in a minute → 429.

## Phone API (HTTPS, `Authorization: Bearer <key>`; 401 if unknown, which the app treats as "unlinked")

All times ISO strings. Errors `{ error: string }` with 4xx/5xx.

- `GET /api/needs` → `{ pcName, projects: [{ id, name, running }], items: NeedItem[] }`
  `NeedItem = { id, projectId, projectName, kind: 'review'|'approval'|'question'|'escalation'|'blocked'|'usage'|'stuck', noteId?, taskId?, title, summary, from, createdAt, evidence?: { id, files: number, thumbs: string[] }, actions: ('approve'|'open'|'answer'|'commit'|'stash')[] }`
  Built from each running project's `GET /api/state`: open notes where `isNeedsYou` (core/board.ts), mapped by type/topic
  (review with task `ready_for_merge` and no `mergeApproval` → 'review' with approve; approval → 'approval';
  escalation → 'escalation'; question addressed to you → 'question'; topic 'checkout' → 'blocked' with commit/stash;
  weekly_usage → 'usage'). `summary` = first line of the Captain's review note, trimmed to 140 chars.
- `GET /api/projects/:pid/tasks/:tid` → `{ task: { id, title, branch, status, stations, builder, reviewedSha }, review: { from, text, at } | null, evidence: [{ id, summary, files: [{ name, kind }] }], diffStat: { added, removed, files } | null }`
- `GET /api/projects/:pid/tasks/:tid/evidence/:eid/:file` → the file bytes (proxied).
- `POST /api/projects/:pid/tasks/:tid/approve` → orchestrator `POST /api/tasks/:id/approve-merge` as you.
- `POST /api/projects/:pid/tasks/:tid/send-back` `{ text }` → orchestrator send-back (see api.ts for the route/body).
- `GET /api/projects/:pid/notes/:nid` → the note with replies; `POST .../reply` `{ text }` → orchestrator reply as you.
- `POST /api/projects/:pid/checkout/commit` and `/checkout/stash` → the orchestrator routes of the same name.
- `GET /api/projects/:pid/crew` → `{ agents: [{ id, role, status, taskId, branch, detail }], usage: { fiveHour: { pct, resetsAt }, weekly: { pct, resetsAt } }, paused }`
- `GET /api/prefs` / `PUT /api/prefs` → `{ notify: { review, question, blocked, usage, stuck }, quiet: { on, from: '22:00', to: '07:00' }, projects: { [pid]: boolean } }`
  Defaults: review/question/blocked on, usage/stuck off, quiet on 22:00–07:00, every project on. During quiet hours only
  'blocked' notifies.
- `DELETE /api/device` → unlinks this phone.
- `GET /api/events` (WebSocket upgrade, same bearer): server sends `{ type: 'need', item: NeedItem }` for each NEW needs-you
  item that passes this device's prefs, `{ type: 'resolved', id }` when one goes away, `{ type: 'ping' }` every 25 s.
  The gateway polls each running project's state every 3 s (or subscribes to its WS) to diff items.

## Admin API (127.0.0.1 only, header `x-muster-admin: <admin-token>`)

- `POST /admin/pair-code` → `{ code, display: 'K7M-4QX', expiresAt, qrSvg, qrText }`
- `GET /admin/status` → `{ pcName, port, fingerprint, network: { mode, lanHosts, tailscale: { installed, ip, dnsName, online } }, devices: [{ id, name, createdAt, lastSeenAt, online }] }`
- `PUT /admin/network` `{ mode }`; `DELETE /admin/devices/:id`; `POST /admin/test` → sends `{ type: 'test' }` to every connected phone.
- `GET/PUT /admin/send` → the default prefs for new devices (the desktop "Send to phone" toggles).
- `POST /admin/projects` `{ root }` → registers a project root.

Each orchestrator exposes `/api/phone/*` (human token only) that forwards to the admin API with the admin token read from
`secretsBase()/phone/admin-token`, starting the gateway first when it isn't running. The desktop UI only talks to its own
orchestrator.

## Android app

- Screens follow M01–M09 exactly (tokens: bg #111113, surface #19191C, surface-2 #222226, line #2D2D32, text #F4F4F5,
  muted #9B9BA4, faint #62626B, captain #F5A524, crew/approve #2DD4BF (text on it #06231F), design #A78BFA, stuck #F2555A,
  warm #FF8A3D; Geist + Geist Mono bundled as font resources).
- Scan: CameraX + ML Kit barcode scanning (bundled model). "Type the code instead" asks for the 6-character code and
  the PC address shown under the QR in Settings → Phone (so the desktop shows `192.168.1.20` next to the code). Without
  the QR there is no pinned fingerprint, so the first connection shows the certificate fingerprint's first 8 hex
  characters and asks the user to compare them with the ones on the PC before trusting it.
- Networking: OkHttp with a TrustManager that accepts only the pinned fingerprint; tries hosts in order and remembers the
  one that worked.
- Notifications: a foreground service (type `remoteMessaging`, low-importance ongoing notification "Listening to WAYNE-PC")
  keeps the `/api/events` WebSocket open, reconnecting with backoff; WorkManager every 15 min as a fallback poll of
  `/api/needs`. Each new item posts a notification (channels: Reviews, Questions, Blocked merges, Other). Review
  notifications get APPROVE + OPEN actions; APPROVE uses `setAuthenticationRequired(true)` (unlock first). Questions get a
  RemoteInput REPLY action. Start the service on boot (RECEIVE_BOOT_COMPLETED) when linked.
- Unlink: `DELETE /api/device`, clear storage, back to M01. A 401 anywhere does the same.
