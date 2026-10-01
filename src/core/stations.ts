// Station definitions: which role works each station, plus a Markdown guideline for it. Stored once per
// OS user (not per repo), next to the human tokens, so every project and the desktop app share them:
//   <secretsBase>/stations.json            [{ name, role }] custom roles for built-in and added stations
//   <secretsBase>/stations/<name>.md       the guideline text (absent = no guideline)
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATION_ROLE, type Role, type StationDef } from '../types.js';
import { badRequest } from './errors.js';
import { secretsBase } from './tokens.js';

export const MAX_GUIDELINE = 20_000;
const ROLES: Role[] = ['captain', 'crew', 'design'];
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,29}$/;
/** The review station is the Captain's; it cannot be reassigned or removed. */
const LOCKED = 'review';

const dir = () => secretsBase();
const indexFile = () => join(dir(), 'stations.json');
const guidelineFile = (name: string) => join(dir(), 'stations', `${name}.md`);

interface Index {
  roles: Record<string, Role>;
}

let cache: { key: string; index: Index } | undefined;

function readIndex(): Index {
  const f = indexFile();
  if (!existsSync(f)) return { roles: {} };
  const key = `${f}:${statSync(f).mtimeMs}:${statSync(f).size}`;
  if (cache?.key === key) return cache.index;
  const roles: Record<string, Role> = {};
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    for (const s of Array.isArray(raw?.stations) ? raw.stations : []) {
      if (s && NAME_RE.test(s.name) && ROLES.includes(s.role)) roles[s.name] = s.role;
    }
  } catch {
    /* unreadable file: fall back to the built-ins */
  }
  const index = { roles };
  cache = { key, index };
  return index;
}

function writeIndex(roles: Record<string, Role>): void {
  mkdirSync(dir(), { recursive: true });
  const stations = Object.entries(roles).map(([name, role]) => ({ name, role }));
  writeFileSync(indexFile(), JSON.stringify({ stations }, null, 2) + '\n');
  cache = undefined;
}

export function stationName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!NAME_RE.test(name)) throw badRequest('Station names are 1-30 characters: letters, digits and "-"');
  return name;
}

/** Which role works `station`. Unknown stations are worked by crew. */
export function roleOfStation(station: string): Role {
  if (station === LOCKED) return 'captain';
  return readIndex().roles[station] ?? STATION_ROLE[station] ?? 'crew';
}

export function readGuideline(station: string): string {
  if (!NAME_RE.test(station)) return '';
  try {
    return readFileSync(guidelineFile(station), 'utf8');
  } catch {
    return '';
  }
}

const describe = (name: string, roles: Record<string, Role>): StationDef => ({
  name,
  role: name === LOCKED ? 'captain' : (roles[name] ?? STATION_ROLE[name] ?? 'crew'),
  builtin: name in STATION_ROLE,
  guideline: readGuideline(name),
});

/** Built-in stations first (build, test, design, review), then the ones added on this machine. */
export function listStations(): StationDef[] {
  const { roles } = readIndex();
  const names = [...Object.keys(STATION_ROLE), ...Object.keys(roles).filter((n) => !(n in STATION_ROLE))];
  return names.map((n) => describe(n, roles));
}

export function getStation(name: string): StationDef | undefined {
  return listStations().find((s) => s.name === name);
}

/** Creates or updates a station. Omitted fields keep their value (a new station defaults to role crew, no guideline). */
export function saveStation(rawName: unknown, patch: { role?: unknown; guideline?: unknown }): StationDef {
  const name = stationName(rawName);
  const { roles } = readIndex();
  const next = { ...roles };
  if (patch.role !== undefined) {
    if (typeof patch.role !== 'string' || !ROLES.includes(patch.role as Role)) throw badRequest('role must be "captain", "crew" or "design"');
    if (name === LOCKED && patch.role !== 'captain') throw badRequest('The review station is always worked by the captain');
    next[name] = patch.role as Role;
  } else if (!(name in STATION_ROLE) && !(name in next)) {
    next[name] = 'crew';
  }
  if (patch.guideline !== undefined) {
    if (typeof patch.guideline !== 'string') throw badRequest('guideline must be a string');
    if (patch.guideline.length > MAX_GUIDELINE) throw badRequest(`guideline is longer than ${MAX_GUIDELINE} characters`);
    mkdirSync(join(dir(), 'stations'), { recursive: true });
    if (patch.guideline.trim()) writeFileSync(guidelineFile(name), patch.guideline);
    else rmSync(guidelineFile(name), { force: true });
  }
  writeIndex(next);
  return describe(name, next);
}

/** Removes an added station; a built-in one is reset to its default role and an empty guideline. */
export function deleteStation(rawName: unknown): void {
  const name = stationName(rawName);
  const { roles } = readIndex();
  if (!(name in STATION_ROLE) && !(name in roles)) throw badRequest(`No station "${name}"`);
  const next = { ...roles };
  delete next[name];
  rmSync(guidelineFile(name), { force: true });
  writeIndex(next);
}
