// Usage: node scripts/ws-probe.mjs <agent> [seconds=10] [repoRoot=F:/Muster]
// Attaches to a running agent's /ws/term socket (read-only) and logs count, size and the first bytes of each message.
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { Coalescer } from '../dist/cli/coalesce.js';

const [agent, secs = '10', root = 'F:/Muster'] = process.argv.slice(2);
if (!agent) throw new Error('usage: ws-probe.mjs <agent> [seconds] [repoRoot]');
const { readHumanToken } = await import(pathToFileURL(join(root, 'dist/core/tokens.js')).href);
const info = JSON.parse(readFileSync(join(root, '.muster/server.json'), 'utf8'));
const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws/term/${agent}?token=${encodeURIComponent(readHumanToken(root))}`);
// What `muster attach` writes to stdout: the real Coalescer from a built tree (run `npm run build:server` first).
let coWrites = 0, coBytes = 0, coTorn = 0;
const co = new Coalescer((b) => { coWrites++; coBytes += b.length; if (b.toString('latin1').replace(/\[\?2026l$/, '').endsWith('[2J')) coTorn++; });
let tornClears = 0; // messages that end right after a screen clear, i.e. a half-drawn frame on screen
let n = 0, bytes = 0, first = true;
const t0 = Date.now();
ws.on('message', (d) => {
  const b = Buffer.from(d);
  if (first) { first = false; console.log(`backlog: ${b.length} bytes`); return; }
  n++; bytes += b.length;
  if (b.toString('latin1').trimEnd().endsWith('[2J')) tornClears++;
  co.push(b);
  console.log(`+${Date.now() - t0}ms ${b.length}B ${JSON.stringify(b.toString('utf8').slice(0, 40))}`);
});
setTimeout(() => { co.flush(); console.log(`COALESCED ${coWrites} writes, ${coBytes} bytes, ${coTorn} ending in a bare screen clear`);
  console.log(`messages ending in a bare screen clear: ${tornClears}`);
  console.log(`TOTAL ${n} messages, ${bytes} bytes in ${secs}s`); process.exit(0); }, Number(secs) * 1000);
