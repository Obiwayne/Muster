import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // .muster/worktrees holds crew checkouts of this repo when Muster runs on itself.
    exclude: ['**/node_modules/**', '**/dist/**', '.muster/**'],
    // Git-heavy flows take a few seconds each, longer while a crew is busy on the same machine.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
