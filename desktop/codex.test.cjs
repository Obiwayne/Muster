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
      if (message.method === 'thread/resume' && options.resumeError) {
        child.stdout.write(JSON.stringify({ id: message.id, error: { code: -32600, message: options.resumeError } }) + '\n'); return;
      }
      const result = message.method === 'account/rateLimits/read' && options.usageResult ? options.usageResult : message.method === 'thread/start' || message.method === 'thread/resume'
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
test('crew-chat posting requires approval and decline sends nothing', async () => {
  const calls = [];
  const { session, sent } = fixture({ toolCall: async (name, args) => { calls.push([name, args]); return 'Posted'; } });
  await session.connect();
  const request = { id: 190, method: 'item/tool/call', params: { tool: 'muster_message_crew', arguments: { text: 'M7 handover' } } };
  session.receive(request);
  assert.equal(calls.length, 0);
  assert.match(session.approvals.get('190').reason, /crew chat \(everyone\): M7 handover/);
  await session.approve(190, 'decline');
  assert.equal(calls.length, 0);
  assert.equal(sent.at(-1).result.success, false);
  session.receive({ ...request, id: 191 });
  await session.approve(191, 'accept');
  assert.deepEqual(calls, [['muster_message_crew', { text: 'M7 handover' }]]);
  await assert.rejects(session.approve(191, 'accept'), /no longer/);
  session.close();
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

test('finds the newest codex.exe in the Codex app folder when it is not on PATH', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { installedCodex } = require('./codex.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-find-'));
  try {
    assert.equal(installedCodex(root), null);
    const bin = path.join(root, 'OpenAI', 'Codex', 'bin');
    for (const [dir, age] of [['old', 2000], ['new', 0]]) {
      fs.mkdirSync(path.join(bin, dir), { recursive: true });
      const exe = path.join(bin, dir, 'codex.exe'); fs.writeFileSync(exe, '');
      const t = new Date(Date.now() - age * 1000); fs.utimesSync(exe, t, t);
    }
    fs.mkdirSync(path.join(bin, 'empty'));
    assert.equal(installedCodex(root), path.join(bin, 'new', 'codex.exe'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

 test('usage refresh reads the Codex bucket, deduplicates requests, and preserves chat state', async () => {
  const limits = { limitId: 'codex', primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: { usedPercent: 16, windowDurationMins: 10080, resetsAt: 2000000000 } };
  const { session, sent } = fixture({ usageResult: { rateLimits: { limitId: 'other' }, rateLimitsByLimitId: { codex: limits } } });
  await Promise.all([session.refreshUsage(), session.refreshUsage()]);
  assert.equal(sent.filter(m => m.method === 'account/rateLimits/read').length, 1);
  assert.deepEqual(session.snapshot().rateLimits, limits);
  assert.equal(session.busy, false); assert.equal(session.messages.length, 0);
  session.receive({ method: 'account/rateLimits/updated', params: { rateLimits: { ...limits, primary: { ...limits.primary, usedPercent: 40 } } } });
  assert.equal(session.snapshot().rateLimits.primary.usedPercent, 40);
  session.receive({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'other', primary: { usedPercent: 99 } } } });
  assert.equal(session.snapshot().rateLimits.primary.usedPercent, 40);
  session.fail(new Error('Disconnected'));
  assert.equal(session.snapshot().rateLimits, null); session.close();
});
 test('unavailable usage does not set a chat error or stop an active turn', async () => {
  const { session } = fixture(); await session.connect();
  session.busy = true; session.rateLimits = { primary: { usedPercent: 20 } };
  session.request = async () => { throw Error('Usage unsupported'); };
  const state = await session.refreshUsage();
  assert.equal(state.rateLimits, null); assert.equal(state.error, null); assert.equal(state.busy, true); session.close();
});

test('session approval is explicit, reversible, and reset on disconnect and a new session', async () => {
  const { session, sent } = fixture();
  assert.equal(session.snapshot().allowSessionActions, false);
  assert.throws(() => session.setSessionActions('true'), /Invalid/);
  session.setSessionActions(true); await session.send('Run approved work');
  let params = sent.find(m => m.method === 'turn/start').params;
  assert.equal(params.approvalPolicy, 'never'); assert.equal(params.sandboxPolicy.type, 'dangerFullAccess');
  assert.throws(() => session.setSessionActions(false), /Stop/);
  session.receive({ id: 95, method: 'item/commandExecution/requestApproval', params: {} });
  assert.equal(sent.at(-1).result.decision, 'accept'); assert.equal(session.approvals.size, 0);
  session.receive({ method: 'turn/completed', params: { turn: {} } });
  session.setSessionActions(false); await session.send('Review only');
  params = sent.filter(m => m.method === 'turn/start').at(-1).params;
  assert.equal(params.approvalPolicy, 'on-request'); assert.equal(params.sandboxPolicy.type, 'readOnly');
  session.receive({ id: 96, method: 'item/fileChange/requestApproval', params: {} });
  assert.equal(session.approvals.size, 1);
  session.fail(new Error('Disconnected')); assert.equal(session.snapshot().allowSessionActions, false);
  session.close();
  const fresh = fixture({ allowSessionActions: true });
  assert.equal(fresh.session.snapshot().allowSessionActions, false); fresh.session.close();
});

test('direct team messages and board replies require approval and reach the correct tool', async () => {
  const calls = []; const { session, sent } = fixture({ toolCall: async (name, args) => { calls.push({name, args}); return 'Sent'; } });
  await session.connect();
  for (const [id, tool, args] of [[101, 'muster_message_agent', {to:'crew-2', text:'Review please'}], [102, 'muster_reply_note', {note:'N12', text:'Resolved'}]]) {
    session.receive({id, method:'item/tool/call', params:{tool, arguments:args}});
    assert.equal(calls.length, id-101);
    assert.ok(session.snapshot().approvals[0].reason.includes(args.to || args.note));
    await session.approve(id, 'accept'); assert.deepEqual(calls.at(-1), {name:tool, args});
    assert.equal(sent.at(-1).result.success, true);
  }
  session.close();
});
test('usage reads limits without opening a conversation', async () => {
  const { session, sent } = fixture({ threadId: 'gone', usageResult: { rateLimits: { primary: { usedPercent: 12 } } } });
  await session.refreshUsage();
  assert.deepEqual(sent.map(m => m.method), ['initialize', 'initialized', 'account/rateLimits/read']);
  assert.equal(session.rateLimits.primary.usedPercent, 12); assert.equal(session.threadId, 'gone'); session.close();
});
test('a saved conversation Codex never stored starts a new one instead of failing', async () => {
  const { session, sent } = fixture({ threadId: '01a13465-gone', resumeError: 'no rollout found for thread id 01a13465-gone' });
  await session.send('Hello');
  assert.deepEqual(sent.filter(m => m.method?.startsWith('thread/')).map(m => m.method), ['thread/resume', 'thread/start']);
  assert.equal(session.threadId, 'thread-1'); assert.equal(session.error, null); session.close();
});
test('other resume errors still fail the connection', async () => {
  const { session } = fixture({ threadId: 'thread-9', resumeError: 'not signed in' });
  await assert.rejects(session.send('Hello'), /not signed in/); assert.equal(session.ready, null); session.close();
});
test('an account update after the usage read keeps usage and reads it again', async () => {
  const { session, sent } = fixture({ usageResult: { rateLimits: { primary: { usedPercent: 30 } } } });
  await session.refreshUsage();
  session.receive({ method: 'account/updated', params: { authMode: 'chatgpt' } });
  assert.equal(session.rateLimits.primary.usedPercent, 30);
  await session.usageRequest;
  assert.equal(sent.filter(m => m.method === 'account/rateLimits/read').length, 2);
  assert.equal(session.rateLimits.primary.usedPercent, 30); session.close();
});
