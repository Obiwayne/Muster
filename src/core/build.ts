// Stale-code detection: a long-running orchestrator keeps the modules it loaded, so a rebuild needs a restart.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MUSTER_HOME } from './paths.js';

/**
 * Newest modification time (ms) of the server's compiled .js files under dist/, or 0 when there is no build
 * (tests run from src/). dist/ui is left out: the dashboard is read from disk per request, so it never goes stale.
 */
export function buildStamp(home = MUSTER_HOME): number {
  let newest = 0;
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (p !== join(home, 'dist', 'ui')) walk(p);
      } else if (e.name.endsWith('.js')) {
        try {
          newest = Math.max(newest, statSync(p).mtimeMs);
        } catch {
          /* removed mid-build */
        }
      }
    }
  };
  walk(join(home, 'dist'));
  return Math.round(newest);
}

/** True when the build on disk is newer than the one the server started with. */
export function isStale(started: number, current: number): boolean {
  return started > 0 && current > started;
}

export function staleText(started: number, current: number): string {
  const at = (ms: number) => new Date(ms).toLocaleString();
  return `This Muster server is running an older build (from ${at(started)}); a newer one was built at ${at(current)}. Click Update at the top of the Bulletin board to load it (or run \`muster down\` then \`muster up\`). Muster clears this note once it runs the new build.`;
}
