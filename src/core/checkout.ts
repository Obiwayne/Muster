// A merge blocked by uncommitted changes in the main checkout. The Captain may not commit them, so
// Muster asks you once on the Bulletin board (Commit & merge / Set aside & merge) and, when you pick
// one, tells the Captain to merge the approved tasks again. Pure state mutations; git runs in the API.
import type { MusterState, Note } from '../types.js';
import { addFeed, addInbox, captainOf, closeNoteIfOpen, HUMAN, postNote, SYSTEM } from './board.js';

const MAX_LISTED = 12;

/** `git status --porcelain` lines → paths ("assets/x.png"); renames keep the new path. */
export function changedPaths(porcelain: string[]): string[] {
  return porcelain.map((l) => l.slice(3).replace(/^.* -> /, '').replace(/^"(.*)"$/, '$1')).filter(Boolean);
}

export function openCheckoutNote(state: MusterState): Note | undefined {
  return state.notes.find((n) => n.topic === 'checkout' && n.open && !n.dismissed);
}

/** Posts the "merge blocked" note to you, or returns the one still open. */
export function blockedByCheckout(state: MusterState, files: string[], taskId?: string): Note {
  const open = openCheckoutNote(state);
  if (open) return open;
  const listed = files.slice(0, MAX_LISTED).join('\n');
  const more = files.length > MAX_LISTED ? `\n…and ${files.length - MAX_LISTED} more` : '';
  const text =
    `Merge blocked: ${files.length} uncommitted file${files.length === 1 ? '' : 's'} in the main checkout\n` +
    `Nothing can merge until these are committed or set aside. The Captain isn't allowed to touch them, so pick one:\n` +
    `Commit & merge keeps them as a commit on the checked-out branch. Set aside & merge stashes them (git stash pop brings them back).\n\n${listed}${more}`;
  const note = postNote(state, { actor: SYSTEM, type: 'system', to: HUMAN, taskId, text, topic: 'checkout' });
  note.open = true; // stays on "Needs you" until you choose
  return note;
}

/** Tasks you approved that are still waiting to merge. */
export function approvedWaiting(state: MusterState): string[] {
  return state.tasks.filter((t) => t.status === 'ready_for_merge' && t.mergeApproval).map((t) => t.id);
}

/** The checkout is clean again: close the note, log it, and tell the Captain to merge what you approved. */
export function checkoutCleared(state: MusterState, how: 'committed' | 'stashed', detail: string): string[] {
  for (const n of state.notes) if (n.topic === 'checkout') closeNoteIfOpen(n);
  addFeed(state, { kind: 'event', from: HUMAN, text: how === 'committed' ? `committed the uncommitted files in the main checkout (${detail})` : `set aside the uncommitted files in the main checkout (${detail})` });
  const waiting = approvedWaiting(state);
  const captain = captainOf(state);
  if (captain && waiting.length) {
    addInbox(state, {
      agentId: captain.id,
      from: HUMAN,
      kind: 'message',
      text: `The main checkout is clean again (the user ${how === 'committed' ? 'committed' : 'set aside'} the uncommitted files: ${detail}). Merge the approved tasks now with merge_task: ${waiting.join(', ')}.`,
    });
  }
  return waiting;
}
