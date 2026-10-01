// Line presets: named station orders ("factory lines"). The built-in presets live in code; edits and
// custom lines are saved per machine in <repo>/.muster/lines.json as { name: { label?, stations } }.
// Station names here never include "review": it is always last, and added when a line is returned.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LineDef, MusterConfig } from '../types.js';
import { badRequest } from './errors.js';
import type { MusterPaths } from './paths.js';
import { getStation, stationName } from './stations.js';

interface Preset {
  label: string;
  stations: string[];
}

export const BUILT_IN_LINES: Record<string, Preset> = {
  standard: { label: 'Standard', stations: ['build'] },
  tested: { label: 'Build + test', stations: ['build', 'test'] },
  designed: { label: 'Design, build, approve', stations: ['design', 'build', 'approve'] },
  planning: { label: 'Plan and approve', stations: ['discover', 'concept', 'plan', 'approve'] },
};
export const DEFAULT_LINE = 'standard';

const MAX_STATIONS = 12;
const fileOf = (p: MusterPaths) => `${p.dir}/lines.json`;

function readSaved(p: MusterPaths): Record<string, Partial<Preset>> {
  try {
    const v = JSON.parse(readFileSync(fileOf(p), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const withReview = (stations: string[]) => [...stations.filter((s) => s !== 'review'), 'review'];

function describe(name: string, saved: Partial<Preset> | undefined): LineDef {
  const base = BUILT_IN_LINES[name];
  const stations = Array.isArray(saved?.stations) && saved.stations.length ? saved.stations : (base?.stations ?? []);
  return { name, label: saved?.label?.trim() || base?.label || name, stations: withReview(stations), builtin: Boolean(base) };
}

/** Built-in presets first (in their own order), then saved custom lines alphabetically. */
export function listLines(p: MusterPaths): LineDef[] {
  const saved = readSaved(p);
  const names = [...Object.keys(BUILT_IN_LINES), ...Object.keys(saved).filter((n) => !BUILT_IN_LINES[n]).sort()];
  return names.map((n) => describe(n, saved[n]));
}

export const getLine = (p: MusterPaths, name: string): LineDef | undefined => listLines(p).find((l) => l.name === name);

export const defaultLineName = (config: Pick<MusterConfig, 'defaultLine'> | undefined): string => config?.defaultLine || DEFAULT_LINE;

/** Creates or updates a line. Stations must exist (a station file or a starter station); "review" is implied. */
export function saveLine(p: MusterPaths, rawName: unknown, patch: { stations?: unknown; label?: unknown }): LineDef {
  const name = stationName(rawName);
  const saved = readSaved(p);
  const current = describe(name, saved[name]);
  let stations = current.stations.filter((s) => s !== 'review');
  if (patch.stations !== undefined) {
    if (!Array.isArray(patch.stations) || patch.stations.some((s) => typeof s !== 'string')) throw badRequest('stations must be a list of station names');
    stations = [...new Set(patch.stations.map((s: string) => stationName(s)).filter((s) => s !== 'review'))];
    if (!stations.length) throw badRequest('A line needs at least one station before review');
    if (stations.length > MAX_STATIONS) throw badRequest(`A line has at most ${MAX_STATIONS} stations`);
    const unknown = stations.filter((s) => !getStation(p, s));
    if (unknown.length) throw badRequest(`Unknown station${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  } else if (!BUILT_IN_LINES[name] && !saved[name]) throw badRequest('A new line needs stations');
  let label = current.label;
  if (patch.label !== undefined) {
    if (typeof patch.label !== 'string' || !patch.label.trim() || patch.label.length > 60) throw badRequest('label must be 1-60 characters');
    label = patch.label.trim();
  }
  saved[name] = { label, stations };
  mkdirSync(dirname(fileOf(p)), { recursive: true });
  writeFileSync(fileOf(p), JSON.stringify(saved, null, 2));
  return describe(name, saved[name]);
}

/** Station names of a line, without review (what task creation takes as `stations`). */
export const lineStations = (p: MusterPaths, name: string): string[] | undefined =>
  getLine(p, name)?.stations.filter((s) => s !== 'review');

