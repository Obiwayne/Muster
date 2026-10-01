#!/usr/bin/env node
// Mock Muster orchestrator for developing the dashboard without real agents.
//
//   node ui/dev/mock-server.mjs            → http://127.0.0.1:47800  (serves dist/ui with the token injected)
//   PORT=47801 MOCK_TOKEN=abc node ui/dev/mock-server.mjs
//   MOCK_EMPTY=1 node ui/dev/mock-server.mjs   → no agents (empty-state dashboard)
//   MOCK_STRICT_DIFF=1 …                         → /diff ignores ?branch= (today's contract)
//
// With `npx vite ui` (dev), set VITE_MUSTER_TOKEN=dev-token; vite proxies /api and /ws here.
// Implements the HTTP API and WebSockets from docs/ARCHITECTURE.md with in-memory state.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 47800);
const TOKEN = process.env.MOCK_TOKEN ?? 'dev-token';
const EMPTY = !!process.env.MOCK_EMPTY;
const here = dirname(fileURLToPath(import.meta.url));
const DIST = normalize(join(here, '..', '..', 'dist', 'ui'));

// ---------------------------------------------------------------- mock data
const now = Date.now();
const iso = (minAgo) => new Date(now - minAgo * 60_000).toISOString();

const GUIDE = (title, lines) => [`# ${title}`, '', ...lines, ''].join(String.fromCharCode(10));
const stationDefs = {
  discover: { role: 'crew', builtin: true, guideline: GUIDE('Discover', ['Find out what the task really needs. Write findings, not code.', '', '- Cite the files you read', '- List unknowns as questions']) },
  concept: { role: 'crew', builtin: true, guideline: GUIDE('Concept', ['Two or three options with a recommendation.']) },
  plan: { role: 'crew', builtin: true, guideline: GUIDE('Plan', ['Turn the chosen concept into small tasks the Captain can post.', '', '- One item per task, with acceptance criteria', '- Suggest a line for each task (new-app, feature, ui or bugfix)', '- Commit the plan to docs/factory/']) },
  approval: { role: 'human', builtin: true, guideline: GUIDE('Approval', ['The task pauses here until you approve it or send it back.']) },
  design: { role: 'design', builtin: true, guideline: GUIDE('Design', ['Sketch the screen in Vellum before anyone builds it.']) },
  build: { role: 'crew', builtin: true, guideline: GUIDE('Build', ['Implement the task in your worktree.', '', '- Keep changes small', '- Run `npm test` before handoff', '- Hand on to the test station with a two-line summary']) },
  test: { role: 'crew', builtin: true, guideline: GUIDE('Test', ['Write and run tests for the change. Do not change the code under test.']) },
  'design-check': { role: 'design', builtin: true, guideline: GUIDE('Design check', ['Compare the built UI with the Vellum framework.', '', 'Post PASS or DRIFT with the task and file:line.']) },
  reproduce: { role: 'crew', builtin: true, guideline: GUIDE('Reproduce', ['Write a failing test that shows the bug.']) },
  fix: { role: 'crew', builtin: true, guideline: GUIDE('Fix', ['Make the failing test pass with the smallest change.']) },
  review: { role: 'captain', builtin: true, guideline: '' },
};
const config = {
  port: PORT,
  captainModel: 'opus',
  crewModel: 'sonnet',
  designModel: 'sonnet',
  maxCrew: 3,
  pauseAtFiveHourPct: 80,
  warnAtWeeklyPct: 75,
  shutdownIdleCrew: true,
  defaultStations: ['plan', 'build', 'test', 'review'],
  defaultLine: 'feature',
  vellumFile: 'muster',
  vellumEdit: 'ask',
  userName: 'Alex',
  testCommand: 'npm test',
  baseBranch: 'main',
  permissionMode: 'acceptEdits',
  vellum: { command: 'node', args: ['vellum-mcp/index.js'] },
  notify: true,
  allowedTools: ['Bash(npm *)', 'mcp__muster__*'],
  projectName: 'acme-app',
};

const lineDefs = [
  { name: 'new-app', label: 'New app / big feature', stations: ['discover', 'concept', 'design', 'plan', 'approval', 'review'], builtin: true },
  { name: 'feature', label: 'Feature', stations: ['plan', 'build', 'test', 'review'], builtin: true },
  { name: 'ui', label: 'UI change', stations: ['design', 'build', 'design-check', 'review'], builtin: true },
  { name: 'bugfix', label: 'Bug fix', stations: ['reproduce', 'fix', 'test', 'review'], builtin: true },
];

const agent = (id, role, branch, status, taskId, minAgo, model) => ({
  id, role, model: model ?? (role === 'captain' ? 'opus' : 'sonnet'), branch,
  worktree: role === 'captain' ? '/work/acme-app' : `/work/acme-app/.muster/worktrees/${id}`,
  status, taskId, sessionId: crypto.randomUUID(), pid: 4000 + Math.floor(Math.random() * 4000),
  startedAt: iso(minAgo), lastActivityAt: iso(status === 'stuck' ? 4 : 0.3), costUsd: +(Math.random() * 3).toFixed(2),
});

const task = (id, title, status, stations, stationIndex, extra = {}) => ({
  id, title, description: extra.description ?? `${title}.`, dependsOn: extra.dependsOn ?? [], stations, stationIndex, status,
  assignee: extra.assignee, branch: extra.branch, createdBy: 'captain', createdAt: iso(extra.created ?? 40), updatedAt: iso(extra.updated ?? 5),
  history: extra.history ?? [{ at: iso(extra.created ?? 40), agentId: 'captain', kind: 'created' }],
});

const S4 = ['plan', 'build', 'test', 'review'];
const SUI = ['design', 'build', 'design-check', 'review'];
const state = {
  version: 1,
  repoRoot: '/work/acme-app',
  agents: EMPTY ? [] : [
    agent('captain', 'captain', 'main', 'working', undefined, 45),
    agent('crew-2', 'crew', 'crew-2/invite-api', 'working', undefined, 44),
    agent('crew-3', 'crew', 'crew-3/share-dialog', 'stuck', 'T4', 40),
    agent('design', 'design', 'design/check', 'waiting', undefined, 38),
    agent('crew-5', 'crew', 'crew-5/tests', 'working', 'T3', 20),
  ],
  tasks: EMPTY ? [] : [
    task('T1', 'Invites table + migration', 'ready_for_merge', ['build', 'review'], 1, { branch: 'crew-2/invites-db', assignee: 'captain', created: 44, updated: 3,
      history: [{ at: iso(44), agentId: 'captain', kind: 'created' }, { at: iso(3), agentId: 'captain', kind: 'review_requested', text: 'Migration adds the invites table with a unique token index. Tests pass. Safe to merge.' }] }),
    task('T2', 'Invite token generator', 'review', S4, 3, { branch: 'crew-2/tokens', assignee: 'captain', created: 43 }),
    task('T3', 'Invite API endpoints', 'in_progress', S4, 2, { branch: 'crew-2/invite-api', assignee: 'crew-5', created: 42, dependsOn: ['T2'] }),
    task('T4', 'Share dialog UI', 'in_progress', SUI, 1, { branch: 'crew-3/share-dialog', assignee: 'crew-3', created: 41, dependsOn: ['T3'] }),
    task('T5', 'Revoke invite link', 'ready', S4, 0, { created: 30 }),
    task('T6', 'Invite email template', 'blocked', SUI, 0, { dependsOn: ['T3', 'T4'], created: 30 }),
    task('T7', 'End-to-end invite test', 'blocked', ['build', 'test', 'review'], 0, { dependsOn: ['T6'], created: 29 }),
    task('T9', 'Concept: sharing beyond invite links', 'awaiting_approval', ['discover', 'concept', 'approval', 'review'], 2, { branch: 'crew-2/sharing-concept', assignee: 'you', created: 36, updated: 1 }),
    task('T8', 'Invite model', 'merged', ['build', 'review'], 1, { branch: 'crew-2/invite-model', created: 120, updated: 62 }),
  ],
  notes: EMPTY ? [] : [
    { id: 'N10', type: 'progress', from: 'crew-2', taskId: 'T3', branch: 'crew-2/invite-api', text: 'Endpoints and tests done, handing to the test station.', createdAt: iso(14), open: false, replies: [] },
    { id: 'N11', type: 'done', from: 'crew-2', taskId: 'T1', branch: 'crew-2/invites-db', text: 'Invites table + migration done. 12 tests pass.', createdAt: iso(9), open: false, replies: [] },
    { id: 'N12', type: 'question', from: 'crew-2', taskId: 'T3', branch: 'crew-2/invite-api', text: 'Should invite links expire after 7 days or 30?', createdAt: iso(11), open: true,
      replies: [{ at: iso(8), from: 'crew-5', text: 'The fixtures assume 7 days, if that helps.' }, { at: iso(6), from: 'captain', text: 'Checking the spec; hold on 7 days for now.' }] },
    { id: 'N13', type: 'review', from: 'captain', taskId: 'T1', branch: 'crew-2/invites-db', text: 'Invites table ready to merge. 3 files, 12 tests passing.', createdAt: iso(0.5), open: true, replies: [] },
    { id: 'N14', type: 'stuck', from: 'crew-3', taskId: 'T4', branch: 'crew-3/share-dialog', text: 'Which token format does T2 use? The share fixture fails on length.\nTried: regenerating the fixture from the API (still 16 chars), reading src/api/tokens.ts (not on my branch yet).', createdAt: iso(4), open: true,
      replies: [{ at: iso(2), from: 'captain', text: 'Use the 22-char base62 token from T2. crew-2 merged it into their branch; pull it with handoff and rerun the fixture.' },
        { at: iso(1), from: 'crew-2', text: 'tokens.ts is on crew-2/invite-api now. The fixture helper is makeInviteToken() in test/fixtures.ts, use that instead of a hard-coded string.' }] },
    { id: 'N15', type: 'waiting', from: 'design', to: 'crew-3', taskId: 'T4', branch: 'design/check', text: 'Design check on T4 once crew-3 hands off.', createdAt: iso(6), open: true, replies: [] },
    { id: 'N16', type: 'escalation', from: 'captain', text: 'Should a revoked invite link show a friendly "link expired" page or a plain 404? This is a product call (N12 is related).', createdAt: iso(2), open: true, replies: [] },
    { id: 'N17', type: 'progress', from: 'design', to: 'crew-3', taskId: 'T4', branch: 'crew-3/share-dialog', text: 'DRIFT T4 ShareDialog primary button is #2563EB; framework uses var(--color-primary)\nsrc/ui/ShareDialog.tsx:42 — hard-coded #2563EB', createdAt: iso(3), open: false, replies: [] },
    { id: 'N18', type: 'question', from: 'design', taskId: 'T4', text: 'DRIFT T4 Share dialog has no matching board in Vellum. Ask the Captain before adding one?', createdAt: iso(3.5), open: false, replies: [{ at: iso(3), from: 'captain', text: 'Not yet, flag it in the review.' }] },
    { id: 'N19', type: 'done', from: 'design', taskId: 'T2', text: 'PASS T2 Token copy UI matches the framework tokens', createdAt: iso(16), open: false, replies: [] },
    { id: 'N21', type: 'approval', from: 'crew-2', taskId: 'T9', branch: 'crew-2/sharing-concept', text: 'Concept for sharing beyond invite links is ready: three options (public link, per-team link, email-only) with a recommendation. Approve to start planning.', createdAt: iso(1), open: true, replies: [] },
    { id: 'N20', type: 'message', from: 'crew-2', to: 'crew-3', text: 'Heads up: the invite API now returns expiresAt as an ISO string, not a number.', createdAt: iso(33), open: false, replies: [] },
  ],
  feed: [],
  inbox: [],
  usage: {
    fiveHour: { usedPercentage: 62, resetsAt: new Date(now + 108 * 60_000).toISOString() },
    sevenDay: { usedPercentage: 38, resetsAt: nextMonday() },
    updatedAt: iso(0.2), perAgentCostUsd: {}, paused: false, weeklyWarned: false,
  },
  goal: EMPTY ? undefined : { text: 'Build the invite-link sharing flow', at: iso(42) },
  nextIds: { agent: 6, task: 10, note: 22, feed: 1, inbox: 1 },
};

function nextMonday() {
  const d = new Date(now);
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

const feedSeed = [
  [44, 'message', 'you', 'captain', 'Build the invite-link sharing flow', {}],
  [43, 'message', 'captain', 'everyone', 'Goal is the invite-link sharing flow. T2 tokens and T3 API go first; T4 share dialog waits on T3. crew-2 take T3, crew-3 take T4.', {}],
  [42.8, 'event', 'muster', undefined, 'captain posted T1–T7', {}],
  [42.5, 'event', 'crew-2', undefined, 'crew-2 claimed T3 Invite API endpoints', { taskId: 'T3' }],
  [42.3, 'event', 'crew-3', undefined, 'crew-3 claimed T4 Share dialog UI', { taskId: 'T4' }],
  [40, 'event', 'muster', undefined, 'design started (design crew)', {}],
  [36, 'message', 'design', 'everyone', 'Reading the Muster framework in Vellum: 38 tokens, 9 pages. I will check every UI branch before review.', {}],
  [33, 'message', 'crew-2', 'crew-3', 'Heads up: the invite API now returns expiresAt as an ISO string, not a number.', {}],
  [30, 'message', 'crew-3', 'crew-2', 'Thanks, switching the dialog to parse it.', {}],
  [22, 'event', 'muster', undefined, 'crew-5 started (crew)', {}],
  [16, 'note', 'design', undefined, 'Token copy UI matches the framework tokens: spacing, type and colour pass.', { noteId: 'N19', noteType: 'done' }],
  [14, 'note', 'crew-2', undefined, 'Endpoints and tests done, handing to the test station.', { noteId: 'N10', noteType: 'progress' }],
  [13.5, 'event', 'crew-2', undefined, 'crew-2 handed T3 to crew-5 (test station): "endpoints + tests done"', { taskId: 'T3' }],
  [11, 'note', 'crew-2', undefined, 'Should invite links expire after 7 days or 30?', { noteId: 'N12', noteType: 'question' }],
  [9, 'note', 'crew-2', undefined, 'Invites table + migration done. 12 tests pass.', { noteId: 'N11', noteType: 'done' }],
  [8, 'reply', 'crew-5', undefined, 'The fixtures assume 7 days, if that helps.', { noteId: 'N12' }],
  [6, 'reply', 'captain', undefined, 'Checking the spec; hold on 7 days for now.', { noteId: 'N12' }],
  [6, 'note', 'design', undefined, 'Design check on T4 once crew-3 hands off.', { noteId: 'N15', noteType: 'waiting' }],
  [4, 'note', 'crew-3', undefined, 'Which token format does T2 use?', { noteId: 'N14', noteType: 'stuck' }],
  [3.5, 'message', 'design', 'crew-3', 'The ShareDialog button is hard-coded #2563EB. The framework in Vellum uses var(--color-primary) for primary buttons.', {}],
  [3, 'event', 'captain', undefined, 'captain requested review of T1: "Safe to merge"', { taskId: 'T1' }],
  [2, 'reply', 'captain', undefined, 'Use the 22-char base62 token from T2. crew-2 has it on their branch.', { noteId: 'N14' }],
  [2, 'note', 'captain', undefined, 'Should a revoked invite link show a friendly page or a 404?', { noteId: 'N16', noteType: 'escalation' }],
  [1, 'reply', 'crew-2', undefined, 'Fixture helper is makeInviteToken() in test/fixtures.ts, use that instead of a hard-coded string.', { noteId: 'N14' }],
  [0.5, 'note', 'captain', undefined, 'Invites table ready to merge. 3 files, 12 tests passing.', { noteId: 'N13', noteType: 'review' }],
];
if (!EMPTY) {
  // a few items from yesterday so the day divider shows
  state.feed.push(feedItem(26 * 60, 'event', 'muster', undefined, 'orchestrator started · captain on opus', {}));
  state.feed.push(feedItem(26 * 60 - 2, 'message', 'captain', 'everyone', 'Invite model is merged. Next up tomorrow: the sharing flow.', {}));
  for (const [m, kind, from, to, text, extra] of feedSeed) state.feed.push(feedItem(m, kind, from, to, text, extra));
}
function feedItem(minAgo, kind, from, to, text, extra = {}) {
  return { id: `F${state.nextIds.feed++}`, at: iso(minAgo), kind, from, ...(to ? { to } : {}), text, ...extra };
}

// ---------------------------------------------------------------- fake terminals
const C = { dim: '\x1b[38;2;155;155;164m', text: '\x1b[38;2;244;244;245m', amber: '\x1b[38;2;245;165;36m', teal: '\x1b[38;2;45;212;191m', lav: '\x1b[38;2;167;139;250m', red: '\x1b[38;2;242;85;90m', green: '\x1b[38;2;52;199;123m', faint: '\x1b[38;2;98;98;107m', bold: '\x1b[1m', reset: '\x1b[0m' };
const dot = (c) => `${c}●${C.reset} `;
const BACKLOG = {
  captain: [
    `${C.faint}╭─ muster captain · opus · /work/acme-app ─────────────╮${C.reset}`,
    `${dot(C.dim)}${C.dim}read_board(open) → 1 stuck, 1 question${C.reset}`,
    `${C.text}crew-3 is stuck on the invite token format. Answering first.${C.reset}`,
    `${dot(C.dim)}${C.dim}reply(N14, "Use the 22-char base62 token from T2")${C.reset}`,
    `${dot(C.dim)}${C.dim}get_diff(crew-2) → 6 files, ${C.green}+214${C.dim} ${C.red}−18${C.reset}`,
    `${dot(C.dim)}${C.dim}run_tests(crew-2) → ${C.green}41 passed${C.reset}`,
    `${C.text}The invite API looks right. One nit: expiresAt should be UTC.${C.reset}`,
    `${dot(C.amber)}${C.amber}request_review(crew-2, "Invite API ready")${C.reset}`,
  ],
  'crew-2': [
    `${dot(C.dim)}${C.dim}claim_task() → T3 Invite API endpoints${C.reset}`,
    `${C.text}  Working in .muster/worktrees/crew-2${C.reset}`,
    `${dot(C.dim)}${C.dim}Edit src/api/invites.ts${C.reset}`,
    `${dot(C.dim)}${C.dim}Bash npm test -- invites → ${C.green}41 passed${C.reset}`,
    `${dot(C.dim)}${C.dim}message_crew(crew-3, "invite API now returns expiresAt")${C.reset}`,
    `${dot(C.text)}${C.text}post_note(progress, "endpoints + tests done")${C.reset}`,
    `${dot(C.teal)}${C.teal}handoff(crew-5, "ready for the test station")${C.reset}`,
  ],
  'crew-3': [
    `${dot(C.dim)}${C.dim}claim_task() → T4 Share dialog UI${C.reset}`,
    `${C.text}  Building ShareDialog with copy-link button${C.reset}`,
    `${dot(C.dim)}${C.dim}Write src/ui/ShareDialog.tsx${C.reset}`,
    `${dot(C.dim)}${C.dim}Bash npm test -- share → ${C.red}2 failed${C.reset}`,
    `${C.dim}  Token format in the fixture doesn't match the API.${C.reset}`,
    `${dot(C.red)}${C.red}post_note(stuck, "which token format does T2 use?")${C.reset}`,
    `${C.red}  Waiting for an answer on N14…${C.reset}`,
  ],
  design: [
    `${dot(C.dim)}${C.dim}vellum.get_basic_info("Muster") → 9 pages${C.reset}`,
    `${C.text}  Reading the design framework: tokens, type scale, buttons${C.reset}`,
    `${dot(C.dim)}${C.dim}vellum.get_tokens() → 38 tokens${C.reset}`,
    `${dot(C.dim)}${C.dim}read_board(waitingOn: design) → none${C.reset}`,
    `${C.dim}  The ShareDialog button uses #2563EB; framework is --color-primary.${C.reset}`,
    `${dot(C.text)}${C.text}post_note(waiting, "design check on T4 once crew-3 hands off")${C.reset}`,
    `${dot(C.lav)}${C.lav}message_crew(crew-3, "use var(--color-primary) on buttons")${C.reset}`,
  ],
};
const TICKS = [
  `${dot(C.dim)}${C.dim}read_inbox() → 0 new${C.reset}`,
  `${dot(C.dim)}${C.dim}Read src/api/tokens.ts${C.reset}`,
  `${dot(C.dim)}${C.dim}Bash npm test -- invites → ${C.green}12 passed${C.reset}`,
  `${dot(C.dim)}${C.dim}list_tasks() → 7 tasks, 1 ready${C.reset}`,
  `${C.text}  Thinking…${C.reset}`,
];
function backlogFor(id) {
  const a = state.agents.find((x) => x.id === id);
  const lines = BACKLOG[id] ?? [
    `${dot(C.dim)}${C.dim}claim_task() → ${a?.taskId ?? 'none'}${C.reset}`,
    `${C.text}  Working in .muster/worktrees/${id}${C.reset}`,
    `${dot(C.dim)}${C.dim}Bash npm test → ${C.green}9 passed${C.reset}`,
  ];
  return lines.join('\r\n') + '\r\n';
}
const termClients = new Map(); // id → Set<ws>
function termWrite(id, data) {
  for (const ws of termClients.get(id) ?? []) if (ws.readyState === 1) ws.send(data);
}
setInterval(() => {
  for (const a of state.agents) {
    if (a.status !== 'working' || !termClients.get(a.id)?.size) continue;
    if (Math.random() < 0.35) termWrite(a.id, TICKS[Math.floor(Math.random() * TICKS.length)] + '\r\n');
  }
}, 2500);

// ---------------------------------------------------------------- helpers
const eventClients = new Set();
let broadcastTimer = null;
function broadcast() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => {
    const msg = JSON.stringify({ type: 'state', state, config });
    for (const ws of eventClients) if (ws.readyState === 1) ws.send(msg);
  }, 100);
}
function toastAll(level, text) {
  const msg = JSON.stringify({ type: 'toast', level, text });
  for (const ws of eventClients) if (ws.readyState === 1) ws.send(msg);
}
function addFeed(kind, from, to, text, extra = {}) {
  const f = { id: `F${state.nextIds.feed++}`, at: new Date().toISOString(), kind, from, ...(to ? { to } : {}), text, ...extra };
  state.feed.push(f);
  return f;
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const need = (cond, status, msg) => { if (!cond) throw new HttpError(status, msg); };
const findAgent = (id) => { const a = state.agents.find((x) => x.id === id); need(a, 404, `No agent ${id}`); return a; };
const findTask = (id) => { const t = state.tasks.find((x) => x.id === id); need(t, 404, `No task ${id}`); return t; };
const findNote = (id) => { const n = state.notes.find((x) => x.id === id); need(n, 404, `No note ${id}`); return n; };
const paused = () => state.usage.fiveHour && state.usage.fiveHour.usedPercentage >= config.pauseAtFiveHourPct;

function fakeDiff(a) {
  const files = {
    'crew-2/invites-db': [['db/migrations/014_invites.sql', 41, 0], ['src/db/invites.ts', 33, 0], ['test/db/invites.test.ts', 22, 0]],
    'crew-2/invite-api': [['src/api/invites.ts', 120, 10], ['src/api/tokens.ts', 44, 4], ['test/api/invites.test.ts', 50, 4]],
    'crew-2/tokens': [['src/api/tokens.ts', 40, 2], ['test/api/tokens.test.ts', 18, 2]],
    'crew-3/share-dialog': [['src/ui/ShareDialog.tsx', 96, 0], ['src/ui/ShareDialog.css', 22, 0], ['test/ui/share.test.ts', 13, 2]],
  }[a.branch] ?? [['README.md', 3, 1]];
  let diff = '';
  for (const [path, add, del] of files) {
    diff += `diff --git a/${path} b/${path}\nindex 1a2b3c4..5d6e7f8 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,${del + 3} +1,${add + 3} @@\n import { thing } from './thing';\n`;
    for (let i = 0; i < del; i++) diff += `-const old${i} = legacy(${i});\n`;
    for (let i = 0; i < add; i++) diff += `+export const line${i} = build(${i}); // ${path.split('/').pop()}\n`;
    diff += ' \n export default thing;\n';
  }
  const add = files.reduce((s, f) => s + f[1], 0);
  const del = files.reduce((s, f) => s + f[2], 0);
  const stat = files.map(([p, a1, d1]) => ` ${p.padEnd(34)} | ${String(a1 + d1).padStart(3)} ${'+'.repeat(Math.min(20, a1))}${'-'.repeat(Math.min(10, d1))}`).join('\n')
    + `\n ${files.length} files changed, ${add} insertions(+)${del ? `, ${del} deletions(-)` : ''}\n`;
  return { branch: a.branch, base: 'main', stat, diff };
}

// ---------------------------------------------------------------- routes
async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

async function api(req, url) {
  const m = req.method;
  const p = url.pathname;
  let r;
  if (m === 'GET' && p === '/api/health') return { ok: true, version: '0.1.0-mock' };
  need(req.headers['x-muster-token'] === TOKEN, 401, 'Bad or missing x-muster-token');

  if (m === 'GET' && p === '/api/state') return { state, config, paused: !!paused() };
  if (m === 'GET' && p === '/api/config') return config;
  if (m === 'PATCH' && p === '/api/config') {
    const patch = await body(req);
    for (const [k, v] of Object.entries(patch)) { if (v === null) delete config[k]; else config[k] = v; }
    state.usage.paused = !!paused();
    broadcast();
    return config;
  }
  const sm = /^\/api\/stations\/([^/]+)$/.exec(p);
  if (m === 'GET' && p === '/api/lines') return { defaultLine: config.defaultLine, lines: lineDefs };
  let lm;
  if ((lm = /^\/api\/lines\/([^/]+)$/.exec(p)) && m === 'PUT') {
    const b = await body(req); const l = lineDefs.find((x) => x.name === lm[1]);
    need(l, 404, 'No such line');
    if (b.stations) l.stations = b.stations; if (b.label) l.label = b.label;
    return l;
  }
  const am = /^\/api\/tasks\/([^/]+)\/(approve|reject)$/.exec(p);
  if (am && m === 'POST') {
    const b = await body(req); const t = state.tasks.find((x) => x.id === am[1]);
    need(t, 404, 'No such task');
    if (am[2] === 'reject') need(b.note, 400, 'A note is required');
    t.status = am[2] === 'approve' ? 'ready' : 'in_progress'; if (am[2] === 'approve') t.stationIndex++;
    for (const n of state.notes) if (n.taskId === t.id && n.type === 'approval') n.open = false;
    broadcast(); return t;
  }
  if (m === 'GET' && p === '/api/stations') {
    const names = [...config.defaultStations.filter((n) => n !== 'review'), ...Object.keys(stationDefs).filter((n) => !config.defaultStations.includes(n)), 'review'];
    return names.map((name) => ({ name, ...stationDefs[name] ?? { role: 'crew', guideline: '', builtin: false } }));
  }
  if (sm && m === 'PUT') {
    const name = decodeURIComponent(sm[1]); const b = await body(req);
    need(/^[a-z0-9-]{1,32}$/.test(name), 400, 'Station names are lowercase letters, digits and dashes, up to 32');
    need(!(b.guideline && b.guideline.length > 20000), 400, 'Guideline is over 20000 characters');
    const cur = stationDefs[name] ?? { role: 'crew', guideline: '', builtin: false };
    stationDefs[name] = { ...cur, ...(b.role ? { role: b.role } : {}), ...(typeof b.guideline === 'string' ? { guideline: b.guideline } : {}) };
    return { name, ...stationDefs[name] };
  }
  if (sm && m === 'DELETE') {
    const name = decodeURIComponent(sm[1]);
    need(name !== 'review', 400, 'The review station cannot be removed');
    if (stationDefs[name]?.builtin) stationDefs[name] = { role: name === 'design' ? 'design' : 'crew', builtin: true, guideline: '' };
    else { delete stationDefs[name]; config.defaultStations = config.defaultStations.filter((n) => n !== name); }
    broadcast();
    return [...config.defaultStations.filter((n) => n !== 'review'), 'review'].map((n) => ({ name: n, ...stationDefs[n] ?? { role: 'crew', guideline: '', builtin: false } }));
  }
  if (m === 'GET' && p === '/api/vellum') return { status: 'connected', checkedAt: new Date().toISOString(), files: [
    { id: 'muster', name: 'Muster', pages: 9, updated: iso(120) }, { id: 'scratch', name: 'Scratchpad', pages: 3, updated: iso(60 * 30) },
    { id: 'wall', name: 'Wall Education', pages: 16, updated: iso(60 * 50) }, { id: 'mayhem', name: 'MayhemDeck', pages: 5, updated: iso(60 * 24 * 6) }] };
  if (m === 'GET' && p === '/api/usage') return { ...state.usage, paused: !!paused() };

  if (m === 'POST' && p === '/api/agents') {
    const b = await body(req);
    need(!paused(), 409, `Paused: 5-hour window at ${state.usage.fiveHour.usedPercentage}%`);
    const role = b.role ?? 'crew';
    need(!(role === 'design' && state.agents.some((a) => a.role === 'design')), 409, 'There is already a design crew');
    const running = state.agents.filter((a) => a.role === 'crew' && a.status !== 'stopped').length;
    need(!(role === 'crew' && running >= config.maxCrew), 409, `Crew limit reached (${running} of ${config.maxCrew} running)`);
    const id = b.name || (role === 'design' ? 'design' : `crew-${state.nextIds.agent++}`);
    need(!state.agents.some((a) => a.id === id), 409, `An agent called ${id} already exists`);
    const a = agent(id, role, `${id}/work`, 'starting', b.taskId, 0);
    state.agents.push(a);
    addFeed('event', 'muster', undefined, `${id} started (${role})`);
    setTimeout(() => { a.status = b.taskId ? 'working' : 'idle'; broadcast(); termWrite(id, `${dot(C.teal)}${C.teal}session started${C.reset}\r\n`); }, 1500);
    broadcast();
    return a;
  }
  let mm;
  if ((mm = /^\/api\/agents\/([^/]+)(?:\/(\w+))?$/.exec(p))) {
    const id = decodeURIComponent(mm[1]);
    const action = mm[2];
    const a = findAgent(id);
    if (m === 'DELETE' && !action) {
      state.agents = state.agents.filter((x) => x !== a);
      addFeed('event', 'muster', undefined, `${id} closed`);
      for (const ws of termClients.get(id) ?? []) ws.close();
      broadcast();
      return { ok: true };
    }
    if (m === 'POST' && action === 'role') {
      const b = await body(req);
      if (b.role === 'captain') {
        const old = state.agents.find((x) => x.role === 'captain' && x !== a);
        if (old) { old.role = 'crew'; old.branch = `${old.id}/work`; }
        a.branch = 'main';
      } else if (a.role === 'captain') a.branch = `${a.id}/work`;
      if (b.role === 'design') for (const x of state.agents) if (x.role === 'design' && x !== a) x.role = 'crew';
      a.role = b.role;
      a.status = 'starting';
      setTimeout(() => { a.status = 'idle'; broadcast(); }, 1200);
      addFeed('event', 'muster', undefined, `${id} is now ${b.role}`);
      toastAll('info', `${id} restarted as ${b.role}`);
      broadcast();
      return a;
    }
    if (m === 'POST' && action === 'stop') { a.status = 'stopped'; addFeed('event', 'muster', undefined, `${id} stopped`); broadcast(); termWrite(id, `\r\n${C.faint}[process exited]${C.reset}\r\n`); return a; }
    if (m === 'POST' && action === 'start') { a.status = 'starting'; setTimeout(() => { a.status = 'idle'; broadcast(); }, 1000); broadcast(); return a; }
    if (m === 'POST' && action === 'input') {
      const b = await body(req);
      termWrite(id, `${C.text}> ${String(b.text).replace(/\n/g, ' ')}${C.reset}\r\n`);
      if (b.submit) {
        a.status = 'working';
        setTimeout(() => termWrite(id, `${dot(C.dim)}${C.dim}Got it. Working on: ${b.text}${C.reset}\r\n`), 700);
        broadcast();
      }
      return { ok: true };
    }
    if (m === 'GET' && action === 'output') return { text: backlogFor(id).replace(/\x1b\[[0-9;]*m/g, '') };
    if (m === 'GET' && action === 'diff') {
      need(a.role !== 'captain', 400, 'The Captain works on main; there is no branch to diff');
      // ?branch= is the extension the UI asks for; MOCK_STRICT_DIFF=1 mimics the current contract (agent's current branch only)
      const want = url.searchParams.get('branch');
      const d = fakeDiff(want && !process.env.MOCK_STRICT_DIFF && want.startsWith(a.id + '/') ? { branch: want } : a);
      return url.searchParams.get('stat') ? { ...d, diff: '' } : d;
    }
    if (m === 'POST' && action === 'tests') {
      await new Promise((res) => setTimeout(res, 900));
      const fail = a.status === 'stuck';
      return { command: config.testCommand, exitCode: fail ? 1 : 0, output: fail ? 'Tests  2 failed | 11 passed (13)' : 'Test Files  3 passed (3)\n     Tests  12 passed (12)' };
    }
    if (m === 'POST' && action === 'merge') {
      const b = await body(req);
      need(b.actor === 'you', 403, 'Only you can merge');
      const t = state.tasks.find((x) => x.status === 'ready_for_merge' && (x.branch?.startsWith(id + '/') || x.branch === a.branch));
      need(t || b.force, 409, `${id} has no task ready to merge`);
      if (t) {
        t.status = 'merged'; t.updatedAt = new Date().toISOString();
        t.history.push({ at: t.updatedAt, agentId: 'you', kind: 'merged' });
        for (const n of state.notes) if (n.type === 'review' && n.taskId === t.id) { n.open = false; n.closedAt = t.updatedAt; }
        addFeed('event', 'you', undefined, `you merged ${t.branch} into main (${t.id} ${t.title})`, { taskId: t.id });
        for (const x of state.tasks) if (x.status === 'blocked' && x.dependsOn.every((d) => ['ready_for_merge', 'merged'].includes(state.tasks.find((y) => y.id === d)?.status))) x.status = 'ready';
      }
      broadcast();
      return { ok: true, output: `Merge made by the 'ort' strategy.\n ${t?.branch}` };
    }
  }
  if (m === 'POST' && p === '/api/ask') {
    const b = await body(req);
    need(b.text, 400, 'text is required');
    state.goal = { text: b.text, at: new Date().toISOString() };
    addFeed('message', 'you', 'captain', b.text);
    termWrite('captain', `${C.text}> ${b.text}${C.reset}\r\n`);
    const cap = state.agents.find((a) => a.role === 'captain');
    if (cap) cap.status = 'working';
    broadcast();
    return { ok: true };
  }
  if (m === 'GET' && p === '/api/tasks') return state.tasks;
  if (m === 'POST' && p === '/api/tasks') {
    const b = await body(req);
    need(b.title, 400, 'title is required');
    let stations = (b.stations?.length ? b.stations : config.defaultStations).filter((s) => s !== 'review');
    stations = [...stations, 'review'];
    const deps = b.dependsOn ?? [];
    const blocked = deps.some((d) => !['ready_for_merge', 'merged'].includes(state.tasks.find((t) => t.id === d)?.status));
    const t = task(`T${state.nextIds.task++}`, b.title, blocked ? 'blocked' : 'ready', stations, 0, { description: b.description, dependsOn: deps, created: 0, updated: 0 });
    t.createdBy = b.actor ?? 'you';
    state.tasks.push(t);
    addFeed('event', b.actor ?? 'you', undefined, `${b.actor ?? 'you'} posted ${t.id} ${t.title}`, { taskId: t.id });
    broadcast();
    return t;
  }
  if ((mm = /^\/api\/tasks\/([^/]+)\/sendback$/.exec(p)) && m === 'POST') {
    const b = await body(req);
    const t = findTask(decodeURIComponent(mm[1]));
    t.status = 'in_progress'; t.stationIndex = 0; t.assignee = t.branch?.split('/')[0]; t.updatedAt = new Date().toISOString();
    for (const n of state.notes) if (n.type === 'review' && n.taskId === t.id) n.open = false;
    addFeed('event', b.actor, undefined, `${b.actor} sent ${t.id} back to ${t.assignee}: "${b.note}"`, { taskId: t.id });
    broadcast();
    return t;
  }
  if (m === 'GET' && p === '/api/notes') {
    const q = url.searchParams;
    let list = state.notes;
    if (q.get('open')) list = list.filter((n) => n.open);
    if (q.get('type')) list = list.filter((n) => n.type === q.get('type'));
    if (q.get('needsYou')) list = list.filter((n) => n.open && (n.type === 'escalation' || n.type === 'review' || n.to === 'you'));
    return list;
  }
  if (m === 'POST' && p === '/api/notes') {
    const b = await body(req);
    const n = { id: `N${state.nextIds.note++}`, type: b.type, from: b.actor, to: b.to, taskId: b.taskId, text: b.text, createdAt: new Date().toISOString(), open: ['stuck', 'question', 'waiting', 'review', 'escalation'].includes(b.type), replies: [] };
    state.notes.push(n);
    addFeed('note', b.actor, undefined, b.text, { noteId: n.id, noteType: n.type });
    broadcast();
    return n;
  }
  if ((mm = /^\/api\/notes\/([^/]+)\/(reply|close)$/.exec(p)) && m === 'POST') {
    const b = await body(req);
    const n = findNote(decodeURIComponent(mm[1]));
    if (mm[2] === 'reply') {
      need(b.text, 400, 'text is required');
      n.replies.push({ at: new Date().toISOString(), from: b.actor, text: b.text });
      addFeed('reply', b.actor, undefined, b.text, { noteId: n.id });
      if (b.close) { n.open = false; n.closedAt = new Date().toISOString(); }
    } else {
      n.open = false; n.closedAt = new Date().toISOString();
      addFeed('event', b.actor, undefined, `${b.actor} cleared ${n.id}`, { noteId: n.id });
      if (n.type === 'stuck') { const a = state.agents.find((x) => x.id === n.from); if (a && a.status === 'stuck') a.status = 'idle'; }
    }
    broadcast();
    return n;
  }
  if (m === 'POST' && p === '/api/messages') {
    const b = await body(req);
    need(b.text, 400, 'text is required');
    const f = addFeed('message', b.actor, b.to ?? 'everyone', b.text);
    broadcast();
    return f;
  }
  if (m === 'GET' && p === '/api/feed') {
    const q = url.searchParams;
    let list = state.feed;
    if (q.get('agent')) list = list.filter((f) => f.from === q.get('agent') || f.to === q.get('agent'));
    if (q.get('before')) { const n = Number(q.get('before').slice(1)); list = list.filter((f) => Number(f.id.slice(1)) < n); }
    return list.slice(-Number(q.get('limit') ?? 200));
  }
  if ((mm = /^\/api\/inbox\/([^/]+)$/.exec(p)) && m === 'GET') return state.inbox.filter((i) => i.agentId === decodeURIComponent(mm[1]));
  throw new HttpError(404, `No route ${m} ${p}`);
}

// ---------------------------------------------------------------- server
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const out = await api(req, url);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out ?? null));
      return;
    }
    // static UI (like the orchestrator: GET / injects the token)
    if (!existsSync(DIST)) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('Mock Muster API is running. Build the UI with `npx vite build ui`, or run `npx vite ui` with VITE_MUSTER_TOKEN=' + TOKEN); return; }
    let file = url.pathname === '/' || url.pathname === '/index.html' ? join(DIST, 'index.html') : normalize(join(DIST, url.pathname));
    if (!file.startsWith(DIST) || !existsSync(file)) file = join(DIST, 'index.html');
    let data = await readFile(file);
    if (file.endsWith('index.html')) data = Buffer.from(data.toString('utf8').replace('<meta name="muster-token" content="">', `<meta name="muster-token" content="${TOKEN}">`));
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.searchParams.get('token') !== TOKEN) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  if (url.pathname === '/ws/events') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      eventClients.add(ws);
      ws.send(JSON.stringify({ type: 'state', state, config }));
      ws.on('close', () => eventClients.delete(ws));
    });
    return;
  }
  const tm = /^\/ws\/term\/([^/]+)$/.exec(url.pathname);
  if (tm) {
    const id = decodeURIComponent(tm[1]);
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!termClients.has(id)) termClients.set(id, new Set());
      termClients.get(id).add(ws);
      ws.send(backlogFor(id));
      let line = '';
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'input') {
          for (const ch of msg.data) {
            if (ch === '\r') { termWrite(id, `\r\n${dot(C.dim)}${C.dim}(mock) received: ${line}${C.reset}\r\n`); line = ''; }
            else if (ch === '\x7f') { if (line) { line = line.slice(0, -1); termWrite(id, '\b \b'); } }
            else if (ch >= ' ') { line += ch; termWrite(id, ch); }
          }
        }
      });
      ws.on('close', () => termClients.get(id)?.delete(ws));
    });
    return;
  }
  socket.destroy();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock Muster on http://127.0.0.1:${PORT}  (token: ${TOKEN}${EMPTY ? ', empty' : ''})`);
  console.log(existsSync(DIST) ? `Serving ${DIST}` : 'dist/ui not built yet: API only');
});
