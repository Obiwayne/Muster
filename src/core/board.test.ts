import { beforeEach, describe, expect, it } from 'vitest';
import type { MusterState, Task } from '../types.js';
import { answerAsk, askHuman, cleanAsk, closeNote, reopenWaiting, waitsOnYou, escalate, inboxFor, isNeedsYou, listFeed, listNotes, markRead, noteFeedId, nudgeText, postNote, reactFeed, replyNote, sendMessage } from './board.js';
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

  it('a reply or answer with via carries it on the feed item; without via there is none', () => {
    const via = { client: 'Claude', approvedOn: 'phone' as const, approvedAt: '2026-10-05T09:30:00.000Z' };
    const n = postNote(s, { actor: 'crew-2', type: 'question', text: 'remote?' });
    replyNote(s, n.id, 'you', 'yes', false, via);
    replyNote(s, n.id, 'you', 'plain');
    const [withVia, plain] = s.feed.filter((f) => f.kind === 'reply' && f.noteId === n.id);
    expect(withVia).toMatchObject({ from: 'you', text: 'yes', via });
    expect(plain).not.toHaveProperty('via');
    const q = askHuman(s, 'captain', [{ header: 'Go', question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }]);
    answerAsk(s, q.id, 'you', [{ choices: ['Yes'] }], { ...via, approvedOn: 'not held' });
    expect(s.feed.filter((f) => f.kind === 'reply' && f.noteId === q.id)).toEqual([expect.objectContaining({ text: 'Go: Yes', via: { ...via, approvedOn: 'not held' } })]);
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

describe('Captain questions (AskUserQuestion)', () => {
  const art = { header: 'Art model', question: 'Which image model?', options: [{ label: 'Flux (Recommended)', description: 'Best quality' }, { label: 'SDXL' }, { label: 'Imagen' }] };
  const size = { header: 'Caption size', question: 'How big are captions?', multiSelect: true, options: [{ label: 'Small' }, { label: 'Large' }] };

  it('cleans the questions and rejects bad input', () => {
    expect(cleanAsk([{ ...art, header: '  A very long header that runs past forty characters  ' }])[0]).toMatchObject({ header: 'A very long header that runs past forty', multiSelect: false });
    expect(cleanAsk([{ question: ' Go? ', options: [{ label: ' Yes ', description: '' }] }])).toEqual([{ header: '', question: 'Go?', multiSelect: false, options: [{ label: 'Yes' }] }]);
    expect(() => cleanAsk([])).toThrow(/1 to 4/);
    expect(() => cleanAsk([art, art, art, art, art])).toThrow(/1 to 4/);
    expect(() => cleanAsk([{ ...art, question: ' ' }])).toThrow(/text is empty/);
    expect(() => cleanAsk([{ ...art, options: [] }])).toThrow(/1 to 6 options/);
    expect(() => cleanAsk([{ ...art, options: Array.from({ length: 7 }, (_, i) => ({ label: `o${i}` })) }])).toThrow(/1 to 6 options/);
    expect(() => cleanAsk([{ ...art, options: [{ label: 'x'.repeat(121) }] }])).toThrow(/longer than 120/);
    expect(() => cleanAsk([{ ...art, options: [{ label: 'a', description: 'x'.repeat(501) }] }])).toThrow(/longer than 500/);
    expect(() => cleanAsk([{ ...art, multiSelect: 'yes' }])).toThrow(/multiSelect/);
  });

  it('only the Captain asks; the note is an open escalation to you', () => {
    expect(() => askHuman(s, 'crew-2', [art])).toThrow(/Only the Captain/);
    const n = askHuman(s, 'captain', [art, size]);
    expect(n).toMatchObject({ type: 'escalation', from: 'captain', to: 'you', open: true, text: 'Which image model?\n\nHow big are captions?' });
    expect(n.ask!.map((q) => q.header)).toEqual(['Art model', 'Caption size']);
    expect(isNeedsYou(n)).toBe(true);
  });

  it('an answer replies as you, closes the note and reaches the Captain', () => {
    const n = askHuman(s, 'captain', [art, size]);
    answerAsk(s, n.id.toLowerCase(), 'you', [{ choices: ['SDXL'], other: 'cheaper' }, { choices: ['Small', 'Large'] }]);
    expect(n.open).toBe(false);
    expect(n.answers).toEqual([{ header: 'Art model', choices: ['SDXL'], other: 'cheaper' }, { header: 'Caption size', choices: ['Small', 'Large'] }]);
    expect(n.replies.at(-1)).toMatchObject({ from: 'you', text: 'Art model: SDXL (note: cheaper)\nCaption size: Small, Large' });
    expect(inboxOf('captain')).toEqual(['reply:you']);
    expect(() => answerAsk(s, n.id, 'you', [{ choices: ['SDXL'] }, { choices: ['Small'] }])).toThrow(/already closed/);
  });

  it('free text alone answers, and an empty header reads as Q<n>', () => {
    const n = askHuman(s, 'captain', [{ ...art, header: '' }]);
    answerAsk(s, n.id, 'you', [{ choices: [], other: 'Ask me tomorrow' }]);
    expect(n.replies.at(-1)!.text).toBe('Q1: Ask me tomorrow');
  });

  it('validates the answers', () => {
    const n = askHuman(s, 'captain', [art, size]);
    const ok = { choices: ['Small'] };
    expect(() => answerAsk(s, n.id, 'captain', [{ choices: ['SDXL'] }, ok])).toThrow(/Only you/);
    expect(() => answerAsk(s, n.id, 'you', [{ choices: ['SDXL'] }])).toThrow(/Answer all 2/);
    expect(() => answerAsk(s, n.id, 'you', [{ choices: ['Midjourney'] }, ok])).toThrow(/not one of the options/);
    expect(() => answerAsk(s, n.id, 'you', [{ choices: ['SDXL', 'Imagen'] }, ok])).toThrow(/pick one option/);
    expect(() => answerAsk(s, n.id, 'you', [{ choices: [], other: ' ' }, ok])).toThrow(/pick an option or write/);
    expect(() => answerAsk(s, n.id, 'you', [{ choices: ['SDXL'], other: 'x'.repeat(1001) }, ok])).toThrow(/longer than 1000/);
    const plain = postNote(s, { actor: 'captain', type: 'escalation', text: 'hm', to: 'you' });
    expect(() => answerAsk(s, plain.id, 'you', [ok])).toThrow(/not a question menu/);
    expect(n.open).toBe(true);
    expect(n.answers).toBeUndefined();
  });

  it('a free-text reply on an ask note leaves it open', () => {
    const n = askHuman(s, 'captain', [art]);
    replyNote(s, n.id, 'you', 'Let me think');
    expect(n.open).toBe(true);
  });
});

describe('notes that wait on you', () => {
  const task = (id: string, extra: Partial<Task>): Task => ({
    id, title: id, description: '', dependsOn: [], stations: ['plan', 'approve', 'review'], stationIndex: 1, status: 'awaiting_approval',
    createdBy: 'captain', createdAt: 'x', updatedAt: 'x', history: [], ...extra,
  });

  it('a Captain reply with close=true leaves a waiting approval note open; your reply closes it', () => {
    s.tasks.push(task('T1', {}));
    const n = postNote(s, { actor: 'crew-2', type: 'approval', taskId: 'T1', to: 'you', text: 'T1 waits for your approval' });
    expect(waitsOnYou(s, n)).toBe(true);
    replyNote(s, n.id, 'captain', 'Got it, redrawing the logo', true);
    expect(n.open).toBe(true);
    expect(isNeedsYou(n)).toBe(true);
    expect(() => closeNote(s, n.id, 'captain')).toThrow(/still waits/);
    replyNote(s, n.id, 'you', 'never mind', true);
    expect(n.open).toBe(false);
  });

  it('a review note closes normally once you approved the merge', () => {
    s.tasks.push(task('T2', { status: 'ready_for_merge', stationIndex: 2 }));
    const n = postNote(s, { actor: 'captain', type: 'review', taskId: 'T2', text: 'T2 ready' });
    expect(() => closeNote(s, n.id, 'captain')).toThrow();
    s.tasks[0].mergeApproval = { at: 'x' };
    closeNote(s, n.id, 'captain');
    expect(n.open).toBe(false);
  });

  it('reopenWaiting puts back the newest approval note an agent closed while the task still waits', () => {
    s.tasks.push(task('T1', {}), task('T3', { status: 'merged' }));
    const old = postNote(s, { actor: 'crew-2', type: 'approval', taskId: 'T1', to: 'you', text: 'first' });
    const n = postNote(s, { actor: 'crew-2', type: 'approval', taskId: 'T1', to: 'you', text: 'second' });
    const done = postNote(s, { actor: 'crew-2', type: 'approval', taskId: 'T3', to: 'you', text: 'merged' });
    for (const x of [old, n, done]) x.open = false;
    expect(reopenWaiting(s)).toBe(1);
    expect([old.open, n.open, done.open]).toEqual([false, true, false]);
    expect(reopenWaiting(s)).toBe(0);
  });
});
