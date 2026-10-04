import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const { updateStatus } = createRequire(import.meta.url)('./update.cjs') as {
  updateStatus: (o: { home: string; appStartedAt: number; serverStartedAt?: number }) => 'build' | 'restart' | 'current';
};

let home: string;
const T = 1_700_000_000_000; // ms
const file = (rel: string, at: number) => {
  const p = join(home, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, 'x');
  utimesSync(p, at / 1000, at / 1000);
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'muster-update-'));
  file('src/a.ts', T);
  file('ui/src/b.ts', T);
  file('desktop/main.cjs', T);
  file('dist/orchestrator/index.js', T + 10_000);
  file('dist/ui/index.html', T + 10_000);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('updateStatus', () => {
  it('is current when the running app and server started after the build', () => {
    expect(updateStatus({ home, appStartedAt: T + 20_000, serverStartedAt: T + 20_000 })).toBe('current');
    expect(updateStatus({ home, appStartedAt: T + 20_000 })).toBe('current'); // no project open
  });

  it('asks for a restart when the build is newer than the running server', () => {
    expect(updateStatus({ home, appStartedAt: T + 20_000, serverStartedAt: T + 5_000 })).toBe('restart');
  });

  it('asks for a restart when the desktop code changed after the app started', () => {
    file('desktop/main.cjs', T + 30_000);
    expect(updateStatus({ home, appStartedAt: T + 20_000, serverStartedAt: T + 20_000 })).toBe('restart');
  });

  it('asks for a build when a source file is newer than the build, or dist is missing', () => {
    file('ui/src/b.ts', T + 15_000);
    expect(updateStatus({ home, appStartedAt: T + 20_000, serverStartedAt: T + 20_000 })).toBe('build');
    rmSync(join(home, 'dist'), { recursive: true });
    file('ui/src/b.ts', T);
    expect(updateStatus({ home, appStartedAt: T + 20_000 })).toBe('build');
  });

  it('ignores node_modules', () => {
    file('ui/node_modules/x/index.js', T + 50_000);
    expect(updateStatus({ home, appStartedAt: T + 20_000, serverStartedAt: T + 20_000 })).toBe('current');
  });
});
