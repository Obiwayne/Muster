// Bulletin board, crew chat feed and per-agent inbox. Pure state mutations;
// the caller commits the store.
import { OPEN_BY_DEFAULT, type Agent, type FeedItem, type InboxItem, type MusterState, type Note, type NoteType } from '../types.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { nextId } from './store.js';

export const NOTE_TYPES: NoteType[] = ['stuck', 'question', 'waiting', 'progress', 'done', 'review', 'approval', 'escalation', 'message', 'system'];
export const HUMAN = 'you';
export const SYSTEM = 'muster';

export const nowIso = () => new Date().toISOString();
export const idNum = (id: string) => Number(id.replace(/\D/g, '')) || 0;

export function findAgent(state: MusterState, id: string): Agent | undefined {
  return state.agents.find((a) => a.id === id);
}

export function requireAgent(state: MusterState, id: string): Agent {
  const a = findAgent(state, id);
  if (!a) throw notFound(`No agent "${id}"`);
  return a;
}

export function captainOf(state: MusterState): Agent | undefined {
  return state.agents.find((a) => a.role === 'captain');
}

export function isCaptain(state: MusterState, actor: string): boolean {
  return captainOf(state)?.id === actor;
}

/** Actors are agent ids, "you" (CLI/dashboard) or "muster" (the orchestrator itself). */
export function requireActor(state: MusterState, actor: unknown): string {
  if (typeof actor !== 'string' || !actor) throw badRequest('Missing actor');
  if (actor !== HUMAN && actor !== SYSTEM && !findAgent(state, actor)) throw notFound(`No agent "${actor}"`);
  return actor;
}

export function addFeed(state: MusterState, item: Omit<FeedItem, 'id' | 'at'>): FeedItem {
  const f: FeedItem = { id: nextId(state, 'feed'), at: nowIso(), ...item };
  state.feed.push(f);
  return f;
}

export function feedEvent(state: MusterState, from: string, text: string, taskId?: string): FeedItem {
  return addFeed(state, { kind: 'event', from, text, taskId });
}

/** Queues an item for an agent. Items for "you", "muster", unknown ids or the sender itself are dropped. */
export function addInbox(state: MusterState, item: Omit<InboxItem, 'id' | 'at' | 'read' | 'delivered'>): InboxItem | undefined {
  if (!findAgent(state, item.agentId) || item.agentId === item.from) return undefined;
  const i: InboxItem = { id: nextId(state, 'inbox'), at: nowIso(), read: false, delivered: false, ...item };
  state.inbox.push(i);
  return i;
}

export function isNeedsYou(n: Note): boolean {
  return n.open && (n.type === 'escalation' || n.type === 'review' || n.type === 'approval' || n.to === HUMAN);
}

export interface NoteInput {
  actor: string;
  type: NoteType;
  text: string;
  taskId?: string;
  to?: string;
}

export function postNote(state: MusterState, input: NoteInput): Note {
  const from = requireActor(state, input.actor);
  if (!NOTE_TYPES.includes(input.type)) throw badRequest(`Unknown note type "${input.type}"`);
  if (!input.text?.trim()) throw badRequest('Note text is empty');
  const agent = findAgent(state, from);
  const taskId = input.taskId ?? agent?.taskId;
  const note: Note = {
    id: nextId(state, 'note'),
    type: input.type,
    from,
    to: input.to || undefined,
    taskId,
    branch: agent?.branch,
    text: input.text.trim(),
    createdAt: nowIso(),
    open: OPEN_BY_DEFAULT.includes(input.type),
    replies: [],
  };
  state.notes.push(note);
  addFeed(state, { kind: 'note', from, to: note.to, noteId: note.id, noteType: note.type, taskId, text: note.text });

  const captainId = captainOf(state)?.id;
  const deliver = (agentId: string) =>
    addInbox(state, { agentId, from, kind: 'note', text: `${note.type} ${note.id} from ${from}: ${note.text}`, noteId: note.id, taskId });
  if (captainId && (note.type === 'stuck' || note.type === 'question' || note.type === 'waiting')) deliver(captainId);
  if (note.to && note.to !== captainId) deliver(note.to);
  return note;
}

export function requireNote(state: MusterState, id: string): Note {
  const n = state.notes.find((x) => x.id === String(id).toUpperCase());
  if (!n) throw notFound(`No note "${id}"`);
  return n;
}

export function closeNoteIfOpen(n: Note): void {
  if (!n.open) return;
  n.open = false;
  n.closedAt = nowIso();
}

export function replyNote(state: MusterState, noteId: string, actor: string, text: string, close = false): Note {
  const from = requireActor(state, actor);
  const note = requireNote(state, noteId);
  if (!text?.trim()) throw badRequest('Reply text is empty');
  const body = text.trim();
  note.replies.push({ at: nowIso(), from, text: body });
  if (close) closeNoteIfOpen(note);
  addFeed(state, { kind: 'reply', from, noteId: note.id, taskId: note.taskId, text: body });

  const item = { from, kind: 'reply' as const, text: `reply from ${from} on ${note.id}: ${body}`, noteId: note.id, taskId: note.taskId };
  addInbox(state, { agentId: note.from, ...item });
  const captain = captainOf(state);
  if (captain && note.from !== captain.id) addInbox(state, { agentId: captain.id, ...item });
  return note;
}

export function closeNote(state: MusterState, noteId: string, actor: string): Note {
  requireActor(state, actor);
  const note = requireNote(state, noteId);
  closeNoteIfOpen(note);
  return note;
}

export function escalate(state: MusterState, actor: string, text: string, noteId?: string): Note {
  if (!isCaptain(state, actor)) throw forbidden('Only the Captain can escalate');
  const original = noteId ? requireNote(state, noteId) : undefined;
  const note = postNote(state, { actor, type: 'escalation', text, to: HUMAN, taskId: original?.taskId });
  if (original) original.replies.push({ at: nowIso(), from: actor, text: `Escalated to you as ${note.id}` });
  return note;
}

export function sendMessage(state: MusterState, actor: string, to: string, text: string): FeedItem {
  const from = requireActor(state, actor);
  if (!text?.trim()) throw badRequest('Message text is empty');
  if (!to) throw badRequest('Missing recipient');
  if (to !== 'everyone' && to !== HUMAN) requireAgent(state, to);
  const body = text.trim();
  const item = addFeed(state, { kind: 'message', from, to, text: body });
  const recipients = to === 'everyone' ? state.agents.map((a) => a.id) : [to];
  for (const agentId of recipients) addInbox(state, { agentId, from, kind: 'message', text: `message from ${from}: ${body}` });
  return item;
}

export interface NoteFilter {
  open?: boolean;
  type?: string;
  from?: string;
  to?: string;
  needsYou?: boolean;
}

const TYPE_RANK: Partial<Record<NoteType, number>> = { stuck: 0, question: 1 };

/** Stuck first, then questions, then the rest; newest first within each group. */
export function listNotes(state: MusterState, f: NoteFilter = {}): Note[] {
  return state.notes
    .filter(
      (n) =>
        (!f.open || n.open) &&
        (!f.type || n.type === f.type) &&
        (!f.from || n.from === f.from) &&
        (!f.to || n.to === f.to) &&
        (!f.needsYou || isNeedsYou(n)),
    )
    .sort((a, b) => (TYPE_RANK[a.type] ?? 2) - (TYPE_RANK[b.type] ?? 2) || idNum(b.id) - idNum(a.id));
}

export function listFeed(state: MusterState, q: { limit?: number; before?: string; agent?: string } = {}): FeedItem[] {
  let items = state.feed;
  const before = q.before ? idNum(q.before) : 0;
  if (before) items = items.filter((f) => idNum(f.id) < before);
  if (q.agent) items = items.filter((f) => f.from === q.agent || f.to === q.agent || f.to === 'everyone');
  return items.slice(-(q.limit || 200));
}

export function inboxFor(state: MusterState, agentId: string, unreadOnly = false): InboxItem[] {
  return state.inbox.filter((i) => i.agentId === agentId && (!unreadOnly || !i.read));
}

export function markRead(state: MusterState, agentId: string, ids?: string[]): number {
  let n = 0;
  for (const i of inboxFor(state, agentId, true)) {
    if (ids && !ids.includes(i.id)) continue;
    i.read = true;
    i.delivered = true;
    n++;
  }
  return n;
}

/** The one-line nudge typed into an idle agent's terminal. */
export function nudgeText(items: InboxItem[]): string {
  const shown = items.slice(0, 4).map(describe);
  if (items.length > 4) shown.push(`+${items.length - 4} more`);
  return `[muster] You have ${items.length} new ${items.length === 1 ? 'item' : 'items'} (${shown.join('; ')}). Call read_inbox.`;
}

function describe(i: InboxItem): string {
  switch (i.kind) {
    case 'reply':
      return `reply from ${i.from} on ${i.noteId}`;
    case 'message':
      return `message from ${i.from}`;
    case 'assignment':
      return `task ${i.taskId} assigned`;
    case 'handoff':
      return `task ${i.taskId} handed to you by ${i.from}`;
    case 'review':
      return `task ${i.taskId} ready for review`;
    case 'note':
      return `${i.noteId} from ${i.from}`;
    default:
      return `notice from ${i.from}`;
  }
}
