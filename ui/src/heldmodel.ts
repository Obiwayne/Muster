// Held remote writes on the desktop Bulletin board (docs/REMOTE.md, "Needs-you Send card"): pure helpers (no DOM)
// for the HELD rows and the Send card. Rendered by pages/heldcard.ts. The hold is the protection: the card shows
// exactly what Send will send, in full, and Send quotes back the digest of what was rendered.
import type { AskQuestion, Note } from '../../src/types';

export type HeldKind = 'goal' | 'reply' | 'answer' | 'approve';

/** One entry of GET /api/phone/remote/pending (gateway /admin/remote/pending). */
export interface PendingRemote {
  id: string; // "P8" (Send/Discard take this)
  projectId: string; // repoKey(root) of the project it goes to
  noteId?: string;
  pendingId: string;
  kind: HeldKind;
  projectName: string;
  client: string;
  text?: string;
  answers?: { choices?: string[]; other?: string }[];
  replyTo?: { id: string; from: string; text: string };
  taskId?: string;
  taskTitle?: string;
  createdAt: string;
  expiresAt: string;
  digest: string;
  title: string;
  summary: string;
}

/** idle: waiting for your tap · sending · failed (still held; `error` from the server) · expired · gone (404). */
export type HeldStatus = 'idle' | 'sending' | 'failed' | 'expired' | 'gone';

export const WARM_MS = 3 * 60_000;

const tms = (iso: string) => { const t = Date.parse(iso); return Number.isNaN(t) ? 0 : t; };

/** Milliseconds left before it expires (never negative). */
export function msLeft(p: Pick<PendingRemote, 'expiresAt'>, now = Date.now()): number {
  return Math.max(0, tms(p.expiresAt) - now);
}

export function isExpired(p: Pick<PendingRemote, 'expiresAt'>, now = Date.now()): boolean {
  return msLeft(p, now) <= 0;
}

/** "m:ss" (rounded up, so it reads 0:01 until it really is over). */
export function fmtLeft(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Under 3 minutes left: the countdown turns warm orange. */
export function isWarm(ms: number): boolean {
  return ms > 0 && ms < WARM_MS;
}

/** "asked just now", "asked 1 min ago", "asked 13 min ago", "asked 2 h ago". */
export function askedAgo(createdAt: string, now = Date.now()): string {
  const m = Math.floor((now - tms(createdAt)) / 60_000);
  if (m < 1) return 'asked just now';
  if (m < 60) return `asked ${m} min ago`;
  return `asked ${Math.floor(m / 60)} h ago`;
}

export const KIND_LABEL: Record<HeldKind, string> = { goal: 'GOAL', reply: 'REPLY', answer: 'ANSWER', approve: 'APPROVE' };

const who = (id: string, captain: string) => (id === captain ? 'the Captain' : id);
const theirs = (id: string, captain: string) => (id === captain ? "the Captain's" : `${id}'s`);

/** "Claude wants to reply on N12" (or "wanted to" once it is over). */
export function heldTitle(p: PendingRemote, opts: { captain?: string; past?: boolean } = {}): string {
  const captain = opts.captain ?? 'captain';
  const v = opts.past ? 'wanted to' : 'wants to';
  switch (p.kind) {
    case 'goal': return `${p.client} ${v} give the Captain a goal`;
    case 'reply': return `${p.client} ${v} reply on ${p.noteId ?? p.replyTo?.id ?? 'a note'}`;
    case 'answer': {
      const n = p.answers?.length ?? 0;
      const of = p.replyTo ? theirs(p.replyTo.from, captain) : "the Captain's";
      return `${p.client} ${v} answer ${of} ${n === 1 ? 'question' : `${n} questions`} on ${p.noteId ?? p.replyTo?.id ?? 'a note'}`;
    }
    case 'approve': return `${p.client} ${v} approve ${p.taskId ?? 'a task'} for merge`;
  }
}

/** One answer as plain text: "MP4 (H.264), WebM" plus the free text. */
export function answerText(a: { choices?: string[]; other?: string }): string {
  return [...(a.choices ?? []), ...(a.other ? [a.other] : [])].join(', ');
}

/** What the HELD row says, in full (never clipped): "Claude wants to reply on N12: Go with 7 days…". */
export function rowText(p: PendingRemote, captain = 'captain'): string {
  const what = p.kind === 'answer' ? (p.answers ?? []).map(answerText).join(' · ')
    : p.kind === 'approve' ? [p.taskId, p.taskTitle].filter(Boolean).join(' ')
    : p.text ?? '';
  return what ? `${heldTitle(p, { captain })}: ${what}` : heldTitle(p, { captain });
}

export interface Recipient { id: string; kind: 'agent' | 'task'; label: string }

/** Who it goes to: goal → captain; reply/answer → the note's author and the captain; approve → the task. */
export function recipients(p: PendingRemote, captain = 'captain'): Recipient[] {
  if (p.kind === 'approve') return [{ id: p.taskId ?? '', kind: 'task', label: [p.taskId, p.taskTitle].filter(Boolean).join(' ') }];
  const ids = p.kind === 'goal' ? [captain] : [...(p.replyTo?.from ? [p.replyTo.from] : []), captain];
  return [...new Set(ids)].map((id) => ({ id, kind: 'agent', label: id }));
}

/** "ada and the Captain", "the Captain", "T3". */
export function recipientText(p: PendingRemote, captain = 'captain'): string {
  const names = recipients(p, captain).map((r) => (r.kind === 'agent' ? who(r.id, captain) : r.id));
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? '';
}

/** The row's mono meta line: "P8 · from Claude · to ada and the Captain". */
export function rowMeta(p: PendingRemote, captain = 'captain'): string {
  return [p.pendingId, `from ${p.client}`, p.kind === 'approve' ? `approve ${p.taskId ?? ''}`.trim() : `to ${recipientText(p, captain)}`].join(' · ');
}

/** The Send button's label. */
export function sendLabel(p: PendingRemote): string {
  switch (p.kind) {
    case 'goal': return 'Send goal';
    case 'reply': return 'Send reply';
    case 'answer': return (p.answers?.length ?? 0) === 1 ? 'Send answer' : 'Send answers';
    case 'approve': return 'Send approval';
  }
}

/** The "Nothing has been sent yet." callout's explanation, naming the recipients. */
export function lockText(p: PendingRemote, captain = 'captain'): string {
  const to = recipientText(p, captain);
  const chat = `shows in crew chat as yours via ${p.client}`;
  switch (p.kind) {
    case 'goal': return `This goal is locked. It reaches the Captain, and ${chat}, only when you press Send.`;
    case 'reply': return `This text is locked. It reaches ${to}, and ${chat}, only when you press Send.`;
    case 'answer': {
      const one = (p.answers?.length ?? 0) === 1;
      return one
        ? `This answer is locked. It reaches ${to}, and ${chat}, only when you press Send.`
        : `These answers are locked. They reach ${to}, and show in crew chat as yours via ${p.client}, only when you press Send.`;
    }
    case 'approve': return `${p.taskId ?? 'The task'} is approved for merge only when you press Send. The Captain then merges and pushes it.`;
  }
}

/** "WILL SEND EXACTLY THIS" / "… THESE 3 ANSWERS"; "WAS NOT SENT" once it is over. */
export function exactLabel(p: PendingRemote, over = false): string {
  if (over) return 'WAS NOT SENT';
  if (p.kind === 'answer') {
    const n = p.answers?.length ?? 0;
    return n === 1 ? 'WILL SEND EXACTLY THIS ANSWER' : `WILL SEND EXACTLY THESE ${n} ANSWERS`;
  }
  return 'WILL SEND EXACTLY THIS';
}

export interface AnswerView { n: number; question: string; choices: string[]; other: string }

/** Every answer with its question (from the note's menu when the board has it; the held write has no question text). */
export function answerViews(p: PendingRemote, ask?: AskQuestion[]): AnswerView[] {
  return (p.answers ?? []).map((a, i) => {
    const q = ask?.[i];
    const question = q ? (q.header && q.question ? `${q.header}: ${q.question}` : q.question || q.header || '') : '';
    return { n: i + 1, question: question || `Answer ${i + 1}`, choices: [...(a.choices ?? [])], other: a.other ?? '' };
  });
}

/** The failed callout's text: the server's reason, then that it's still held. */
export function failedText(error: string): string {
  const e = error.trim().replace(/\s+$/, '');
  return `${e ? (/[.!?]$/.test(e) ? e : `${e}.`) + ' ' : ''}It's still held, unchanged. Try again, or discard it.`;
}

/** Order on the board: soonest to expire first. */
export function sortHeld<T extends Pick<PendingRemote, 'expiresAt' | 'pendingId'>>(list: T[]): T[] {
  return [...list].sort((a, b) => tms(a.expiresAt) - tms(b.expiresAt) || a.pendingId.localeCompare(b.pendingId));
}

// ---------------------------------------------------------------- which project

/**
 * The string the gateway hashes for a project id (src/core/tokens.ts repoKey): forward slashes, no trailing slash,
 * lower case for a Windows path. The board hashes it (sha256, first 16 hex) to find its own held writes.
 */
export function projectKeyInput(repoRoot: string): string {
  let p = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[A-Za-z]:\//.test(p) || /^[A-Za-z]:$/.test(p) || p.startsWith('//')) p = p.toLowerCase();
  return p;
}

/** Held writes for this board's project: by id when known, else (no WebCrypto) by project name. */
export function forProject<T extends Pick<PendingRemote, 'projectId' | 'projectName'>>(list: T[], project: { id?: string | null; name: string }): T[] {
  return list.filter((p) => (project.id ? p.projectId === project.id : p.projectName === project.name));
}

/** The note a held reply/answer goes to, from the board's state (for its type and the menu's questions). */
export function targetNote(p: Pick<PendingRemote, 'noteId' | 'replyTo'>, notes: Note[]): Note | undefined {
  const id = p.noteId ?? p.replyTo?.id;
  return id ? notes.find((n) => n.id === id) : undefined;
}
