// Exit 0 when dist/ is missing or older than any source file (so Muster.cmd rebuilds), else exit 1.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const newest = (dir) => {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
};
const built = ['dist/orchestrator/index.js', 'dist/ui/index.html'];
if (built.some((f) => !existsSync(f))) process.exit(0);
const builtAt = Math.min(...built.map((f) => statSync(f).mtimeMs));
process.exit(Math.max(newest('src'), newest('ui')) > builtAt ? 0 : 1);
