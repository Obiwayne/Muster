import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
const home = process.env.MUSTER_CHECK_HOME || process.cwd();
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: 'F:/Muster/node_modules/electron/dist/electron.exe', args: [home, '--open=F:/Muster'], env, timeout: 30000 });
try {
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Open Codex chat', exact: true }).waitFor({timeout:30000});
  await page.getByRole('button', { name: 'Open Codex chat', exact: true }).click();
  const state = await page.evaluate(() => window.musterApp.codexState());
  assert.ok(Array.isArray(state.messages));
  await page.getByRole('textbox', { name: 'Message Codex' }).fill('Reply exactly: Muster desktop connection works. Do not use any tools.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.locator('.codex-message.assistant').filter({hasText:'Muster desktop connection works.'}).last().waitFor({timeout:60000});
  await page.screenshot({path:'../../outputs/Muster-Codex-live.png'});
  console.log('Real Electron IPC, local Codex response and live UI passed.');
} finally { await app.evaluate(({app}) => app.exit(0)).catch(()=>{}); }
