import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../types.js';
import { loadConfig, saveConfig } from './config.js';
import { musterPaths } from './paths.js';

let dir: string;
const paths = () => musterPaths(dir);
function setup(config?: unknown) {
  dir = mkdtempSync(join(tmpdir(), 'muster-config-'));
  mkdirSync(join(dir, '.muster'), { recursive: true });
  if (config !== undefined) writeFileSync(paths().config, JSON.stringify(config));
}
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('nested config (researchBrowser, intel)', () => {
  it('defaults when absent', () => {
    setup();
    const c = loadConfig(paths());
    expect(c.researchBrowser).toEqual(DEFAULT_CONFIG.researchBrowser);
    expect(c.intel).toEqual(DEFAULT_CONFIG.intel);
  });

  it('a partial object is laid over the defaults', () => {
    setup({ researchBrowser: { mode: 'public' }, intel: { checkMaxAgeDays: 7 } });
    const c = loadConfig(paths());
    expect(c.researchBrowser).toEqual({ ...DEFAULT_CONFIG.researchBrowser, mode: 'public' });
    expect(c.intel).toEqual({ recheck: 'weekly', checkMaxAgeDays: 7 });
  });

  it('saving a partial patch keeps the other fields; null unsets one', () => {
    setup({ intel: { checkMaxAgeDays: 7, companiesHouseKey: 'k' } });
    let c = saveConfig(paths(), { intel: { recheck: 'monthly' } as never });
    expect(c.intel).toEqual({ recheck: 'monthly', checkMaxAgeDays: 7, companiesHouseKey: 'k' });
    c = saveConfig(paths(), { intel: { companiesHouseKey: null } as never, researchBrowser: { operaAllow: ['reddit.com'] } as never });
    expect(c.intel.companiesHouseKey).toBeUndefined();
    expect(c.researchBrowser.operaAllow).toEqual(['reddit.com']);
    expect(c.researchBrowser.maxPagesPerJob).toBe(150);
    expect(JSON.parse(readFileSync(paths().config, 'utf8')).researchBrowser).toEqual({ operaAllow: ['reddit.com'] });
  });
});
