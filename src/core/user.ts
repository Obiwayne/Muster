// The person running Muster: the name agents call them by. Stored once per OS user (not per repo),
// next to the human tokens, so every project, the CLI and the desktop app share it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { secretsBase } from './tokens.js';

const userFile = () => join(secretsBase(), 'user.json');

export function readUserName(): string | undefined {
  if (!existsSync(userFile())) return undefined;
  try {
    const name = JSON.parse(readFileSync(userFile(), 'utf8')).name;
    return typeof name === 'string' && name.trim() ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Saves the name (trimmed, max 40 chars, no control characters); an empty name clears it. */
export function writeUserName(name: string | null | undefined): string | undefined {
  const clean = (name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || undefined;
  mkdirSync(secretsBase(), { recursive: true });
  writeFileSync(userFile(), JSON.stringify({ name: clean ?? null }, null, 2));
  return clean;
}
