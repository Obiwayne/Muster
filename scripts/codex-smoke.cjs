// Manual integration check: one short inference turn, no commands or file edits.
const { CodexSession } = require('../desktop/codex.cjs');
const session = new CodexSession(process.cwd());
const timer = setTimeout(() => { session.close(); process.exitCode = 1; console.error('Codex smoke check timed out'); }, 90000);
(async () => {
  try {
    await session.connect();
    console.log('Codex App Server handshake and conversation creation passed.');
    await session.request('account/read', { refreshToken: false });
    const completed = new Promise((resolve, reject) => session.on('state', state => {
      if (state.error) reject(new Error(state.error));
      else if (!state.busy && state.messages.some(m => m.role === 'assistant')) resolve();
    }));
    await session.send('Reply with exactly: Muster connection works. Do not use tools or run commands.');
    await completed;
    if (!session.messages.some(m => m.role === 'assistant' && m.text.includes('Muster connection works'))) throw new Error('Unexpected reply');
    console.log('Real streamed response passed.');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
  finally { clearTimeout(timer); session.removeAllListeners('state'); session.close(); }
})();
