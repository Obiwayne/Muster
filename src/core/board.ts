// Bulletin board, crew chat feed and per-agent inbox. Pure state mutations;
// the caller commits the store.
import { OPEN_BY_DEFAULT, REACTION_EMOJI, type Agent, type AskAnswer, type AskOption, type AskQuestion, type FeedItem, type InboxItem, type MusterState, type Note, type NoteType, type ReactionEmoji } from '../types.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
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
  return n.open && !n.dismissed && (n.type === 'escalation' || n.type === 'review' || n.type === 'approval' || n.to === HUMAN);
}

export interface NoteInput {
  actor: string;
  type: NoteType;
  text: string;
  taskId?: string;
  to?: string;
  topic?: Note['topic'];
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
    ...(input.topic ? { topic: input.topic } : {}),
    replies: [],
  };
  state.notes.push(note);
  const feedId = addFeed(state, { kind: 'note', from, to: note.to, noteId: note.id, noteType: note.type, taskId, text: note.text }).id;

  const captainId = captainOf(state)?.id;
  const deliver = (agentId: string) =>
    addInbox(state, { agentId, from, kind: 'note', text: `${note.type} ${note.id} from ${from}: ${note.text}`, noteId: note.id, taskId, feedId });
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
  const feedId = addFeed(state, { kind: 'reply', from, noteId: note.id, taskId: note.taskId, text: body }).id;

  const item = { from, kind: 'reply' as const, text: `reply from ${from} on ${note.id}: ${body}`, noteId: note.id, taskId: note.taskId, feedId };
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

/** POST /api/notes/:id/dismiss: you take a note off the board. It stays in state (closed, dismissed) for history. */
export function dismissNote(state: MusterState, noteId: string, actor: string): Note {
  if (actor !== HUMAN) throw forbidden('Only you can dismiss notes');
  const note = requireNote(state, noteId);
  closeNoteIfOpen(note);
  note.dismissed = true;
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
  for (const agentId of recipients) addInbox(state, { agentId, from, kind: 'message', text: `message from ${from}: ${body}`, feedId: item.id });
  return item;
}

export interface NoteFilter {
  open?: boolean;
  type?: string;
  from?: string;
  to?: string;
  needsYou?: boolean;
  dismissed?: boolean; // include dismissed notes (left out by default)
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
        (!f.needsYou || isNeedsYou(n)) &&
        (f.dismissed || !n.dismissed),
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

/** The crew-chat line a note was posted as, so inbox items queued for it elsewhere can carry its feedId. */
export function noteFeedId(state: MusterState, noteId: string): string | undefined {
  return state.feed.find((f) => f.kind === 'note' && f.noteId === noteId)?.id;
}

/** Marks an agent's unread items read and records the agent once in readBy of each linked feed line. */
export function markRead(state: MusterState, agentId: string, ids?: string[]): number {
  let n = 0;
  for (const i of inboxFor(state, agentId, true)) {
    if (ids && !ids.includes(i.id)) continue;
    i.read = true;
    i.delivered = true;
    if (i.feedId) markFeedRead(state, i.feedId, agentId);
    n++;
  }
  return n;
}

function markFeedRead(state: MusterState, feedId: string, agentId: string): void {
  if (!findAgent(state, agentId)) return; // read receipts are for agents only
  const f = state.feed.find((x) => x.id === feedId);
  if (!f || f.from === agentId) return;
  const readBy = (f.readBy ??= []);
  if (!readBy.includes(agentId)) readBy.push(agentId);
}

export function requireFeed(state: MusterState, id: string): FeedItem {
  const raw = String(id ?? '').trim().toUpperCase();
  const fid = /^\d+$/.test(raw) ? `F${raw}` : raw;
  const f = state.feed.find((x) => x.id === fid);
  if (!f) throw notFound(`No crew chat line "${id}"`);
  return f;
}

export function isReactionEmoji(e: unknown): e is ReactionEmoji {
  return typeof e === 'string' && (REACTION_EMOJI as readonly string[]).includes(e);
}

/** POST /api/feed/:id/react: toggles actor's reaction on a feed line. Not a message: no inbox items, no nudges. */
export function reactFeed(state: MusterState, feedId: string, actor: string, emoji: unknown): FeedItem {
  const by = requireActor(state, actor);
  if (by === SYSTEM) throw forbidden('muster does not react');
  const e = typeof emoji === 'string' ? emoji.replace(/️/g, '').trim() : emoji;
  if (!isReactionEmoji(e)) throw badRequest(`Unknown reaction "${String(emoji)}"; use one of ${REACTION_EMOJI.join(' ')}`);
  const f = requireFeed(state, feedId);
  const reactions = (f.reactions ??= []);
  const at = reactions.findIndex((r) => r.by === by && r.emoji === e);
  if (at >= 0) reactions.splice(at, 1);
  else reactions.push({ emoji: e, by, at: nowIso() });
  if (!reactions.length) delete f.reactions;
  return f;
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

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function askText(v: unknown, what: string, max: number, required: boolean): string | undefined {
  if (v === undefined || v === null) {
    if (required) throw badRequest(`${what} is missing`);
    return undefined;
  }
  if (typeof v !== 'string') throw badRequest(`${what} must be text`);
  const t = v.trim();
  if (required && !t) throw badRequest(`${what} is empty`);
  if (t.length > max) throw badRequest(`${what} is longer than ${max} characters`);
  return t || undefined;
}

/** The AskUserQuestion input, checked and trimmed: 1-4 questions of 1-6 options each. Throws 400 on bad input. */
export function cleanAsk(questions: unknown): AskQuestion[] {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) throw badRequest('Ask 1 to 4 questions');
  return questions.map((q, i) => {
    const at = `Question ${i + 1}`;
    if (!isObj(q)) throw badRequest(`${at} must be an object`);
    if (q.header !== undefined && typeof q.header !== 'string') throw badRequest(`${at} header must be text`);
    if (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean') throw badRequest(`${at} multiSelect must be true or false`);
    if (!Array.isArray(q.options) || q.options.length < 1 || q.options.length > 6) throw badRequest(`${at} needs 1 to 6 options`);
    const options = q.options.map((o, j): AskOption => {
      if (!isObj(o)) throw badRequest(`${at} option ${j + 1} must be an object`);
      const description = askText(o.description, `${at} option ${j + 1} description`, 500, false);
      return { label: askText(o.label, `${at} option ${j + 1} label`, 120, true)!, ...(description ? { description } : {}) };
    });
    return { header: (q.header ?? '').trim().slice(0, 40).trim(), question: askText(q.question, `${at} text`, 1000, true)!, multiSelect: q.multiSelect ?? false, options };
  });
}

/** POST /api/ask-user: the Captain's AskUserQuestion menu as an open escalation to you. */
export function askHuman(state: MusterState, actor: string, questions: unknown): Note {
  if (!isCaptain(state, actor)) throw forbidden('Only the Captain asks you questions');
  const ask = cleanAsk(questions);
  const note = postNote(state, { actor, type: 'escalation', text: ask.map((q) => q.question).join('\n\n'), to: HUMAN });
  note.ask = ask;
  return note;
}

/** POST /api/notes/:id/answer: your answer to an ask note, one per question by index. Replies as you and closes it. */
export function answerAsk(state: MusterState, noteId: string, actor: string, answers: unknown): Note {
  if (actor !== HUMAN) throw forbidden('Only you answer the Captain\'s questions');
  const note = requireNote(state, noteId);
  if (!note.ask) throw badRequest(`${note.id} is not a question menu`);
  if (!note.open) throw conflict(`${note.id} is already closed`);
  if (!Array.isArray(answers) || answers.length !== note.ask.length) throw badRequest(`Answer all ${note.ask.length} question${note.ask.length === 1 ? '' : 's'}`);
  const clean = note.ask.map((q, i): AskAnswer => {
    const a = answers[i];
    const at = q.header || `Q${i + 1}`;
    if (!isObj(a)) throw badRequest(`${at}: answer must be an object`);
    if (a.choices !== undefined && (!Array.isArray(a.choices) || a.choices.some((c) => typeof c !== 'string'))) throw badRequest(`${at}: choices must be a list of option labels`);
    const choices = [...new Set((a.choices ?? []) as string[])];
    for (const c of choices) if (!q.options.some((o) => o.label === c)) throw badRequest(`${at}: "${c}" is not one of the options`);
    if (!q.multiSelect && choices.length > 1) throw badRequest(`${at}: pick one option`);
    const other = askText(a.other, `${at}: other`, 1000, false);
    if (!choices.length && !other) throw badRequest(`${at}: pick an option or write an answer`);
    return { header: q.header, choices, ...(other ? { other } : {}) };
  });
  const text = clean
    .map((a, i) => {
      const body = a.choices.length ? `${a.choices.join(', ')}${a.other ? ` (note: ${a.other})` : ''}` : a.other!;
      return `${a.header || `Q${i + 1}`}: ${body}`;
    })
    .join('\n');
  note.answers = clean;
  return replyNote(state, note.id, HUMAN, text, true);
}
