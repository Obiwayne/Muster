import { beforeEach, describe, expect, it } from 'vitest';
import type { MusterState } from '../types.js';
import { closeNote, escalate, inboxFor, isNeedsYou, listFeed, listNotes, markRead, noteFeedId, nudgeText, postNote, reactFeed, replyNote, sendMessage } from './board.js';
import { emptyState } from './store.js';
import { makeAgent } from './testutil.js';

let s: MusterState;
const inboxOf = (id: string) => inboxFor(s, id).map((i) => `${i.kind}:${i.from}`);

beforeEach(() => {
  s = emptyState('/repo');
  s.agents.push(makeAgent('captain', 'captain'), makeAgent('crew-2', 'crew', { taskId: 'T3' }), makeAgent('crew-3', 'crew'));
});

describe('notes', () => {
  it('fills task and branch from the author and opens stuck/question/waiting', () => {
    const n = postNote(s, { actor: 'crew-2', type: 'stuck', text: 'tests hang' });
    expect(n).toMatchObject({ id: 'N1', from: 'crew-2', taskId: 'T3', branch: 'crew-2/work', open: true });
    expect(postNote(s, { actor: 'crew-2', type: 'progress', text: 'half way' }).open).toBe(false);
  });

  it('delivers stuck/question/waiting to the Captain, waiting also to its target', () => {
    postNote(s, { actor: 'crew-2', type: 'question', text: 'which API?' });
    postNote(s, { actor: 'crew-2', type: 'waiting', text: 'need the invite API', to: 'crew-3' });
    postNote(s, { actor: 'crew-2', type: 'progress', text: 'step done' });
    expect(inboxOf('captain')).toEqual(['note:crew-2', 'note:crew-2']);
    expect(inboxOf('crew-3')).toEqual(['note:crew-2']);
    expect(inboxOf('crew-2')).toEqual([]);
  });

  it('replies go to the author and the Captain; close ends the thread', () => {
    const n = postNote(s, { actor: 'crew-2', type: 'stuck', text: 'help' });
    replyNote(s, n.id, 'crew-3', 'try --runInBand');
    expect(inboxOf('crew-2')).toEqual(['reply:crew-3']);
    expect(inboxOf('captain')).toEqual(['note:crew-2', 'reply:crew-3']);
    replyNote(s, n.id.toLowerCase(), 'crew-2', 'worked', true);
    expect(n.open).toBe(false);
    expect(n.replies.map((r) => r.from)).toEqual(['crew-3', 'crew-2']);
    expect(inboxOf('crew-2')).toEqual(['reply:crew-3']); // own reply is not delivered to yourself
  });

  it('sorts stuck, then question, then the rest, newest first', () => {
    postNote(s, { actor: 'crew-2', type: 'progress', text: 'p1' });
    postNote(s, { actor: 'crew-2', type: 'question', text: 'q1' });
    postNote(s, { actor: 'crew-3', type: 'stuck', text: 's1' });
    postNote(s, { actor: 'crew-3', type: 'question', text: 'q2' });
    expect(listNotes(s).map((n) => n.text)).toEqual(['s1', 'q2', 'q1', 'p1']);
    expect(listNotes(s, { open: true, from: 'crew-2' }).map((n) => n.text)).toEqual(['q1']);
    closeNote(s, 'N2', 'captain');
    expect(listNotes(s, { open: true }).map((n) => n.text)).toEqual(['s1', 'q2']);
  });

  it('only escalations, reviews and notes to you need you', () => {
    const q = postNote(s, { actor: 'crew-2', type: 'question', text: 'q' });
    expect(isNeedsYou(q)).toBe(false);
    expect(() => escalate(s, 'crew-2', 'decide')).toThrow(/Only the Captain/);
    const e = escalate(s, 'captain', 'Pick a pricing tier', q.id);
    expect(e).toMatchObject({ type: 'escalation', to: 'you', open: true, taskId: 'T3' });
    expect(q.replies.at(-1)?.text).toBe(`Escalated to you as ${e.id}`);
    expect(listNotes(s, { needsYou: true }).map((n) => n.id)).toEqual([e.id]);
  });
});

describe('messages and feed', () => {
  it('delivers a direct message to one agent and a broadcast to everyone else', () => {
    sendMessage(s, 'crew-2', 'crew-3', 'I changed the invite API');
    sendMessage(s, 'you', 'everyone', 'standup');
    expect(inboxOf('crew-3')).toEqual(['message:crew-2', 'message:you']);
    expect(inboxOf('captain')).toEqual(['message:you']); // the Captain sees crew-to-crew messages in the feed only
    expect(inboxOf('crew-2')).toEqual(['message:you']);
    expect(() => sendMessage(s, 'crew-2', 'nobody', 'hi')).toThrow(/No agent/);
  });

  it('filters the feed by agent and pages with before', () => {
    sendMessage(s, 'crew-2', 'crew-3', 'a');
    sendMessage(s, 'captain', 'crew-2', 'b');
    sendMessage(s, 'you', 'everyone', 'c');
    expect(listFeed(s, { agent: 'crew-3' }).map((f) => f.text)).toEqual(['a', 'c']);
    expect(listFeed(s, { before: 'F3' }).map((f) => f.id)).toEqual(['F1', 'F2']);
    expect(listFeed(s, { limit: 1 }).map((f) => f.id)).toEqual(['F3']);
  });

  it('marks inbox items read and builds the nudge line', () => {
    const n = postNote(s, { actor: 'crew-2', type: 'stuck', text: 'x' });
    replyNote(s, n.id, 'captain', 'y');
    sendMessage(s, 'crew-3', 'crew-2', 'z');
    const items = inboxFor(s, 'crew-2', true);
    expect(nudgeText(items)).toBe(`[muster] You have 2 new items (reply from captain on ${n.id}; message from crew-3). Call read_inbox.`);
    expect(markRead(s, 'crew-2', [items[0].id])).toBe(1);
    expect(inboxFor(s, 'crew-2', true)).toHaveLength(1);
    markRead(s, 'crew-2');
    expect(inboxFor(s, 'crew-2', true)).toHaveLength(0);
  });
});

describe('read receipts and reactions', () => {
  it('links every inbox item made from a feed line to it (messages, notes, replies)', () => {
    const m = sendMessage(s, 'you', 'everyone', 'standup');
    expect(inboxFor(s, 'crew-2')[0].feedId).toBe(m.id);
    expect(inboxFor(s, 'captain')[0].feedId).toBe(m.id);
    const n = postNote(s, { actor: 'crew-2', type: 'waiting', text: 'need API', to: 'crew-3' });
    const noteLine = s.feed.find((f) => f.kind === 'note' && f.noteId === n.id)!;
    expect(noteFeedId(s, n.id)).toBe(noteLine.id);
    expect(inboxFor(s, 'captain').at(-1)!.feedId).toBe(noteLine.id);
    expect(inboxFor(s, 'crew-3').at(-1)!.feedId).toBe(noteLine.id);
    replyNote(s, n.id, 'crew-3', 'done in 5');
    const replyLine = s.feed.at(-1)!;
    expect(replyLine.kind).toBe('reply');
    expect(inboxFor(s, 'crew-2').at(-1)!.feedId).toBe(replyLine.id);
    expect(inboxFor(s, 'captain').at(-1)!.feedId).toBe(replyLine.id);
  });

  it('reading appends the agent to readBy once, in order', () => {
    const m = sendMessage(s, 'you', 'everyone', 'standup');
    markRead(s, 'crew-3');
    markRead(s, 'crew-2');
    markRead(s, 'crew-2');
    expect(m.readBy).toEqual(['crew-3', 'crew-2']);
    const other = sendMessage(s, 'captain', 'crew-2', 'x');
    expect(other.readBy).toBeUndefined();
  });

  it('marking only some ids marks only their lines', () => {
    const a = sendMessage(s, 'you', 'crew-2', 'a');
    const b = sendMessage(s, 'you', 'crew-2', 'b');
    markRead(s, 'crew-2', [inboxFor(s, 'crew-2')[1].id]);
    expect(a.readBy).toBeUndefined();
    expect(b.readBy).toEqual(['crew-2']);
  });

  it('toggles one reaction per (by, emoji) and validates', () => {
    const m = sendMessage(s, 'captain', 'crew-2', 'please look');
    const inboxBefore = s.inbox.length;
    reactFeed(s, m.id, 'crew-2', '👀');
    reactFeed(s, m.id.toLowerCase(), 'you', '👀');
    reactFeed(s, m.id, 'crew-2', '✅');
    expect(m.reactions!.map((r) => `${r.by}:${r.emoji}`)).toEqual(['crew-2:👀', 'you:👀', 'crew-2:✅']);
    reactFeed(s, m.id, 'crew-2', '👀');
    expect(m.reactions!.map((r) => `${r.by}:${r.emoji}`)).toEqual(['you:👀', 'crew-2:✅']);
    expect(s.inbox.length).toBe(inboxBefore); // not a message: nobody is told
    expect(() => reactFeed(s, m.id, 'crew-2', '🔥')).toThrow(/Unknown reaction/);
    expect(() => reactFeed(s, 'F999', 'crew-2', '👍')).toThrow(/No crew chat line/);
    expect(() => reactFeed(s, m.id, 'nobody', '👍')).toThrow(/No agent/);
  });

  it('accepts an emoji with a variation selector', () => {
    const m = sendMessage(s, 'captain', 'crew-2', 'q');
    reactFeed(s, m.id, 'crew-2', '❓️');
    expect(m.reactions![0].emoji).toBe('❓');
  });
});
