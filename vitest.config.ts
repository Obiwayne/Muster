import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // .muster/worktrees holds crew checkouts of this repo when Muster runs on itself.
    exclude: ['**/node_modules/**', '**/dist/**', '.muster/**'],
    // Git-heavy flows take a few seconds each, longer while a crew is busy on the same machine.
    // Tests were written against numbered crew ids (crew-2, crew-3); agents.test.ts covers names.
    setupFiles: ['./src/core/test-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
