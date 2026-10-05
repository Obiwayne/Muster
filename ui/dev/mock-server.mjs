#!/usr/bin/env node
// Mock Muster orchestrator for developing the dashboard without real agents.
//
//   node ui/dev/mock-server.mjs            → http://127.0.0.1:47800  (serves dist/ui with the token injected)
//   PORT=47801 MOCK_TOKEN=abc node ui/dev/mock-server.mjs
//   MOCK_EMPTY=1 node ui/dev/mock-server.mjs   → no agents (empty-state dashboard)
//   MOCK_STRICT_DIFF=1 …                         → /diff ignores ?branch= (today's contract)
//   MOCK_ROADMAP=none|draft …                    → no roadmap / a draft waiting for approval (default: approved, M3 active)
//   MOCK_RESEARCH=none|running …                 → no research yet / scout still researching (default: a finished run, 4 new ideas)
//   MOCK_INTEL=none|running …                    → no competitors yet / an intel sweep running (default: Padlet, Wakelet, Linoit swept)
//   MOCK_INTEL=researching …                     → scout researching Figma (the progress overlay; advances every MOCK_INTEL_STEP_MS, 4000) + intel ready / stopped notes
//   MOCK_BROWSER=off …                           → GET /api/browser: playwright-core missing
//   MOCK_SANDBOX=<dir> …                       → research, roadmap, intel store and intel config read from <dir>/.muster (a live run's data; read only)
//   MOCK_PHONE=down|empty …                      → /api/phone/*: gateway won't start / no linked phones, no Tailscale
//   MOCK_WEEKLY=84 …                             → weekly usage % (default 38; at 75+ an open weekly usage alert note)
//   MOCK_REMOTE=off …                            → /api/phone/remote/pending fails (remote off / gateway down: no held writes shown)
//
// With `npx vite ui` (dev), set VITE_MUSTER_TOKEN=dev-token; vite proxies /api and /ws here.
// Implements the HTTP API and WebSockets from docs/ARCHITECTURE.md with in-memory state.

import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createIntelMock } from './intel-mock.mjs';

const PORT = Number(process.env.PORT ?? 47800);
const TOKEN = process.env.MOCK_TOKEN ?? 'dev-token';
const EMPTY = !!process.env.MOCK_EMPTY;
const WEEKLY = Number(process.env.MOCK_WEEKLY ?? 38);
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
const SKILLS = [
  { name: 'evidence-driven-testing', description: 'Records visual proof while testing, then attaches it to the task.' },
  { name: 'before-and-after', description: 'Captures before/after screenshots of a page or element.' },
  { name: 'code-structure', description: 'Keeps shared mechanics in a service layer, domain rules in actions.' },
  { name: 'unslop', description: 'Cuts AI tells from commit messages, docs and replies.' },
];
stationDefs.build.skills = ['code-structure'];
stationDefs.test.skills = ['evidence-driven-testing'];
stationDefs['design-check'].skills = ['before-and-after'];
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
  crewNames: 'names',
  requireEvidence: true,
  githubOffer: 'ask',
  weeklyAlerts: true,
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
  assignee: extra.assignee, branch: extra.branch, evidence: extra.evidence, createdBy: 'captain', createdAt: iso(extra.created ?? 40), updatedAt: iso(extra.updated ?? 5),
  history: extra.history ?? [{ at: iso(extra.created ?? 40), agentId: 'captain', kind: 'created' }],
});


// Evidence the last station attached (files are served from docs/ by the route in the HTTP handler).
const EVIDENCE_FILES = {
  '01-after-token-copy.png': join(here, '..', '..', 'docs', 'design', 'design-system.png'),
  'tests.txt': Buffer.from(['> vitest run', '', ' ✓ src/core/tokens.test.ts (14 tests)', ' ✓ src/api/invites.test.ts (12 tests)', '', ' Test Files  2 passed (2)', '      Tests  26 passed (26)'].join(String.fromCharCode(10))),
  'assertions.md': Buffer.from(['Tested commit: 4f2c1a9', '- token is 22 chars base62: passed', '- unique index rejects duplicates: passed', '- expiry defaults to 7 days: passed'].join(String.fromCharCode(10))),
};
const evidence = (id, station, by, summary, names, minAgo) => ({
  id, station, by, at: iso(minAgo), summary, sha: '4f2c1a9d03b7e5a1c8d2f6b94e0a7c35d1b8f2e6',
  files: names.map((name) => ({ name, kind: name.endsWith('.png') ? 'image' : 'text', bytes: 2048 })),
});

const S4 = ['plan', 'build', 'test', 'review'];
const SUI = ['design', 'build', 'design-check', 'review'];
const state = {
  version: 1,
  repoRoot: '/work/acme-app',
  agents: EMPTY ? [] : [
    agent('captain', 'captain', 'main', 'working', undefined, 45),
    agent('ada', 'crew', 'ada/invite-api', 'working', undefined, 44),
    agent('bea', 'crew', 'bea/share-dialog', 'stuck', 'T4', 40),
    agent('design', 'design', 'design/check', 'waiting', undefined, 38),
    agent('cleo', 'crew', 'cleo/tests', 'working', 'T3', 20),
  ],
  tasks: EMPTY ? [] : [
    task('T1', 'Invites table + migration', 'ready_for_merge', ['build', 'review'], 1, { branch: 'ada/invites-db', assignee: 'captain', created: 44, updated: 3,
      evidence: [evidence('E1', 'build', 'ada', 'Migration applies and rolls back; 12 invite tests pass.', ['01-after-token-copy.png', 'tests.txt', 'assertions.md'], 6)],
      history: [{ at: iso(44), agentId: 'captain', kind: 'created' }, { at: iso(3), agentId: 'captain', kind: 'review_requested', text: 'Migration adds the invites table with a unique token index. Tests pass. Safe to merge.' }] }),
    task('T2', 'Invite token generator', 'review', S4, 3, { branch: 'ada/tokens', assignee: 'captain', created: 43,
      evidence: [evidence('E1', 'test', 'bea', '22-char base62 tokens, 14 tests pass.', ['tests.txt', 'assertions.md'], 8)] }),
    task('T3', 'Invite API endpoints', 'in_progress', S4, 2, { branch: 'ada/invite-api', assignee: 'cleo', created: 42, dependsOn: ['T2'] }),
    task('T4', 'Share dialog UI', 'in_progress', SUI, 1, { branch: 'bea/share-dialog', assignee: 'bea', created: 41, dependsOn: ['T3'] }),
    task('T5', 'Revoke invite link', 'ready', S4, 0, { created: 30 }),
    task('T6', 'Invite email template', 'blocked', SUI, 0, { dependsOn: ['T3', 'T4'], created: 30 }),
    task('T7', 'End-to-end invite test', 'blocked', ['build', 'test', 'review'], 0, { dependsOn: ['T6'], created: 29 }),
    task('T9', 'Concept: sharing beyond invite links', 'awaiting_approval', ['discover', 'concept', 'approval', 'review'], 2, { branch: 'ada/sharing-concept', assignee: 'you', created: 36, updated: 1 }),
    task('T8', 'Invite model', 'merged', ['build', 'review'], 1, { branch: 'ada/invite-model', created: 120, updated: 62 }),
  ],
  notes: EMPTY ? [] : [
    { id: 'N10', type: 'progress', from: 'ada', taskId: 'T3', branch: 'ada/invite-api', text: 'Endpoints and tests done, handing to the test station.', createdAt: iso(14), open: false, replies: [] },
    { id: 'N11', type: 'done', from: 'ada', taskId: 'T1', branch: 'ada/invites-db', text: 'Invites table + migration done. 12 tests pass.', createdAt: iso(9), open: false, replies: [] },
    { id: 'N12', type: 'question', from: 'ada', taskId: 'T3', branch: 'ada/invite-api', text: 'Should invite links expire after 7 days or 30?', createdAt: iso(11), open: true,
      replies: [{ at: iso(8), from: 'cleo', text: 'The fixtures assume 7 days, if that helps.' }, { at: iso(6), from: 'captain', text: 'Checking the spec; hold on 7 days for now.' }] },
    { id: 'N13', type: 'review', from: 'captain', taskId: 'T1', branch: 'ada/invites-db', text: 'Invites table ready to merge. 3 files, 12 tests passing.', createdAt: iso(0.5), open: true, replies: [] },
    { id: 'N14', type: 'stuck', from: 'bea', taskId: 'T4', branch: 'bea/share-dialog', text: 'Which token format does T2 use? The share fixture fails on length.\nTried: regenerating the fixture from the API (still 16 chars), reading src/api/tokens.ts (not on my branch yet).', createdAt: iso(4), open: true,
      replies: [{ at: iso(2), from: 'captain', text: 'Use the 22-char base62 token from T2. ada merged it into their branch; pull it with handoff and rerun the fixture.' },
        { at: iso(1), from: 'ada', text: 'tokens.ts is on ada/invite-api now. The fixture helper is makeInviteToken() in test/fixtures.ts, use that instead of a hard-coded string.' },
        { at: iso(0.6), from: 'you', text: 'Use makeInviteToken() from test/fixtures.ts and rerun the share fixture; no hard-coded tokens.' }] },
    { id: 'N15', type: 'waiting', from: 'design', to: 'bea', taskId: 'T4', branch: 'design/check', text: 'Design check on T4 once bea hands off.', createdAt: iso(6), open: true, replies: [] },
    { id: 'N16', type: 'escalation', from: 'captain', text: 'Should a revoked invite link show a friendly "link expired" page or a plain 404? This is a product call (N12 is related).', createdAt: iso(2), open: true, replies: [] },
    // The Captain's AskUserQuestion menu (docs/ASK.md): one open, one answered.
    { id: 'N23', type: 'escalation', from: 'captain', to: 'you', text: 'Which model should draw the wall thumbnails?\n\nWhich caption sizes should a post offer?', createdAt: iso(1.5), open: true, replies: [],
      ask: [
        { header: 'Art model', question: 'Which model should draw the wall thumbnails?', multiSelect: false, options: [
          { label: 'Flux schnell (Recommended)', description: 'Fast and cheap, good enough at thumbnail size' },
          { label: 'SDXL', description: 'Sharper detail, about 3x the cost per image' },
          { label: 'No thumbnails', description: 'Show the first post as text instead' }] },
        { header: 'Caption size', question: 'Which caption sizes should a post offer?', multiSelect: true, options: [
          { label: 'Small', description: '12 px, fits three lines under a photo' },
          { label: 'Medium', description: '14 px, the current default' },
          { label: 'Large', description: '18 px, for projecting on a class screen' }] }] },
    { id: 'N24', type: 'escalation', from: 'captain', to: 'you', text: 'Ship the share dialog behind a flag first?', createdAt: iso(40), open: false, closedAt: iso(35),
      ask: [{ header: 'Rollout', question: 'Ship the share dialog behind a flag first?', multiSelect: false, options: [{ label: 'Yes, flag it (Recommended)', description: 'Turn it on for one class first' }, { label: 'No, ship to everyone' }] }],
      answers: [{ header: 'Rollout', choices: ['Yes, flag it (Recommended)'], other: "start with Ms. Lee's class" }],
      replies: [{ at: iso(35), from: 'you', text: "Rollout: Yes, flag it (Recommended) (note: start with Ms. Lee's class)" }] },
    // a 3-question menu: the long held answer P11 goes to it
    { id: 'N25', type: 'escalation', from: 'captain', to: 'you', text: 'Export formats: which should the Export dialog offer?\n\nDefault resolution for a new export?\n\nAnything else the crew should know before building the presets?', createdAt: iso(5), open: true, replies: [],
      ask: [
        { header: 'Export formats', question: 'which should the Export dialog offer?', multiSelect: true, options: [{ label: 'MP4 (H.264)' }, { label: 'WebM' }, { label: 'GIF' }] },
        { header: '', question: 'Default resolution for a new export?', multiSelect: false, options: [{ label: '720p' }, { label: '1080p' }, { label: '4K' }] },
        { header: '', question: 'Anything else the crew should know before building the presets?', multiSelect: false, options: [{ label: 'No, go ahead' }] }] },
    { id: 'N17', type: 'progress', from: 'design', to: 'bea', taskId: 'T4', branch: 'bea/share-dialog', text: 'DRIFT T4 ShareDialog primary button is #2563EB; framework uses var(--color-primary)\nsrc/ui/ShareDialog.tsx:42 — hard-coded #2563EB', createdAt: iso(3), open: false, replies: [] },
    { id: 'N18', type: 'question', from: 'design', taskId: 'T4', text: 'DRIFT T4 Share dialog has no matching board in Vellum. Ask the Captain before adding one?', createdAt: iso(3.5), open: false, replies: [{ at: iso(3), from: 'captain', text: 'Not yet, flag it in the review.' }] },
    { id: 'N19', type: 'done', from: 'design', taskId: 'T2', text: 'PASS T2 Token copy UI matches the framework tokens', createdAt: iso(16), open: false, replies: [] },
    { id: 'N21', type: 'approval', from: 'ada', taskId: 'T9', branch: 'ada/sharing-concept', text: 'Concept for sharing beyond invite links is ready: three options (public link, per-team link, email-only) with a recommendation. Approve to start planning.', createdAt: iso(1), open: true, replies: [] },
    { id: 'N20', type: 'message', from: 'ada', to: 'bea', text: 'Heads up: the invite API now returns expiresAt as an ISO string, not a number.', createdAt: iso(33), open: false, replies: [] },
  ],
  feed: [],
  inbox: [],
  usage: {
    fiveHour: { usedPercentage: 62, resetsAt: new Date(now + 108 * 60_000).toISOString() },
    sevenDay: { usedPercentage: WEEKLY, resetsAt: nextMonday() },
    updatedAt: iso(0.2), perAgentCostUsd: {}, paused: false, weeklyWarned: false,
  },
  goal: EMPTY ? undefined : { text: 'Build the invite-link sharing flow', at: iso(42) },
  nextIds: { agent: 6, task: 10, note: 26, feed: 1, inbox: 1, stage: 6, goal: 15, idea: 12, run: 2 },
};
if (!EMPTY && WEEKLY >= config.warnAtWeeklyPct) {
  state.usage.weeklyWarned = true;
  const r = new Date(state.usage.sevenDay.resetsAt);
  const when = `${r.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '')}, ${String(r.getHours()).padStart(2, '0')}:${String(r.getMinutes()).padStart(2, '0')}`;
  state.notes.unshift({ id: 'N22', type: 'system', topic: 'weekly_usage', from: 'muster', to: 'you', text: `Weekly usage at ${WEEKLY}%. Resets ${when}.`, createdAt: iso(31), open: true, replies: [] });
}

// ---------------------------------------------------------------- roadmap (dates relative to today)
const ROADMAP_MODE = process.env.MOCK_ROADMAP ?? 'approved';
const dayStr = (offset) => { const d = new Date(now); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function seedRoadmap() {
  if (EMPTY || ROADMAP_MODE === 'none') return;
  const draft = ROADMAP_MODE === 'draft';
  const stage = (id, title, description, start, due, status, goalIds, exitCriteria, completedAt) => ({ id, title, description, start: dayStr(start), due: dayStr(due), status: draft ? 'planned' : status, goalIds, exitCriteria, ...(completedAt !== undefined && !draft ? { completedAt: dayStr(completedAt) } : {}) });
  const goal = (id, stageId, title, description, status, start, due) => ({ id, stageId, title, description, status: draft ? 'planned' : status, ...(start !== undefined ? { start: dayStr(start), due: dayStr(due) } : {}) });
  const crit = (text, done) => ({ text, done: draft ? false : done });
  state.roadmap = {
    title: 'wall-education v1.0', summary: 'A shared class wall: teachers post, students react, everyone sees it live.',
    launchDate: dayStr(43), status: draft ? 'draft' : 'approved', revision: draft ? 0 : 1, ...(draft ? { noteId: 'N21' } : { approvedAt: iso(60 * 24 * 20) }),
    createdBy: 'captain', updatedAt: iso(30),
    ...(draft ? {} : { statusLine: { text: `M3 Sharing & invites is 40%: G7 invite flow is in review, G8 share permissions starts next. Launch on ${dayStr(43)} still holds.`, at: iso(14), by: 'captain', taskId: 'T90' } }),
    stages: [
      stage('M1', 'Foundations', 'Repo, CI, design tokens and the app shell.', -24, -13, 'done', ['G1', 'G2'], [crit('CI runs on every push', true)], -13),
      stage('M2', 'Accounts & classes', 'Sign-in, roles and classes with join codes.', -17, -1, 'done', ['G3', 'G4', 'G5'], [crit('A teacher can create a class', true)], -1),
      stage('M3', 'Sharing & invites', 'Teachers share a wall with a link, set who can post, and pull in a class roster.', -3, 15, 'active', ['G7', 'G8', 'G9'],
        [{ ...crit('A teacher shares a wall by link', true), ...(draft ? {} : { doneAt: iso(12), by: 'captain' }) }, crit('Roles are enforced on every API route', false), crit('A 30-student roster imports cleanly', false)]),
      stage('M4', 'Wall editor', 'The wall canvas: posts, layout and live presence.', 11, 36, 'planned', ['G10', 'G11', 'G12'], [crit('Posts sync between two browsers in under a second', false)]),
      stage('M5', 'Launch v1.0', 'Hardening, load test and the launch checklist.', 33, 42, 'planned', draft ? ['G6'] : ['G6', 'G14'], [crit('Load test: 500 concurrent students', false)]),
    ],
    goals: [
      goal('G1', 'M1', 'Repo and CI', '', 'done'), goal('G2', 'M1', 'Design tokens', '', 'done'),
      goal('G3', 'M2', 'Email sign-in + magic links', '', 'done'), goal('G4', 'M2', 'Teacher / student roles', '', 'done'), goal('G5', 'M2', 'Class join codes', '', 'done'),
      goal('G7', 'M3', 'Invite-link sharing flow', 'Share a wall by link; revoke it; email the invite.', 'active', -3, 6),
      goal('G8', 'M3', 'Share permissions & roles', 'starts when invite flow merges', 'planned', 3, 9),
      goal('G9', 'M3', 'Class roster import', 'CSV + Google Classroom', 'planned', 6, 15),
      goal('G10', 'M4', 'Wall canvas & layout', '', 'planned'), goal('G11', 'M4', 'Post types: text, image, link', '', 'planned'), goal('G12', 'M4', 'Realtime presence', '', 'planned'),
      goal('G6', 'M5', 'Hardening', '', 'planned'),
      ...(draft ? [] : [goal('G14', 'M5', 'Export a wall as a PDF for parents', 'From research idea R8', 'planned')]),
    ],
  };
  if (draft) {
    state.notes.push({ id: 'N21', type: 'approval', from: 'captain', text: `Roadmap ready for your approval\nwall-education v1.0 · 5 stages · launch ${dayStr(43)}`, createdAt: iso(5), open: true, replies: [] });
    return;
  }
  for (const t of state.tasks) t.goalId = t.id === 'T8' ? 'G5' : 'G7';
  // merged history so the panels have data
  const merged = [['T90', 'Class join codes', 'G5', 1], ['T91', 'Teacher / student roles', 'G4', 2], ['T92', 'Email sign-in + magic links', 'G3', 3], ['T93', 'Roles middleware', 'G4', 3], ['T94', 'Design tokens', 'G2', 6], ['T95', 'CI pipeline', 'G1', 8], ['T96', 'App shell', 'G2', 9]];
  for (const [id, title, goalId, daysAgo] of merged) state.tasks.push({ ...task(id, title, 'merged', ['build', 'review'], 1, { created: daysAgo * 1440 + 300, updated: daysAgo * 1440 }), goalId });
}
seedRoadmap();

// ---------------------------------------------------------------- research (scout's runs and ideas)
const RESEARCH_MODE = process.env.MOCK_RESEARCH ?? 'done';
function seedResearch() {
  state.research = { runs: [], ideas: [] };
  if (EMPTY || RESEARCH_MODE === 'none') return;
  const running = RESEARCH_MODE === 'running';
  const sources = { competitors: ['Padlet', 'Wakelet', 'Linoit'], reviews: true, forums: ['r/Teachers', 'r/edtech'], ownApp: false };
  const idea = (id, minAgo, over) => ({ id, runId: 'RR1', effort: 'M', evidence: [], status: 'new', thread: [], createdAt: iso(minAgo), ...over });
  const ev = (kind, source, text, url, count) => ({ kind, source, ...(text ? { text } : {}), ...(url ? { url } : {}), ...(count ? { count } : {}) });
  const ideas = [
    idea('R7', 118, {
      title: 'Moderation queue before posts go live', summary: "Teachers' top Padlet complaint: inappropriate posts appear before anyone can review them.",
      impact: 'high', stageId: 'M3',
      evidence: [
        ev('review', 'App Store review · Padlet · 2★', 'A student posted something awful and the whole class saw it before I could delete it.', 'https://apps.apple.com/us/app/padlet/id834618886?see-all=reviews', 37),
        ev('forum', 'r/Teachers · 412 upvotes', 'Is there any wall tool where I approve posts first? I stopped using them because of this.', 'https://www.reddit.com/r/Teachers/', 5),
        ev('competitor', 'Wakelet public roadmap: “Post approval” · planned', undefined, 'https://wakelet.com/'),
      ],
      thread: [
        { at: iso(40), from: 'you', text: 'Worth doing before launch? What would it cost us?' },
        { at: iso(34), from: 'captain', text: "Yes. It's the complaint that makes teachers leave, and it fits right after Share permissions: about 5 tasks (hold queue, review list, “pending” state, per-wall toggle, tests).\n\nM3 moves from Oct 17 to Oct 20. Launch stays Nov 14." },
      ],
      plan: ['+ Add goal Moderation queue to M3 (Oct 13–17)', '~ Move M3 due date (Oct 17 → 20)'],
    }),
    idea('R9', 112, {
      title: 'Unlimited walls on the free plan', summary: "Padlet's 3-wall free limit is the most upvoted complaint on r/Teachers this year.",
      impact: 'business', effort: 'S', stageId: 'M5',
      evidence: [ev('review', 'G2 review · Padlet · 2★', 'Three walls is nothing. I teach five classes.', undefined, 53), ev('forum', 'r/Teachers · 1.2k upvotes', 'Padlet just cut free accounts to 3 walls. Alternatives?', 'https://www.reddit.com/r/Teachers/', 8), ev('competitor', 'Padlet: 3 free walls', undefined, 'https://padlet.com/premium')],
    }),
    idea('R10', 104, {
      title: 'Google Classroom roster sync', summary: 'Teachers re-type class lists. Both Padlet and Wakelet list Classroom sync as “coming soon”.',
      impact: 'medium', stageId: 'M3', overlapsGoalId: 'G9',
      evidence: [ev('review', 'Play Store review · Wakelet · 3★', 'I had to add 31 kids by hand.', undefined, 11), ev('forum', 'r/edtech · 88 upvotes', undefined, 'https://www.reddit.com/r/edtech/', 2), ev('competitor', 'On 2 competitor roadmaps')],
    }),
    idea('R11', 96, {
      title: 'Wall templates for the first lesson', summary: 'New teachers stare at an empty wall; Linoit and Padlet both lead with templates in onboarding.',
      impact: 'low', effort: 'S', stageId: 'M4',
      evidence: [ev('competitor', 'Linoit onboarding: 12 starter templates', undefined, 'https://en.linoit.com/'), ev('app', 'Our app: empty wall has no hint text')],
    }),
    idea('R8', 116, {
      title: 'Export a wall as a PDF for parents', summary: "Parents can't log in, so teachers screenshot walls by hand. Padlet charges for PDF export.",
      impact: 'medium', effort: 'S', stageId: 'M5', status: 'approved', goalId: 'G14', decidedAt: iso(100),
      evidence: [ev('review', 'App Store review · Padlet · 3★', 'PDF export should not be a paid feature.', undefined, 20), ev('forum', 'r/Teachers · 96 upvotes', undefined, undefined, 3), ev('competitor', 'Paid on Padlet')],
      thread: [{ at: iso(99), from: 'captain', text: 'Added it to M5 Launch as G14: one task for the PDF renderer, one for the share sheet.' }],
      plan: ['+ Add goal Export a wall as a PDF to M5 (Nov 3–7)'],
    }),
    idea('R6', 114, { title: 'Dark mode for projector use', summary: 'Teachers project walls in dim rooms; white backgrounds glare.', impact: 'low', effort: 'S', stageId: 'M4', status: 'approved', decidedAt: iso(20),
      evidence: [ev('forum', 'r/Teachers · 54 upvotes', 'My projector turns every white wall into a flashbang.', undefined, 1)] }),
    idea('R3', 117, { title: 'AI-written post suggestions', summary: 'One competitor added AI prompts; reviews are mixed.', impact: 'low', effort: 'L', status: 'rejected', decidedAt: iso(60), evidence: [ev('competitor', 'Padlet AI recipes')] }),
    idea('R4', 117, { title: 'Native iPad app', summary: 'Some reviews ask for an app; most use the browser fine.', impact: 'medium', effort: 'L', status: 'rejected', decidedAt: iso(61), evidence: [ev('review', 'App Store review · Padlet · 4★', 'Wish it was an app on our iPads.', undefined, 6)] }),
    idea('R5', 116, { title: 'Wall comment threads', summary: 'Nested replies on posts.', impact: 'low', effort: 'M', status: 'rejected', decidedAt: iso(62), evidence: [ev('forum', 'r/edtech · 12 upvotes')] }),
  ];
  if (running) {
    const keep = new Set(['R7', 'R9', 'R10']);
    state.research.ideas = ideas.filter((i) => keep.has(i.id)).map((i) => ({ ...i, runId: 'RR2', status: 'new', thread: [], plan: undefined, createdAt: iso(i.id === 'R7' ? 6 : i.id === 'R9' ? 4 : 2) }));
    state.research.runs = [{ id: 'RR2', status: 'running', sources, focus: 'Why do teachers stop using wall apps after the first month?', depth: 'thorough', agentId: 'scout', startedAt: iso(9), ideaIds: ['R7', 'R9', 'R10'] }];
    state.agents.push(agent('scout', 'research', 'main', 'working', undefined, 9));
    state.nextIds.run = 3;
    return;
  }
  state.research.ideas = ideas;
  state.research.runs = [{
    id: 'RR1', status: 'done', sources, depth: 'thorough', agentId: 'scout', startedAt: iso(138), finishedAt: iso(120), sourcesRead: 47,
    summary: 'Padlet, Wakelet and Linoit roadmaps · 312 app-store reviews · 18 Reddit threads', ideaIds: ideas.map((i) => i.id),
  }];
}
seedResearch();

function roadmapProgress() {
  const r = state.roadmap;
  if (!r) return null;
  const today = dayStr(0);
  const goals = {};
  for (const g of r.goals) {
    const ts = state.tasks.filter((t) => t.goalId === g.id && t.status !== 'cancelled');
    const done = ts.filter((t) => t.status === 'merged').length;
    const agents = [...new Set(ts.filter((t) => t.status !== 'merged' && t.assignee).map((t) => t.assignee))];
    goals[g.id] = { done, total: ts.length, percent: ts.length ? Math.round((done / ts.length) * 100) : 0, agents };
  }
  const stages = {};
  const rank = { late: 3, at_risk: 2, on_track: 1, not_started: 0 };
  let worst = null;
  for (const s of r.stages) {
    const gs = r.goals.filter((g) => g.stageId === s.id && g.status !== 'cancelled');
    const done = gs.reduce((n, g) => n + goals[g.id].done, 0);
    const total = gs.reduce((n, g) => n + goals[g.id].total, 0);
    const percent = total ? Math.round((done / total) * 100) : 0;
    let health = 'on_track';
    if (s.status === 'done') health = 'done';
    else if (s.status === 'planned' && (!s.start || s.start > today)) health = 'not_started';
    else if (s.due && today > s.due) health = 'late';
    else if (s.start && s.due) {
      const expected = (Date.parse(today) - Date.parse(s.start)) / Math.max(1, Date.parse(s.due) - Date.parse(s.start));
      if (percent / 100 < expected - 0.15) health = 'at_risk';
    }
    if (health !== 'done' && (worst === null || rank[health] > rank[worst])) worst = health;
    stages[s.id] = { done, total, percent, health, criteriaDone: s.exitCriteria.filter((c) => c.done).length, criteriaTotal: s.exitCriteria.length };
  }
  const all = r.goals.filter((g) => g.status !== 'cancelled').map((g) => goals[g.id]);
  const done = all.reduce((n, g) => n + g.done, 0);
  const total = all.reduce((n, g) => n + g.total, 0);
  const cur = r.stages.find((s) => s.status !== 'done');
  const curGoal = cur && r.goals.find((g) => g.stageId === cur.id && g.status === 'active');
  return {
    overall: { done, total, percent: total ? Math.round((done / total) * 100) : 0 },
    health: worst ?? 'done',
    daysToLaunch: r.launchDate ? Math.round((Date.parse(r.launchDate) - Date.parse(today)) / 86400000) : undefined,
    currentStageId: cur?.id, currentGoalId: curGoal?.id, stages, goals,
  };
}
const roadmapOut = () => ({ roadmap: state.roadmap ?? null, progress: roadmapProgress() });

function nextMonday() {
  const d = new Date(now);
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

const react = (emoji, by, minAgo) => ({ emoji, by, at: iso(minAgo) });
const feedSeed = [
  [44, 'message', 'you', 'captain', 'Build the invite-link sharing flow', {}],
  [43, 'message', 'captain', 'everyone', 'Goal: the invite-link sharing flow. T2 and T3 go first; T4 waits on T3.\n- T3 Invite API endpoints → ada\n- T4 Share dialog UI · after T3 → bea', { reactions: [react('👍', 'ada', 42.9), react('👍', 'bea', 42.9), react('👍', 'design', 42)], readBy: ['ada', 'bea', 'design'] }],
  [42.8, 'event', 'muster', undefined, 'captain posted T1–T7', {}],
  [42.5, 'event', 'ada', undefined, 'ada claimed T3 Invite API endpoints', { taskId: 'T3' }],
  [42.3, 'event', 'bea', undefined, 'bea claimed T4 Share dialog UI', { taskId: 'T4' }],
  [40, 'event', 'muster', undefined, 'design started (design crew)', {}],
  [37, 'message', 'you', 'captain', 'Also keep a revoke button next to every invite link in the share dialog.', { via: { client: 'Claude', approvedOn: 'not held', approvedAt: iso(37) }, readBy: ['captain'] }],
  [36, 'message', 'design', 'everyone', 'Reading the Muster framework in Vellum: 38 tokens, 9 pages. I will check every UI branch before review.', {}],
  [33, 'message', 'ada', 'bea', 'Heads up: the invite API now returns expiresAt as an ISO string, not a number.', { readBy: ['bea'] }],
  [32, 'message', 'ada', 'bea', 'Types are in src/api/invites.ts if you want them.', { reactions: [react('🙌', 'bea', 30)] }],
  [30, 'message', 'bea', 'ada', 'Thanks, switching the dialog to parse it.', {}],
  [22, 'event', 'muster', undefined, 'cleo started (crew)', {}],
  [16, 'note', 'design', undefined, 'Token copy UI matches the framework tokens: spacing, type and colour pass.', { noteId: 'N19', noteType: 'done' }],
  [14, 'note', 'ada', undefined, 'Endpoints and tests done, handing to the test station.', { noteId: 'N10', noteType: 'progress' }],
  [13.5, 'event', 'ada', undefined, 'ada handed T3 to cleo (test station): "endpoints + tests done"', { taskId: 'T3' }],
  [11, 'note', 'ada', undefined, 'Should invite links expire after 7 days or 30?', { noteId: 'N12', noteType: 'question' }],
  [9, 'note', 'ada', undefined, 'Invites table + migration done. 12 tests pass.', { noteId: 'N11', noteType: 'done' }],
  [8, 'reply', 'cleo', undefined, 'The fixtures assume 7 days, if that helps.', { noteId: 'N12' }],
  [6, 'reply', 'captain', undefined, 'Checking the spec; hold on 7 days for now.', { noteId: 'N12' }],
  [6, 'note', 'design', undefined, 'Design check on T4 once bea hands off.', { noteId: 'N15', noteType: 'waiting' }],
  [4, 'note', 'bea', undefined, 'Which token format does T2 use? The share fixture fails on length.', { noteId: 'N14', noteType: 'stuck', taskId: 'T4', reactions: [react('👀', 'captain', 3.9)], readBy: ['captain'] }],
  [3.6, 'note', 'design', undefined, 'Share dialog has no matching board in Vellum. Ask the Captain before adding one?', { noteId: 'N18', noteType: 'question', taskId: 'T4', reactions: [react('✅', 'design', 2.9)] }],
  [3.5, 'message', 'design', 'bea', 'The ShareDialog button is hard-coded #2563EB.\nUse `var(--color-primary)` like every primary button.', { readBy: ['bea'] }],
  [3.2, 'reply', 'captain', undefined, 'Not yet, flag it in the review.', { noteId: 'N18' }],
  [3, 'event', 'captain', undefined, 'captain requested review of T1: "Safe to merge"', { taskId: 'T1' }],
  [2, 'reply', 'captain', undefined, 'Use the 22-char base62 token from T2. ada has it on their branch.', { noteId: 'N14' }],
  [2, 'note', 'captain', undefined, 'Should a revoked invite link show a friendly page or a 404?', { noteId: 'N16', noteType: 'escalation' }],
  [1, 'reply', 'ada', undefined, 'Fixture helper is makeInviteToken() in test/fixtures.ts, use that instead of a hard-coded string.', { noteId: 'N14' }],
  [0.8, 'message', 'you', 'captain', "Keep T4 small please, I'd like to try the share link tonight.", { reactions: [react('👍', 'captain', 0.6)], readBy: ['captain'] }],
  // sent from the Claude app through the remote connector (docs/REMOTE.md): yours, on the right, with a "via Claude" chip
  [0.6, 'reply', 'you', undefined, 'Use makeInviteToken() from test/fixtures.ts and rerun the share fixture; no hard-coded tokens.', { noteId: 'N14', via: { client: 'Claude', approvedOn: 'phone', approvedAt: iso(0.6) }, reactions: [react('👀', 'bea', 0.4)], readBy: ['bea', 'captain'] }],
  [0.5, 'note', 'captain', undefined, 'Invites table ready to merge. 3 files, 12 tests passing.', { noteId: 'N13', noteType: 'review' }],
];
if (ROADMAP_MODE === 'approved') {
  feedSeed.push([95, 'event', 'captain', undefined, 'added goal G14 Export a wall as a PDF for parents to M5 Launch v1.0', {}]);
  feedSeed.push([12, 'event', 'captain', undefined, 'ticked M3 exit criterion 1: A teacher shares a wall by link', {}]);
  feedSeed.sort((a, b) => b[0] - a[0]);
}
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
    `${C.text}bea is stuck on the invite token format. Answering first.${C.reset}`,
    `${dot(C.dim)}${C.dim}reply(N14, "Use the 22-char base62 token from T2")${C.reset}`,
    `${dot(C.dim)}${C.dim}get_diff(ada) → 6 files, ${C.green}+214${C.dim} ${C.red}−18${C.reset}`,
    `${dot(C.dim)}${C.dim}run_tests(ada) → ${C.green}41 passed${C.reset}`,
    `${C.text}The invite API looks right. One nit: expiresAt should be UTC.${C.reset}`,
    `${dot(C.amber)}${C.amber}request_review(ada, "Invite API ready")${C.reset}`,
  ],
  'ada': [
    `${dot(C.dim)}${C.dim}claim_task() → T3 Invite API endpoints${C.reset}`,
    `${C.text}  Working in .muster/worktrees/ada${C.reset}`,
    `${dot(C.dim)}${C.dim}Edit src/api/invites.ts${C.reset}`,
    `${dot(C.dim)}${C.dim}Bash npm test -- invites → ${C.green}41 passed${C.reset}`,
    `${dot(C.dim)}${C.dim}message_crew(bea, "invite API now returns expiresAt")${C.reset}`,
    `${dot(C.text)}${C.text}post_note(progress, "endpoints + tests done")${C.reset}`,
    `${dot(C.teal)}${C.teal}handoff(cleo, "ready for the test station")${C.reset}`,
  ],
  'bea': [
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
    `${dot(C.text)}${C.text}post_note(waiting, "design check on T4 once bea hands off")${C.reset}`,
    `${dot(C.lav)}${C.lav}message_crew(bea, "use var(--color-primary) on buttons")${C.reset}`,
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
// competitive intelligence (/api/intel/*, GET /api/browser and the `intel` event)
const intel = createIntelMock({
  state, config, now, need, HttpError, toastAll, readBody: (req) => body(req), broadcast: () => broadcast(),
  send: (msg) => { const t = JSON.stringify(msg); for (const ws of eventClients) if (ws.readyState === 1) ws.send(t); },
});
// MOCK_SANDBOX: replay a live run's research, roadmap and intel store (the files are only read).
if (process.env.MOCK_SANDBOX) {
  const dir = join(process.env.MOCK_SANDBOX, '.muster');
  const read = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const live = read('state.json');
  if (live.research) state.research = live.research;
  state.roadmap = live.roadmap ?? null;
  const store = read('intel.json');
  for (const k of Object.keys(intel.store)) delete intel.store[k];
  Object.assign(intel.store, store);
  const cfg = existsSync(join(dir, 'config.json')) ? read('config.json') : {};
  if (cfg.projectName) config.projectName = cfg.projectName;
  if (cfg.intel) config.intel = { ...config.intel, ...cfg.intel };
  if (cfg.researchBrowser) config.researchBrowser = { ...config.researchBrowser, ...cfg.researchBrowser };
}
const paused = () => state.usage.fiveHour && state.usage.fiveHour.usedPercentage >= config.pauseAtFiveHourPct;

function fakeDiff(a) {
  const files = {
    'ada/invites-db': [['db/migrations/014_invites.sql', 41, 0], ['src/db/invites.ts', 33, 0], ['test/db/invites.test.ts', 22, 0]],
    'ada/invite-api': [['src/api/invites.ts', 120, 10], ['src/api/tokens.ts', 44, 4], ['test/api/invites.test.ts', 50, 4]],
    'ada/tokens': [['src/api/tokens.ts', 40, 2], ['test/api/tokens.test.ts', 18, 2]],
    'bea/share-dialog': [['src/ui/ShareDialog.tsx', 96, 0], ['src/ui/ShareDialog.css', 22, 0], ['test/ui/share.test.ts', 13, 2]],
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

// /api/phone/* (docs/PHONE.md admin API, forwarded by the orchestrator). MOCK_PHONE=down: every call 503s (the banner);
// MOCK_PHONE=empty: no linked phones, Tailscale not installed.
const PHONE = process.env.MOCK_PHONE ?? '';
const phoneDown = PHONE === 'down';
const phone = {
  pcName: 'WAYNE-PC', port: 47910, fingerprint: '3f9a1c07b2e4d85a6c1f0e93b7d24a58c6e1f3a907b2d4c85e6a1f30c9b7e2d4',
  network: PHONE === 'empty'
    ? { mode: 'lan', lanHosts: ['192.168.1.20'], tailscale: { installed: false, ip: null, dnsName: null, online: false } }
    : { mode: 'tailscale', lanHosts: ['192.168.1.20'], tailscale: { installed: true, ip: '100.101.42.7', dnsName: 'wayne-pc.tail8c2e1.ts.net.', online: true } },
  devices: PHONE === 'empty' ? [] : [
    { id: 'dev-pixel8', name: 'Pixel 8 · Wayne', createdAt: new Date(new Date(now).setHours(9, 12, 0, 0)).toISOString(), lastSeenAt: iso(2), online: false },
  ],
};
let phoneSend = { notify: { review: true, question: true, blocked: true, usage: false, stuck: false }, quiet: { on: true, from: '22:00', to: '07:00' }, projects: {} };
const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
let pairCount = 0;
async function phoneQr(text) {
  try {
    const QR = (await import('qrcode')).default;
    return await QR.toString(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#111113', light: '#ffffff' } });
  } catch {
    // qrcode not installed: a plain placeholder in the same shape
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25" shape-rendering="crispEdges"><path fill="#111113" d="M0 0h7v7h-7zM1 1v5h5v-5zM2 2h3v3h-3zM18 0h7v7h-7zM19 1v5h5v-5zM20 2h3v3h-3zM0 18h7v7h-7zM1 19v5h5v-5zM2 20h3v3h-3zM16 16h5v5h-5zM17 17v3h3v-3zM18 18h1v1h-1z"/></svg>';
  }
}
async function phoneApi(req, m, p) {
  need(!phoneDown, 503, 'Could not start the phone gateway (dist/phone/index.js exited). Port 47910 may be in use.');
  if (m === 'GET' && p === '/api/phone/status') return phone;
  if (m === 'POST' && p === '/api/phone/pair-code') {
    // the first code matches the design (K7M-4QX, 1:52 left); later ones are random and get the full 2 minutes
    const code = pairCount++ === 0 ? 'K7M4QX' : Array.from({ length: 6 }, () => PAIR_ALPHABET[Math.floor(Math.random() * PAIR_ALPHABET.length)]).join('');
    const hosts = [...phone.network.lanHosts, ...(phone.network.mode === 'tailscale' && phone.network.tailscale.installed ? [phone.network.tailscale.ip, phone.network.tailscale.dnsName.replace(/\.$/, '')] : [])];
    const qrText = `muster://pair?c=${code}&p=${phone.port}&f=${phone.fingerprint}&n=${phone.pcName}&h=${hosts.join(',')}`;
    const ttl = pairCount === 1 ? 112_000 : 120_000;
    return { code, display: `${code.slice(0, 3)}-${code.slice(3)}`, expiresAt: new Date(Date.now() + ttl).toISOString(), qrSvg: await phoneQr(qrText), qrText };
  }
  if (m === 'PUT' && p === '/api/phone/network') {
    const { mode } = await body(req);
    need(mode === 'lan' || mode === 'tailscale', 400, 'mode must be lan or tailscale');
    need(mode === 'lan' || phone.network.tailscale.installed, 409, 'Tailscale is not installed on this PC');
    phone.network.mode = mode;
    return { ok: true, mode };
  }
  const dm = /^\/api\/phone\/devices\/([^/]+)$/.exec(p);
  if (m === 'DELETE' && dm) {
    const i = phone.devices.findIndex((d) => d.id === decodeURIComponent(dm[1]));
    need(i >= 0, 404, 'No such phone');
    phone.devices.splice(i, 1);
    return { ok: true };
  }
  if (m === 'POST' && p === '/api/phone/test') return { ok: true, sent: phone.devices.filter((d) => d.online).length };
  if (p === '/api/phone/remote/pending' || p.startsWith('/api/phone/remote/pending/')) return remotePendingApi(req, m, p);
  if (m === 'GET' && p === '/api/phone/send') return phoneSend;
  if (m === 'PUT' && p === '/api/phone/send') { phoneSend = { ...phoneSend, ...(await body(req)) }; return phoneSend; }
  throw new HttpError(404, `No phone route ${m} ${p}`);
}

// ---------------------------------------------------------------- held remote writes (docs/REMOTE.md, milestone 4)
// GET /api/phone/remote/pending, POST .../:id/send { digest } | .../:id/discard. P9 always fails to send (409, the
// failed state); P7 expires 20 s after start (the expired state); P5 belongs to another project (never shown here).
const REMOTE_OFF = process.env.MOCK_REMOTE === 'off';
/** The gateway's project id: repoKey(root) (src/core/tokens.ts). */
const projectKey = (root) => {
  let k = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[A-Za-z]:\//.test(k)) k = k.toLowerCase();
  return createHash('sha256').update(k).digest('hex').slice(0, 16);
};
const inSec = (s) => new Date(now + s * 1000).toISOString();
const LONG_OTHER = [
  'Yes, a few things. Name the presets after where the video goes, not the codec: "YouTube", "YouTube Shorts", "Instagram Reel", "Archive". Archive is the only one that keeps the original frame rate and uses a high bitrate; the others cap at 30 fps.',
  'Keep the last preset the user picked per project, not globally, because I switch between a landscape channel and a Shorts channel all day.',
  "Don't add GIF export yet. If the WebM encoder isn't available on this machine, grey the option out with a one-line reason instead of hiding it, so I know it exists.",
  'Please add a test for the per-project memory, and one that a vertical timeline still opens on YouTube Shorts.',
].join('\n\n');
function heldWrite(w) {
  const projectId = w.projectId ?? projectKey(state.repoRoot);
  const digest = createHash('sha256').update(JSON.stringify([w.id, projectId, w.kind, w.text ?? null, w.noteId ?? null, w.answers ?? null, w.taskId ?? null])).digest('hex');
  return { projectName: config.projectName ?? 'acme-app', client: 'Claude', pendingId: w.id, digest, ...w, projectId };
}
const remotePending = EMPTY ? [] : [
  heldWrite({ id: 'P8', kind: 'reply', noteId: 'N12', text: "Go with 7 days, and show the friendly 'link expired' page with a button to ask for a new link.",
    replyTo: { id: 'N12', from: 'ada', text: "Should invite links expire after 7 days or 30? And should a revoked link show a friendly 'link expired' page or a plain 404?" },
    createdAt: iso(13), expiresAt: inSec(138) }),
  heldWrite({ id: 'P11', kind: 'answer', noteId: 'N25', answers: [{ choices: ['MP4 (H.264)', 'WebM'] }, { choices: ['1080p'] }, { choices: [], other: LONG_OTHER }],
    replyTo: { id: 'N25', from: 'captain', text: 'Export formats: which should the Export dialog offer? Default resolution for a new export? Anything else the crew should know before building the presets?' },
    createdAt: iso(4), expiresAt: inSec(652) }),
  heldWrite({ id: 'P9', kind: 'goal', text: 'Run the full export test suite on the Windows build and post the timings for each preset on the board.', createdAt: iso(9), expiresAt: inSec(370) }),
  heldWrite({ id: 'P7', kind: 'reply', noteId: 'N14', text: 'Pull ada/invite-api first, then rerun the fixture.',
    replyTo: { id: 'N14', from: 'bea', text: 'Which token format does T2 use? The share fixture fails on length.' }, createdAt: iso(14.6), expiresAt: inSec(20) }),
  heldWrite({ id: 'P5', kind: 'goal', projectId: '0000000000000000', projectName: 'StarCut', text: 'Another project: never on this board.', createdAt: iso(2), expiresAt: inSec(600) }),
];
async function remotePendingApi(req, m, p) {
  need(!REMOTE_OFF, 503, 'Phone gateway: remote access is off');
  for (let i = remotePending.length - 1; i >= 0; i--) if (Date.parse(remotePending[i].expiresAt) <= Date.now()) remotePending.splice(i, 1);
  if (m === 'GET' && p === '/api/phone/remote/pending') {
    return remotePending.map((w) => ({ ...w, title: `${w.client} wants to ${w.kind} ${w.noteId ?? w.taskId ?? ''}`.trim(), summary: (w.text ?? '').slice(0, 140) }));
  }
  const mm = /^\/api\/phone\/remote\/pending\/([^/]+)\/(send|discard)$/.exec(p);
  need(mm && m === 'POST', 404, `No phone route ${m} ${p}`);
  const i = remotePending.findIndex((w) => w.id.toUpperCase() === decodeURIComponent(mm[1]).toUpperCase());
  need(i >= 0, 404, `Nothing held as ${mm[1]}: it was already sent, discarded or has expired`);
  const w = remotePending[i];
  if (mm[2] === 'discard') { remotePending.splice(i, 1); return { ok: true, id: w.id }; }
  const b = await body(req);
  need(typeof b.digest === 'string' && b.digest, 400, 'Send needs the digest of the card you saw');
  need(b.digest === w.digest, 409, `${w.id} is not what your screen showed; reload and check it again. Nothing was sent.`);
  need(w.id !== 'P9', 409, "acme-app's Captain isn't running (Muster said: captain is not running)");
  const via = { client: w.client, approvedOn: 'desktop', approvedAt: new Date().toISOString() };
  let summary = '';
  if (w.kind === 'goal') {
    state.goal = { text: w.text, at: new Date().toISOString() };
    addFeed('message', 'you', 'captain', w.text, { via });
    summary = 'Goal sent to the Captain';
  } else if (w.kind === 'reply') {
    const n = findNote(w.noteId);
    n.replies.push({ at: new Date().toISOString(), from: 'you', text: w.text });
    addFeed('reply', 'you', undefined, w.text, { noteId: n.id, via });
    summary = `Replied on ${n.id}`;
  } else if (w.kind === 'answer') {
    const n = findNote(w.noteId);
    n.answers = n.ask.map((q, k) => ({ header: q.header, choices: w.answers[k].choices ?? [], ...(w.answers[k].other ? { other: w.answers[k].other } : {}) }));
    const text = n.answers.map((a, k) => `${a.header || `Q${k + 1}`}: ${[...a.choices, ...(a.other ? [a.other] : [])].join(', ')}`).join('\n');
    n.replies.push({ at: new Date().toISOString(), from: 'you', text });
    addFeed('reply', 'you', undefined, text, { noteId: n.id, via });
    n.open = false; n.closedAt = new Date().toISOString();
    summary = `Answered ${n.id}`;
  }
  remotePending.splice(i, 1);
  broadcast();
  return { ok: true, id: w.id, summary };
}

// GET /api/project (T17 contract). MOCK_GH=missing|unauthed simulates a machine without gh.
let ghRemote;
const project = () => ({
  name: config.projectName ?? 'wall-education',
  root: 'F:/Projects/wall-education',
  ...(ghRemote ? { remoteUrl: ghRemote } : {}),
  gh: { installed: process.env.MOCK_GH !== 'missing', authed: !process.env.MOCK_GH, ...(process.env.MOCK_GH ? {} : { user: 'mock-user' }) },
});

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
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete config[k];
      // researchBrowser / intel are partial objects deep-merged over the current ones (contract); null clears a field
      else if ((k === 'researchBrowser' || k === 'intel') && v && typeof v === 'object') {
        const next = { ...(config[k] ?? {}) };
        for (const [kk, vv] of Object.entries(v)) { if (vv === null) delete next[kk]; else next[kk] = vv; }
        config[k] = next;
      } else config[k] = v;
    }
    state.usage.paused = !!paused();
    broadcast();
    return config;
  }
  if (m === 'GET' && p === '/api/project') return project();
  if (m === 'POST' && p === '/api/project/github') {
    const b = await body(req);
    need(b.name && /^[\w.-]+$/.test(b.name), 400, 'Invalid repository name');
    need(project().gh.installed && project().gh.authed, 400, 'gh is not installed or not logged in');
    ghRemote = `https://github.com/mock-user/${b.name}`;
    return { url: ghRemote };
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
  if (m === 'GET' && p === '/api/skills') return SKILLS;
  if (m === 'GET' && p === '/api/project') return { name: config.projectName, root: state.repoRoot, gh: { installed: true, authed: true, user: 'alex' } };
  if (m === 'POST' && p === '/api/project/github') return { url: 'https://github.com/alex/acme-app' };
  if (m === 'GET' && p === '/api/stations') {
    const names = [...config.defaultStations.filter((n) => n !== 'review'), ...Object.keys(stationDefs).filter((n) => !config.defaultStations.includes(n)), 'review'];
    return names.map((name) => ({ name, ...stationDefs[name] ?? { role: 'crew', guideline: '', builtin: false } }));
  }
  if (sm && m === 'PUT') {
    const name = decodeURIComponent(sm[1]); const b = await body(req);
    need(/^[a-z0-9-]{1,32}$/.test(name), 400, 'Station names are lowercase letters, digits and dashes, up to 32');
    need(!(b.guideline && b.guideline.length > 20000), 400, 'Guideline is over 20000 characters');
    const cur = stationDefs[name] ?? { role: 'crew', guideline: '', builtin: false };
    stationDefs[name] = { ...cur, ...(b.role ? { role: b.role } : {}), ...(typeof b.guideline === 'string' ? { guideline: b.guideline } : {}), ...(Array.isArray(b.skills) ? { skills: b.skills } : {}) };
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
    { id: 'wall', name: 'Client Portal', pages: 16, updated: iso(60 * 50) }, { id: 'mayhem', name: 'MayhemDeck', pages: 5, updated: iso(60 * 24 * 6) }] };
  if (m === 'GET' && p === '/api/usage') return { ...state.usage, paused: !!paused() };
  if (p.startsWith('/api/phone/')) return phoneApi(req, m, p);

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
  // ---- research
  if (m === 'GET' && p === '/api/research') return state.research;
  if (m === 'POST' && p === '/api/research/runs') {
    const b = await body(req);
    need(b.actor === 'you', 403, 'Only you can start research');
    need(!paused(), 409, `Paused: 5-hour window at ${state.usage.fiveHour.usedPercentage}%`);
    need(!state.research.runs.some((r) => r.status === 'running'), 409, 'A research run is already running');
    const src = b.sources ?? {};
    need(src.competitors?.length || src.reviews || src.forums?.length || src.ownApp, 400, 'Pick at least one source');
    need(!intel.store.jobs.some((j) => j.status === 'running'), 409, `scout is busy with ${intel.store.jobs.find((j) => j.status === 'running')?.id}`);
    const run = { id: `RR${state.nextIds.run++}`, status: 'running', sources: { competitors: src.competitors ?? [], reviews: !!src.reviews, forums: src.forums ?? [], ownApp: !!src.ownApp }, ...(b.focus ? { focus: b.focus } : {}), depth: b.depth === 'thorough' ? 'thorough' : 'quick', browse: ['profile', 'public', 'opera'].includes(b.browse) ? b.browse : config.researchBrowser?.mode ?? 'profile', agentId: 'scout', startedAt: new Date().toISOString(), ideaIds: [] };
    state.research.runs.push(run);
    let scout = state.agents.find((a) => a.id === 'scout');
    if (!scout) { scout = agent('scout', 'research', 'main', 'starting', undefined, 0); state.agents.push(scout); }
    scout.status = 'working';
    addFeed('event', 'you', undefined, `you started research ${run.id} (${run.depth})`);
    broadcast();
    // scout finds two ideas, then finishes
    const found = [
      { title: 'Read-only share links for parents', summary: 'Parents want to see the wall without an account; teachers paste screenshots into emails instead.', impact: 'medium', effort: 'S', stageId: 'M3', evidence: [{ kind: 'forum', source: 'r/Teachers · 77 upvotes', text: 'How do you show parents the class wall without giving them a login?', count: 3 }] },
      { title: 'Bulk-delete posts after a lesson', summary: 'Cleaning a wall for the next class means deleting posts one by one.', impact: 'low', effort: 'S', stageId: 'M4', evidence: [{ kind: 'review', source: 'Play Store review · Linoit · 2★', text: 'Deleting 30 sticky notes one at a time is painful.', count: 9 }] },
    ];
    found.forEach((f, k) => setTimeout(() => {
      if (run.status !== 'running') return;
      const i = { id: `R${state.nextIds.idea++}`, runId: run.id, status: 'new', thread: [], createdAt: new Date().toISOString(), ...f };
      state.research.ideas.push(i); run.ideaIds.push(i.id);
      broadcast();
    }, 4000 + k * 4000));
    setTimeout(() => {
      if (run.status !== 'running') return;
      run.status = 'done'; run.finishedAt = new Date().toISOString(); run.sourcesRead = 23; run.summary = `${run.sources.competitors.join(', ') || 'No competitors'} · reviews and forum threads`;
      scout.status = 'stopped';
      toastAll('info', `scout found ${run.ideaIds.length} ideas`);
      broadcast();
    }, 12000);
    return run;
  }
  let rr;
  if (m === 'POST' && (rr = /^\/api\/research\/runs\/([^/]+)\/cancel$/.exec(p))) {
    const run = state.research.runs.find((r) => r.id === decodeURIComponent(rr[1]));
    need(run, 404, 'No such run');
    need(run.status === 'running', 409, `${run.id} is not running`);
    run.status = 'cancelled'; run.finishedAt = new Date().toISOString();
    const scout = state.agents.find((a) => a.id === 'scout'); if (scout) scout.status = 'stopped';
    addFeed('event', 'you', undefined, `you cancelled research ${run.id}`);
    broadcast();
    return run;
  }
  if (m === 'POST' && (rr = /^\/api\/research\/ideas\/([^/]+)\/(ask|approve|reject|reopen)$/.exec(p))) {
    const b = await body(req);
    const i = state.research.ideas.find((x) => x.id === decodeURIComponent(rr[1]));
    need(i, 404, 'No such idea');
    const now = new Date().toISOString();
    if (rr[2] === 'ask') {
      need(b.text?.trim(), 400, 'text is required');
      i.thread.push({ at: now, from: 'you', text: b.text.trim() });
      setTimeout(() => {
        i.thread.push({ at: new Date().toISOString(), from: 'captain', text: `It fits ${i.stageId ?? 'the next stage'}: roughly ${i.effort === 'L' ? '8' : i.effort === 'M' ? '5' : '2'} tasks.\n\nNothing else moves if it goes in after the current goal.` });
        i.plan = [`+ Add goal ${i.title} to ${i.stageId ?? 'M4'}`];
        toastAll('info', `Captain answered on ${i.id}`);
        broadcast();
      }, 2500);
    } else if (rr[2] === 'approve') {
      need(i.status === 'new', 409, `${i.id} is ${i.status}`);
      const blocked = intel.gate(i);
      need(!blocked, 409, blocked);
      i.status = 'approved'; i.decidedAt = now;
      intel.approved(i);
      setTimeout(() => {
        const r = state.roadmap; if (!r) return;
        const stage = r.stages.find((x) => x.id === i.stageId) ?? r.stages.find((x) => x.status !== 'done');
        if (!stage) return;
        const g = { id: `G${state.nextIds.goal++}`, stageId: stage.id, title: i.title, description: `From research idea ${i.id}`, status: 'planned' };
        r.goals.push(g); stage.goalIds.push(g.id); i.goalId = g.id; r.updatedAt = new Date().toISOString();
        addFeed('event', 'captain', undefined, `added goal ${g.id} ${g.title} to ${stage.id} ${stage.title}`);
        broadcast();
      }, 3000);
    } else if (rr[2] === 'reject') {
      need(i.status === 'new', 409, `${i.id} is ${i.status}`);
      i.status = 'rejected'; i.decidedAt = now;
    } else {
      need(i.status !== 'new', 409, `${i.id} is already new`);
      i.status = 'new'; delete i.decidedAt;
    }
    broadcast();
    return i;
  }
  // ---- usage alerts
  if (m === 'POST' && p === '/api/usage/weekly-alert') {
    const b = await body(req);
    need(b.actor === 'you', 403, 'Only you can change usage alerts');
    const u = state.usage;
    if (b.action === 'remind_at') {
      const pct = Number(b.percent);
      need(Number.isInteger(pct) && pct >= 1 && pct <= 100, 400, 'percent must be 1–100');
      need(pct > (u.sevenDay?.usedPercentage ?? 0), 400, `Weekly usage is already at ${u.sevenDay?.usedPercentage}%: pick a higher percentage`);
      u.weeklyRemindAt = pct; u.weeklyWarned = false;
    } else if (b.action === 'snooze_week') u.weeklySnoozedUntil = u.sevenDay?.resetsAt ?? new Date(Date.now() + 7 * 86400000).toISOString();
    else if (b.action === 'never') config.weeklyAlerts = false;
    else throw new HttpError(400, 'action must be remind_at, snooze_week or never');
    if (b.noteId) { const n = state.notes.find((x) => x.id === b.noteId); if (n) { n.open = false; n.dismissed = true; n.closedAt = new Date().toISOString(); } }
    broadcast();
    return { usage: u, config };
  }
  if (m === 'GET' && p === '/api/roadmap') return roadmapOut();
  if (m === 'POST' && p === '/api/roadmap/approve') {
    const r = state.roadmap;
    need(r && r.status === 'draft', 409, 'The roadmap is not a draft');
    r.status = 'approved'; r.revision++; r.approvedAt = new Date().toISOString();
    for (const n of state.notes) if (n.id === r.noteId) n.open = false;
    delete r.noteId;
    const first = r.stages.find((s) => s.status !== 'done');
    if (first) { first.status = 'active'; const g = r.goals.find((x) => x.id === first.goalIds[0]); if (g) g.status = 'active'; }
    addFeed('event', 'you', undefined, `you approved the roadmap (revision ${r.revision})`);
    broadcast();
    return roadmapOut();
  }
  if (m === 'POST' && p === '/api/roadmap/reject') {
    const b = await body(req);
    need(b.note, 400, 'note is required');
    need(state.roadmap?.status === 'draft', 409, 'The roadmap is not a draft');
    addFeed('message', 'you', 'captain', `Roadmap sent back: ${b.note}`);
    broadcast();
    return roadmapOut();
  }
  let rmm;
  if (m === 'POST' && (rmm = /^\/api\/roadmap\/stages\/([^/]+)\/criteria\/(\d+)$/.exec(p))) {
    const b = await body(req);
    const s = state.roadmap?.stages.find((x) => x.id === decodeURIComponent(rmm[1]));
    need(s, 404, 'No such stage');
    const c = s.exitCriteria[Number(rmm[2])];
    need(c, 404, 'No such criterion');
    c.done = !!b.done;
    if (c.done) { c.doneAt = new Date().toISOString(); c.by = 'you'; } else { delete c.doneAt; delete c.by; }
    broadcast();
    return roadmapOut();
  }
  if (m === 'POST' && (rmm = /^\/api\/roadmap\/stages\/([^/]+)\/complete$/.exec(p))) {
    const r = state.roadmap;
    const i = r ? r.stages.findIndex((x) => x.id === decodeURIComponent(rmm[1])) : -1;
    need(i >= 0, 404, 'No such stage');
    r.stages[i].status = 'done'; r.stages[i].completedAt = new Date().toISOString();
    if (r.stages[i + 1]) r.stages[i + 1].status = 'active';
    broadcast();
    return roadmapOut();
  }
  if (m === 'POST' && p === '/api/roadmap/status') {
    const b = await body(req);
    const text = String(b.text ?? '').trim();
    need(state.roadmap, 404, 'There is no roadmap yet');
    need(text && text.length <= 400, 400, 'text must be 1..400 characters');
    state.roadmap.statusLine = { text, at: new Date().toISOString(), by: 'captain', ...(b.taskId ? { taskId: String(b.taskId).toUpperCase() } : {}) };
    addFeed('event', 'captain', undefined, `Roadmap: ${text}`);
    broadcast();
    return roadmapOut();
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
    let list = q.get('dismissed') ? state.notes : state.notes.filter((n) => !n.dismissed);
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
  if ((mm = /^\/api\/notes\/([^/]+)\/dismiss$/.exec(p)) && m === 'POST') {
    const b = await body(req);
    need(b.actor === 'you', 403, 'Only you can dismiss notes');
    const n = findNote(decodeURIComponent(mm[1]));
    n.open = false; n.dismissed = true; n.closedAt = new Date().toISOString();
    broadcast();
    return n;
  }
  if ((mm = /^\/api\/notes\/([^/]+)\/answer$/.exec(p)) && m === 'POST') {
    const b = await body(req);
    const n = findNote(decodeURIComponent(mm[1]));
    need(n.ask, 400, `${n.id} is not a question menu`);
    need(n.open, 409, `${n.id} is already closed`);
    need(Array.isArray(b.answers) && b.answers.length === n.ask.length, 400, 'Answer every question');
    n.answers = n.ask.map((q, i) => ({ header: q.header, choices: b.answers[i].choices ?? [], ...(b.answers[i].other ? { other: b.answers[i].other } : {}) }));
    const text = n.answers.map((a, i) => `${a.header || `Q${i + 1}`}: ${a.choices.length ? `${a.choices.join(', ')}${a.other ? ` (note: ${a.other})` : ''}` : a.other}`).join('\n');
    n.replies.push({ at: new Date().toISOString(), from: 'you', text });
    addFeed('reply', 'you', undefined, text, { noteId: n.id });
    n.open = false; n.closedAt = new Date().toISOString();
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
  if ((mm = /^\/api\/feed\/([^/]+)\/react$/.exec(p)) && m === 'POST') {
    const b = await body(req);
    const f = state.feed.find((x) => x.id === decodeURIComponent(mm[1]).toUpperCase());
    need(f, 404, `No crew chat line "${mm[1]}"`);
    const emoji = String(b.emoji ?? '').replace(/\uFE0F/g, '');
    need(['👍', '👀', '✅', '🙌', '❓'].includes(emoji), 400, `Unknown reaction "${b.emoji}"`);
    const by = b.actor ?? 'you';
    f.reactions ??= [];
    const at = f.reactions.findIndex((r) => r.by === by && r.emoji === emoji);
    if (at >= 0) f.reactions.splice(at, 1);
    else f.reactions.push({ emoji, by, at: new Date().toISOString() });
    if (!f.reactions.length) delete f.reactions;
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
    const evm = /^\/api\/tasks\/[^/]+\/evidence\/[^/]+\/([^/]+)$/.exec(url.pathname);
    if (evm && req.headers['x-muster-token'] === TOKEN) {
      const f = EVIDENCE_FILES[decodeURIComponent(evm[1])];
      need(f, 404, 'No such evidence file');
      const data = Buffer.isBuffer(f) ? f : await readFile(f);
      res.writeHead(200, { 'content-type': Buffer.isBuffer(f) ? 'text/plain' : 'image/png' });
      res.end(data);
      return;
    }
    if ((url.pathname.startsWith('/api/intel') || url.pathname === '/api/browser' || url.pathname.startsWith('/api/browser/')) && req.headers['x-muster-token'] === TOKEN) {
      const out = await intel.route(req, req.method, url.pathname);
      if (out?.text !== undefined) { res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' }); res.end(out.text); return; }
      if (out) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out.body ?? null)); return; }
    }
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
