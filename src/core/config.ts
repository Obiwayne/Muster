import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { DEFAULT_CONFIG, type MusterConfig } from '../types.js';
import type { MusterPaths } from './paths.js';
import { readUserName, writeUserName } from './user.js';

function readPartial(p: MusterPaths): Partial<MusterConfig> {
  if (!existsSync(p.config)) return {};
  try {
    return JSON.parse(readFileSync(p.config, 'utf8')) as Partial<MusterConfig>;
  } catch {
    return {};
  }
}

export function loadConfig(p: MusterPaths): MusterConfig {
  return { ...DEFAULT_CONFIG, projectName: basename(p.root), ...readPartial(p), userName: readUserName() };
}

export type ConfigPatch = { [K in keyof MusterConfig]?: MusterConfig[K] | null };

/** Merges `patch` into config.json (which stays partial) and returns the full config. A null value unsets the key. */
export function saveConfig(p: MusterPaths, patch: ConfigPatch): MusterConfig {
  if ('userName' in patch) {
    const { userName, ...rest } = patch;
    writeUserName(userName);
    patch = rest;
  }
  const next: Record<string, unknown> = { ...readPartial(p), ...patch };
  delete next.userName;
  for (const [k, v] of Object.entries(next)) if (v === null) delete next[k];
  writeFileSync(p.config, JSON.stringify(next, null, 2) + '\n');
  return loadConfig(p);
}
