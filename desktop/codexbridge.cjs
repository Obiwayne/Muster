// Codex bridge worker: delivers queued Captain messages (orchestrator /api/codex/*) into the panel's own Codex thread,
// reports status as the turn streams, and posts the reply. Message text, replies and tokens are never logged.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const POLL_MS = 2000;
const HEARTBEAT_MS = 10000;
const KEEP_DELIVERIES = 200;

// Mirrors src/core/tokens.ts: the human token lives outside the repo, under a hash of the repo root.
function humanToken(root, env = process.env) {
  const base = env.MUSTER_SECRETS_DIR ? path.resolve(env.MUSTER_SECRETS_DIR)
    : process.platform === 'win32' ? path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'muster')
      : path.join(os.homedir(), '.muster');
  let p = path.resolve(root).replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32') p = p.toLowerCase();
  const key = createHash('sha256').update(p).digest('hex').slice(0, 16);
  try { return fs.readFileSync(path.join(base, key, 'token'), 'utf8').trim() || null; } catch { return null; }
}

class ApiError extends Error { constructor(status) { super(`Muster API returned ${status}`); this.status = status; } }

// The orchestrator calls the bridge needs; tests pass a fake with the same four methods.
function orchestratorApi(root) {
  async function call(method, route, body) {
    const port = JSON.parse(fs.readFileSync(path.join(root, '.muster', 'server.json'), 'utf8')).port;
    const token = humanToken(root);
    if (!token) throw new Error('Muster token not found.');
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { method, signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', 'x-muster-token': token },
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) throw new ApiError(r.status);
    return r.status === 204 ? null : r.json().catch(() => null);
  }
  const id = encodeURIComponent;
  return {
    queue: () => call('GET', '/api/codex/queue?status=queued'),
    claim: (messageId, deliveryKey) => call('POST', `/api/codex/${id(messageId)}/claim`, { deliveryKey }),
    status: (messageId, body) => call('POST', `/api/codex/${id(messageId)}/status`, body),
    heartbeat: () => call('POST', '/api/codex/worker', { alive: true }),
  };
}

function failureText(e) {
  const m = String(e?.message || e);
  if (/not found/i.test(m) && /codex/i.test(m)) return 'Codex CLI not found';
  if (/log ?in|sign(ed)? in|unauthori[sz]ed|auth/i.test(m)) return 'Not signed in to Codex: run codex login';
  return m.slice(0, 500);
}

class CodexBridge {
  // options: root, api, getSession() -> CodexSession, file (delivery journal path), pollMs, heartbeatMs
  constructor(options) {
    this.o = options; this.timers = []; this.running = false; this.stopped = false;
    this.deliveries = {};
    try { this.deliveries = JSON.parse(fs.readFileSync(options.file, 'utf8')); } catch { /* no journal yet */ }
  }
  start() {
    this.stopped = false;
    const beat = () => this.o.api.heartbeat().catch(() => {});
    beat();
    this.timers.push(setInterval(beat, this.o.heartbeatMs || HEARTBEAT_MS), setInterval(() => void this.tick(), this.o.pollMs || POLL_MS));
    void this.tick();
  }
  stop() { this.stopped = true; for (const t of this.timers) clearInterval(t); this.timers = []; }
  save() {
    const keys = Object.keys(this.deliveries);
    for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DELIVERIES))) delete this.deliveries[k];
    try { fs.mkdirSync(path.dirname(this.o.file), { recursive: true }); fs.writeFileSync(this.o.file + '.tmp', JSON.stringify(this.deliveries)); fs.renameSync(this.o.file + '.tmp', this.o.file); }
    catch { /* worst case a crash re-sends one message */ }
  }
  async report(id, body) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await this.o.api.status(id, body); return true; }
      catch (e) { if (e?.status && e.status < 500) return false; await new Promise(r => setTimeout(r, 300 * (attempt + 1))); }
    }
    return false;
  }
  // One message at a time, strictly in createdAt order; never overlaps itself.
  async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const session = this.o.getSession();
      if (session.busy) return; // the panel (or an earlier delivery) owns the thread
      const queue = await this.o.api.queue().catch(() => null);
      const msg = Array.isArray(queue) ? [...queue].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0] : null;
      if (msg) await this.deliver(session, msg);
    } catch { /* project closed or server unreachable; the next poll retries */ } finally { this.running = false; }
  }
  async deliver(session, msg) {
    const known = this.deliveries[msg.deliveryKey];
    if (known?.turnId) { // Codex already accepted this delivery before a crash: never send it twice
      await this.o.api.claim(msg.id, msg.deliveryKey).catch(() => {});
      await this.report(msg.id, { status: 'failed', error: 'Delivery was interrupted after Codex accepted it; not re-sent' });
      return;
    }
    try { await this.o.api.claim(msg.id, msg.deliveryKey); }
    catch { return; } // 409: another worker holds it, or the server is unreachable; try again next poll

    const turns = new Map(); // turnId -> { replies, deltas, done, error }
    const turn = id => { if (!turns.has(id)) turns.set(id, { replies: [], deltas: '', done: false, error: null, responding: false }); return turns.get(id); };
    let chain = Promise.resolve(); // status posts go out one at a time, in order
    const post = body => (chain = chain.then(() => this.report(msg.id, body)));
    let ourTurn = null; let finish; const finished = new Promise(r => { finish = r; });
    const sendResponding = () => {
      const t = turn(ourTurn);
      if (!t.responding) { t.responding = true; void post({ status: 'responding', codexThreadId: session.threadId }); }
    };
    const settle = () => {
      if (!ourTurn) return;
      const t = turns.get(ourTurn);
      if (t?.done) finish();
    };
    const onNotify = m => {
      const p = m.params || {};
      const id = p.turnId || p.turn?.id;
      if (!id) return;
      const t = turn(id);
      if (m.method === 'item/agentMessage/delta') { t.deltas += p.delta || ''; if (id === ourTurn) sendResponding(); }
      else if (m.method === 'item/completed' && p.item?.type === 'agentMessage') t.replies.push(p.item.text || '');
      else if (m.method === 'turn/completed') {
        t.done = true;
        if (p.turn?.error) t.error = p.turn.error.message || 'Codex reported an error';
        else if (p.turn?.status === 'failed') t.error = 'Codex turn failed';
      }
      settle();
    };
    const onState = state => { // process died mid-turn: no turn/completed will ever arrive
      if (ourTurn && !state.busy && !turn(ourTurn).done) { turn(ourTurn).error = state.error || 'Codex connection closed'; turn(ourTurn).done = true; finish(); }
    };
    session.on('notify', onNotify); session.on('state', onState);
    try {
      let turnId;
      try {
        turnId = await session.send(`From Captain (${msg.id}):\n${msg.text}`, msg.context || '');
        if (!turnId) throw new Error('Codex did not start a turn');
      } catch (e) {
        await post({ status: 'failed', error: failureText(e) }); return;
      }
      ourTurn = turnId;
      this.deliveries[msg.deliveryKey] = { turnId, messageId: msg.id }; this.save();
      const t = turn(turnId);
      if (t.deltas || t.replies.length) sendResponding();
      if (t.done) finish(); else if (!session.busy) onState({ busy: false, error: session.error });
      await finished;
      if (t.error) { await post({ status: 'failed', error: failureText(t.error), codexThreadId: session.threadId }); return; }
      sendResponding();
      await post({ status: 'completed', codexThreadId: session.threadId, reply: t.replies.length ? t.replies.join('\n\n') : t.deltas });
    } finally { session.off('notify', onNotify); session.off('state', onState); }
  }
}

module.exports = { CodexBridge, orchestratorApi, humanToken };
