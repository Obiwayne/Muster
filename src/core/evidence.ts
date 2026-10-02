// Evidence: proof a task works (screenshots, test output, measured numbers). Agents save it in
// <worktree>/.muster-evidence/<task>/ (git ignores it), then add_evidence copies the files into
// .muster/evidence/<task>/<E#>/ and records them on the task. The Captain can't flag a task ready for
// merge without evidence, and the review card shows it.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Evidence, EvidenceFile, Task } from '../types.js';
import { badRequest, notFound } from './errors.js';
import type { MusterPaths } from './paths.js';

export const EVIDENCE_DIR = '.muster-evidence';
export const MAX_EVIDENCE_FILE = 100 * 1024 * 1024; // per file
export const MAX_EVIDENCE_FILES = 40; // per add_evidence call
export const MAX_EVIDENCE_TASK = 500 * 1024 * 1024; // per task, all entries
const MAX_SUMMARY = 4000;

const KINDS: Record<string, EvidenceFile['kind']> = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.svg': 'image',
  '.mp4': 'video', '.webm': 'video', '.mov': 'video',
  '.md': 'text', '.txt': 'text', '.log': 'text', '.json': 'text', '.csv': 'text', '.html': 'text',
};
export const evidenceKind = (name: string): EvidenceFile['kind'] => KINDS[extname(name).toLowerCase()] ?? 'other';

export const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.json': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8', '.html': 'text/plain; charset=utf-8',
};

const evidenceRoot = (p: MusterPaths) => join(p.dir, 'evidence');
const ENTRY_RE = /^E\d+$/;

/** Is `child` inside `parent` (after resolving symlinks)? */
function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

/** Files named by an agent, relative to its worktree; folders expand to the files in them. */
export function collectFiles(worktree: string, names: string[]): string[] {
  const root = realpathSync(worktree);
  const out: string[] = [];
  const add = (abs: string, named: string) => {
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      throw badRequest(`${named}: no such file in your worktree`);
    }
    if (!inside(root, real)) throw badRequest(`${named} is outside your worktree`);
    const st = statSync(real);
    if (st.isDirectory()) {
      for (const e of readdirSync(real).sort()) add(join(real, e), `${named}/${e}`);
      return;
    }
    if (!st.isFile()) throw badRequest(`${named} is not a file`);
    if (st.size > MAX_EVIDENCE_FILE) throw badRequest(`${named} is ${Math.round(st.size / 1048576)} MB; the limit is ${MAX_EVIDENCE_FILE / 1048576} MB per file (trim or compress it)`);
    if (!out.includes(real)) out.push(real);
    if (out.length > MAX_EVIDENCE_FILES) throw badRequest(`More than ${MAX_EVIDENCE_FILES} files; attach the ones that show the result`);
  };
  for (const n of names) {
    if (typeof n !== 'string' || !n.trim()) throw badRequest('files must be paths in your worktree');
    add(resolve(root, n.trim()), n.trim());
  }
  if (!out.length) throw badRequest('No files to attach');
  return out;
}

export interface AttachInput {
  task: Task;
  worktree: string;
  files: string[];
  /** Inline text saved as notes.md (for the Captain, who can't write files): test output, a checklist. */
  text?: string;
  summary: string;
  station: string;
  by: string;
  sha?: string;
  at: string;
}

/** Copies the files into .muster/evidence/<task>/<E#>/ and returns the record (the caller stores it on the task). */
export function attachEvidence(p: MusterPaths, input: AttachInput): Evidence {
  const summary = input.summary.trim();
  if (!summary) throw badRequest('summary is required: what the evidence shows');
  if (summary.length > MAX_SUMMARY) throw badRequest(`summary is longer than ${MAX_SUMMARY} characters`);
  const text = input.text?.trim() ? input.text.trimEnd() + '\n' : '';
  if (!input.files.length && !text) throw badRequest('Pass files (paths in your worktree) or text');
  const sources = input.files.length ? collectFiles(input.worktree, input.files) : [];
  const used = (input.task.evidence ?? []).reduce((n, e) => n + e.files.reduce((m, f) => m + f.bytes, 0), 0);
  const adding = sources.reduce((n, f) => n + statSync(f).size, 0) + Buffer.byteLength(text);
  if (used + adding > MAX_EVIDENCE_TASK) throw badRequest(`${input.task.id} would hold more than ${MAX_EVIDENCE_TASK / 1048576} MB of evidence; attach fewer or smaller files`);

  const id = `E${(input.task.evidence ?? []).reduce((n, e) => Math.max(n, Number(e.id.slice(1)) || 0), 0) + 1}`;
  const dir = join(evidenceRoot(p), input.task.id, id);
  mkdirSync(dir, { recursive: true });
  const files: EvidenceFile[] = [];
  if (text) {
    writeFileSync(join(dir, 'notes.md'), text);
    files.push({ name: 'notes.md', kind: 'text', bytes: Buffer.byteLength(text) });
  }
  for (const src of sources) {
    let name = basename(src).replace(/[^\w.@()+-]/g, '_');
    for (let i = 2; files.some((f) => f.name.toLowerCase() === name.toLowerCase()); i++) name = `${i}-${basename(src).replace(/[^\w.@()+-]/g, '_')}`;
    copyFileSync(src, join(dir, name));
    files.push({ name, kind: evidenceKind(name), bytes: statSync(src).size });
  }
  return { id, station: input.station, by: input.by, at: input.at, summary, ...(input.sha ? { sha: input.sha } : {}), files };
}

/** Absolute path of one stored evidence file (404 unless the task records it). */
export function evidencePath(p: MusterPaths, task: Task, entryId: string, name: string): string {
  const entry = ENTRY_RE.test(entryId) ? task.evidence?.find((e) => e.id === entryId) : undefined;
  const file = entry?.files.find((f) => f.name === name);
  if (!entry || !file) throw notFound(`No evidence ${entryId}/${name} on ${task.id}`);
  const full = join(evidenceRoot(p), task.id, entry.id, file.name);
  if (!inside(evidenceRoot(p), full) || !existsSync(full)) throw notFound(`Evidence file ${entryId}/${name} is missing on disk`);
  return full;
}

export const contentType = (name: string) => CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';

/**
 * Keeps agents' .muster-evidence/ folders out of git: one line in the shared .git/info/exclude covers every
 * worktree. Returns true when it added the line.
 */
export function ensureEvidenceIgnored(commonGitDir: string): boolean {
  const exclude = join(commonGitDir, 'info', 'exclude');
  const existing = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (existing.split(/\r?\n/).some((l) => l.trim() === `${EVIDENCE_DIR}/` || l.trim() === `/${EVIDENCE_DIR}/`)) return false;
  mkdirSync(join(commonGitDir, 'info'), { recursive: true });
  writeFileSync(exclude, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + `${EVIDENCE_DIR}/\n`);
  return true;
}

/** One line per entry for agents: "E1 test by ada · 3 files (2 images): summary". */
export function formatEvidence(task: Pick<Task, 'evidence'>): string {
  const list = task.evidence ?? [];
  if (!list.length) return 'Evidence: none yet.';
  return ['Evidence:', ...list.map((e) => {
    const images = e.files.filter((f) => f.kind === 'image').length;
    return `- ${e.id} at ${e.station} by ${e.by}${e.sha ? ` @ ${e.sha.slice(0, 8)}` : ''} · ${e.files.length} file${e.files.length === 1 ? '' : 's'}${images ? ` (${images} image${images === 1 ? '' : 's'})` : ''}: ${e.summary.split('\n')[0].slice(0, 200)}`;
  })].join('\n');
}
