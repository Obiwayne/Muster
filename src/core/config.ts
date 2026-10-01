import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { DEFAULT_CONFIG, type MusterConfig } from '../types.js';
import { defaultLineName, getLine } from './lines.js';
import type { MusterPaths } from './paths.js';
import { readUserName, writeUserName } from './user.js';

export function readPartial(p: MusterPaths): Partial<MusterConfig> {
  if (!existsSync(p.config)) return {};
  try {
    return JSON.parse(readFileSync(p.config, 'utf8')) as Partial<MusterConfig>;
  } catch {
    return {};
  }
}

export function loadConfig(p: MusterPaths): MusterConfig {
  const partial = readPartial(p);
  const config = { ...DEFAULT_CONFIG, projectName: basename(p.root), ...partial, userName: readUserName() };
  // Migration: a config.json from before lines kept its stations in defaultStations; they become the default line's edit.
  if (Array.isArray(partial.defaultStations) && partial.defaultLine === undefined && partial.lines === undefined) {
    const stations = partial.defaultStations.filter((s) => s !== 'review');
    if (stations.length) config.lines = { [config.defaultLine]: { label: getLine(undefined, config.defaultLine)?.label ?? config.defaultLine, stations } };
  }
  config.defaultLine = defaultLineName(config);
  // defaultStations is an alias for the default line's stations + review.
  config.defaultStations = getLine(config, config.defaultLine)!.stations;
  return config;
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
