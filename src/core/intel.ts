// Competitive intelligence store (.muster/intel.json): competitors, labelled and sourced findings, intel jobs and
// watches. Everything here is a pure mutation of an IntelStore (plus MusterState where ideas and agents live);
// IntelFile loads and saves it. Verdicts and the intel check live in core/intelcheck.ts.
// See docs/ARCHITECTURE.md § "Competitive intelligence".
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  INTEL_AREAS,
  type BrowseMode,
  type CapabilityCell,
  type CapabilityStatus,
  type IntelArea,
  type IntelCapability,
  type IntelChange,
  type IntelClaim,
  type IntelCompetitor,
  type IntelConfidence,
  type IntelFiling,
  type IntelFinding,
  type IntelInsight,
  type IntelJob,
  type IntelJobKind,
  type IntelLabel,
  type IntelPlan,
  type IntelPositioning,
  type IntelSample,
  type IntelScenario,
  type IntelSiteSource,
  type IntelSocialChannel,
  type IntelSocialInsight,
  type IntelSource,
  type IntelSourceKind,
  type IntelStore,
  type IntelSummary,
  type IntelTheme,
  type IntelWatch,
  type MusterConfig,
  type MusterState,
  type WatchCadence,
} from '../types.js';
import { findAgent, HUMAN, isCaptain, nowIso } from './board.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import type { MusterPaths } from './paths.js';
import { writeAtomic, type StoreOptions } from './store.js';

// ------------------------------------------------------------------ constants

export const US = 'us';
export const MAX_QUOTE = 300;
export const MAX_QUOTES = 6;
export const MAX_SOURCES = 12;
export const THIN_EVIDENCE = 5; // themes with fewer independent sources are "thin evidence", never a finding
const MAX_TEXT = 2000;
const MAX_TITLE = 200;
const COLOUR_SLOTS = 8;
const DAY_MS = 86_400_000;

export const LABELS: IntelLabel[] = ['fact', 'opinion', 'prediction'];
export const CONFIDENCES: IntelConfidence[] = ['high', 'medium', 'low'];
export const CADENCES: WatchCadence[] = ['off', 'daily', 'weekly', 'monthly'];
export const BROWSE_MODES: BrowseMode[] = ['profile', 'public', 'opera'];
export const SOURCE_KINDS: IntelSourceKind[] = [
  'site', 'pricing', 'roadmap', 'changelog', 'help', 'app_store', 'google_play', 'g2', 'capterra', 'reddit', 'forum',
  'linkedin', 'youtube', 'tiktok', 'instagram', 'x', 'facebook', 'companies_house', 'jobs', 'press', 'rss', 'own_app', 'other',
];
const CAP_STATUSES: CapabilityStatus[] = ['yes', 'partial', 'paid', 'none', 'planned', 'missing'];
export const RECORD_KINDS = ['profile', 'capability', 'theme', 'sample', 'social', 'social_insight', 'plan', 'finding', 'scenario', 'filing', 'positioning', 'insight', 'change'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

type IdKind = keyof IntelStore['nextIds'];
const PREFIX: Record<IdKind, string> = { capability: 'F', theme: 'TH', insight: 'IN', plan: 'PL', finding: 'IF', scenario: 'PS', social: 'SO', change: 'IX', check: 'IC', watch: 'W', job: 'IJ' };

// ------------------------------------------------------------------ store

export function emptyIntel(projectName = 'Our app'): IntelStore {
  return {
    version: 1,
    rev: 0,
    competitors: [usCompetitor(projectName)],
    capabilities: [],
    themes: [],
    social: [],
    socialInsights: [],
    plans: [],
    findings: [],
    scenarios: [],
    filings: [],
    insights: [],
    changes: [],
    checks: [],
    watches: [],
    jobs: [],
    captainThread: [],
    nextIds: { capability: 1, theme: 1, insight: 1, plan: 1, finding: 1, scenario: 1, social: 1, change: 1, check: 1, watch: 1, job: 1 },
  };
}

function usCompetitor(name: string): IntelCompetitor {
  return { id: US, name, url: '', isUs: true, colour: 0, sources: [], areas: [], watch: 'off', browse: 'profile', addedAt: nowIso() };
}

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Fills missing lists, puts `us` back, and makes sure no id is handed out twice (nextIds above every stored id). */
export function migrateIntel(raw: Partial<IntelStore>, projectName = 'Our app'): IntelStore {
  const base = emptyIntel(projectName);
  const s: IntelStore = {
    ...base,
    ...raw,
    version: 1,
    rev: Number.isInteger(raw.rev) ? (raw.rev as number) : 0,
    competitors: list(raw.competitors),
    capabilities: list(raw.capabilities),
    themes: list(raw.themes),
    social: list(raw.social),
    socialInsights: list(raw.socialInsights),
    plans: list(raw.plans),
    findings: list(raw.findings),
    scenarios: list(raw.scenarios),
    filings: list(raw.filings),
    insights: list(raw.insights),
    changes: list(raw.changes),
    checks: list(raw.checks),
    watches: list(raw.watches),
    jobs: list(raw.jobs),
    captainThread: list(raw.captainThread),
    nextIds: { ...base.nextIds, ...(raw.nextIds ?? {}) },
  };
  const us = s.competitors.find((c) => c.id === US);
  if (!us) s.competitors.unshift(usCompetitor(projectName));
  else {
    us.isUs = true;
    if (!us.name) us.name = projectName;
  }
  const above = (ids: (string | undefined)[]) => Math.max(0, ...ids.map((id) => Number(String(id ?? '').replace(/\D/g, '')) || 0)) + 1;
  const n = s.nextIds;
  n.capability = Math.max(n.capability, above(s.capabilities.map((x) => x.id)));
  n.theme = Math.max(n.theme, above(s.themes.map((x) => x.id)));
  n.insight = Math.max(n.insight, above(s.insights.map((x) => x.id)));
  n.plan = Math.max(n.plan, above(s.plans.map((x) => x.id)));
  n.finding = Math.max(n.finding, above(s.findings.map((x) => x.id)));
  n.scenario = Math.max(n.scenario, above(s.scenarios.map((x) => x.id)));
  n.social = Math.max(n.social, above(s.socialInsights.map((x) => x.id)));
  n.change = Math.max(n.change, above(s.changes.map((x) => x.id)));
  n.check = Math.max(n.check, above(s.checks.map((x) => x.id)));
  n.watch = Math.max(n.watch, above(s.watches.map((x) => x.id)));
  n.job = Math.max(n.job, above(s.jobs.map((x) => x.id)));
  return s;
}

export function nextIntelId(store: IntelStore, kind: IdKind): string {
  return `${PREFIX[kind]}${store.nextIds[kind]++}`;
}

export const intelFile = (paths: MusterPaths) => join(paths.dir, 'intel.json');
export const shotsDir = (paths: MusterPaths, workId: string) => join(paths.dir, 'intel', 'shots', workId);

/**
 * Owns .muster/intel.json. Callers mutate `store` and call `commit()`: rev + 1, atomic write (same retry-on-lock as
 * state.json), then a 'change' event. A missing file is an empty store; a corrupt one is set aside and logged.
 */
export class IntelFile extends EventEmitter {
  store: IntelStore;
  private log: (msg: string) => void;

  constructor(
    private file: string,
    projectName: string,
    private opts: StoreOptions = {},
  ) {
    super();
    this.log = opts.log ?? ((msg) => console.error(msg));
    this.store = this.load(projectName);
  }

  private load(projectName: string): IntelStore {
    if (!existsSync(this.file)) return emptyIntel(projectName);
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<IntelStore>;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
      return migrateIntel(raw, projectName);
    } catch (e) {
      const aside = `${this.file}.corrupt-${Date.now()}`;
      try {
        renameSync(this.file, aside);
      } catch {
        /* keep going with an empty store */
      }
      this.log(`${this.file} could not be read (${e instanceof Error ? e.message : e}); starting with an empty intel store (old file kept as ${aside})`);
      return emptyIntel(projectName);
    }
  }

  save(): boolean {
    return writeAtomic(this.file, JSON.stringify(this.store, null, 1), this.opts);
  }

  /** rev + 1, save, and notify listeners (even if the save failed: memory is the truth). */
  commit(): void {
    this.store.rev++;
    try {
      this.save();
    } finally {
      this.emit('change', this.store.rev);
    }
  }
}

// ------------------------------------------------------------------ small helpers

/** Today as YYYY-MM-DD in local time. */
export function today(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function isDay(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

function obj(v: unknown, what: string): Record<string, any> {
  if (!isObj(v)) throw badRequest(`${what} must be an object`);
  return v;
}

export function text(v: unknown, what: string, max = MAX_TEXT, required = true): string {
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`${what} is required`);
    return '';
  }
  if (typeof v !== 'string') throw badRequest(`${what} must be text`);
  const t = v.trim();
  if (required && !t) throw badRequest(`${what} is required`);
  if (t.length > max) throw badRequest(`${what} is longer than ${max} characters`);
  return t;
}

const optText = (v: unknown, what: string, max = MAX_TEXT) => text(v, what, max, false) || undefined;

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) throw badRequest(`${what} must be one of ${allowed.join(', ')}`);
  return v as T;
}

function int(v: unknown, what: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw badRequest(`${what} must be a whole number from ${min}${max < Number.MAX_SAFE_INTEGER ? ` to ${max}` : ''}`);
  return v as number;
}

function optInt(v: unknown, what: string, min = 0, max?: number): number | undefined {
  return v === undefined || v === null ? undefined : int(v, what, min, max);
}

function strings(v: unknown, what: string, opts: { min?: number; max?: number; each?: number } = {}): string[] {
  if (v === undefined || v === null) v = [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw badRequest(`${what} must be a list of text`);
  const items = (v as string[]).map((x) => x.trim()).filter(Boolean);
  if (opts.min && items.length < opts.min) throw badRequest(`${what} needs at least ${opts.min} item${opts.min === 1 ? '' : 's'}`);
  if (opts.max !== undefined && items.length > opts.max) throw badRequest(`${what}: at most ${opts.max} items`);
  for (const x of items) if (x.length > (opts.each ?? MAX_TEXT)) throw badRequest(`${what}: "${x.slice(0, 40)}…" is longer than ${opts.each ?? MAX_TEXT} characters`);
  return items;
}

function url(v: unknown, what: string, required: boolean): string | undefined {
  const u = text(v, what, 2000, required);
  if (!u) return undefined;
  if (!/^https?:\/\/\S+$/i.test(u)) throw badRequest(`${what} must be an http(s) link`);
  return u;
}

const day = (v: unknown, what: string, required = false): string | undefined => {
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`${what} is required (YYYY-MM-DD)`);
    return undefined;
  }
  if (!isDay(v)) throw badRequest(`${what} must be a date YYYY-MM-DD`);
  return v;
};

const unit = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw badRequest(`${what} must be a number from 0 to 1`);
  return v;
};

// ------------------------------------------------------------------ claims (the rule)

export function checkSource(raw: unknown, what: string): IntelSource {
  const s = obj(raw, what);
  const kind = oneOf(s.kind, SOURCE_KINDS, `${what}.kind`);
  const src: IntelSource = { kind, title: text(s.title, `${what}.title`, MAX_TITLE), seenAt: day(s.seenAt, `${what}.seenAt`) ?? today() };
  const u = url(s.url, `${what}.url`, kind !== 'own_app');
  if (u) src.url = u;
  const pub = day(s.publishedAt, `${what}.publishedAt`);
  if (pub) src.publishedAt = pub;
  if (s.via !== undefined && s.via !== null) src.via = oneOf(s.via, BROWSE_MODES, `${what}.via`);
  return src;
}

export function checkSources(raw: unknown, what: string): IntelSource[] {
  if (!Array.isArray(raw) || raw.length < 1) throw badRequest(`${what}.sources: at least one source is required`);
  if (raw.length > MAX_SOURCES) throw badRequest(`${what}.sources: at most ${MAX_SOURCES}`);
  return raw.map((s, i) => checkSource(s, `${what}.sources[${i}]`));
}

export interface ClaimRules {
  implication?: boolean; // required "what it means for us"
  label?: IntelLabel; // forced label: absent → this one; a different one → 400
}

/**
 * The rule for every significant conclusion: label, confidence, 1–12 sources (url unless own_app, dates valid,
 * seenAt filled with today), asOf, implication where required; a prediction needs signals, timeframe and what
 * would change it. 400 names the field.
 */
export function checkClaim(raw: unknown, what: string, rules: ClaimRules = {}): IntelClaim {
  const c = obj(raw, what);
  let label: IntelLabel;
  if (rules.label) {
    if (c.label !== undefined && c.label !== null && c.label !== rules.label) throw badRequest(`${what}.label must be "${rules.label}" here`);
    label = rules.label;
  } else label = oneOf(c.label, LABELS, `${what}.label`);
  const claim: IntelClaim = {
    label,
    confidence: oneOf(c.confidence, CONFIDENCES, `${what}.confidence`),
    sources: checkSources(c.sources, what),
    asOf: day(c.asOf, `${what}.asOf`) ?? today(),
  };
  const implication = text(c.implication, `${what}.implication`, MAX_TEXT, !!rules.implication);
  if (implication) claim.implication = implication;
  if (label === 'prediction') {
    const p = c.prediction;
    if (!isObj(p)) throw badRequest(`${what}.prediction is required for a prediction: { signals, timeframe, wouldChange }`);
    claim.prediction = {
      signals: strings(p.signals, `${what}.prediction.signals`, { min: 1, max: 12, each: 500 }),
      timeframe: text(p.timeframe, `${what}.prediction.timeframe`, MAX_TITLE),
      wouldChange: text(p.wouldChange, `${what}.prediction.wouldChange`, 1000),
    };
  } else if (c.prediction !== undefined && c.prediction !== null) throw badRequest(`${what}.prediction is only for label "prediction"`);
  return claim;
}

// ------------------------------------------------------------------ competitors

export const tracked = (store: IntelStore) => store.competitors.filter((c) => !c.isUs && !c.removed);
export const trackedIds = (store: IntelStore) => tracked(store).map((c) => c.id);

export function requireCompetitor(store: IntelStore, id: unknown, what = 'competitorId'): IntelCompetitor {
  if (typeof id !== 'string' || !id.trim()) throw badRequest(`${what} is required`);
  const c = store.competitors.find((x) => x.id === id.trim().toLowerCase());
  if (!c) throw badRequest(`${what}: no competitor "${id}" (tracked: ${store.competitors.filter((x) => !x.removed).map((x) => x.id).join(', ')})`);
  return c;
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/^-|-$/g, '');

const normUrl = (u: string) => u.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');

/** The lowest colour slot no live competitor uses (us keeps 0); when all are taken, round-robin. */
function freeColour(store: IntelStore): number {
  const used = new Set(store.competitors.filter((c) => !c.removed).map((c) => c.colour));
  for (let i = 1; i < COLOUR_SLOTS; i++) if (!used.has(i)) return i;
  return store.competitors.length % COLOUR_SLOTS;
}

function siteSources(v: unknown): IntelSiteSource[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw badRequest('sources must be a list of { kind, url, label?, note? }');
  if (v.length > 40) throw badRequest('sources: at most 40');
  return v.map((s, i) => {
    const o = obj(s, `sources[${i}]`);
    const out: IntelSiteSource = { kind: oneOf(o.kind, SOURCE_KINDS, `sources[${i}].kind`), url: url(o.url, `sources[${i}].url`, true)! };
    const label = optText(o.label, `sources[${i}].label`, MAX_TITLE);
    const note = optText(o.note, `sources[${i}].note`, MAX_TITLE);
    if (label) out.label = label;
    if (note) out.note = note;
    return out;
  });
}

function areas(v: unknown, what = 'areas'): IntelArea[] {
  if (v === undefined || v === null) return [...INTEL_AREAS];
  if (!Array.isArray(v)) throw badRequest(`${what} must be a list of ${INTEL_AREAS.join(', ')}`);
  const out = [...new Set(v.map((a, i) => oneOf(a, INTEL_AREAS, `${what}[${i}]`)))];
  return out.length ? out : [...INTEL_AREAS];
}

function identity(v: unknown): IntelCompetitor['identity'] | undefined {
  if (v === undefined || v === null) return undefined;
  const o = obj(v, 'identity');
  const out: NonNullable<IntelCompetitor['identity']> = {};
  const legal = optText(o.legalName, 'identity.legalName', MAX_TITLE);
  const from = optText(o.matchedFrom, 'identity.matchedFrom', MAX_TITLE);
  if (legal) out.legalName = legal;
  if (from) out.matchedFrom = from;
  if (o.companiesHouse !== undefined && o.companiesHouse !== null) {
    const ch = obj(o.companiesHouse, 'identity.companiesHouse');
    out.companiesHouse = {
      number: text(ch.number, 'identity.companiesHouse.number', 20),
      status: text(ch.status, 'identity.companiesHouse.status', 100),
      url: url(ch.url, 'identity.companiesHouse.url', true)!,
      ...(optText(ch.incorporated, 'identity.companiesHouse.incorporated', 40) ? { incorporated: ch.incorporated.trim() } : {}),
      ...(optText(ch.registeredOffice, 'identity.companiesHouse.registeredOffice', 300) ? { registeredOffice: ch.registeredOffice.trim() } : {}),
    };
  }
  return out;
}

const requireHuman = (actor: string, what: string) => {
  if (actor !== HUMAN) throw forbidden(`Only you can ${what}`);
};
const requireYouOrCaptain = (state: MusterState, actor: string, what: string) => {
  if (actor !== HUMAN && !isCaptain(state, actor)) throw forbidden(`Only you or the Captain can ${what}`);
};
export const isResearcher = (state: MusterState, actor: string) => findAgent(state, actor)?.role === 'research';
export function requireResearcher(state: MusterState, actor: string, what: string): void {
  if (!isResearcher(state, actor)) throw forbidden(`Only the research agent can ${what}`);
}

export interface CompetitorInput {
  id?: unknown;
  name: unknown;
  url: unknown;
  tagline?: unknown;
  identity?: unknown;
  sources?: unknown;
  areas?: unknown;
  watch?: unknown;
  browse?: unknown;
}

/** POST /api/intel/competitors: you only. 409 on a duplicate id or url; a removed competitor with the same id comes back. */
export function addCompetitor(store: IntelStore, actor: string, input: CompetitorInput, config: Pick<MusterConfig, 'researchBrowser'>): IntelCompetitor {
  requireHuman(actor, 'add competitors');
  const name = text(input?.name, 'name', 120);
  const home = url(input?.url, 'url', true)!;
  const id = input?.id === undefined || input.id === null || input.id === '' ? slug(name) : slug(text(input.id, 'id', 40));
  if (!id) throw badRequest('id must contain letters or digits');
  if (id === US) throw badRequest('"us" is reserved for your own app');
  const existing = store.competitors.find((c) => c.id === id);
  if (existing && !existing.removed) throw conflict(`"${id}" is already tracked (${existing.name})`);
  const sameUrl = store.competitors.find((c) => !c.removed && c.url && normUrl(c.url) === normUrl(home) && c.id !== id);
  if (sameUrl) throw conflict(`${home} is already tracked as "${sameUrl.id}"`);
  const c: IntelCompetitor = {
    id,
    name,
    url: home,
    colour: existing?.colour ?? freeColour(store),
    sources: siteSources(input?.sources),
    areas: areas(input?.areas),
    watch: input?.watch === undefined || input.watch === null ? 'off' : oneOf(input.watch, CADENCES, 'watch'),
    browse: input?.browse === undefined || input.browse === null ? config.researchBrowser.mode : oneOf(input.browse, BROWSE_MODES, 'browse'),
    addedAt: nowIso(),
  };
  const tagline = optText(input?.tagline, 'tagline', 300);
  if (tagline) c.tagline = tagline;
  const ident = identity(input?.identity);
  if (ident) c.identity = ident;
  if (existing) Object.assign(existing, c, { removed: undefined, lastSweptAt: existing.lastSweptAt });
  else store.competitors.push(c);
  const result = existing ?? c;
  if (existing) delete existing.removed;
  planCompetitorWatch(store, result);
  return result;
}

/** PATCH /api/intel/competitors/:id: you only. A watch change re-plans its watch. `us` takes name/url/sources/identity. */
export function patchCompetitor(store: IntelStore, actor: string, id: string, patch: Partial<CompetitorInput>): IntelCompetitor {
  requireHuman(actor, 'change competitors');
  const c = store.competitors.find((x) => x.id === String(id).toLowerCase() && !x.removed);
  if (!c) throw notFound(`No competitor "${id}"`);
  const p = patch ?? {};
  if (p.name !== undefined) c.name = text(p.name, 'name', 120);
  if (p.url !== undefined) {
    const u = c.isUs && (p.url === '' || p.url === null) ? '' : url(p.url, 'url', true)!;
    const same = u ? store.competitors.find((x) => !x.removed && x.id !== c.id && x.url && normUrl(x.url) === normUrl(u)) : undefined;
    if (same) throw conflict(`${u} is already tracked as "${same.id}"`);
    c.url = u;
  }
  if (p.tagline !== undefined) {
    const t = optText(p.tagline, 'tagline', 300);
    if (t) c.tagline = t;
    else delete c.tagline;
  }
  if (p.sources !== undefined) c.sources = siteSources(p.sources);
  if (p.identity !== undefined) {
    const ident = identity(p.identity);
    if (ident) c.identity = ident;
    else delete c.identity;
  }
  if (!c.isUs) {
    if (p.areas !== undefined) c.areas = areas(p.areas);
    if (p.browse !== undefined) c.browse = oneOf(p.browse, BROWSE_MODES, 'browse');
    if (p.watch !== undefined) {
      c.watch = oneOf(p.watch, CADENCES, 'watch');
      planCompetitorWatch(store, c);
    }
  }
  return c;
}

/** DELETE /api/intel/competitors/:id: hidden (removed), watch off, findings kept. `us` is refused. */
export function removeCompetitor(store: IntelStore, actor: string, id: string): IntelCompetitor {
  requireHuman(actor, 'remove competitors');
  const key = String(id).toLowerCase();
  if (key === US) throw badRequest('"us" is your own app and stays');
  const c = store.competitors.find((x) => x.id === key && !x.removed);
  if (!c) throw notFound(`No competitor "${id}"`);
  c.removed = true;
  c.watch = 'off';
  planCompetitorWatch(store, c);
  for (const j of store.jobs) if (j.status === 'queued' && j.competitorIds.length === 1 && j.competitorIds[0] === c.id) j.status = 'cancelled';
  return c;
}

// ------------------------------------------------------------------ watches

export function cadenceMs(c: WatchCadence): number {
  return c === 'daily' ? DAY_MS : c === 'weekly' ? 7 * DAY_MS : c === 'monthly' ? 30 * DAY_MS : 0;
}

/** When a watch with this cadence is next due, counted from `from` (ms). */
export function nextAt(cadence: WatchCadence, from = Date.now()): string {
  return new Date(from + cadenceMs(cadence)).toISOString();
}

function planCompetitorWatch(store: IntelStore, c: IntelCompetitor): void {
  const w = store.watches.find((x) => x.subject.kind === 'competitor' && x.subject.competitorId === c.id);
  if (c.watch === 'off' || c.removed) {
    if (w) w.active = false;
    return;
  }
  if (w) {
    if (!w.active || w.cadence !== c.watch) w.nextAt = nextAt(c.watch);
    w.active = true;
    w.cadence = c.watch;
    return;
  }
  store.watches.push({ id: nextIntelId(store, 'watch'), subject: { kind: 'competitor', competitorId: c.id }, cadence: c.watch, nextAt: nextAt(c.watch), active: true });
}

/** A re-check watch for an approved idea (none when the cadence is off). */
export function createIdeaWatch(store: IntelStore, ideaId: string, cadence: WatchCadence, alertOn?: string): IntelWatch | undefined {
  if (cadence === 'off') return undefined;
  const old = store.watches.find((x) => x.subject.kind === 'idea' && x.subject.ideaId === ideaId);
  if (old) {
    Object.assign(old, { cadence, active: true, nextAt: nextAt(cadence) });
    if (alertOn) old.alertOn = alertOn;
    return old;
  }
  const w: IntelWatch = { id: nextIntelId(store, 'watch'), subject: { kind: 'idea', ideaId }, cadence, nextAt: nextAt(cadence), active: true, ...(alertOn ? { alertOn } : {}) };
  store.watches.push(w);
  return w;
}

export function requireWatch(store: IntelStore, id: string): IntelWatch {
  const w = store.watches.find((x) => x.id === String(id).trim().toUpperCase());
  if (!w) throw notFound(`No watch "${id}"`);
  return w;
}

/** Stops a watch (DELETE /api/intel/watches/:id, a rejected idea, a cancelled goal). Returns it, or undefined. */
export function stopWatch(store: IntelStore, id: string | undefined): IntelWatch | undefined {
  const w = id ? store.watches.find((x) => x.id === id) : undefined;
  if (w) w.active = false;
  return w;
}

// ------------------------------------------------------------------ jobs

export const runningJob = (store: IntelStore) => store.jobs.find((j) => j.status === 'running');
export const queuedJobs = (store: IntelStore) => store.jobs.filter((j) => j.status === 'queued');
const runningRun = (state: MusterState) => state.research?.runs.find((r) => r.status === 'running');

export function requireJob(store: IntelStore, id: string): IntelJob {
  const key = String(id).trim().toUpperCase();
  const j = key === 'CURRENT' ? runningJob(store) : store.jobs.find((x) => x.id === key);
  if (!j) throw notFound(key === 'CURRENT' ? 'No intel job is running' : `No intel job "${id}"`);
  return j;
}

export interface JobInput {
  kind: IntelJobKind;
  competitorIds: string[];
  areas: IntelArea[];
  browse: BrowseMode;
  depth: 'quick' | 'thorough';
  by: string;
  ideaId?: string;
  checkId?: string;
  watchId?: string;
}

/** The thing a job is about, for de-duplication: an idea for checks, the competitors otherwise. */
const subjectKey = (j: Pick<IntelJob, 'kind' | 'ideaId' | 'competitorIds'>) =>
  j.kind === 'check' || j.kind === 'recheck' ? `idea:${j.ideaId}` : j.kind === 'sweep' ? 'sweep' : `co:${[...j.competitorIds].sort().join(',')}`;

/** Queues a job, or returns the queued/running one for the same subject (no duplicates). */
export function enqueueJob(store: IntelStore, input: JobInput): IntelJob {
  const key = subjectKey(input);
  const dup = store.jobs.find((j) => (j.status === 'queued' || j.status === 'running') && subjectKey(j) === key);
  if (dup) return dup;
  const job: IntelJob = {
    id: nextIntelId(store, 'job'),
    kind: input.kind,
    status: 'queued',
    competitorIds: input.competitorIds,
    areas: input.areas,
    browse: input.browse,
    depth: input.depth,
    by: input.by,
    queuedAt: nowIso(),
    pagesBrowsed: 0,
    ...(input.ideaId ? { ideaId: input.ideaId } : {}),
    ...(input.checkId ? { checkId: input.checkId } : {}),
    ...(input.watchId ? { watchId: input.watchId } : {}),
  };
  store.jobs.push(job);
  return job;
}

/** POST /api/intel/jobs: a sweep over every tracked competitor (or the ones named), or one competitor's research. */
export function requestJob(store: IntelStore, state: MusterState, actor: string, input: Record<string, unknown>, config: Pick<MusterConfig, 'researchBrowser'>): IntelJob {
  requireYouOrCaptain(state, actor, 'start intel jobs');
  const kind = oneOf(input?.kind, ['sweep', 'competitor'] as const, 'kind');
  let ids: string[];
  if (input?.competitorIds === undefined || input.competitorIds === null) ids = trackedIds(store);
  else {
    if (!Array.isArray(input.competitorIds)) throw badRequest('competitorIds must be a list of competitor ids');
    ids = [...new Set(input.competitorIds.map((x, i) => requireCompetitor(store, x, `competitorIds[${i}]`).id))].filter((x) => x !== US);
  }
  if (!ids.length) throw conflict('No competitors are tracked yet: add one on the Intel page first');
  if (kind === 'competitor' && ids.length !== 1) throw badRequest('A competitor job is for exactly one competitor');
  const comps = ids.map((id) => requireCompetitor(store, id));
  const job = enqueueJob(store, {
    kind,
    competitorIds: ids,
    areas: input?.areas === undefined || input.areas === null ? [...new Set(comps.flatMap((c) => c.areas))] : areas(input.areas),
    browse: input?.browse === undefined || input.browse === null ? (kind === 'competitor' ? comps[0].browse : config.researchBrowser.mode) : oneOf(input.browse, BROWSE_MODES, 'browse'),
    depth: input?.depth === undefined || input.depth === null ? 'quick' : oneOf(input.depth, ['quick', 'thorough'] as const, 'depth'),
    by: actor,
  });
  return job;
}

/**
 * The dispatcher's step: the oldest queued job starts when scout is free (no running job or research run) and
 * Muster isn't paused. Returns the job that started, or undefined.
 */
export function startNextJob(store: IntelStore, state: MusterState): IntelJob | undefined {
  if (runningJob(store) || runningRun(state) || state.usage.paused) return undefined;
  const job = queuedJobs(store)[0];
  if (!job) return undefined;
  job.status = 'running';
  job.startedAt = nowIso();
  const check = job.checkId ? store.checks.find((c) => c.id === job.checkId) : undefined;
  if (check && check.status === 'queued') check.status = 'running';
  return job;
}

/** A check whose job ended without scout writing it: back to its last written revision, else failed. */
function settleCheck(store: IntelStore, job: IntelJob, reason: string): void {
  const check = job.checkId ? store.checks.find((c) => c.id === job.checkId) : undefined;
  if (!check || (check.status !== 'queued' && check.status !== 'running')) return;
  if (check.doneAt) check.status = 'done';
  else {
    check.status = 'failed';
    check.skippedReason = reason;
  }
}

/** POST /api/intel/finish (finish_intel_job): the research agent, for the running job. */
export function finishJob(store: IntelStore, state: MusterState, actor: string, input: { summary: unknown; sourcesRead?: unknown }): IntelJob {
  requireResearcher(state, actor, 'finish intel jobs');
  const job = runningJob(store);
  if (!job) throw conflict('No intel job is running');
  const summary = text(input?.summary, 'summary', 4000);
  const read = optInt(input?.sourcesRead, 'sourcesRead');
  job.status = 'done';
  job.finishedAt = nowIso();
  job.summary = summary;
  if (read !== undefined) job.sourcesRead = read;
  if (job.kind === 'competitor' || job.kind === 'sweep' || job.kind === 'watch') {
    for (const id of job.competitorIds) {
      const c = store.competitors.find((x) => x.id === id);
      if (c) c.lastSweptAt = job.finishedAt;
    }
  }
  const watch = job.watchId ? store.watches.find((w) => w.id === job.watchId) : undefined;
  if (watch) watch.lastAt = job.finishedAt;
  settleCheck(store, job, 'scout finished the job without writing the check');
  return job;
}

/** scout exited mid-job (or could not start): the job fails, its findings stay. */
export function failJob(store: IntelStore, reason: string): IntelJob | undefined {
  const job = runningJob(store);
  if (!job) return undefined;
  job.status = 'failed';
  job.finishedAt = nowIso();
  job.error = reason;
  settleCheck(store, job, reason);
  return job;
}

/** POST /api/intel/jobs/:id/cancel: you or the Captain. Returns whether it was running (the caller then stops scout). */
export function cancelJob(store: IntelStore, state: MusterState, actor: string, id: string): { job: IntelJob; wasRunning: boolean } {
  requireYouOrCaptain(state, actor, 'cancel intel jobs');
  const job = requireJob(store, id);
  if (job.status !== 'queued' && job.status !== 'running') throw conflict(`${job.id} is already ${job.status}`);
  const wasRunning = job.status === 'running';
  job.status = 'cancelled';
  job.finishedAt = nowIso();
  settleCheck(store, job, 'cancelled');
  return { job, wasRunning };
}

/** The 10-minute tick: every due active watch queues one job (none twice) and moves to its next date. */
export function tickWatches(store: IntelStore, state: MusterState, config: Pick<MusterConfig, 'researchBrowser'>, now = Date.now()): IntelJob[] {
  const queued: IntelJob[] = [];
  for (const w of store.watches) {
    if (!w.active || w.cadence === 'off' || Date.parse(w.nextAt) > now) continue;
    let job: IntelJob | undefined;
    if (w.subject.kind === 'competitor') {
      const c = store.competitors.find((x) => x.id === (w.subject as { competitorId: string }).competitorId);
      if (!c || c.removed) {
        w.active = false;
        continue;
      }
      job = enqueueJob(store, { kind: 'watch', competitorIds: [c.id], areas: c.areas, browse: c.browse, depth: 'quick', by: 'schedule', watchId: w.id });
    } else {
      const ideaId = w.subject.ideaId;
      const idea = state.research?.ideas.find((i) => i.id === ideaId);
      const check = idea?.checkId ? store.checks.find((c) => c.id === idea.checkId) : undefined;
      if (!idea || idea.status !== 'approved') {
        w.active = false;
        continue;
      }
      if (!trackedIds(store).length && !check) {
        w.nextAt = nextAt(w.cadence, now);
        continue;
      }
      job = enqueueJob(store, {
        kind: 'recheck',
        competitorIds: trackedIds(store),
        areas: [...INTEL_AREAS],
        browse: config.researchBrowser.mode,
        depth: 'quick',
        by: 'schedule',
        ideaId,
        watchId: w.id,
        ...(check ? { checkId: check.id } : {}),
      });
      if (check && check.status !== 'running' && job.status === 'queued' && check.status !== 'queued' && job.checkId === check.id) check.status = 'queued';
    }
    w.nextAt = nextAt(w.cadence, now);
    w.lastJobId = job.id;
    if (!queued.includes(job)) queued.push(job);
  }
  return queued;
}

/** One line per job for strips and briefs: "IJ3 competitor research · Padlet". */
export function jobLabel(store: IntelStore, job: IntelJob): string {
  const names = job.competitorIds.map((id) => store.competitors.find((c) => c.id === id)?.name ?? id);
  switch (job.kind) {
    case 'competitor':
      return `Researching ${names[0] ?? 'a competitor'}`;
    case 'sweep':
      return `Sweep of ${names.length} competitor${names.length === 1 ? '' : 's'}`;
    case 'watch':
      return `Watching ${names.join(', ')} for changes`;
    case 'check':
      return `Intel check of ${job.ideaId}`;
    case 'recheck':
      return `Re-check of ${job.ideaId}`;
  }
}

// ------------------------------------------------------------------ record (scout's findings)

type Ctx = { state: MusterState; jobId?: string };

function cell(store: IntelStore, compId: string, raw: unknown, what: string): CapabilityCell {
  const c = obj(raw, what);
  const status = oneOf(c.status, CAP_STATUSES, `${what}.status`);
  const out: CapabilityCell = { ...checkClaim(c, what), status };
  const note = optText(c.note, `${what}.note`, MAX_TITLE);
  if (note) out.note = note;
  if (status === 'planned') {
    if (compId === US) {
      const stageId = optText(c.stageId, `${what}.stageId`, 20)?.toUpperCase();
      if (!stageId) throw badRequest(`${what}.stageId is required when we have it planned`);
      out.stageId = stageId;
    } else out.planNote = text(c.planNote, `${what}.planNote`, MAX_TITLE);
  }
  return out;
}

function findByKey<T extends { id: string }>(items: T[], item: Record<string, any>, nameKey?: keyof T): T | undefined {
  if (typeof item.id === 'string' && item.id.trim()) {
    const found = items.find((x) => x.id === item.id.trim().toUpperCase());
    if (!found) throw notFound(`No item "${item.id}" to update; leave id out to add a new one`);
    return found;
  }
  if (nameKey && typeof item[nameKey as string] === 'string') {
    const n = (item[nameKey as string] as string).trim().toLowerCase();
    return items.find((x) => String(x[nameKey]).toLowerCase() === n);
  }
  return undefined;
}

function ideaRef(state: MusterState, v: unknown, what: string): string | undefined {
  const id = optText(v, what, 20)?.toUpperCase();
  if (id && !state.research?.ideas.some((i) => i.id === id)) throw badRequest(`${what}: no idea "${v}"`);
  return id;
}

function goalRef(state: MusterState, v: unknown, what: string): string | undefined {
  const id = optText(v, what, 20)?.toUpperCase();
  if (id && !state.roadmap?.goals.some((g) => g.id === id)) throw badRequest(`${what}: no goal "${v}" on the roadmap`);
  return id;
}

function capabilityIds(store: IntelStore, v: unknown, what: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw badRequest(`${what} must be a list of capability ids (F3)`);
  return [...new Set(v.map((x, i) => {
    const id = text(x, `${what}[${i}]`, 20).toUpperCase();
    if (!store.capabilities.some((c) => c.id === id)) throw badRequest(`${what}[${i}]: no capability "${x}"`);
    return id;
  }))];
}

function recordCapability(store: IntelStore, item: Record<string, any>, ctx: Ctx): IntelCapability {
  const existing = findByKey(store.capabilities, item, 'name');
  const name = item.name === undefined && existing ? existing.name : text(item.name, 'name', MAX_TITLE);
  const cellsRaw = item.cells === undefined && existing ? {} : obj(item.cells, 'cells');
  if (!existing && !Object.keys(cellsRaw).length) throw badRequest('cells needs at least one competitor cell, e.g. { "us": {...}, "padlet": {...} }');
  const cells: Record<string, CapabilityCell> = {};
  for (const [id, raw] of Object.entries(cellsRaw)) {
    const comp = requireCompetitor(store, id, `cells.${id}`);
    cells[comp.id] = cell(store, comp.id, raw, `cells.${comp.id}`);
  }
  const goalId = goalRef(ctx.state, item.goalId, 'goalId');
  const ideaId = ideaRef(ctx.state, item.ideaId, 'ideaId');
  const group = item.group === undefined ? undefined : optText(item.group, 'group', 80);
  const cap: IntelCapability = existing ?? { id: nextIntelId(store, 'capability'), name, cells: {}, verdict: 'parity', verdictVs: [], updatedAt: nowIso() };
  cap.name = name;
  if (item.group !== undefined) {
    if (group) cap.group = group;
    else delete cap.group;
  }
  Object.assign(cap.cells, cells);
  if (goalId) cap.goalId = goalId;
  if (ideaId) cap.ideaId = ideaId;
  cap.updatedAt = nowIso();
  if (!existing) store.capabilities.push(cap);
  return cap;
}

function quotes(v: unknown): IntelTheme['quotes'] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw badRequest('quotes must be a list of { text, source }');
  if (v.length > MAX_QUOTES) throw badRequest(`quotes: at most ${MAX_QUOTES} per theme`);
  return v.map((q, i) => {
    const o = obj(q, `quotes[${i}]`);
    return { text: text(o.text, `quotes[${i}].text`, MAX_QUOTE), source: checkSource(o.source, `quotes[${i}].source`) };
  });
}

function recordTheme(store: IntelStore, item: Record<string, any>, ctx: Ctx): IntelTheme {
  const existing = findByKey(store.themes, item, 'title');
  const claim = checkClaim(item, 'theme', { label: 'opinion' });
  const byCompetitor: Record<string, number> = {};
  for (const [id, n] of Object.entries(item.byCompetitor === undefined ? {} : obj(item.byCompetitor, 'byCompetitor'))) byCompetitor[requireCompetitor(store, id, `byCompetitor.${id}`).id] = int(n, `byCompetitor.${id}`);
  const mentions = int(item.mentions, 'mentions');
  if ((item.sampleSize === undefined || item.sampleSize === null) && !store.sample?.total) {
    throw badRequest('Missing sampleSize: send it, or record the sample (kind sample) first; themes default to its total');
  }
  const sampleSize = int(item.sampleSize ?? store.sample?.total, 'sampleSize', 1);
  if (mentions > sampleSize) throw badRequest('mentions can not be more than sampleSize');
  const theme: IntelTheme = {
    ...claim,
    id: existing?.id ?? '',
    title: text(item.title, 'title', MAX_TITLE),
    mentions,
    sampleSize,
    independentSources: int(item.independentSources, 'independentSources'),
    byCompetitor,
    severity: oneOf(item.severity, ['severe', 'high', 'medium', 'low'] as const, 'severity'),
    trend: oneOf(item.trend, ['rising', 'steady', 'easing', 'new'] as const, 'trend'),
    quotes: quotes(item.quotes),
  };
  if (item.love === true) theme.love = true;
  for (const k of ['trendNote', 'who', 'workaround'] as const) {
    const t = optText(item[k], k, 500);
    if (t) theme[k] = t;
  }
  if (item.ourAnswer !== undefined && item.ourAnswer !== null) {
    const a = obj(item.ourAnswer, 'ourAnswer');
    theme.ourAnswer = { kind: oneOf(a.kind, ['edge', 'opportunity', 'watch', 'win_over'] as const, 'ourAnswer.kind'), text: text(a.text, 'ourAnswer.text', 500) };
    const ideaId = ideaRef(ctx.state, a.ideaId, 'ourAnswer.ideaId');
    const goalId = goalRef(ctx.state, a.goalId, 'ourAnswer.goalId');
    if (ideaId) theme.ourAnswer.ideaId = ideaId;
    if (goalId) theme.ourAnswer.goalId = goalId;
  }
  return upsert(store.themes, existing, theme, store, 'theme');
}

/** Updates `existing` in place, or adds `next`; a new item gets its id only now, after validation passed. */
function upsert<T extends object>(items: T[], existing: T | undefined, next: T, store?: IntelStore, kind?: IdKind): T {
  if (store && kind && !(next as { id?: string }).id) (next as { id?: string }).id = nextIntelId(store, kind);
  if (existing) {
    for (const k of Object.keys(existing)) delete (existing as Record<string, unknown>)[k];
    return Object.assign(existing, next);
  }
  items.push(next);
  return next;
}

function recordSample(store: IntelStore, item: Record<string, any>): IntelSample {
  if (!Array.isArray(item.counts) || !item.counts.length) throw badRequest('counts needs at least one { kind, label, n }');
  const counts = item.counts.map((c: unknown, i: number) => {
    const o = obj(c, `counts[${i}]`);
    return { kind: oneOf(o.kind, [...SOURCE_KINDS, 'social_comments'] as const, `counts[${i}].kind`), label: text(o.label, `counts[${i}].label`, MAX_TITLE), n: int(o.n, `counts[${i}].n`) };
  });
  const sum = counts.reduce((a: number, c: { n: number }) => a + c.n, 0);
  const sample: IntelSample = { window: text(item.window, 'window', 100), counts, total: item.total === undefined ? sum : int(item.total, 'total', 1), asOf: day(item.asOf, 'asOf') ?? today() };
  store.sample = sample;
  return sample;
}

const CHANNELS = ['youtube', 'tiktok', 'instagram', 'linkedin', 'reddit', 'x', 'facebook'] as const;

function recordSocial(store: IntelStore, item: Record<string, any>): IntelSocialChannel {
  const competitorId = requireCompetitor(store, item.competitorId).id;
  const channel = oneOf(item.channel, CHANNELS, 'channel');
  const existing = store.social.find((s) => s.competitorId === competitorId && s.channel === channel);
  const s: IntelSocialChannel = { ...checkClaim(item, 'social'), competitorId, channel, presence: oneOf(item.presence, ['active', 'dormant', 'absent'] as const, 'presence') };
  const u = url(item.url, 'url', false);
  if (u) s.url = u;
  const followers = optInt(item.followers, 'followers');
  if (followers !== undefined) s.followers = followers;
  for (const k of ['cadence', 'contentType', 'replies', 'dormantFor'] as const) {
    const t = optText(item[k], k, 200);
    if (t) s[k] = t;
  }
  return upsert(store.social, existing, s);
}

function recordSocialInsight(store: IntelStore, item: Record<string, any>): IntelSocialInsight {
  const existing = findByKey(store.socialInsights, item);
  const s: IntelSocialInsight = {
    ...checkClaim(item, 'social_insight'),
    id: existing?.id ?? '',
    kind: oneOf(item.kind, ['engagement', 'comment_complaint', 'win'] as const, 'kind'),
    text: text(item.text, 'text', 1000),
  };
  if (item.competitorId !== undefined && item.competitorId !== null) s.competitorId = requireCompetitor(store, item.competitorId).id;
  const metric = optText(item.metric, 'metric', 100);
  if (metric) s.metric = metric;
  return upsert(store.socialInsights, existing, s, store, 'social');
}

function recordPlan(store: IntelStore, item: Record<string, any>): IntelPlan {
  const existing = findByKey(store.plans, item, 'title');
  const kind = oneOf(item.kind, ['commitment', 'prediction'] as const, 'kind');
  const p: IntelPlan = {
    ...checkClaim(item, 'plan', { label: kind === 'commitment' ? 'fact' : 'prediction' }),
    id: existing?.id ?? '',
    competitorId: requireCompetitor(store, item.competitorId).id,
    title: text(item.title, 'title', MAX_TITLE),
    kind,
    capabilityIds: capabilityIds(store, item.capabilityIds, 'capabilityIds'),
  };
  if (item.status !== undefined && item.status !== null) p.status = oneOf(item.status, ['planned', 'in_progress', 'shipped', 'dropped'] as const, 'status');
  const tf = optText(item.timeframe, 'timeframe', 100);
  if (tf) p.timeframe = tf;
  return upsert(store.plans, existing, p, store, 'plan');
}

function facts(v: unknown, what: string): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined;
  const o = obj(v, what);
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(o)) out[text(k, `${what} key`, 80)] = text(x, `${what}.${k}`, 500);
  return out;
}

function recordFinding(store: IntelStore, item: Record<string, any>): IntelFinding {
  const existing = findByKey(store.findings, item);
  const area = oneOf(item.area, INTEL_AREAS, 'area');
  const f: IntelFinding = { ...checkClaim(item, 'finding'), id: existing?.id ?? '', area, title: text(item.title, 'title', MAX_TITLE) };
  if (item.competitorId !== undefined && item.competitorId !== null) f.competitorId = requireCompetitor(store, item.competitorId).id;
  const detail = optText(item.detail, 'detail', 4000);
  if (detail) f.detail = detail;
  const fx = facts(item.facts, 'facts');
  if (fx) f.facts = fx;
  if (area === 'ai') f.aiStatus = oneOf(item.aiStatus, ['verified', 'claimed'] as const, 'aiStatus');
  if (area === 'team' || area === 'org' || item.partial === true) f.partial = true;
  return upsert(store.findings, existing, f, store, 'finding');
}

function recordScenario(store: IntelStore, item: Record<string, any>): IntelScenario {
  const existing = findByKey(store.scenarios, item, 'name');
  const costs: IntelScenario['costs'] = {};
  for (const [id, raw] of Object.entries(obj(item.costs, 'costs'))) {
    const key = requireCompetitor(store, id, `costs.${id}`).id;
    const o = obj(raw, `costs.${id}`);
    const c: IntelScenario['costs'][string] = { currency: text(o.currency, `costs.${id}.currency`, 10), period: oneOf(o.period, ['month', 'year', 'once'] as const, `costs.${id}.period`) };
    if (o.amount !== undefined && o.amount !== null) {
      if (typeof o.amount !== 'number' || !Number.isFinite(o.amount) || o.amount < 0) throw badRequest(`costs.${id}.amount must be a number ≥ 0 (leave it out when it isn't sold or needs a quote)`);
      c.amount = o.amount;
    }
    const note = optText(o.note, `costs.${id}.note`, 200);
    if (note) c.note = note;
    costs[key] = c;
  }
  const s: IntelScenario = {
    ...checkClaim(item, 'scenario'),
    id: existing?.id ?? '',
    name: text(item.name, 'name', MAX_TITLE),
    assumptions: strings(item.assumptions, 'assumptions', { min: 1, max: 12, each: 300 }),
    costs,
  };
  return upsert(store.scenarios, existing, s, store, 'scenario');
}

function recordFiling(store: IntelStore, item: Record<string, any>): IntelFiling {
  const competitorId = requireCompetitor(store, item.competitorId).id;
  const companyNumber = text(item.companyNumber, 'companyNumber', 20);
  const existing = store.filings.find((f) => f.competitorId === competitorId && f.companyNumber === companyNumber);
  const f: IntelFiling = { ...checkClaim(item, 'filing'), competitorId, companyNumber, status: text(item.status, 'status', 100), limits: text(item.limits, 'limits', 1000) };
  for (const k of ['incorporated', 'accountsType', 'accountsMadeUpTo', 'accountsDue'] as const) {
    const t = optText(item[k], k, 60);
    if (t) f[k] = t;
  }
  if (item.overdue === true) f.overdue = true;
  const officers = optInt(item.officers, 'officers');
  if (officers !== undefined) f.officers = officers;
  if (item.pscs !== undefined) f.pscs = strings(item.pscs, 'pscs', { max: 20, each: 120 });
  const fig = facts(item.figures, 'figures');
  if (fig) f.figures = fig;
  return upsert(store.filings, existing, f);
}

function recordPositioning(store: IntelStore, item: Record<string, any>): IntelPositioning {
  const axis = (v: unknown, what: string) => {
    const o = obj(v, what);
    return { label: text(o.label, `${what}.label`, 100), min: text(o.min, `${what}.min`, 60), max: text(o.max, `${what}.max`, 60) };
  };
  if (!Array.isArray(item.points) || !item.points.length) throw badRequest('points needs at least one { competitorId, x, y }');
  const p: IntelPositioning = {
    ...checkClaim(item, 'positioning'),
    title: text(item.title, 'title', MAX_TITLE),
    x: axis(item.x, 'x'),
    y: axis(item.y, 'y'),
    points: item.points.map((pt: unknown, i: number) => {
      const o = obj(pt, `points[${i}]`);
      const out: IntelPositioning['points'][number] = { competitorId: requireCompetitor(store, o.competitorId, `points[${i}].competitorId`).id, x: unit(o.x, `points[${i}].x`), y: unit(o.y, `points[${i}].y`) };
      if (o.future === true) out.future = true;
      const label = optText(o.label, `points[${i}].label`, 60);
      if (label) out.label = label;
      return out;
    }),
    assumptions: strings(item.assumptions, 'assumptions', { min: 1, max: 12, each: 300 }),
  };
  if (item.openSpace !== undefined && item.openSpace !== null) {
    const o = obj(item.openSpace, 'openSpace');
    p.openSpace = { x0: unit(o.x0, 'openSpace.x0'), y0: unit(o.y0, 'openSpace.y0'), x1: unit(o.x1, 'openSpace.x1'), y1: unit(o.y1, 'openSpace.y1'), label: text(o.label, 'openSpace.label', 100) };
  }
  store.positioning = p;
  return p;
}

function recordInsight(store: IntelStore, item: Record<string, any>, ctx: Ctx): IntelInsight {
  const existing = findByKey(store.insights, item, 'title');
  const i: IntelInsight = {
    ...checkClaim(item, 'insight', { implication: true }),
    id: existing?.id ?? '',
    kind: oneOf(item.kind, ['match', 'advantage', 'audience', 'test'] as const, 'kind'),
    title: text(item.title, 'title', MAX_TITLE),
    detail: text(item.detail, 'detail', 2000),
  };
  const ideaId = ideaRef(ctx.state, item.ideaId, 'ideaId');
  if (ideaId) i.ideaId = ideaId;
  return upsert(store.insights, existing, i, store, 'insight');
}

function recordChange(store: IntelStore, item: Record<string, any>, ctx: Ctx): IntelChange {
  const existing = findByKey(store.changes, item);
  const c: IntelChange = {
    ...checkClaim(item, 'change', { implication: true }),
    id: existing?.id ?? '',
    at: day(item.at, 'at') ?? today(),
    competitorId: requireCompetitor(store, item.competitorId).id,
    area: oneOf(item.area, INTEL_AREAS, 'area'),
    title: text(item.title, 'title', MAX_TITLE),
    planImpact: oneOf(item.planImpact, ['none', 'watch', 'respond'] as const, 'planImpact'),
    seen: existing?.seen ?? false,
  };
  if (existing?.suggestion) c.suggestion = existing.suggestion;
  const ideaId = ideaRef(ctx.state, item.ideaId, 'ideaId');
  const goalId = goalRef(ctx.state, item.goalId, 'goalId');
  if (ideaId) c.ideaId = ideaId;
  if (goalId) c.goalId = goalId;
  const jobId = existing?.jobId ?? ctx.jobId;
  if (jobId) c.jobId = jobId;
  return upsert(store.changes, existing, c, store, 'change');
}

function recordProfile(store: IntelStore, item: Record<string, any>): IntelCompetitor {
  const c = requireCompetitor(store, item.competitorId ?? item.id);
  if (item.name !== undefined) c.name = text(item.name, 'name', 120);
  if (item.tagline !== undefined) {
    const t = optText(item.tagline, 'tagline', 300);
    if (t) c.tagline = t;
  }
  if (item.url !== undefined && !c.url) c.url = url(item.url, 'url', true)!;
  if (item.identity !== undefined) c.identity = { ...c.identity, ...identity(item.identity) };
  if (item.sources !== undefined) {
    const add = siteSources(item.sources);
    for (const s of add) if (!c.sources.some((x) => normUrl(x.url) === normUrl(s.url))) c.sources.push(s);
  }
  return c;
}

/**
 * POST /api/intel/record (record_intel): the research agent, while an intel job or a research run runs. An item with
 * a known id (or capability name / theme title / plan title / insight title, case-insensitive) is updated, else
 * created. Capability verdicts are recomputed by the caller (core/intelcheck.ts recomputeVerdicts).
 */
export function recordIntel(store: IntelStore, state: MusterState, actor: string, kind: unknown, item: unknown): unknown {
  requireResearcher(state, actor, 'record intel');
  const job = runningJob(store);
  if (!job && !runningRun(state)) throw conflict('Nothing is running: record intel only during an intel job or a research run');
  const k = oneOf(kind, RECORD_KINDS, 'kind');
  const it = obj(item, 'item');
  const ctx: Ctx = { state, jobId: job?.id };
  switch (k) {
    case 'profile':
      return recordProfile(store, it);
    case 'capability':
      return recordCapability(store, it, ctx);
    case 'theme':
      return recordTheme(store, it, ctx);
    case 'sample':
      return recordSample(store, it);
    case 'social':
      return recordSocial(store, it);
    case 'social_insight':
      return recordSocialInsight(store, it);
    case 'plan':
      return recordPlan(store, it);
    case 'finding':
      return recordFinding(store, it);
    case 'scenario':
      return recordScenario(store, it);
    case 'filing':
      return recordFiling(store, it);
    case 'positioning':
      return recordPositioning(store, it);
    case 'insight':
      return recordInsight(store, it, ctx);
    case 'change':
      return recordChange(store, it, ctx);
  }
}

// ------------------------------------------------------------------ captain thread, changes

/** POST /api/intel/reply: the Captain answers about the gaps in general. */
export function intelReply(store: IntelStore, state: MusterState, actor: string, body: unknown): void {
  if (!isCaptain(state, actor)) throw forbidden('Only the Captain replies on the intel thread');
  store.captainThread.push({ at: nowIso(), from: actor, text: text(body, 'text', 4000) });
}

/** POST /api/intel/changes/seen: you opened the change log (ids, or all). */
export function markChangesSeen(store: IntelStore, actor: string, ids?: unknown): number {
  requireHuman(actor, 'mark changes seen');
  let want: Set<string> | undefined;
  if (ids !== undefined && ids !== null) {
    if (!Array.isArray(ids)) throw badRequest('ids must be a list of change ids (IX3)');
    want = new Set(ids.map((x) => String(x).trim().toUpperCase()));
  }
  let n = 0;
  for (const c of store.changes) {
    if (c.seen || (want && !want.has(c.id))) continue;
    c.seen = true;
    n++;
  }
  return n;
}

/** POST /api/intel/changes/:id/suggest: the Captain's suggested response to a change. */
export function suggestOnChange(store: IntelStore, state: MusterState, actor: string, id: string, body: unknown): IntelChange {
  if (!isCaptain(state, actor)) throw forbidden('Only the Captain suggests responses to changes');
  const c = store.changes.find((x) => x.id === String(id).trim().toUpperCase());
  if (!c) throw notFound(`No change "${id}"`);
  c.suggestion = text(body, 'text', 2000);
  return c;
}

// ------------------------------------------------------------------ summary, brief, report

const distinctSources = (claims: IntelClaim[]) => new Set(claims.flatMap((c) => c.sources.map((s) => s.url ?? `${s.kind}:${s.title}`))).size;

export function allClaims(store: IntelStore): IntelClaim[] {
  return [
    ...store.capabilities.flatMap((c) => Object.values(c.cells)),
    ...store.themes,
    ...store.social,
    ...store.socialInsights,
    ...store.plans,
    ...store.findings,
    ...store.scenarios,
    ...store.filings,
    ...(store.positioning ? [store.positioning] : []),
    ...store.insights,
    ...store.changes,
    ...store.checks.flatMap((c) => c.rows),
  ];
}

export function intelSummary(store: IntelStore, state: MusterState): IntelSummary {
  const live = tracked(store);
  const swept = live.map((c) => c.lastSweptAt).filter((x): x is string => !!x).sort();
  const running = runningJob(store);
  return {
    rev: store.rev,
    competitors: live.length,
    ...(swept.length ? { lastSweptAt: swept.at(-1) } : {}),
    sources: distinctSources(allClaims(store)),
    gaps: store.capabilities.filter((c) => c.verdict === 'gap').length,
    edges: store.capabilities.filter((c) => c.verdict === 'edge').length,
    open: store.capabilities.filter((c) => c.verdict === 'open').length,
    newIdeas: (state.research?.ideas ?? []).filter((i) => i.origin === 'intel' && i.status === 'new').length,
    alerts: store.changes.filter((c) => !c.seen && c.planImpact === 'respond').length,
    ...(running ? { runningJob: { id: running.id, kind: running.kind, label: jobLabel(store, running), startedAt: running.startedAt ?? running.queuedAt } } : {}),
    queuedJobs: queuedJobs(store).length,
  };
}

const RULES = [
  'Rules:',
  '- Record as you go: one claim per record_intel call. Every claim has label, confidence, sources (title, url, publishedAt when the page has a date), asOf.',
  '- Labels: fact = you saw it on a primary source; opinion = what customers say; prediction = your inference, with prediction { signals, timeframe, wouldChange }.',
  "- Capabilities: fill the us cell too, from our own app (README, code, roadmap; source kind own_app, no url). Leave it out only when you can't tell: a missing us cell counts as not having it, so it shows as a gap.",
  '- Themes: count mentions within the stated sample (record the sample first); never generalise from a few loud complaints. Fewer than 5 independent sources is thin evidence.',
  `- Quotes at most ${MAX_QUOTE} characters, at most ${MAX_QUOTES} per theme, public usernames at most.`,
  '- Audience: separate claimed (their marketing) from evidenced (reviews, case studies). AI: verified (seen working) vs claimed.',
  '- Team, org and filings are a partial public view: say so. Engagement is attention, not sales.',
  '- Pricing scenarios are realistic and list their assumptions.',
  '- Changes: what changed, why it matters (implication), and planImpact none/watch/respond.',
  '- Gaps, open spaces and edges worth acting on: add_opportunity, then intel_check for that idea.',
  "- browse is read-only and rate-limited; prefer official feeds (Companies House, store pages, RSS, public roadmaps). Never sign in yourself, never touch cookies or browser profiles. If a page needs a login the profile doesn't have, say so in your summary.",
  '- When done, finish_intel_job(summary, sourcesRead).',
];

/** GET /api/intel/brief: what scout works from during an intel job (or the reminder during a research run). */
export function intelBrief(store: IntelStore, state: MusterState, config: Pick<MusterConfig, 'researchBrowser'>): string {
  const job = runningJob(store);
  const comps = tracked(store);
  if (!job) {
    if (runningRun(state)) {
      return [
        'No intel job is running; a research run is (use research_brief for it).',
        comps.length
          ? `Competitors tracked: ${comps.map((c) => `${c.name} (${c.id})`).join(', ')}. After every add_idea, write intel_check for that idea.`
          : 'No competitors are tracked, so ideas need no intel check (the server marks them skipped).',
      ].join('\n');
    }
    return 'No intel job is running. Nothing to do: wait until you are given one.';
  }
  const out: string[] = [`Intel job ${job.id} (${job.kind}, ${job.depth}): ${jobLabel(store, job)}.`];
  const jobComps = job.competitorIds.map((id) => store.competitors.find((c) => c.id === id)).filter((c): c is IntelCompetitor => !!c);
  if (jobComps.length) {
    out.push('', 'Competitors:');
    for (const c of jobComps) {
      out.push(`- ${c.name} (${c.id}) ${c.url}${c.lastSweptAt ? ` · last swept ${c.lastSweptAt.slice(0, 10)}` : ''}`);
      if (c.sources.length) out.push(`  sources: ${c.sources.map((s) => `${s.label ?? s.kind} ${s.url}`).join(' · ')}`);
      out.push(`  areas: ${(job.kind === 'competitor' || job.kind === 'watch' ? c.areas : job.areas).join(', ')}`);
    }
  }
  if (job.kind === 'watch') out.push('', `Look for changes since ${jobComps[0]?.lastSweptAt?.slice(0, 10) ?? 'the first sweep'}: record each as kind "change".`);
  if (job.ideaId) {
    const idea = state.research?.ideas.find((i) => i.id === job.ideaId);
    const check = job.checkId ? store.checks.find((c) => c.id === job.checkId) : undefined;
    out.push('', `Idea ${job.ideaId}: ${idea?.title ?? '?'}${idea ? ` — ${idea.summary}` : ''}`);
    if (idea?.opportunity?.capabilityIds.length) out.push(`Capabilities: ${idea.opportunity.capabilityIds.join(', ')}`);
    out.push(`Write one intel_check(${job.ideaId}, rows, verdictText, confidence, capabilities?, watchFor?) with a row per area you can cover (features, complaints, social, plans, pricing, audience, ai).`);
    if (check?.doneAt) {
      out.push('', `Previous revision ${check.revision} (${check.doneAt.slice(0, 10)}): ${check.verdict} (${check.confidence}). ${check.verdictText}`);
      for (const r of check.rows) out.push(`- ${r.area}: ${r.finding} [${r.signal}, ${r.label}, ${r.confidence}]`);
      if (check.watchFor) out.push(`Watching for: ${check.watchFor}`);
    }
  }
  const r = state.roadmap;
  out.push('', 'Product:');
  if (!r) out.push(`${store.competitors.find((c) => c.isUs)?.name ?? 'our app'}: no roadmap yet; read the README and code for what it does.`);
  else {
    out.push(`${r.title}${r.summary ? ` — ${r.summary}` : ''}`);
    for (const st of r.stages) out.push(`${st.id} ${st.title} (${st.status}): ${st.goalIds.map((g) => `${g} ${r.goals.find((x) => x.id === g)?.title ?? ''}`).join('; ')}`);
  }
  out.push('', 'Already in the store (update these instead of duplicating):');
  out.push(`- capabilities: ${store.capabilities.map((c) => `${c.id} ${c.name}`).join('; ') || 'none'}`);
  out.push(`- themes: ${store.themes.map((t) => `${t.id} ${t.title}`).join('; ') || 'none'}`);
  out.push(`- plans: ${store.plans.map((p) => `${p.id} ${p.title} (${p.competitorId})`).join('; ') || 'none'}`);
  out.push(`- intel ideas: ${(state.research?.ideas ?? []).filter((i) => i.origin === 'intel').map((i) => `${i.id} ${i.title}`).join('; ') || 'none'}`);
  const left = Math.max(0, config.researchBrowser.maxPagesPerJob - job.pagesBrowsed);
  out.push('', `Browsing: mode ${job.browse}, ${left} of ${config.researchBrowser.maxPagesPerJob} browse calls left, at least ${config.researchBrowser.minDelayMs} ms between pages on one site.`);
  out.push('', ...RULES);
  return out.join('\n');
}

const claimLine = (c: IntelClaim) =>
  `[${c.label} · ${c.confidence} · as of ${c.asOf}] Sources: ${c.sources.map((s) => `${s.title}${s.url ? ` (${s.url})` : ''}${s.publishedAt ? `, ${s.publishedAt}` : ''}, seen ${s.seenAt}`).join('; ')}${c.prediction ? `. Signals: ${c.prediction.signals.join('; ')}. Timeframe: ${c.prediction.timeframe}. Would change: ${c.prediction.wouldChange}` : ''}${c.implication ? `. For us: ${c.implication}` : ''}`;

/** GET /api/intel/report: the whole store as Markdown, every claim with its label, confidence, date and sources. */
export function intelReport(store: IntelStore, state: MusterState): string {
  const name = (id: string) => store.competitors.find((c) => c.id === id)?.name ?? id;
  const out: string[] = [`# Competitive intelligence — ${name(US)}`, '', `Exported ${today()} · store revision ${store.rev}`, ''];
  out.push('Labels: fact = seen on a primary source; opinion = what customers say; prediction = an inference with its signals.', '');
  out.push('## Competitors', '');
  for (const c of tracked(store)) out.push(`- **${c.name}** (${c.url})${c.identity?.legalName ? ` · ${c.identity.legalName}` : ''}${c.lastSweptAt ? ` · swept ${c.lastSweptAt.slice(0, 10)}` : ''}`);
  if (store.capabilities.length) {
    out.push('', '## Feature matrix', '');
    for (const cap of store.capabilities) {
      out.push(`### ${cap.id} ${cap.name} — ${cap.verdict}${cap.verdictVs.length ? ` vs ${cap.verdictVs.map(name).join(', ')}` : ''}${cap.verdictStage ? ` (${cap.verdictStage})` : ''}${cap.ideaId ? ` · ${cap.ideaId}` : ''}`);
      for (const [id, cell] of Object.entries(cap.cells)) out.push(`- ${name(id)}: ${cell.status}${cell.note ? ` (${cell.note})` : ''}. ${claimLine(cell)}`);
    }
  }
  const section = <T extends IntelClaim>(title: string, items: T[], head: (x: T) => string) => {
    if (!items.length) return;
    out.push('', `## ${title}`, '');
    for (const x of items) out.push(`- ${head(x)}. ${claimLine(x)}`);
  };
  if (store.sample) out.push('', `Sample: ${store.sample.counts.map((c) => `${c.n} ${c.label}`).join(' + ')} = ${store.sample.total}, ${store.sample.window} (as of ${store.sample.asOf})`);
  section('Themes', store.themes, (t) => `${t.id} ${t.title}: ${t.mentions} of ${t.sampleSize} (${Math.round((t.mentions / t.sampleSize) * 100)}%), ${t.independentSources} independent sources${t.independentSources < THIN_EVIDENCE ? ' — thin evidence' : ''}, ${t.severity}, ${t.trend}`);
  section('Competitor plans', store.plans, (p) => `${p.id} ${name(p.competitorId)}: ${p.title} (${p.kind}${p.status ? `, ${p.status}` : ''}${p.timeframe ? `, ${p.timeframe}` : ''})`);
  section('Findings', store.findings, (f) => `${f.id} [${f.area}] ${f.competitorId ? `${name(f.competitorId)}: ` : ''}${f.title}${f.partial ? ' (partial public view)' : ''}${f.detail ? ` — ${f.detail}` : ''}`);
  section('Social', store.social, (s) => `${name(s.competitorId)} on ${s.channel}: ${s.presence}${s.followers !== undefined ? `, ${s.followers} followers` : ''}`);
  section('Social insights (engagement is attention, not sales)', store.socialInsights, (s) => `${s.id} ${s.kind}: ${s.text}`);
  section('Pricing scenarios', store.scenarios, (s) => `${s.id} ${s.name} (assumptions: ${s.assumptions.join('; ')}): ${Object.entries(s.costs).map(([id, c]) => `${name(id)} ${c.amount === undefined ? 'n/a' : `${c.amount} ${c.currency}/${c.period}`}`).join(', ')}`);
  section('Filings', store.filings, (f) => `${name(f.competitorId)} ${f.companyNumber}: ${f.status}. Limits: ${f.limits}`);
  if (store.positioning) section('Positioning', [store.positioning], (p) => `${p.title} (assumptions: ${p.assumptions.join('; ')})`);
  section('What this means for us', store.insights, (i) => `${i.id} ${i.kind}: ${i.title} — ${i.detail}`);
  section('Change log', store.changes, (c) => `${c.at} ${c.id} ${name(c.competitorId)} [${c.area}] ${c.title} — plan: ${c.planImpact}${c.suggestion ? ` (Captain: ${c.suggestion})` : ''}`);
  const ideas = (state.research?.ideas ?? []).filter((i) => i.checkId);
  if (ideas.length) {
    out.push('', '## Intel checks', '');
    for (const i of ideas) {
      const c = store.checks.find((x) => x.id === i.checkId);
      if (!c) continue;
      out.push(`### ${i.id} ${i.title} — ${c.id} rev ${c.revision}: ${c.status === 'skipped' ? `skipped (${c.skippedReason})` : `${c.verdict} (${c.confidence}, ${c.sourceCount} sources)`}`, c.verdictText ? `${c.verdictText}` : '');
      for (const r of c.rows) out.push(`- ${r.area}: ${r.finding} (${r.signal}). ${claimLine(r)}`);
    }
  }
  return out.join('\n') + '\n';
}

/** What a research run, intel job or check costs, so the modals can show it (the usage estimate includes intel checks). */
export { estimateResearch, estimateIntelJob } from './intelestimate.js';
