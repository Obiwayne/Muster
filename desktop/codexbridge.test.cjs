const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { CodexSession } = require('./codex.cjs');
const { CodexBridge } = require('./codexbridge.cjs');

function codex(options = {}) {
  const sent = []; const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  child.stdin = new Writable({ write(data, _e, done) {
    const m = JSON.parse(data.toString()); sent.push(m);
    if (m.method && m.id !== undefined) queueMicrotask(() => {
      const result = m.method.startsWith('thread/') ? { thread: { id: 'th' } } : m.method === 'turn/start' ? (options.noTurn ? {} : { turn: { id: 'tu1' } }) : {};
      child.stdout.write(JSON.stringify({ id: m.id, result }) + '\n');
    });
    done();
  } });
  const session = new CodexSession('C:/p', { spawn: () => child, executable: () => 'codex.exe' });
  const emit = (method, params) => session.receive({ method, params: { threadId: 'th', ...params } });
  return { session, sent, emit, child };
}
function orchestrator(queue) {
  const calls = []; const api = {
    calls,
    queue: async () => queue.map(m => ({ ...m })),
    claim: async (id, key) => { calls.push(['claim', id, key]); },
    status: async (id, body) => { calls.push(['status', id, body]); },
    heartbeat: async () => {},
  };
  return api;
}
const msg = (n, extra = {}) => ({ id: `CX${n}`, text: `do ${n}`, context: 'ctx', deliveryKey: `k${n}`, createdAt: `2026-01-0${n}`, ...extra });
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-')), 'x.bridge.json');
const wait = () => new Promise(r => setTimeout(r, 20));

test('delivers the oldest message, streams responding, then completed with every agent message', async () => {
  const { session, sent, emit } = codex(); const api = orchestrator([msg(2), msg(1)]);
  const bridge = new CodexBridge({ api, getSession: () => session, file: tmp() });
  const done = bridge.tick(); await wait();
  assert.deepEqual(api.calls[0], ['claim', 'CX1', 'k1']);
  const turn = sent.find(m => m.method === 'turn/start');
  assert.match(turn.params.input[0].text, /From Captain \(CX1\):\ndo 1/); assert.match(turn.params.input[0].text, /^ctx/);
  emit('item/agentMessage/delta', { turnId: 'other', itemId: 'z', delta: 'no' });
  emit('item/agentMessage/delta', { turnId: 'tu1', itemId: 'a', delta: 'Hi' });
  emit('item/completed', { turnId: 'tu1', item: { type: 'agentMessage', id: 'a', text: 'Hi there' } });
  emit('item/completed', { turnId: 'tu1', item: { type: 'agentMessage', id: 'b', text: 'Done' } });
  emit('turn/completed', { turn: { id: 'tu1' } });
  await done;
  assert.deepEqual(api.calls.slice(1).map(c => c[2].status), ['delivered', 'responding', 'completed']);
  assert.equal(api.calls[1][2].codexThreadId, 'th');
  assert.equal(api.calls[3][2].reply, 'Hi there\n\nDone'); session.close();
});

test('waits while the panel is busy and claims nothing', async () => {
  const { session } = codex(); session.busy = true; const api = orchestrator([msg(1)]);
  await new CodexBridge({ api, getSession: () => session, file: tmp() }).tick();
  assert.equal(api.calls.length, 0);
});

test('reports failed when turn/start returns no turn id', async () => {
  const { session } = codex({ noTurn: true }); const api = orchestrator([msg(1)]);
  await new CodexBridge({ api, getSession: () => session, file: tmp() }).tick();
  assert.equal(api.calls[1][2].status, 'failed'); session.close();
});

test('a turn error and a dead connection both report failed', async () => {
  const a = codex(); const apiA = orchestrator([msg(1)]);
  const p = new CodexBridge({ api: apiA, getSession: () => a.session, file: tmp() }).tick(); await wait();
  a.emit('turn/completed', { turn: { id: 'tu1', error: { message: 'boom' } } }); await p;
  assert.deepEqual(apiA.calls.map(c => c[2]?.status), [undefined, 'delivered', 'failed']);
  assert.deepEqual(apiA.calls[2][2], { status: 'failed', error: 'boom', codexThreadId: 'th' }); a.session.close();
  const b = codex(); const apiB = orchestrator([msg(1)]);
  const q = new CodexBridge({ api: apiB, getSession: () => b.session, file: tmp() }).tick(); await wait();
  b.child.emit('exit'); await q;
  assert.equal(apiB.calls.at(-1)[2].status, 'failed'); assert.match(apiB.calls.at(-1)[2].error, /connection closed/);
});

test('a delivery that already has a turn id is never re-sent after a restart', async () => {
  const file = tmp(); fs.writeFileSync(file, JSON.stringify({ k1: { turnId: 'old', messageId: 'CX1' } }));
  const { session, sent } = codex(); const api = orchestrator([msg(1)]);
  await new CodexBridge({ api, getSession: () => session, file }).tick();
  assert.equal(sent.some(m => m.method === 'turn/start'), false);
  assert.equal(api.calls.at(-1)[2].status, 'failed');
});

test('a refused claim sends nothing to Codex', async () => {
  const { session, sent } = codex(); const api = orchestrator([msg(1)]); api.claim = async () => { throw new Error('409'); };
  await new CodexBridge({ api, getSession: () => session, file: tmp() }).tick();
  assert.equal(sent.length, 0);
});

const finishTurn = (emit, turnId, text) => {
  emit('item/completed', { turnId, item: { type: 'agentMessage', id: `m-${turnId}`, text } });
  emit('turn/completed', { turn: { id: turnId } });
};

test('a follow-up message goes to the same Codex thread', async () => {
  const { session, sent, emit } = codex(); const file = tmp();
  const api = orchestrator([msg(1)]);
  const bridge = new CodexBridge({ api, getSession: () => session, file });
  const first = bridge.tick(); await wait(); finishTurn(emit, 'tu1', 'one'); await first;
  const api2 = orchestrator([msg(2)]);
  const bridge2 = new CodexBridge({ api: api2, getSession: () => session, file });
  const second = bridge2.tick(); await wait(); finishTurn(emit, 'tu1', 'two'); await second;
  const turns = sent.filter(m => m.method === 'turn/start');
  assert.equal(turns.length, 2);
  assert.equal(turns[0].params.threadId, 'th'); assert.equal(turns[1].params.threadId, 'th');
  assert.equal(sent.filter(m => m.method === 'thread/start').length, 1);
  assert.equal(api2.calls.at(-1)[2].reply, 'two'); session.close();
});

test('Codex missing or signed out reports failed with a useful error', async () => {
  for (const [message, expected] of [
    ['Codex CLI was not found. Install Codex and sign in with codex login first.', /Codex CLI not found/],
    ['401 Unauthorized', /codex login/],
    ['Codex connection closed. Send a message to reconnect.', /connection closed/]]) {
    const { session } = codex(); session.send = async () => { throw new Error(message); };
    const api = orchestrator([msg(1)]);
    await new CodexBridge({ api, getSession: () => session, file: tmp() }).tick();
    assert.equal(api.calls[1][2].status, 'failed'); assert.match(api.calls[1][2].error, expected);
  }
});

test('a crash after delivery is recovered from the journal without resending', async () => {
  const { session, sent } = codex(); const file = tmp();
  const api = orchestrator([msg(1)]);
  const bridge = new CodexBridge({ api, getSession: () => session, file });
  const p = bridge.tick(); await wait();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).k1, { turnId: 'tu1', messageId: 'CX1' });
  bridge.stop(); session.close(); void p; // the app dies here, before turn/completed
  const again = codex(); const api2 = orchestrator([msg(1)]);
  await new CodexBridge({ api: api2, getSession: () => again.session, file }).tick();
  assert.equal(again.sent.some(m => m.method === 'turn/start'), false);
  assert.equal(sent.filter(m => m.method === 'turn/start').length, 1);
  assert.equal(api2.calls.at(-1)[2].status, 'failed'); assert.match(api2.calls.at(-1)[2].error, /not re-sent/);
});

test('a retry after a failed send delivers exactly once', async () => {
  const { session, sent, emit } = codex(); const file = tmp(); const real = session.send.bind(session);
  let fail = true; session.send = async (...args) => { if (fail) { fail = false; throw new Error('Codex timed out: turn/start'); } return real(...args); };
  const api = orchestrator([msg(1)]);
  const bridge = new CodexBridge({ api, getSession: () => session, file });
  await bridge.tick();
  assert.equal(api.calls[1][2].status, 'failed');
  const p = bridge.tick(); await wait(); finishTurn(emit, 'tu1', 'ok'); await p;
  assert.equal(sent.filter(m => m.method === 'turn/start').length, 1);
  assert.equal(api.calls.at(-1)[2].status, 'completed');
  await bridge.tick(); // the journal now holds the key: a stale queue entry is not sent again
  assert.equal(sent.filter(m => m.method === 'turn/start').length, 1); session.close();
});

test('two projects deliver to their own sessions and journals', async () => {
  const a = codex(); const b = codex();
  const apiA = orchestrator([msg(1, { text: 'for A' })]); const apiB = orchestrator([msg(2, { text: 'for B' })]);
  const pa = new CodexBridge({ api: apiA, getSession: () => a.session, file: tmp() }).tick();
  const pb = new CodexBridge({ api: apiB, getSession: () => b.session, file: tmp() }).tick(); await wait();
  finishTurn(a.emit, 'tu1', 'reply A'); await pa;
  finishTurn(b.emit, 'tu1', 'reply B'); await pb;
  assert.match(a.sent.find(m => m.method === 'turn/start').params.input[0].text, /for A/);
  assert.match(b.sent.find(m => m.method === 'turn/start').params.input[0].text, /for B/);
  assert.equal(apiA.calls.at(-1)[2].reply, 'reply A'); assert.equal(apiB.calls.at(-1)[2].reply, 'reply B');
  assert.equal(apiA.calls.some(c => c[1] === 'CX2'), false); assert.equal(apiB.calls.some(c => c[1] === 'CX1'), false);
  a.session.close(); b.session.close();
});

test('delivers one turn at a time and picks up the next once the panel is idle', async () => {
  const { session, sent, emit } = codex(); const api = orchestrator([msg(1), msg(2)]);
  const bridge = new CodexBridge({ api, getSession: () => session, file: tmp() });
  session.busy = true; await bridge.tick(); assert.equal(api.calls.length, 0);
  session.busy = false;
  const p = bridge.tick(); await wait();
  await bridge.tick(); // overlapping tick while a delivery is in flight does nothing
  assert.equal(sent.filter(m => m.method === 'turn/start').length, 1);
  finishTurn(emit, 'tu1', 'x'); await p; session.close();
});

test('nothing sensitive is logged', async () => {
  const seen = []; const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => seen.push(a.join(' '));
  try {
    const { session, emit } = codex(); const api = orchestrator([msg(1, { text: 'SECRET-TEXT' })]); api.status = async () => { throw new Error('x'); };
    const p = new CodexBridge({ api, getSession: () => session, file: tmp() }).tick(); await wait(); finishTurn(emit, 'tu1', 'SECRET-REPLY'); await p; session.close();
  } finally { Object.assign(console, orig); }
  assert.deepEqual(seen, []);
});

test('delivered is reported when Codex accepts the turn, before any reply text', async () => {
  const { session, emit } = codex(); const api = orchestrator([msg(1)]);
  const p = new CodexBridge({ api, getSession: () => session, file: tmp() }).tick(); await wait();
  assert.deepEqual(api.calls.map(c => c[2]?.status), [undefined, 'delivered']);
  assert.equal(api.calls[1][2].codexThreadId, 'th');
  finishTurn(emit, 'tu1', 'x'); await p; session.close();
});

test('restart replays the recorded outcome of a finished turn instead of reporting interrupted', async () => {
  const file = tmp();
  const { session, emit } = codex(); const api = orchestrator([msg(1)]);
  api.status = async (id, body) => { api.calls.push(['status', id, body]); if (body.status === 'completed') throw Object.assign(new Error('x'), { status: 503 }); };
  const p = new CodexBridge({ api, getSession: () => session, file }).tick(); await wait(); finishTurn(emit, 'tu1', 'final answer'); await p; session.close();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).k1;
  assert.equal(saved.outcome.status, 'completed'); assert.equal(saved.reported, undefined);
  const again = codex(); const api2 = orchestrator([msg(1)]);
  await new CodexBridge({ api: api2, getSession: () => again.session, file }).tick();
  assert.equal(again.sent.some(m => m.method === 'turn/start'), false);
  assert.deepEqual(api2.calls.at(-1)[2], { status: 'completed', codexThreadId: 'th', reply: 'final answer' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).k1.reported, true);
  const api3 = orchestrator([msg(1)]);
  await new CodexBridge({ api: api3, getSession: () => again.session, file }).tick();
  assert.equal(api3.calls.length, 0); // reported once; a stale queue entry is left alone
});

test('a refused status post is kept and retried on the next poll, then given up after the cap', async () => {
  const file = tmp(); fs.writeFileSync(file, JSON.stringify({ k1: { turnId: 'old', messageId: 'CX1', outcome: { status: 'completed', reply: 'r' } } }));
  const { session } = codex(); const api = orchestrator([msg(1)]);
  api.status = async (id, body) => { api.calls.push(['status', id, body]); throw Object.assign(new Error('x'), { status: 409 }); };
  const bridge = new CodexBridge({ api, getSession: () => session, file });
  for (let i = 0; i < 8; i++) await bridge.tick();
  assert.equal(api.calls.filter(c => c[0] === 'status').length, 5);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).k1.outcome.status, 'completed');
});

test('a /ws/events state change triggers a poll, and the socket is reconnected and closed on stop', async () => {
  const { session, sent, emit } = codex(); const api = orchestrator([msg(1)]);
  const sockets = []; api.events = (onEvent, onClose) => { const s = { onEvent, onClose, closed: false }; sockets.push(s); return () => { s.closed = true; }; };
  const bridge = new CodexBridge({ api, getSession: () => session, file: tmp(), pollMs: 1e6, heartbeatMs: 1e6, reconnectMs: 5 });
  bridge.stop = bridge.stop.bind(bridge);
  const origTick = bridge.tick.bind(bridge); let ticks = 0; bridge.tick = () => { ticks++; return origTick(); };
  bridge.start(); await wait();
  const before = ticks; sockets[0].onEvent(); await wait();
  assert.ok(ticks > before); assert.equal(sent.some(m => m.method === 'turn/start'), true); // the first tick already delivered; the event ticked again
  sockets[0].onClose(); await new Promise(r => setTimeout(r, 40));
  assert.equal(sockets.length, 2);
  bridge.stop(); assert.equal(sockets[1].closed, true);
  sockets[1].onClose(); await new Promise(r => setTimeout(r, 40));
  assert.equal(sockets.length, 2); // no reconnect after stop
  emit('turn/completed', { turn: { id: 'tu1' } }); session.close();
});
