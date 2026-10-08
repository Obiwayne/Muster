// Local Codex App Server transport. The renderer never chooses an executable or working directory.
const { spawn, execFileSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

// The Codex desktop app keeps codex.exe in %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\ without adding it to PATH,
// and the hash changes when Codex updates, so fall back to the newest copy there.
function installedCodex(localAppData = process.env.LOCALAPPDATA) {
  if (!localAppData) return null;
  const bin = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  let dirs; try { dirs = fs.readdirSync(bin); } catch { return null; }
  return dirs.map(d => path.join(bin, d, 'codex.exe')).filter(f => fs.existsSync(f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}

function executable() {
  let lines = [];
  try {
    lines = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which',
      [process.platform === 'win32' ? 'codex.exe' : 'codex'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split(/\r?\n/);
  } catch { /* not on PATH */ }
  const found = lines[0] || (process.platform === 'win32' ? installedCodex() : null);
  if (!found) throw new Error('Codex CLI was not found. Install Codex and sign in with codex login first.');
  return found;
}

class CodexSession extends EventEmitter {
  constructor(root, options = {}) {
    super(); this.root = root; this.options = options; this.pending = new Map();
    this.approvals = new Map(); this.sequence = 0; this.threadId = options.threadId || null; this.turnId = null;
    this.messages = options.messages || []; this.busy = false; this.closed = false;
  }
  snapshot() { return { messages: this.messages, busy: this.busy, threadId: this.threadId,
    approvals: [...this.approvals.values()], error: this.error || null }; }
  changed() { this.emit('state', this.snapshot()); }
  write(message) { this.process.stdin.write(JSON.stringify(message) + '\n'); }
  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex timed out: ${method}`)); }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  receive(message) {
    if (message.method && message.id !== undefined) {
      if (message.method === 'item/tool/call' && this.options.toolCall) {
        if (message.params?.tool === 'muster_message_captain') {
          this.approvals.set(String(message.id), { id: message.id, method: message.method, ...message.params,
            reason: 'Send this message to the Captain: ' + (message.params.arguments?.text || '') }); this.changed();
        } else void this.callTool(message.id, message.params);
      } else if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
        this.approvals.set(String(message.id), { id: message.id, method: message.method, ...message.params }); this.changed();
      } else if (message.method === 'item/permissions/requestApproval') {
        this.write({ id: message.id, result: { permissions: {}, scope: 'turn' } });
      } else if (message.method === 'mcpServer/elicitation/request') {
        this.write({ id: message.id, result: { action: 'decline', content: null } });
      } else {
        this.write({ id: message.id, error: { code: -32601, message: 'This request is not supported by Muster yet.' } });
      }
      return;
    }
    if (message.id !== undefined) {
      const p = this.pending.get(message.id); if (!p) return;
      clearTimeout(p.timer); this.pending.delete(message.id);
      message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result); return;
    }
    const p = message.params || {};
    if (p.threadId && this.threadId && p.threadId !== this.threadId) return;
    this.emit('notify', message);
    if (message.method === 'item/agentMessage/delta') {
      let item = this.messages.find(m => m.id === p.itemId);
      if (!item) { item = { id: p.itemId, role: 'assistant', text: '' }; this.messages.push(item); }
      item.text += p.delta || ''; this.changed();
    } else if (message.method === 'item/completed' && p.item?.type === 'agentMessage') {
      const item = this.messages.find(m => m.id === p.item.id);
      if (item) item.text = p.item.text || item.text;
      else this.messages.push({ id: p.item.id, role: 'assistant', text: p.item.text || '' });
      this.changed();
    } else if (message.method === 'turn/started') { this.turnId = p.turn?.id; this.busy = true; this.changed(); }
    else if (message.method === 'turn/completed') {
      this.busy = false; this.turnId = null; this.approvals.clear();
      if (p.turn?.error) this.error = p.turn.error.message;
      this.changed();
    } else if (message.method === 'serverRequest/resolved') { this.approvals.delete(String(p.requestId)); this.changed(); }
    else if (message.method === 'error') { this.error = p.error?.message || 'Codex reported an error'; this.changed(); }
  }
  async connect() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (key.startsWith('MUSTER_') || key.startsWith('ELECTRON_')) delete env[key];
      this.process = (this.options.spawn || spawn)((this.options.executable || executable)(), ['app-server', '--listen', 'stdio://'],
        { cwd: this.root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const child = this.process;
      const failed = e => { if (this.process === child) { this.process = null; this.fail(e); } };
      child.once('error', failed);
      child.once('exit', () => failed(new Error('Codex connection closed. Send a message to reconnect.')));
      child.stdin.on('error', failed);
      this.process.stderr.on('data', () => {}); // drain; do not expose diagnostics which may contain credentials
      this.lines = createInterface({ input: this.process.stdout });
      this.lines.on('line', line => { try { this.receive(JSON.parse(line)); } catch { /* ignore non-protocol output */ } });
      await this.request('initialize', { clientInfo: { name: 'muster', title: 'Muster', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      this.write({ method: 'initialized', params: {} });
      const params = { cwd: this.root, approvalPolicy: 'on-request', sandbox: 'read-only' };
      const result = await this.request(this.threadId ? 'thread/resume' : 'thread/start',
        this.threadId ? { ...params, threadId: this.threadId } : { ...params, dynamicTools: this.options.tools || [] });
      this.threadId = result.thread.id; this.changed();
    })().catch(e => {
      const child = this.process; this.process = null; child?.kill(); this.lines?.close();
      this.fail(e); throw e;
    });
    return this.ready;
  }
  fail(error) {
    this.ready = null;
    this.error = error.message; this.busy = false; this.approvals.clear();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.changed();
  }
  async send(text, context = '') {
    if (this.busy) throw new Error('Wait for Codex to finish or stop the current response.');
    if (typeof text !== 'string' || !text.trim() || text.length > 32000) throw new Error('Enter a message of up to 32,000 characters.');
    this.busy = true; this.error = null; this.changed();
    try {
      await this.connect();
      this.messages.push({ id: `user-${Date.now()}`, role: 'user', text }); this.changed();
      const result = await this.request('turn/start', { threadId: this.threadId,
        input: [{ type: 'text', text: context ? `${context}\n\nUser request:\n${text}` : text }] });
      if (this.busy) this.turnId = result.turn.id;
      return result.turn.id;
    } catch (e) { this.busy = false; this.error = e.message; this.changed(); throw e; }
  }
  async interrupt() { if (this.threadId && this.turnId) await this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }); }
  async callTool(id, params) {
    const child = this.process;
    let result;
    try { const text = await this.options.toolCall(params.tool, params.arguments);
      result = { success: true, contentItems: [{ type: 'inputText', text }] };
    } catch (e) { result = { success: false, contentItems: [{ type: 'inputText', text: e.message }] }; }
    if (child && this.process === child && !child.stdin.destroyed) {
      try { this.write({ id, result }); } catch (e) { this.fail(e); }
    }
  }
  async approve(id, decision) {
    const p = this.approvals.get(String(id));
    if (!p || !['accept', 'decline'].includes(decision)) throw new Error('This approval is no longer available.');
    this.approvals.delete(String(id)); this.changed();
    if (p.method === 'item/tool/call') {
      if (decision === 'accept') await this.callTool(p.id, p);
      else this.write({ id: p.id, result: { success: false, contentItems: [{ type: 'inputText', text: 'User declined sending the message.' }] } });
    } else this.write({ id: p.id, result: { decision } });
  }
  close() { this.closed = true; const child = this.process; this.process = null; child?.kill(); this.lines?.close(); this.fail(new Error('Codex stopped')); }
}
module.exports = { CodexSession, installedCodex };
