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
  assert.deepEqual(api.calls.slice(1).map(c => c[2].status), ['responding', 'completed']);
  assert.equal(api.calls[1][2].codexThreadId, 'th');
  assert.equal(api.calls[2][2].reply, 'Hi there\n\nDone'); session.close();
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
  assert.deepEqual(apiA.calls[1][2], { status: 'failed', error: 'boom', codexThreadId: 'th' }); a.session.close();
  const b = codex(); const apiB = orchestrator([msg(1)]);
  const q = new CodexBridge({ api: apiB, getSession: () => b.session, file: tmp() }).tick(); await wait();
  b.child.emit('exit'); await q;
  assert.equal(apiB.calls[1][2].status, 'failed'); assert.match(apiB.calls[1][2].error, /connection closed/);
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
