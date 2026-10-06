// Factory lines: named station orders. The built-in lines live here; your edits and custom lines are
// config.lines ({ label, stations } with no "review", saved in config.json) merged over them.
// "review" is appended to every line when it is returned. config.defaultStations is an alias for the
// default line's stations + review (see config.ts).
import type { LineDef, MusterConfig } from '../types.js';
import { badRequest } from './errors.js';
import type { MusterPaths } from './paths.js';
import { getStation, stationName } from './stations.js';

type Entry = { label: string; stations: string[] };
type LineConfig = Pick<MusterConfig, 'lines' | 'defaultLine'>;

export const BUILT_IN_LINES: Record<string, Entry> = {
  'new-app': { label: 'New app / big feature', stations: ['discover', 'concept', 'design', 'plan', 'approval'] },
  feature: { label: 'Feature', stations: ['plan', 'build', 'test'] },
  ui: { label: 'UI change', stations: ['design', 'build', 'design-check'] },
  bugfix: { label: 'Bug fix', stations: ['reproduce', 'fix', 'test'] },
};
export const DEFAULT_LINE = 'feature';
const MAX_STATIONS = 12;

const isLocked = (s: string) => s === 'review' || s === 'qa';
/** Every line ends with the locked qa station, then review. */
const withReview = (stations: string[]) => [...stations.filter((s) => !isLocked(s)), 'qa', 'review'];
const valid = (e: unknown): e is Partial<Entry> => Boolean(e) && typeof e === 'object';

function describe(name: string, edit: unknown): LineDef {
  const base = BUILT_IN_LINES[name];
  const e = valid(edit) ? edit : undefined;
  const stations = Array.isArray(e?.stations) && e.stations.length ? e.stations.filter((s): s is string => typeof s === 'string') : (base?.stations ?? []);
  return { name, label: (typeof e?.label === 'string' && e.label.trim()) || base?.label || name, stations: withReview(stations), builtin: Boolean(base) };
}

/** Built-in lines first (in their own order), then custom lines alphabetically; edits merged over the built-ins. */
export function listLines(config: Pick<MusterConfig, 'lines'> | undefined): LineDef[] {
  const edits = config?.lines && typeof config.lines === 'object' ? config.lines : {};
  const names = [...Object.keys(BUILT_IN_LINES), ...Object.keys(edits).filter((n) => !BUILT_IN_LINES[n]).sort()];
  return names.map((n) => describe(n, edits[n]));
}

export const getLine = (config: Pick<MusterConfig, 'lines'> | undefined, name: string): LineDef | undefined => listLines(config).find((l) => l.name === name);

/** The default line's name: config.defaultLine when that line still exists, else "feature". */
export const defaultLineName = (config: Partial<LineConfig> | undefined): string =>
  config?.defaultLine && getLine(config as LineConfig, config.defaultLine) ? config.defaultLine : DEFAULT_LINE;

/** Station names of a line, without review (what task creation takes as `stations`). */
export const lineStations = (config: Pick<MusterConfig, 'lines'> | undefined, name: string): string[] | undefined =>
  getLine(config, name)?.stations.filter((s) => !isLocked(s));

/**
 * Validates a PUT /api/lines/:name body and returns the entry to store in config.lines.
 * Every station must exist (a station file or a built-in one); "review" is implied.
 */
export function lineEntry(p: MusterPaths, config: Pick<MusterConfig, 'lines'>, rawName: unknown, patch: { stations?: unknown; label?: unknown }): { name: string; entry: Entry } {
  const name = stationName(rawName);
  const current = getLine(config, name);
  let stations = current?.stations.filter((s) => !isLocked(s));
  if (patch.stations !== undefined) {
    if (!Array.isArray(patch.stations) || patch.stations.some((s) => typeof s !== 'string')) throw badRequest('stations must be a list of station names');
    stations = [...new Set(patch.stations.map((s: string) => stationName(s)).filter((s) => !isLocked(s)))];
    if (!stations.length) throw badRequest('A line needs at least one station before review');
    if (stations.length > MAX_STATIONS) throw badRequest(`A line has at most ${MAX_STATIONS} stations`);
    const unknown = stations.filter((s) => !getStation(p, s));
    if (unknown.length) throw badRequest(`Unknown station${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  }
  if (!stations) throw badRequest('A new line needs stations');
  let label = current?.label ?? name;
  if (patch.label !== undefined) {
    if (typeof patch.label !== 'string' || !patch.label.trim() || patch.label.length > 60) throw badRequest('label must be 1-60 characters');
    label = patch.label.trim();
  }
  return { name, entry: { label, stations } };
}

/** A line name as used in config.lines and URLs: same rules as station names. */
export const lineNameOrThrow = (raw: unknown): string => stationName(raw);

/** Shape-checks a stored line entry (config.lines value or defaultStations): valid station names, no review. */
export function checkedEntry(p: MusterPaths, raw: unknown, needLabel = true): Entry {
  const e = raw as Partial<Entry> | null;
  if (!e || typeof e !== 'object' || !Array.isArray(e.stations)) throw badRequest('a line needs a stations list');
  const stations = [...new Set(e.stations.map((s) => stationName(s)).filter((s) => !isLocked(s)))];
  if (!stations.length) throw badRequest('A line needs at least one station before review');
  if (stations.length > MAX_STATIONS) throw badRequest(`A line has at most ${MAX_STATIONS} stations`);
  const label = typeof e.label === 'string' && e.label.trim() ? e.label.trim().slice(0, 60) : '';
  if (needLabel && !label) throw badRequest('a line needs a label');
  void p;
  return { label, stations };
}
