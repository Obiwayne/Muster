const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { CodexSession } = require('./codex.cjs');

function fixture(options = {}) {
  const sent = []; const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  child.stdin = new Writable({ write(data, _encoding, done) {
    const message = JSON.parse(data.toString()); sent.push(message);
    if (message.method && message.id !== undefined) queueMicrotask(() => {
      const result = message.method === 'thread/start' || message.method === 'thread/resume'
        ? { thread: { id: 'thread-1' } } : message.method === 'turn/start' ? { turn: { id: 'turn-1' } } : {};
      child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n');
    });
    done();
  } });
  const session = new CodexSession('C:/project', { ...options, spawn: () => child, executable: () => 'codex.exe' });
  return { session, sent, child };
}
test('handshake precedes thread and turn; concurrent send is refused; streaming ends cleanly', async () => {
  const { session, sent } = fixture();
  await session.send('Hello', 'Project context');
  assert.deepEqual(sent.slice(0, 4).map(m => m.method), ['initialize', 'initialized', 'thread/start', 'turn/start']);
  assert.equal(sent[2].params.sandbox, 'read-only');
  assert.equal(sent[2].params.approvalPolicy, 'on-request');
  await assert.rejects(session.send('Again'), /Wait/);
  session.receive({ method: 'item/agentMessage/delta', params: { threadId: 'other', itemId: 'a', delta: 'Wrong' } });
  session.receive({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', itemId: 'a', delta: 'Hello' } });
  session.receive({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', itemId: 'a', delta: ' world' } });
  session.receive({ method: 'turn/completed', params: { threadId: 'thread-1', turn: {} } });
  assert.equal(session.messages[1].text, 'Hello world'); assert.equal(session.busy, false); session.close();
});
test('saved conversation resumes and stop scopes to its current turn', async () => {
  const { session, sent } = fixture({ threadId: 'thread-1' });
  await session.send('Continue'); await session.interrupt();
  assert.equal(sent[2].method, 'thread/resume');
  assert.deepEqual(sent.at(-1).params, { threadId: 'thread-1', turnId: 'turn-1' }); session.close();
});
test('Captain message runs only after approval and a declined message is never sent', async () => {
  let calls = 0;
  const { session, sent } = fixture({ toolCall: async () => { calls++; return 'Sent'; } });
  await session.connect();
  const request = { id: 90, method: 'item/tool/call', params: { tool: 'muster_message_captain', arguments: { text: 'Hello Captain' } } };
  session.receive(request); assert.equal(calls, 0);
  await session.approve(90, 'decline'); assert.equal(calls, 0); assert.equal(sent.at(-1).result.success, false);
  session.receive({ ...request, id: 91 }); await session.approve(91, 'accept'); assert.equal(calls, 1);
  await assert.rejects(session.approve(91, 'accept'), /no longer/); session.close();
});
test('process death rejects outstanding requests and retains conversation identity', async () => {
  const { session, child } = fixture({ threadId: 'thread-1' }); await session.connect();
  child.emit('exit'); assert.equal(session.threadId, 'thread-1'); assert.equal(session.busy, false); assert.equal(session.ready, null);
  session.close();
});

test('completed messages survive missing deltas without duplicating streamed messages', async () => {
  const { session } = fixture(); await session.connect();
  session.receive({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a', text: 'Complete' } } });
  session.receive({ method: 'item/agentMessage/delta', params: { itemId: 'b', delta: 'Part' } });
  session.receive({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'b', text: 'Full response' } } });
  assert.deepEqual(session.messages.map(m => m.text), ['Complete', 'Full response']); session.close();
});

test('a tool finishing after disconnect does not write to a dead connection', async () => {
  let finish;
  const { session, child, sent } = fixture({ toolCall: () => new Promise(resolve => { finish = resolve; }) });
  await session.connect();
  const pending = session.callTool(91, { tool: 'muster_status', arguments: { section: 'status' } });
  child.emit('exit'); const count = sent.length;
  finish('Old result'); await pending; assert.equal(sent.length, count); session.close();
});
