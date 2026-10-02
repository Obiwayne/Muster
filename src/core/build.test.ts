import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildStamp, isStale, staleText } from './build.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function home(): string {
  const d = mkdtempSync(join(tmpdir(), 'muster-build-'));
  dirs.push(d);
  return d;
}
function file(path: string, secs: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '');
  utimesSync(path, secs, secs);
}

describe('buildStamp', () => {
  it('is 0 without a dist folder', () => {
    expect(buildStamp(home())).toBe(0);
  });

  it('takes the newest server .js file and ignores dist/ui and non-js files', () => {
    const h = home();
    file(join(h, 'dist', 'core', 'a.js'), 1000);
    file(join(h, 'dist', 'orchestrator', 'b.js'), 2000);
    file(join(h, 'dist', 'core', 'a.js.map'), 9000);
    file(join(h, 'dist', 'ui', 'assets', 'index.js'), 9000);
    expect(buildStamp(h)).toBe(2_000_000);
  });
});

describe('isStale', () => {
  it('only when a known start build is older than the current one', () => {
    expect(isStale(1000, 2000)).toBe(true);
    expect(isStale(2000, 2000)).toBe(false);
    expect(isStale(0, 2000)).toBe(false); // no build at start (running from src)
  });

  it('says how to fix it', () => {
    expect(staleText(1000, 2000)).toMatch(/muster down.*muster up/);
  });
});
