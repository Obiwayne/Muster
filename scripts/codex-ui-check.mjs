import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const port = 47919;
const server = spawn(process.execPath, ['ui/dev/mock-server.mjs'], { env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: 'ignore' });
let browser;
const timeout = setTimeout(() => { server.kill(); browser?.close(); console.error('UI check timed out'); process.exitCode = 1; }, 60000);
try {
  for (let attempt = 0; attempt < 30; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript(() => {
    let state = { messages: [], busy: false, approvals: [], error: null };
    let listener = () => {};
    window.musterApp = {
      projects: async () => ({ current: '/work/acme-app', projects: [] }),
      updateStatus: async () => 'current',
      onCodexState: fn => { listener = fn; window.codexTestEmit = next => { state = next; fn(next); }; return () => {}; },
      codexState: async () => state,
      codexSend: async text => {
        state = { ...state, messages: [...state.messages, { id: 'u1', role: 'user', text }, { id: 'a1', role: 'assistant', text: 'The invite flow is ready for review.' }] };
        listener(state);
      },
      codexNew: async () => { state = { messages: [], busy: false, approvals: [], error: null }; return state; },
      codexStop: async () => { state.busy = false; listener(state); },
      codexApprove: async (id, decision) => { window.codexTestDecision = { id, decision }; state.approvals = []; listener(state); },
    };
  });
  await page.goto(`http://127.0.0.1:${port}/#/dashboard`);
  await page.getByRole('button', { name: 'Open Codex chat', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Codex chat' });
  await pane.waitFor({ state: 'visible' });
  await page.getByRole('textbox', { name: 'Message Codex' }).fill('Review the invite flow.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('The invite flow is ready for review.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close Codex chat', exact: true }).last().click();
  await page.getByRole('button', { name: 'Open Codex chat', exact: true }).click();
  assert.equal(await pane.getByText('Review the invite flow.', { exact: true }).count(), 1);
  const before = (await pane.boundingBox()).width;
  await page.getByRole('separator', { name: 'Resize Codex chat' }).focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal((await pane.boundingBox()).width, before + 20);
  await page.evaluate(() => window.codexTestEmit({ messages: [{ id: 'a2', role: 'assistant', text: 'I can send this to the Captain.' }], busy: true,
    approvals: [{ id: 90, method: 'item/tool/call', reason: 'Send to Captain: Please review the invite flow.' }], error: null }));
  await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.codexTestDecision), { id: 90, decision: 'accept' });
  await page.evaluate(() => window.codexTestEmit({ messages: [{ id: 'u1', role: 'user', text: 'Review the invite flow and help me coordinate with the Captain.' },
    { id: 'a1', role: 'assistant', text: 'The API is ready for review. Crew-3 is blocked on the invite token format, so that is the next thing to resolve.\n\nI can inspect the sharing screen in Vellum and draft a clear handoff for the Captain.' }], busy: false, approvals: [], error: null }));
  await page.getByText('The API is ready for review.', { exact: false }).waitFor();
  await mkdir('../../outputs', { recursive: true });
  await page.screenshot({ path: '../../outputs/Muster-Codex-panel.png' });
  await page.setViewportSize({ width: 1100, height: 800 });
  assert.ok((await pane.boundingBox()).x >= 0);
  await page.keyboard.press('Escape');
  await pane.waitFor({ state: 'hidden' });
  console.log('UI checks passed: open, send, close/reopen, resize, Captain approval, narrow viewport, Escape.');
} finally {
  clearTimeout(timeout); await browser?.close(); server.kill();
}
