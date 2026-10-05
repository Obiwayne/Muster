// Held remote writes (docs/REMOTE.md, "Confirmation gate"): what Claude asked to send through the connector, waiting for
// your tap on Send (phone or desktop). Kept in the gateway's state.json; 15 minutes, then they expire unsent.
// A held write never changes. Its `digest` covers everything that would be sent, the card shows it, and Send must
// quote it back, so a tap always sends exactly what was on screen (a stale or different card gets 409).
import { createHash } from 'node:crypto';
import type { NeedItem, RemoteWriteView } from './needs.js';
import type { WriteInput, WriteKind } from './remote.js';

export const PENDING_TTL_MS = 15 * 60_000;

export interface PendingWrite {
  id: string; // "P1", "P2", ...
  projectId: string;
  projectName: string;
  kind: WriteKind;
  text?: string;
  noteId?: string;
  answers?: WriteInput['answers'];
  taskId?: string;
  /** The note a reply/answer goes to, as it was when the write was held (agent-written; shown as data). */
  replyTo?: { id: string; from: string; type: string; text: string; questions?: { header: string; question: string; multiSelect: boolean; options: string[] }[] };
  /** approve: the task's title when held. */
  taskTitle?: string;
  /** The connector client that asked (the OAuth client's name). */
  client: string;
  createdAt: string;
  expiresAt: string;
  /** sha256 of what would be sent (see digestOf). */
  digest: string;
}

/** What Send would do, as one canonical string: the digest the card shows and Send must quote back. */
export function digestOf(w: Pick<PendingWrite, 'id' | 'projectId' | 'kind' | 'text' | 'noteId' | 'answers' | 'taskId'>): string {
  const what = [w.id, w.projectId, w.kind, w.text ?? null, w.noteId ?? null, w.answers ?? null, w.taskId ?? null];
  return createHash('sha256').update(JSON.stringify(what)).digest('hex');
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1).trimEnd() + '…' : one;
};

export function pendingTitle(w: PendingWrite): string {
  switch (w.kind) {
    case 'goal':
      return `${w.client} wants to set a goal`;
    case 'reply':
      return `${w.client} wants to reply on ${w.noteId}`;
    case 'answer':
      return `${w.client} wants to answer ${w.noteId}`;
    case 'approve':
      return `${w.client} wants to approve ${w.taskId} for merge`;
  }
}

/** One short line for notifications and lists. Cards show `remote` in full instead. */
export function pendingSummary(w: PendingWrite): string {
  if (w.kind === 'answer') return clip((w.answers ?? []).map((a) => [...(a.choices ?? []), ...(a.other ? [a.other] : [])].join(', ')).join(' | '), 140);
  if (w.kind === 'approve') return `Approve ${w.taskId}; the Captain then merges and pushes it`;
  return clip(w.text ?? '', 140);
}

/** Everything the Send card must show, untruncated. */
export function pendingView(w: PendingWrite): RemoteWriteView {
  return {
    pendingId: w.id,
    kind: w.kind,
    projectName: w.projectName,
    client: w.client,
    ...(w.text !== undefined ? { text: w.text } : {}),
    ...(w.answers ? { answers: w.answers } : {}),
    ...(w.replyTo ? { replyTo: w.replyTo } : {}),
    ...(w.taskId ? { taskId: w.taskId } : {}),
    ...(w.taskTitle ? { taskTitle: w.taskTitle } : {}),
    createdAt: w.createdAt,
    expiresAt: w.expiresAt,
    digest: w.digest,
  };
}

/** The Needs-you item for a held write (phone and desktop): Send or Discard. */
export function pendingToNeed(w: PendingWrite): NeedItem {
  return {
    id: `${w.projectId}:${w.id}`,
    projectId: w.projectId,
    projectName: w.projectName,
    kind: 'remote_write',
    ...(w.noteId ? { noteId: w.noteId } : {}),
    ...(w.taskId ? { taskId: w.taskId } : {}),
    title: pendingTitle(w),
    summary: pendingSummary(w),
    from: w.client,
    createdAt: w.createdAt,
    remote: pendingView(w),
    actions: ['send', 'discard'],
  };
}

/** Splits off the writes whose time ran out. */
export function sweepExpired(list: PendingWrite[], now: number): { live: PendingWrite[]; expired: PendingWrite[] } {
  const live: PendingWrite[] = [];
  const expired: PendingWrite[] = [];
  for (const w of list) (Date.parse(w.expiresAt) > now ? live : expired).push(w);
  return { live, expired };
}
