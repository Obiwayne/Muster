#!/usr/bin/env node
// Muster: record a browser demo as a video (for a Media demo GIF, docs/MEDIA.md "Demo GIF").
//   node record.mjs <url-or-file> <out.webm> <actions.mjs> [--size 1280x800] [--hold 1200]
// actions.mjs default-exports `async (page) => { … }`: the demo steps in code (clicks, typing, waits). Use sample
// data only. --hold keeps recording that many ms after the last step so the result stays on screen.
// Browser: $MUSTER_CHROME, else agent-browser's Chrome, else installed Chrome, else Edge (like shot.mjs).
// Playwright comes from Muster's own node_modules, so the project needs nothing installed.
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const size = flag('--size', '1280x800');
const hold = Number(flag('--hold', '1200'));
const [target, outArg, actionsArg] = args;
if (!target || !outArg || !actionsArg || !/^\d+x\d+$/.test(size) || !Number.isFinite(hold)) {
  console.error('usage: node record.mjs <url-or-file> <out.webm> <actions.mjs> [--size 1280x800] [--hold 1200]');
  process.exit(2);
}
const url = /^[a-z]+:\/\//i.test(target) ? target : pathToFileURL(resolve(target)).href;
const out = resolve(outArg);
const [width, height] = size.split('x').map(Number);

function browsers() {
  const list = [];
  if (process.env.MUSTER_CHROME) list.push(process.env.MUSTER_CHROME);
  const ab = join(homedir(), '.agent-browser', 'browsers');
  try {
    for (const d of readdirSync(ab).sort().reverse()) list.push(join(ab, d, 'chrome.exe'), join(ab, d, 'chrome-win64', 'chrome.exe'), join(ab, d, 'chrome'));
  } catch { /* none */ }
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  for (const p of pf) list.push(join(p, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  for (const p of pf) list.push(join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  list.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  return list.filter((p) => existsSync(p));
}

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright-core'));
} catch {
  console.error("playwright-core isn't installed next to Muster. Run `npm install` in Muster's folder.");
  process.exit(1);
}
const exe = browsers()[0];
if (!exe) {
  console.error('No Chrome or Edge found. Set MUSTER_CHROME to a browser executable, or run `agent-browser install`.');
  process.exit(1);
}
const actions = (await import(pathToFileURL(resolve(actionsArg)).href)).default;
if (typeof actions !== 'function') {
  console.error(`${actionsArg} must default-export an async function (page) => { … }`);
  process.exit(2);
}

const videoDir = mkdtempSync(join(tmpdir(), 'muster-record-'));
const browser = await chromium.launch({ executablePath: exe, headless: true });
let code = 0;
try {
  const context = await browser.newContext({ viewport: { width, height }, recordVideo: { dir: videoDir, size: { width, height } } });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'load' });
  try {
    await actions(page);
    await page.waitForTimeout(hold);
  } catch (e) {
    code = 1;
    console.error(`A step failed: ${e instanceof Error ? e.message : e}`);
  }
  const video = page.video();
  await context.close(); // the video is written when its context closes
  const saved = video && (await video.path());
  if (!saved || !existsSync(saved)) throw new Error('no video was written');
  if (!existsSync(dirname(out))) throw new Error(`folder ${dirname(out)} doesn't exist`);
  try {
    renameSync(saved, out);
  } catch {
    copyFileSync(saved, out); // another drive
  }
  console.log(`${out} (${width}x${height}) from ${url}${code ? ' (stopped at the failed step)' : ''}`);
} catch (e) {
  code = 1;
  console.error(`Recording failed: ${e instanceof Error ? e.message : e}`);
} finally {
  await browser.close();
  rmSync(videoDir, { recursive: true, force: true });
}
process.exit(code);
