// Notes ("jots"): ideas you keep on the Notes page, typed there or saved through Claude with the remote connector's
// muster_note tool. A note triggers no agent; "Send to Captain" turns one into a goal (the API layer types it in).
// Pure state mutations; the caller commits the store.
import type { Jot, MusterState } from '../types.js';
import { HUMAN, nowIso } from './board.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { nextId } from './store.js';

export const MAX_JOT_TEXT = 8000;
export const MAX_JOT_TITLE = 120;
export const MAX_JOT_TAGS = 8;
export const MAX_JOT_TAG = 30;

export interface JotInput {
  text?: unknown;
  title?: unknown;
  tags?: unknown;
}

/** Notes, pinned first, then newest first (by createdAt). */
export function listJots(state: MusterState, query?: string): Jot[] {
  const q = (query ?? '').trim().toLowerCase();
  const all = (state.jots ?? []).filter((j) => !q || searchText(j).includes(q));
  return all.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.createdAt.localeCompare(a.createdAt) || jotNo(b) - jotNo(a));
}

const jotNo = (j: Jot) => Number(j.id.replace(/\D/g, '')) || 0;
const searchText = (j: Jot) => `${j.title ?? ''}\n${j.text}\n${j.tags.join(' ')}`.toLowerCase();

/** What a note is called: its title, else its first non-empty line (cut to the title length). */
export function jotTitle(j: Pick<Jot, 'title' | 'text'>): string {
  if (j.title?.trim()) return j.title.trim();
  const first = j.text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
  return first.length > MAX_JOT_TITLE ? `${first.slice(0, MAX_JOT_TITLE - 1)}…` : first;
}

export function requireJot(state: MusterState, id: string): Jot {
  const j = state.jots?.find((x) => x.id === String(id).trim().toUpperCase());
  if (!j) throw notFound(`No note "${id}"`);
  return j;
}

function requireHuman(actor: string, what: string): void {
  if (actor !== HUMAN) throw forbidden(`Only you can ${what}`);
}

function bodyText(v: unknown): string {
  if (typeof v !== 'string') throw badRequest('text must be text');
  const t = v.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!t) throw badRequest('The note is empty');
  if (t.length > MAX_JOT_TEXT) throw badRequest(`A note is at most ${MAX_JOT_TEXT} characters`);
  return t;
}

function title(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw badRequest('title must be text');
  const t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (t.length > MAX_JOT_TITLE) throw badRequest(`A title is at most ${MAX_JOT_TITLE} characters`);
  return t || undefined;
}

function tags(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw badRequest('tags must be a list of words');
  const out = [...new Set(v.map((x: string) => x.trim().replace(/^#/, '').toLowerCase()).filter(Boolean))];
  if (out.length > MAX_JOT_TAGS) throw badRequest(`At most ${MAX_JOT_TAGS} tags`);
  for (const t of out) if (t.length > MAX_JOT_TAG) throw badRequest(`Tag "${t.slice(0, 20)}…" is longer than ${MAX_JOT_TAG} characters`);
  return out;
}

/** POST /api/jots: you only (the connector saves as you, `client` set: from 'claude'). */
export function addJot(state: MusterState, actor: string, input: JotInput, client?: string): Jot {
  requireHuman(actor, 'add notes');
  const at = nowIso();
  const jot: Jot = {
    id: nextId(state, 'jot'),
    text: bodyText(input.text),
    tags: tags(input.tags),
    from: client ? 'claude' : 'you',
    ...(client ? { client } : {}),
    createdAt: at,
    updatedAt: at,
  };
  const t = title(input.title);
  if (t) jot.title = t;
  (state.jots ??= []).push(jot);
  return jot;
}

/** POST /api/jots/:id/edit: you only; fields you leave out stay. An empty title clears it. */
export function editJot(state: MusterState, actor: string, id: string, input: JotInput): Jot {
  requireHuman(actor, 'edit notes');
  const jot = requireJot(state, id);
  if (input.text !== undefined) jot.text = bodyText(input.text);
  if (input.title !== undefined) {
    const t = title(input.title);
    if (t) jot.title = t;
    else delete jot.title;
  }
  if (input.tags !== undefined) jot.tags = tags(input.tags);
  jot.updatedAt = nowIso();
  return jot;
}

/** POST /api/jots/:id/pin {pinned}: you only. */
export function pinJot(state: MusterState, actor: string, id: string, pinned: unknown): Jot {
  requireHuman(actor, 'pin notes');
  const jot = requireJot(state, id);
  if (typeof pinned !== 'boolean') throw badRequest('pinned must be true or false');
  if (pinned) jot.pinned = true;
  else delete jot.pinned;
  return jot;
}

/** DELETE /api/jots/:id: you only. */
export function deleteJot(state: MusterState, actor: string, id: string): Jot {
  requireHuman(actor, 'delete notes');
  const jot = requireJot(state, id);
  state.jots = (state.jots ?? []).filter((j) => j !== jot);
  return jot;
}

/** The goal text "Send to Captain" types in: the title (when set) and the note. */
export function jotGoal(j: Jot): string {
  const t = j.title?.trim();
  return t && !j.text.startsWith(t) ? `${t}\n\n${j.text}` : j.text;
}

/** After the goal went to the Captain. */
export function markJotSent(state: MusterState, id: string): Jot {
  const jot = requireJot(state, id);
  jot.sentAt = nowIso();
  return jot;
}

/** list_notes for the Captain, and muster_notes for the connector: plain text, newest/pinned first. */
export function formatJots(list: Jot[], max = 30): string {
  if (!list.length) return 'No notes yet.';
  const lines = list.slice(0, max).map((j) => {
    const meta = [j.pinned ? 'pinned' : '', j.from === 'claude' ? 'via Claude' : j.from, j.createdAt.slice(0, 10), j.sentAt ? `sent to the Captain ${j.sentAt.slice(0, 10)}` : '', j.tags.length ? j.tags.map((t) => `#${t}`).join(' ') : ''].filter(Boolean).join(' · ');
    return `${j.id} ${jotTitle(j)} (${meta})\n${j.text}`;
  });
  const more = list.length > max ? `\n\n(${list.length - max} more notes not shown.)` : '';
  return `${lines.join('\n\n')}${more}`;
}
