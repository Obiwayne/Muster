// "Restart to update": is the running Muster older than the code on disk? Same rule as scripts/needs-build.mjs
// (sources newer than dist → build first), plus a build or desktop change newer than what is running → restart.
const fs = require('node:fs');
const path = require('node:path');

const BUILT = ['dist/orchestrator/index.js', 'dist/ui/index.html'];

/** Newest mtime under `dir`, skipping node_modules and dist; 0 when it doesn't exist. */
function newest(dir) {
  let t = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
  }
  return t;
}

/** When dist was built (the older of its two entry files), or 0 when it is missing. */
function builtAt(home) {
  try {
    return Math.min(...BUILT.map((f) => fs.statSync(path.join(home, f)).mtimeMs));
  } catch {
    return 0;
  }
}

/**
 * 'build': the sources changed since the last build (build, then restart).
 * 'restart': a newer build, or newer desktop code, than what is running.
 * 'current': nothing to do.
 * serverStartedAt: when the open project's orchestrator started (ms), or undefined when none is open.
 */
function updateStatus({ home, appStartedAt, serverStartedAt }) {
  const built = builtAt(home);
  if (!built || Math.max(newest(path.join(home, 'src')), newest(path.join(home, 'ui'))) > built) return 'build';
  if (newest(path.join(home, 'desktop')) > appStartedAt) return 'restart';
  if (serverStartedAt !== undefined && built > serverStartedAt) return 'restart';
  return 'current';
}

module.exports = { updateStatus, builtAt, newest };
