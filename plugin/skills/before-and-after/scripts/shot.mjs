#!/usr/bin/env node
// Muster: one screenshot of a URL (or local file) with headless Chrome or Edge, no npm packages needed.
//   node shot.mjs <url-or-file> <out.png> [--size 1280x800] [--wait 1500]
// --wait gives the page that many ms of virtual time to render (scripts, fonts) before the shot.
// Browser: $MUSTER_CHROME, else agent-browser's Chrome, else installed Chrome, else Edge.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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
const wait = Number(flag('--wait', '1500'));
const [target, outArg] = args;
if (!target || !outArg || !/^\d+x\d+$/.test(size) || !Number.isFinite(wait)) {
  console.error('usage: node shot.mjs <url-or-file> <out.png> [--size 1280x800] [--wait 1500]');
  process.exit(2);
}
const url = /^[a-z]+:\/\//i.test(target) ? target : pathToFileURL(resolve(target)).href;
const out = resolve(outArg);

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

const exe = browsers()[0];
if (!exe) {
  console.error('No Chrome or Edge found. Set MUSTER_CHROME to a browser executable, or run `agent-browser install`.');
  process.exit(1);
}
const [w, h] = size.split('x');
const started = Date.now();
const before = existsSync(out) ? statSync(out).mtimeMs : 0;
const child = spawn(exe, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  `--window-size=${w},${h}`, `--virtual-time-budget=${wait}`, `--screenshot=${out}`, url,
], { stdio: 'ignore', windowsHide: true });
child.on('error', (e) => { console.error(`Could not start ${exe}: ${e.message}`); process.exit(1); });

// Chrome on Windows can return before the file lands; wait for it to appear and stop growing.
const deadline = started + 60_000 + wait;
let last = -1;
const tick = setInterval(() => {
  const ready = existsSync(out) && statSync(out).mtimeMs > before;
  if (ready) {
    const n = statSync(out).size;
    if (n > 0 && n === last) return finish(0, `${out} (${w}x${h}, ${n} bytes) from ${url}`);
    last = n;
  }
  if (Date.now() > deadline) finish(1, `No screenshot after ${Math.round((Date.now() - started) / 1000)} s (${exe}).`);
}, 250);

function finish(code, msg) {
  clearInterval(tick);
  try { child.kill(); } catch { /* gone */ }
  setTimeout(() => {
    (code ? console.error : console.log)(msg);
    process.exit(code);
  }, 300);
}
