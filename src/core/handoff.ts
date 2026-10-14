// The Captain's handoff note: what a fresh Captain session needs to carry on after a recycle.
// One note per project: .muster/handoffs/latest.md is the newest; every note is also kept as a dated copy (for debugging).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MusterState } from '../types.js';
import { badRequest } from './errors.js';
import type { MusterPaths } from './paths.js';

export interface Handoff {
  text: string;
  by: string; // agent id, or "muster" for one written from the board when the Captain didn't write its own
  at: string; // ISO time
}

export const MAX_HANDOFF_CHARS = 8000;
const KEEP_HISTORY = 50;

const dirOf = (p: MusterPaths) => join(p.dir, 'handoffs');
const latestOf = (p: MusterPaths) => join(dirOf(p), 'latest.json');

export function saveHandoff(p: MusterPaths, by: string, text: string, at = new Date()): Handoff {
  const body = text.trim();
  if (!body) throw badRequest('The handoff is empty');
  if (body.length > MAX_HANDOFF_CHARS) throw badRequest(`Keep the handoff under ${MAX_HANDOFF_CHARS} characters (it is ${body.length}); the next Captain reads the board itself`);
  const h: Handoff = { text: body, by, at: at.toISOString() };
  const dir = dirOf(p);
  mkdirSync(dir, { recursive: true });
  writeFileSync(latestOf(p), JSON.stringify(h, null, 2));
  writeFileSync(join(dir, `${h.at.replace(/[:.]/g, '-')}-${by}.md`), `# Handoff by ${by} at ${h.at}\n\n${body}\n`);
  pruneHistory(dir);
  return h;
}

export function latestHandoff(p: MusterPaths): Handoff | undefined {
  try {
    const h = JSON.parse(readFileSync(latestOf(p), 'utf8')) as Handoff;
    return typeof h?.text === 'string' ? h : undefined;
  } catch {
    return undefined;
  }
}

function pruneHistory(dir: string): void {
  const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP_HISTORY))) rmSync(join(dir, f), { force: true });
}

export function handoffHistory(p: MusterPaths): string[] {
  const dir = dirOf(p);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md') && statSync(join(dir, f)).isFile()).sort();
}

/** What the Captain is asked when it has to write its handoff. */
export function handoffRequest(reason: string): string {
  return `[muster] ${reason} Write your handoff now: call handoff(text) with the current goal, tasks in flight (who has what), reviews pending, decisions waiting on the user, and what you were about to do next. Keep it short; the next Captain reads the board itself. Then end your turn; Muster restarts you on a fresh session.`;
}

/** Written from the board when the Captain didn't write its own handoff in time. */
export function boardHandoff(state: MusterState): string {
  const lines: string[] = ['(Written by Muster from the board: the previous Captain did not write a handoff in time.)'];
  if (state.goal) lines.push(`Last goal from the user: ${state.goal.text}`);
  const r = state.roadmap;
  const goal = r?.goals.find((g) => g.status === 'active');
  if (goal) lines.push(`Active roadmap goal: ${goal.id} ${goal.title}`);
  if (r?.statusLine) lines.push(`Last roadmap status: ${r.statusLine.text}`);
  const open = state.tasks.filter((t) => !['merged', 'cancelled'].includes(t.status));
  if (open.length) lines.push('Open tasks:', ...open.map((t) => `- ${t.id} [${t.status}] ${t.title}${t.assignee ? ` @${t.assignee}` : ''}`));
  const needs = state.notes.filter((n) => n.open && (n.type === 'escalation' || n.to === 'you'));
  if (needs.length) lines.push('Waiting on the user:', ...needs.map((n) => `- ${n.id} ${n.text.slice(0, 160)}`));
  return lines.join('\n');
}

/** The first prompt of a fresh Captain session after a recycle. */
export function reloadPrompt(agentId: string, h: Handoff | undefined): string {
  const note = h ? `Handoff from the previous session (${h.by}, ${h.at}): ${h.text}` : 'There is no handoff note.';
  return `[muster] You are ${agentId}, the Captain, on a fresh session: Muster restarted you to keep your context small. ${note} Now call read_board, roadmap and read_inbox, then carry on with the same goal without asking the user anything the handoff or the board already answers.`;
}

const reloadMarker = (p: MusterPaths) => join(dirOf(p), 'reload');

/** The Captain's next start is a fresh session that starts from the latest handoff (set by `muster recycle` while Muster is down). */
export function markReload(p: MusterPaths): void {
  mkdirSync(dirOf(p), { recursive: true });
  writeFileSync(reloadMarker(p), new Date().toISOString());
}

/** True once if a reload was marked; clears the mark. */
export function takeReload(p: MusterPaths): boolean {
  if (!existsSync(reloadMarker(p))) return false;
  rmSync(reloadMarker(p), { force: true });
  return true;
}
