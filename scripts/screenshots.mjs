// Takes the README screenshots (docs/screenshots/*.png, 1600x1000) from the real dashboard
// served by the mock orchestrator, headlessly, with Electron's offscreen capturePage.
//
//   npm run build:ui && npm run screenshots
//
// No new dependencies: Electron is already a devDependency, the mock server is ui/dev/mock-server.mjs.
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'docs', 'screenshots');
const PORT = Number(process.env.SHOT_PORT) || 47899;
const TOKEN = 'dev-token';
const W = 1600, H = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [join(root, 'ui', 'dev', 'mock-server.mjs')], {
  env: { ...process.env, PORT: String(PORT), MOCK_TOKEN: TOKEN, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'ignore',
});
const stop = () => { try { server.kill(); } catch { /* already gone */ } };

app.disableHardwareAcceleration();
let win;
const js = (code) => win.webContents.executeJavaScript(code);

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return; } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('mock server did not start');
}

async function shot(name, route, prep) {
  await win.loadURL(`http://127.0.0.1:${PORT}/#/${route}`);
  await sleep(1800);
  if (prep) { await js(prep); await sleep(700); }
  const img = await win.webContents.capturePage();
  const size = img.getSize();
  writeFileSync(join(out, `${name}.png`), img.toPNG());
  console.log(`${name}.png ${size.width}x${size.height}`);
}

const click = (selector, text) => `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)})); if (!el) throw new Error('missing ' + ${JSON.stringify(text)}); el.click(); })()`;

async function main() {
  win = new BrowserWindow({
    width: W, height: H, useContentSize: true, show: false, frame: false,
    webPreferences: { preload: join(root, 'scripts', 'screenshots-preload.cjs'), offscreen: true, backgroundThrottling: false },
  });
  mkdirSync(out, { recursive: true });
  await waitForServer();
  await shot('dashboard', 'dashboard');
  await shot('board', 'board?note=N21');
  await shot('chat', 'chat', "(() => { const f = document.querySelector('.feed'); if (f) f.scrollTop = 0; })()");
  await shot('tasks', 'tasks');
  await shot('branches', 'branches');
  // Vellum: blur every file card except the Muster framework file (the other cards are private projects).
  await shot('vellum', 'vellum', `(() => {
    for (const c of document.querySelectorAll('.agent-card')) {
      const t = c.querySelector('.t')?.textContent ?? '';
      if (['Scratchpad', 'Client Portal', 'MayhemDeck'].includes(t)) c.style.filter = 'blur(6px)';
    }
  })()`);
  await shot('settings', 'settings');
  await shot('edit-line', 'settings', `(async () => { ${click('button', 'Edit line')}; await new Promise((r) => setTimeout(r, 900)); ${click('.se-item', 'test')}; })()`);
  await shot('evidence', 'tasks', `(async () => { ${click('.ev-strip', 'more')}; await new Promise((r) => setTimeout(r, 1200)); })()`);
}

// No top-level await on ready: Electron holds 'ready' until an ESM entry point has finished loading.
app.whenReady().then(main).then(() => { stop(); app.quit(); }, (e) => { console.error(e); stop(); app.exit(1); });
