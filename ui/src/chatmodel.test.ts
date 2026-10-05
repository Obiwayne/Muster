import { describe, expect, it } from 'vitest';
import type { FeedItem } from '../../src/types';
import {
  badgeLabel, buildRows, eventText, isPathLike, isRemoteMine, mineTarget, needsYouCount, parseBlocks, parseHandoff, parseTaskRow, summarizeReactions, tokenize,
  typingAgent, unreadIndex, viaView,
} from './chatmodel';

const T0 = Date.parse('2026-10-03T21:00:00');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
let n = 0;
const fi = (min: number, kind: FeedItem['kind'], from: string, text: string, extra: Partial<FeedItem> = {}): FeedItem =>
  ({ id: `F${++n}`, at: at(min), kind, from, text, ...extra });

describe('tokenize', () => {
  it('finds tasks, colours, backticks, calls and paths', () => {
    expect(tokenize('The button is hard-coded #2563EB. Use `var(--color-primary)` like T3, see test/fixtures.ts or makeInviteToken().')).toEqual([
      { k: 'text', t: 'The button is hard-coded ' },
      { k: 'color', t: '#2563EB' },
      { k: 'text', t: '. Use ' },
      { k: 'code', t: 'var(--color-primary)' },
      { k: 'text', t: ' like ' },
      { k: 'task', t: 'T3' },
      { k: 'text', t: ', see ' },
      { k: 'code', t: 'test/fixtures.ts' },
      { k: 'text', t: ' or ' },
      { k: 'code', t: 'makeInviteToken()' },
      { k: 'text', t: '.' },
    ]);
  });

  it('keeps plain words plain and never produces markup', () => {
    expect(tokenize('<b>and/or</b> T2/T3 3.5 e.g. ok')).toEqual([{ k: 'text', t: '<b>and/or</b> T2/T3 3.5 e.g. ok' }]);
  });

  it('chips paths in brackets and branch names', () => {
    expect(tokenize('(on crew-2/invite-api)')).toEqual([{ k: 'text', t: '(on ' }, { k: 'code', t: 'crew-2/invite-api' }, { k: 'text', t: ')' }]);
    expect(isPathLike('src/ui/ShareDialog.tsx:42')).toBe(false);
    expect(isPathLike('src/ui/ShareDialog.tsx')).toBe(true);
    expect(isPathLike('./scripts')).toBe(true);
    expect(isPathLike('README.md')).toBe(true);
    expect(isPathLike('and/or')).toBe(false);
  });

  it('marks mentions of known agents only', () => {
    expect(tokenize('@crew-2 and @nobody', ['crew-2'])).toEqual([{ k: 'mention', t: 'crew-2' }, { k: 'text', t: ' and @nobody' }]);
  });
});

describe('parseBlocks', () => {
  const agents = ['crew-2', 'crew-3', 'captain'];
  it('reads task rows with assignees', () => {
    expect(parseTaskRow('- T3 Invite API endpoints → crew-2', agents)).toEqual({ taskId: 'T3', title: 'Invite API endpoints', agent: 'crew-2' });
    expect(parseTaskRow('T4: Share dialog UI · after T3 (crew-3)', agents)).toEqual({ taskId: 'T4', title: 'Share dialog UI · after T3', agent: 'crew-3' });
    expect(parseTaskRow('T4 waits on T3', agents)).toBeNull();
    expect(parseTaskRow('Goal: T3 first → crew-2', agents)).toBeNull();
  });

  it('splits paragraphs, lists and task rows', () => {
    const b = parseBlocks('Goal: the invite flow.\n- T3 Invite API → crew-2\n- T4 Share dialog → crew-3\n\n• one\n• two `x`\nDone.', { agents, taskRows: true });
    expect(b.map((x) => x.k)).toEqual(['p', 'tasks', 'list', 'p']);
    expect(b[1]).toEqual({ k: 'tasks', rows: [{ taskId: 'T3', title: 'Invite API', agent: 'crew-2' }, { taskId: 'T4', title: 'Share dialog', agent: 'crew-3' }] });
    expect(b[2]).toEqual({ k: 'list', items: [[{ k: 'text', t: 'one' }], [{ k: 'text', t: 'two ' }, { k: 'code', t: 'x' }]] });
  });

  it('leaves task-looking lines alone when task rows are off', () => {
    expect(parseBlocks('- T3 Invite API → crew-2', { agents }).map((x) => x.k)).toEqual(['list']);
  });
});

describe('events', () => {
  it('parses hand-offs from the orchestrator and the mock', () => {
    expect(parseHandoff({ kind: 'event', from: 'crew-2', text: 'handed T3 to crew-5: Endpoints and tests done, 41 passing.' }))
      .toEqual({ from: 'crew-2', taskId: 'T3', to: 'crew-5', station: undefined, note: 'Endpoints and tests done, 41 passing.' });
    expect(parseHandoff({ kind: 'event', from: 'ada', text: 'ada handed T3 to cleo (test station): "endpoints + tests done"' }))
      .toEqual({ from: 'ada', taskId: 'T3', to: 'cleo', station: 'test station', note: 'endpoints + tests done' });
    expect(parseHandoff({ kind: 'event', from: 'crew-2', text: 'handed T3 to review: (no note)' })?.note).toBe('');
    expect(parseHandoff({ kind: 'message', from: 'crew-2', text: 'handed T3 to crew-5: x' })).toBeNull();
  });

  it('prefixes the actor when the text starts with a verb', () => {
    expect(eventText({ from: 'crew-2', text: 'claimed T3 Invite API (build)' })).toBe('crew-2 claimed T3 Invite API (build)');
    expect(eventText({ from: 'ada', text: 'ada claimed T3' })).toBe('ada claimed T3');
    expect(eventText({ from: 'captain', text: 'T3 waits for your approval (approval)' })).toBe('T3 waits for your approval (approval)');
    expect(eventText({ from: 'muster', text: 'orchestrator started' })).toBe('orchestrator started');
  });
});

describe('buildRows', () => {
  it('groups one sender within 5 minutes, merges events within a minute and threads note replies', () => {
    n = 0;
    const list = [
      fi(0, 'message', 'captain', 'a', { to: 'everyone' }),
      fi(2, 'message', 'captain', 'b', { to: 'everyone' }),
      fi(8, 'message', 'captain', 'c', { to: 'everyone' }), // 6 min later: new group
      fi(8.2, 'event', 'crew-2', 'claimed T3'),
      fi(8.5, 'event', 'crew-3', 'claimed T4'),
      fi(9, 'note', 'crew-3', 'Which token?', { noteId: 'N14', noteType: 'stuck' }),
      fi(10, 'reply', 'captain', 'Use base62', { noteId: 'N14' }),
      fi(10.5, 'note', 'crew-3', 'progress', { noteId: 'N15', noteType: 'progress' }),
      fi(11, 'reply', 'crew-2', 'Loose reply', { noteId: 'N9' }),
      fi(12, 'event', 'crew-2', 'handed T3 to crew-5: done'),
    ];
    const rows = buildRows(list);
    expect(rows.map((r) => r.t)).toEqual(['day', 'group', 'group', 'events', 'card', 'notice', 'group', 'handoff']);
    expect(rows[1].t === 'group' && rows[1].items.map((x) => x.text)).toEqual(['a', 'b']);
    expect(rows[3].t === 'events' && rows[3].items.length).toBe(2);
    expect(rows[4].t === 'card' && rows[4].replies.map((x) => x.text)).toEqual(['Use base62']);
  });

  it('places the unread divider before the first line from someone else', () => {
    n = 0;
    const list = [fi(0, 'message', 'crew-2', 'x'), fi(1, 'message', 'you', 'mine', { to: 'crew-2' }), fi(2, 'message', 'crew-2', 'y'), fi(3, 'event', 'crew-2', 'claimed T3')];
    expect(unreadIndex(list, null)).toBe(-1);
    expect(unreadIndex(list, 'F1')).toBe(2);
    expect(unreadIndex(list, 'F4')).toBe(-1);
    const rows = buildRows(list, { lastSeen: 'F1' });
    expect(rows.map((r) => r.t)).toEqual(['day', 'group', 'group', 'unread', 'group', 'events']);
    expect(rows[3]).toEqual({ t: 'unread', count: 2 });
  });

  it('starts a new day with a day row', () => {
    n = 0;
    const rows = buildRows([fi(-24 * 60, 'message', 'captain', 'old'), fi(0, 'message', 'captain', 'new')]);
    expect(rows.map((r) => r.t)).toEqual(['day', 'group', 'day', 'group']);
  });
});

describe('reactions, typing, badges', () => {
  it('summarizes reactions in emoji order', () => {
    expect(summarizeReactions([
      { emoji: '✅', by: 'crew-3', at: at(0) },
      { emoji: '👍', by: 'crew-2', at: at(0) },
      { emoji: '👍', by: 'design', at: at(0) },
    ])).toEqual([{ emoji: '👍', by: ['crew-2', 'design'] }, { emoji: '✅', by: ['crew-3'] }]);
    expect(summarizeReactions(undefined)).toEqual([]);
  });

  it('shows typing for a working recipient of the latest message', () => {
    n = 0;
    const agents = [{ id: 'captain', status: 'working' }, { id: 'crew-2', status: 'idle' }];
    const now = T0 + 3 * 60_000;
    expect(typingAgent([fi(0, 'message', 'you', 'hi', { to: 'captain' })], agents, [], now)).toBe('captain');
    expect(typingAgent([fi(0, 'message', 'you', 'hi', { to: 'crew-2' })], agents, [], now)).toBeNull();
    expect(typingAgent([fi(0, 'message', 'you', 'hi', { to: 'everyone' })], agents, [], now)).toBeNull();
    expect(typingAgent([fi(0, 'message', 'you', 'hi', { to: 'captain' })], agents, [], now + 20 * 60_000)).toBeNull();
    expect(typingAgent([fi(0, 'reply', 'crew-2', 'r', { noteId: 'N1' }), fi(1, 'event', 'x', 'y')], agents, [{ id: 'N1', from: 'captain' }], now)).toBe('captain');
  });

  it('counts needs-you notes without dismissed ones and labels the badge', () => {
    expect(needsYouCount([
      { open: true, type: 'escalation' },
      { open: true, type: 'review' },
      { open: true, type: 'approval' },
      { open: true, type: 'question', to: 'you' },
      { open: true, type: 'escalation', dismissed: true },
      { open: false, type: 'review' },
      { open: true, type: 'stuck' },
    ])).toBe(4);
    expect([0, 1, 9, 10, 42].map(badgeLabel)).toEqual(['', '1', '9', '9+', '9+']);
  });
});

describe('sent via the remote connector', () => {
  const via = (approvedOn: 'phone' | 'desktop' | 'not held', min = 6) => ({ client: 'Claude', approvedOn, approvedAt: at(min) });

  it('renders a remote reply of yours as its own right-side bubble and keeps it in the note card', () => {
    n = 0;
    const list = [
      fi(0, 'note', 'ada', 'Should invite links expire after 7 days or 30?', { noteId: 'N12', noteType: 'question' }),
      fi(1, 'reply', 'captain', 'Hold on 7 days.', { noteId: 'N12' }),
      fi(6, 'reply', 'you', 'Go with 7 days.', { noteId: 'N12', via: via('phone') }),
      fi(7, 'reply', 'you', 'Typed myself.', { noteId: 'N12' }),
    ];
    const rows = buildRows(list);
    expect(rows.map((r) => r.t)).toEqual(['day', 'card', 'group']);
    const card = rows[1].t === 'card' ? rows[1] : null;
    expect(card?.replies.map((r) => r.text)).toEqual(['Hold on 7 days.', 'Go with 7 days.', 'Typed myself.']);
    const g = rows[2].t === 'group' ? rows[2] : null;
    expect(g?.items.map((r) => r.text)).toEqual(['Go with 7 days.']); // the one you typed stays only in the card
    expect(g?.items[0].from).toBe('you');
  });

  it('keeps a via line out of a group with lines you typed', () => {
    n = 0;
    const rows = buildRows([
      fi(0, 'message', 'you', 'typed', { to: 'captain' }),
      fi(1, 'message', 'you', 'from Claude', { to: 'captain', via: via('desktop', 1) }),
    ]);
    expect(rows.map((r) => r.t)).toEqual(['day', 'group', 'group']);
  });

  it('only your lines with via count as remote', () => {
    expect(isRemoteMine({ from: 'you', via: via('phone') })).toBe(true);
    expect(isRemoteMine({ from: 'you' })).toBe(false);
    expect(isRemoteMine({ from: 'ada', via: via('phone') })).toBe(false);
  });

  it('describes the chip: where you approved it, or that the hold was off', () => {
    expect(viaView(via('phone', 66))).toEqual({
      chip: 'via Claude', title: 'Sent from the Claude app', detail: 'approved on your phone at 22:06',
      text: 'Sent from the Claude app · approved on your phone at 22:06',
    });
    expect(viaView(via('desktop', 66)).detail).toBe('approved on your desktop at 22:06');
    expect(viaView(via('not held')).text).toBe('Sent from the Claude app · the hold was off');
    expect(viaView({ client: '', approvedOn: 'phone', approvedAt: at(0) }).chip).toBe('via Claude');
  });

  it('addresses a remote reply to the note author and links the note', () => {
    const notes = [{ id: 'N12', from: 'ada' }];
    expect(mineTarget({ kind: 'reply', noteId: 'N12' }, notes)).toEqual({ to: 'ada', noteId: 'N12' });
    expect(mineTarget({ kind: 'reply', noteId: 'N99' }, notes)).toEqual({ noteId: 'N99' });
    expect(mineTarget({ kind: 'message', to: 'captain' }, notes)).toEqual({ to: 'captain' });
  });
});
