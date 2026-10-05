// Held remote writes (docs/REMOTE.md, "Confirmation gate"): what Claude asked to send through the connector, waiting for
// your tap on Send (phone or desktop). Kept in the gateway's state.json; 15 minutes, then they expire unsent.
import type { NeedItem } from './needs.js';
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
  /** The connector client that asked (the OAuth client's name). */
  client: string;
  createdAt: string;
  expiresAt: string;
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

/** One line of what would be sent. */
export function pendingSummary(w: PendingWrite): string {
  if (w.kind === 'answer') return clip((w.answers ?? []).map((a) => [...(a.choices ?? []), ...(a.other ? [a.other] : [])].join(', ')).join(' | '), 140);
  if (w.kind === 'approve') return `Approve ${w.taskId}; the Captain then merges and pushes it`;
  return clip(w.text ?? '', 140);
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
