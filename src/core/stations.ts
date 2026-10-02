// Station definitions: which role works each station, a Markdown guideline for it, and the skills its
// worker uses. One file per station in <repo>/.muster/stations/<name>.md (.muster is per machine, never committed):
//   ---
//   role: crew
//   skills: code-structure, unslop      (optional; absent = the station's default skills, empty = none)
//   ---
//   <guideline Markdown>
// Station order stays in config.defaultStations; this only says who works a station and how.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATION_ROLE, type MusterConfig, type Role, type SkillInfo, type StationDef, type Task } from '../types.js';
import { badRequest, notFound } from './errors.js';
import { STARTER_GUIDELINES } from './starters.js';
import { PLUGIN_DIR, type MusterPaths } from './paths.js';

export const MAX_GUIDELINE = 20_000;
const ROLES: Role[] = ['captain', 'crew', 'design', 'human'];
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,29}$/;
const SKILL_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REVIEW = 'review';
const NL = String.fromCharCode(10);
const BUILT_IN = Object.keys(STATION_ROLE); // stations that work without a file: starter role + guideline
const SEEDED = [...Object.keys(STARTER_GUIDELINES), REVIEW]; // every station of the built-in lines, plus review

const DEFAULT_GUIDELINE: Record<string, string> = {
  ...STARTER_GUIDELINES,
  review: "Extra checks for the Captain's review. The fixed rules (tests pass, diff matches the task, only the human merges) always apply and can't be relaxed here. Read the diff, run the tests, and check the acceptance criteria before flagging the branch ready for merge.",
};

/** Skills a station uses until its file says otherwise (folder names in plugin/skills). */
export const DEFAULT_SKILLS: Record<string, string[]> = {
  discover: ['web-research'],
  concept: ['web-research'],
  plan: ['code-structure'],
  build: ['code-structure'],
  fix: ['code-structure'],
  reproduce: ['evidence-driven-testing'],
  test: ['evidence-driven-testing'],
  'design-check': ['evidence-driven-testing', 'before-and-after'],
  review: ['unslop'],
};
export const EVIDENCE_SKILL = 'evidence-driven-testing';
export { PLUGIN_DIR };

/** The skills in Muster's plugin, read from each plugin/skills/<name>/SKILL.md frontmatter. */
export function listSkills(pluginDir = PLUGIN_DIR): SkillInfo[] {
  let dirs: string[] = [];
  try {
    dirs = readdirSync(join(pluginDir, 'skills')).filter((d) => SKILL_RE.test(d)).sort();
  } catch {
    return [];
  }
  const out: SkillInfo[] = [];
  for (const name of dirs) {
    let text: string;
    try {
      text = readFileSync(join(pluginDir, 'skills', name, 'SKILL.md'), 'utf8').replace(/\r\n/g, NL);
    } catch {
      continue;
    }
    const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
    // description: one line, or a folded block (">" / "|") of indented lines
    const m = /^description:[ \t]*(.*)$/m.exec(front);
    let description = m?.[1]?.trim() ?? '';
    if (m && /^[>|][-+]?$/.test(description)) {
      const block: string[] = [];
      for (const l of front.slice(m.index + m[0].length + 1).split(NL)) {
        if (!/^\s+\S/.test(l)) break;
        block.push(l.trim());
      }
      description = block.join(' ');
    }
    out.push({ name, description: description.replace(/^["']|["']$/g, '') });
  }
  return out;
}

const dirOf = (p: MusterPaths) => join(p.dir, 'stations');
const fileOf = (p: MusterPaths, name: string) => join(dirOf(p), `${name}.md`);

export function stationName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!NAME_RE.test(name)) throw badRequest('Station names are 1-30 characters: letters, digits and "-"');
  return name;
}

type StationFile = { role?: Role; skills?: string[]; guideline: string };

function parse(text: string): StationFile {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { guideline: text };
  const role = /^role:\s*(\S+)\s*$/m.exec(m[1])?.[1];
  const line = /^skills:[ \t]*(.*?)\s*$/m.exec(m[1]);
  const skills = line ? line[1].split(/[\s,]+/).map((s) => s.toLowerCase()).filter((s) => SKILL_RE.test(s)) : undefined;
  return { role: ROLES.includes(role as Role) ? (role as Role) : undefined, ...(skills ? { skills } : {}), guideline: text.slice(m[0].length) };
}

const serialise = (role: Role, guideline: string, skills?: string[]) =>
  `---${NL}role: ${role}${NL}${skills ? `skills: ${skills.join(', ')}`.trimEnd() + NL : ''}---${NL}${guideline}`;

function read(p: MusterPaths, name: string): StationFile | undefined {
  if (!NAME_RE.test(name)) return undefined;
  try {
    return parse(readFileSync(fileOf(p, name), 'utf8'));
  } catch {
    return undefined;
  }
}

const roleFor = (name: string, file?: { role?: Role }): Role => (name === REVIEW ? 'captain' : (file?.role ?? STATION_ROLE[name] ?? 'crew'));

/** Writes the starter file of every built-in line station (and review) that is missing; existing files are never touched. */
export function seedStations(p: MusterPaths): void {
  mkdirSync(dirOf(p), { recursive: true });
  for (const name of SEEDED) {
    if (!existsSync(fileOf(p, name))) writeFileSync(fileOf(p, name), serialise(STATION_ROLE[name], DEFAULT_GUIDELINE[name].trimEnd() + NL, DEFAULT_SKILLS[name] ?? []));
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
  return {
    name,
    role: roleFor(name, file),
    guideline: file?.guideline ?? DEFAULT_GUIDELINE[name] ?? '',
    skills: file?.skills ?? DEFAULT_SKILLS[name] ?? [],
    builtin: BUILT_IN.includes(name),
  };
}

export function getStation(p: MusterPaths, name: string): StationDef | undefined {
  return NAME_RE.test(name) && (existsSync(fileOf(p, name)) || BUILT_IN.includes(name)) ? describe(p, name) : undefined;
}

/** The guideline text for a station ('' when it has none). */
export const readGuideline = (p: MusterPaths, name: string): string => getStation(p, name)?.guideline ?? '';

/** Creates or updates a station. Omitted fields keep their value (a new station defaults to role crew, empty guideline, no skills). */
export function saveStation(p: MusterPaths, rawName: unknown, patch: { role?: unknown; guideline?: unknown; skills?: unknown }): StationDef {
  const name = stationName(rawName);
  if (patch.role !== undefined && (typeof patch.role !== 'string' || !ROLES.includes(patch.role as Role))) throw badRequest('role must be "captain", "crew", "design" or "human"');
  if (name === REVIEW && patch.role !== undefined && patch.role !== 'captain') throw badRequest('The review station is always worked by the captain');
  if (patch.guideline !== undefined) {
    if (typeof patch.guideline !== 'string') throw badRequest('guideline must be a string');
    if (patch.guideline.length > MAX_GUIDELINE) throw badRequest(`guideline is longer than ${MAX_GUIDELINE} characters`);
  }
  if (patch.skills !== undefined && (!Array.isArray(patch.skills) || patch.skills.some((s) => typeof s !== 'string' || !SKILL_RE.test(s)))) {
    throw badRequest('skills must be a list of skill names (lowercase letters, digits and "-")');
  }
  const current = describe(p, name);
  const role = (patch.role as Role | undefined) ?? current.role;
  const guideline = (patch.guideline as string | undefined) ?? current.guideline;
  const skills = patch.skills !== undefined ? [...new Set(patch.skills as string[])] : current.skills;
  mkdirSync(dirOf(p), { recursive: true });
  writeFileSync(fileOf(p, name), serialise(role, guideline, skills));
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

/** The block handed to an agent working `station`: heading plus guideline (cut at ~8 KB), then its skills. '' when both are empty. */
export function formatGuideline(station: string, guideline: string, skills: string[] = []): string {
  const text = guideline.trim();
  const parts: string[] = [];
  if (text) {
    const body = text.length > MAX_DELIVERED ? `${text.slice(0, MAX_DELIVERED)}
(guideline cut, ${text.length - MAX_DELIVERED} more characters in .muster/stations/${station}.md)` : text;
    parts.push(`## Station: ${station} guidelines
${body}`);
  }
  if (skills.length) {
    parts.push(`## Skills for this station
Load ${skills.map((s) => `\`muster:${s}\``).join(', ')} with the Skill tool before you start, and follow ${skills.length > 1 ? 'them' : 'it'}. Each skill's "In Muster" section wins over the rest of it.`);
  }
  return parts.join(NL + NL);
}

/**
 * The station that must attach evidence: the last one before review that an agent works (a "human" station
 * can't). With none, the Captain attaches it at review.
 */
export function evidenceStation(task: Pick<Task, 'stations'>, roles: Record<string, Role> = {}): string {
  const roleOf = (s: string) => roles[s] ?? STATION_ROLE[s] ?? 'crew';
  return task.stations.filter((s) => s !== REVIEW && roleOf(s) !== 'human').at(-1) ?? REVIEW;
}

/** What the evidence station is told to produce. */
export function evidenceBlock(taskId: string, station: string): string {
  const when = station === REVIEW ? 'Before you call request_review' : 'Before you hand on or report done';
  return `## Evidence (required at ${station})
This is the last working station before review. ${when}, prove ${taskId} does what it should and attach the proof with \`add_evidence(files, summary)\`. Load \`muster:${EVIDENCE_SKILL}\` for how. Save it under \`.muster-evidence/${taskId}/\` in your worktree. Git ignores that folder: never \`git add -f\` it (a branch that commits it can't be handed on):
- UI: a screenshot of every state the task changes, before and after.
- Code: the test command's output, plus measured numbers or before/after command output when they show the change.
- Docs, plans or designs: the document itself, or exported artboards.
Add an \`assertions.md\` with one line per acceptance criterion: passed / failed / untested + reason. The Captain cannot flag ${taskId} ready for merge without evidence.`;
}

/** Everything handed to whoever works the task's current station, read fresh from .muster/stations. */
export function stationBrief(p: MusterPaths, task: Task, roles?: Record<string, Role>): string {
  const station = task.stations[task.stationIndex] ?? REVIEW;
  const def = getStation(p, station);
  const parts = [formatGuideline(station, def?.guideline ?? '', def?.skills ?? [])];
  if (!task.evidence?.length && evidenceStation(task, roles ?? stationRoles(p)) === station) parts.push(evidenceBlock(task.id, station));
  return parts.filter(Boolean).join(NL + NL);
}

/** Read fresh from .muster/stations at delivery time. */
export const guidelineBlock = (p: MusterPaths, station: string): string => {
  const def = getStation(p, station);
  return formatGuideline(station, def?.guideline ?? '', def?.skills ?? []);
};

/** One line saying what a station is for: the first non-heading, non-empty line of its guideline. */
export function stationPurpose(guideline: string): string {
  const line = guideline.split(NL).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  return line && line.length > 140 ? line.slice(0, 137) + '...' : (line ?? '');
}
