// Station definitions: which role works each station, plus a Markdown guideline for it. One file per
// station in <repo>/.muster/stations/<name>.md (.muster is per machine, never committed):
//   ---
//   role: crew
//   ---
//   <guideline Markdown>
// Station order stays in config.defaultStations; this only says who works a station and how.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATION_ROLE, type MusterConfig, type Role, type StationDef } from '../types.js';
import { badRequest, notFound } from './errors.js';
import type { MusterPaths } from './paths.js';

export const MAX_GUIDELINE = 20_000;
const ROLES: Role[] = ['captain', 'crew', 'design'];
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,29}$/;
const REVIEW = 'review';
const BUILT_IN = Object.keys(STATION_ROLE);

const DEFAULT_GUIDELINE: Record<string, string> = {
  build: 'Implement the task as described. Keep the change small and reviewable, run the tests, and commit before handing on.',
  test: 'Verify the build station\'s work: run the tests, add missing tests for the new behaviour, and report anything that fails.',
  design: 'Compare the UI changes against the design framework and report pass or drift for each check.',
  review: "Extra checks for the Captain's review. The fixed rules (tests pass, diff matches the task, only the human merges) always apply and can't be relaxed here. Read the diff, run the tests, and check the acceptance criteria before flagging the branch ready for merge.",
};

const dirOf = (p: MusterPaths) => join(p.dir, 'stations');
const fileOf = (p: MusterPaths, name: string) => join(dirOf(p), `${name}.md`);

export function stationName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!NAME_RE.test(name)) throw badRequest('Station names are 1-30 characters: letters, digits and "-"');
  return name;
}

function parse(text: string): { role?: Role; guideline: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { guideline: text };
  const role = /^role:\s*(\S+)\s*$/m.exec(m[1])?.[1];
  return { role: ROLES.includes(role as Role) ? (role as Role) : undefined, guideline: text.slice(m[0].length) };
}

const serialise = (role: Role, guideline: string) => `---\nrole: ${role}\n---\n${guideline}`;

function read(p: MusterPaths, name: string): { role?: Role; guideline: string } | undefined {
  if (!NAME_RE.test(name)) return undefined;
  try {
    return parse(readFileSync(fileOf(p, name), 'utf8'));
  } catch {
    return undefined;
  }
}

const roleFor = (name: string, file?: { role?: Role }): Role => (name === REVIEW ? 'captain' : (file?.role ?? STATION_ROLE[name] ?? 'crew'));

/** Writes build/test/design/review.md when .muster/stations doesn't exist yet; existing files are never touched. */
export function seedStations(p: MusterPaths): void {
  if (existsSync(dirOf(p))) return;
  mkdirSync(dirOf(p), { recursive: true });
  for (const name of BUILT_IN) {
    if (!existsSync(fileOf(p, name))) writeFileSync(fileOf(p, name), serialise(STATION_ROLE[name], DEFAULT_GUIDELINE[name] + '\n'));
  }
}

/** station → role for every station file, for the pure task functions (anything absent falls back to the built-ins). */
export function stationRoles(p: MusterPaths): Record<string, Role> {
  const roles: Record<string, Role> = {};
  for (const s of listStations(p, undefined)) roles[s.name] = s.role;
  return roles;
}

/** Stations in config.defaultStations order, then the other defined ones alphabetically, with review last. */
export function listStations(p: MusterPaths, config: Pick<MusterConfig, 'defaultStations'> | undefined): StationDef[] {
  let files: string[] = [];
  try {
    files = readdirSync(dirOf(p)).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).filter((n) => NAME_RE.test(n));
  } catch {
    /* no folder yet */
  }
  const ordered = (config?.defaultStations ?? []).filter((n) => NAME_RE.test(n));
  const names = [...new Set([...ordered, ...files.sort(), REVIEW])].filter((n) => files.includes(n) || BUILT_IN.includes(n));
  names.splice(0, names.length, ...names.filter((n) => n !== REVIEW), REVIEW);
  return names.map((n) => describe(p, n));
}

function describe(p: MusterPaths, name: string): StationDef {
  const file = read(p, name);
  return { name, role: roleFor(name, file), guideline: file?.guideline ?? DEFAULT_GUIDELINE[name] ?? '', builtin: BUILT_IN.includes(name) };
}

export function getStation(p: MusterPaths, name: string): StationDef | undefined {
  return NAME_RE.test(name) && (existsSync(fileOf(p, name)) || BUILT_IN.includes(name)) ? describe(p, name) : undefined;
}

/** The guideline text for a station ('' when it has none). */
export const readGuideline = (p: MusterPaths, name: string): string => getStation(p, name)?.guideline ?? '';

/** Creates or updates a station. Omitted fields keep their value (a new station defaults to role crew, empty guideline). */
export function saveStation(p: MusterPaths, rawName: unknown, patch: { role?: unknown; guideline?: unknown }): StationDef {
  const name = stationName(rawName);
  if (patch.role !== undefined && (typeof patch.role !== 'string' || !ROLES.includes(patch.role as Role))) throw badRequest('role must be "captain", "crew" or "design"');
  if (name === REVIEW && patch.role !== undefined && patch.role !== 'captain') throw badRequest('The review station is always worked by the captain');
  if (patch.guideline !== undefined) {
    if (typeof patch.guideline !== 'string') throw badRequest('guideline must be a string');
    if (patch.guideline.length > MAX_GUIDELINE) throw badRequest(`guideline is longer than ${MAX_GUIDELINE} characters`);
  }
  const current = describe(p, name);
  const role = (patch.role as Role | undefined) ?? current.role;
  const guideline = (patch.guideline as string | undefined) ?? current.guideline;
  mkdirSync(dirOf(p), { recursive: true });
  writeFileSync(fileOf(p, name), serialise(role, guideline));
  return describe(p, name);
}

/** Removes a station file. The review station cannot be removed. */
export function deleteStation(p: MusterPaths, rawName: unknown): void {
  const name = stationName(rawName);
  if (name === REVIEW) throw badRequest('The review station cannot be removed');
  if (!existsSync(fileOf(p, name))) throw notFound(`No station "${name}"`);
  rmSync(fileOf(p, name), { force: true });
}

export const MAX_DELIVERED = 8_000;

/** The block handed to an agent working `station`: heading plus guideline, cut at ~8 KB. '' when the guideline is empty. */
export function formatGuideline(station: string, guideline: string): string {
  const text = guideline.trim();
  if (!text) return '';
  const body = text.length > MAX_DELIVERED ? `${text.slice(0, MAX_DELIVERED)}
(guideline cut, ${text.length - MAX_DELIVERED} chars more)` : text;
  return `## Station: ${station} guidelines
${body}`;
}

/** Read fresh from .muster/stations at delivery time. */
export const guidelineBlock = (p: MusterPaths, station: string): string => formatGuideline(station, readGuideline(p, station));

/** One line saying what a station is for: the first non-heading, non-empty line of its guideline. */
export function stationPurpose(guideline: string): string {
  const line = guideline.split(String.fromCharCode(10)).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  return line && line.length > 140 ? line.slice(0, 137) + '...' : (line ?? '');
}
