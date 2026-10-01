// "Start a new app from nothing": make a folder, git init, README + .gitignore, first commit, set up .muster.
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { initMuster } from '../cli/init.js';

export interface NewProjectOptions {
  parentDir: string;
  idea: string;
  title?: string;
  /** Test seam: the date used in the default slug. */
  now?: Date;
}

export interface NewProject {
  root: string;
  slug: string;
}

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const gitConfigured = (cwd: string, key: string): boolean => {
  try {
    return git(cwd, ['config', key]).length > 0;
  } catch {
    return false;
  }
};

export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
}

export function createNewProject(opts: NewProjectOptions): NewProject {
  const idea = opts.idea.trim();
  if (!idea) throw new Error('Give the new app an idea.');
  const parent = resolve(opts.parentDir);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new Error(`Parent folder "${parent}" does not exist.`);
  try {
    accessSync(parent, constants.W_OK);
  } catch {
    throw new Error(`Parent folder "${parent}" is not writable.`);
  }

  const title = opts.title?.trim() || undefined;
  const base = (title && slugify(title)) || `idea-${(opts.now ?? new Date()).toISOString().slice(0, 10)}`;
  let slug = base;
  for (let n = 2; existsSync(join(parent, slug)); n++) slug = `${base}-${n}`;
  const root = join(parent, slug);
  mkdirSync(root);

  git(root, ['init', '-q', '-b', 'main']);
  writeFileSync(join(root, 'README.md'), `# ${title ?? 'Untitled idea'}\n\n${idea}\n`);
  writeFileSync(join(root, '.gitignore'), 'node_modules\ndist\n.env\n');
  git(root, ['add', '.']);
  // Use the person's git identity; fall back to a placeholder for this one commit only (never global).
  const fallback = gitConfigured(root, 'user.name') && gitConfigured(root, 'user.email') ? [] : ['-c', 'user.name=Muster', '-c', 'user.email=muster@localhost'];
  git(root, [...fallback, 'commit', '-q', '-m', 'Initial commit']);

  const init = initMuster(root, true);
  return { root: init.root, slug };
}
