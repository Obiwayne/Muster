// Crew chat: one chronological log of messages, note cards, hand-offs and events, plus a composer.
// Agent text is only ever rendered as text nodes (chips come from chatmodel.tokenize, never HTML).
import type { FeedItem, MusterState, Note } from '../../../src/types';
import { REACTION_EMOJI } from '../../../src/types';
import { h, icon, setChildren, toggle, type Child } from '../dom';
import type { Snapshot } from '../events';
import type { Page } from '../page';
import { api } from '../api';
import { errToast, run } from '../actions';
import { NOTE_BADGE, dayLabel, displayName, hhmm, idNum, initial, ms, noteLabel, roleOf, sortedAgents } from '../util';
import { buildRows, eventText, feedNum, parseBlocks, summarizeReactions, typingAgent, type Block, type Row, type Seg } from '../chatmodel';

const SHOW_EVENTS_KEY = 'muster.chat.showEvents';
const SEEN_KEY = 'muster.chat.lastSeen';
const PLACEHOLDER = (name: string) => `Message the crew as ${name}… use @ to mention, T3 to link a task`;

export function createChat(): Page {
  let snap: Snapshot | null = null;
  let agentFilter: string | null = null;
  let showEvents = (() => { try { return localStorage.getItem(SHOW_EVENTS_KEY) !== '0'; } catch { return true; } })();
  const items = new Map<string, FeedItem>();
  let loaded = false;
  let lastId = '';
  // Unread divider: the last-seen feed id when this view of the chat started (undefined: not captured yet).
  let anchor: string | null | undefined;
  let replyTo: { noteId: string; from: string } | null = null;

  const chips = h('div', { style: 'display:flex;align-items:center;gap:6px;flex:1;min-width:0;flex-wrap:wrap' });
  const tgl = toggle(showEvents, (v) => {
    showEvents = v;
    try { localStorage.setItem(SHOW_EVENTS_KEY, v ? '1' : '0'); } catch { /* ignore */ }
    renderFeed(true);
  }, true);
  const filterbar = h('div.filterbar.chat-filter', null, chips, h('span.faint', { style: 'font-size:12px' }, 'Show hand-offs and notes'), tgl);
  const feed = h('div.feed.chat-feed');
  const jump = h('button.btn.sm.secondary.jump', { hidden: true, onclick: () => { feed.scrollTop = feed.scrollHeight; jump.hidden = true; } }, icon('down', 12), 'New messages');
  const toSel = h('select') as HTMLSelectElement;
  const input = h('input.field', { placeholder: PLACEHOLDER('you') }) as HTMLInputElement;
  const send = h('button.btn.lg.accent', null, 'Send') as HTMLButtonElement;
  const replyChip = h('button.reply-chip', { hidden: true, title: 'Stop replying to the note', onclick: () => setReply(null) });
  const emojiPick = h('div.emoji-pick', { hidden: true }, REACTION_EMOJI.map((e) => h('button', { title: `Insert ${e}`, onclick: () => insertEmoji(e) }, e)));
  const emojiBtn = h('button.emoji-btn', { title: 'Insert an emoji', onclick: () => { emojiPick.hidden = !emojiPick.hidden; } }, icon('smile', 17));
  const composer = h('div.composer', null,
    h('label.to-select', null, h('span.to', null, 'To'), toSel, icon('chevron', 12, 2.5)),
    replyChip, input, h('div.emoji-wrap', null, emojiBtn, emojiPick), send);
  const el = h('div.page', null, filterbar, feed, jump, composer);

  // Stay pinned to the bottom while rows grow after rendering (emoji fonts, wrapping) if the reader was at the bottom.
  let pinned = true;
  feed.addEventListener('scroll', () => {
    pinned = atBottom(8);
    if (atBottom()) jump.hidden = true;
  });
  const grow = new ResizeObserver(() => { if (pinned) feed.scrollTop = feed.scrollHeight; });
  document.addEventListener('mousedown', (e) => {
    if (!emojiPick.hidden && !(e.target as Element).closest?.('.emoji-wrap')) emojiPick.hidden = true;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') anchor = undefined;
    else renderFeed(true);
  });

  function insertEmoji(e: string): void {
    const s = input.selectionStart ?? input.value.length;
    const t = input.selectionEnd ?? s;
    input.value = input.value.slice(0, s) + e + input.value.slice(t);
    input.focus();
    input.setSelectionRange(s + e.length, s + e.length);
    emojiPick.hidden = true;
  }

  function setReply(r: { noteId: string; from: string } | null): void {
    replyTo = r;
    replyChip.hidden = !r;
    setChildren(replyChip, r ? [icon('reply', 12), `Reply on ${r.noteId}`, icon('x', 11)] : []);
    toSel.disabled = !!r;
    input.placeholder = r ? `Reply on ${r.noteId}… goes to ${snap && roleOf(snap.state, r.from) === 'captain' ? 'the Captain' : `${displayName(r.from)} and the Captain`}` : PLACEHOLDER(displayName('you'));
  }

  const doSend = async () => {
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    if (replyTo) {
      const ok = await run(api.reply(replyTo.noteId, text));
      send.disabled = false;
      if (ok) { input.value = ''; setReply(null); }
      return;
    }
    const r = await run(api.message(toSel.value || 'everyone', text));
    send.disabled = false;
    if (r) {
      input.value = '';
      items.set(r.id, r);
      renderFeed(true, true);
    }
  };
  send.onclick = doSend;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) doSend();
    if (e.key === 'Escape' && replyTo) setReply(null);
  });

  function startReply(f: FeedItem): void {
    if (f.noteId && (f.kind === 'note' || f.kind === 'reply')) {
      const note = snap?.state.notes.find((n) => n.id === f.noteId);
      setReply({ noteId: f.noteId, from: note?.from ?? f.from });
    } else {
      setReply(null);
      if ([...toSel.options].some((o) => o.value === f.from)) toSel.value = f.from;
    }
    input.focus();
  }

  async function react(id: string, emoji: string): Promise<void> {
    try {
      const f = await api.react(id, emoji);
      items.set(f.id, f);
      renderFeed(true);
    } catch (e) {
      errToast(e);
    }
  }

  // ---------------------------------------------------------------- scrolling, last seen

  function settle(fn: () => void): void {
    fn();
    requestAnimationFrame(fn); // fonts and wrapping can change heights after this frame
    document.fonts?.ready.then(() => { if (jump.hidden) fn(); });
  }
  function toBottom(): void {
    jump.hidden = true;
    pinned = true;
    settle(() => { feed.scrollTop = feed.scrollHeight; });
  }
  function atBottom(slack = 60): boolean { return feed.scrollHeight - feed.scrollTop - feed.clientHeight < slack; }
  const isVisible = () => el.isConnected && !el.hidden && document.visibilityState === 'visible';
  const seenKey = () => `${SEEN_KEY}:${snap?.state.repoRoot ?? ''}`;
  function readSeen(): string | null { try { return localStorage.getItem(seenKey()); } catch { return null; } }
  function markSeen(): void {
    let max = 0;
    items.forEach((f) => { max = Math.max(max, feedNum(f.id)); });
    if (max > feedNum(readSeen())) { try { localStorage.setItem(seenKey(), `F${max}`); } catch { /* ignore */ } }
  }

  // ---------------------------------------------------------------- filters

  function renderChips(state: MusterState): void {
    const agents = sortedAgents(state);
    setChildren(chips,
      h('button.chip', { class: !agentFilter && 'active', onclick: () => { agentFilter = null; renderChips(state); renderFeed(true, true); } }, 'Everyone'),
      agents.map((a) => h('button.chip', {
        class: [agentFilter === a.id && 'active', `r-${a.role}`],
        onclick: () => { agentFilter = a.id; renderChips(state); renderFeed(true, true); },
      }, h('span.dot.sm'), a.id)));
    // composer recipients
    const cur = toSel.value || 'everyone';
    setChildren(toSel, h('option', { value: 'everyone' }, 'everyone'), agents.map((a) => h('option', { value: a.id }, a.id)));
    toSel.value = [...toSel.options].some((o) => o.value === cur) ? cur : 'everyone';
  }

  function visibleItems(): FeedItem[] {
    const all = [...items.values()].sort((a, b) => idNum(a.id) - idNum(b.id) || ms(a.at) - ms(b.at));
    return all.filter((f) => {
      if (!showEvents && (f.kind === 'event' || f.kind === 'note')) return false;
      if (agentFilter) {
        if (f.from === agentFilter || f.to === agentFilter) return true;
        if (f.kind === 'event' && new RegExp(`(^|\\W)${agentFilter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`).test(f.text)) return true;
        return false;
      }
      return true;
    });
  }

  // ---------------------------------------------------------------- pieces

  const role = (state: MusterState, who: string) => `r-${roleOf(state, who)}`;

  function avatar(state: MusterState, who: string, cls = 'cav'): HTMLElement {
    return h(`div.avatar.${cls}`, { class: role(state, who), title: displayName(who) }, initial(who));
  }

  function segs(state: MusterState, list: Seg[]): Child[] {
    return list.map((s) => {
      switch (s.k) {
        case 'text': return s.t;
        case 'code': return h('span.cchip.mono', null, s.t);
        case 'color': return h('span.cchip.mono', null, h('span.sw', { style: { background: s.t } }), s.t);
        case 'task': {
          const t = state.tasks.find((x) => x.id === s.t);
          return h('span.cchip.mono.task', { title: t ? `${t.id} ${t.title} · ${t.status}` : '' }, s.t);
        }
        case 'mention': return h('span.mention', { class: role(state, s.t) }, `@${displayName(s.t)}`);
      }
    });
  }

  function blocks(state: MusterState, list: Block[]): HTMLElement[] {
    return list.map((b) => {
      if (b.k === 'p') return h('div.cp', null, segs(state, b.segs));
      if (b.k === 'list') return h('ul.clist', null, b.items.map((it) => h('li', null, segs(state, it))));
      return h('div.ctasks', null, b.rows.map((r) => {
        const t = state.tasks.find((x) => x.id === r.taskId);
        return h('div.ctask', null,
          h('span.cchip.mono.task', null, r.taskId),
          h('span.ttl', null, r.title || t?.title || ''),
          h('span.dot.sm', { class: role(state, r.agent) }),
          h('span.agent.mono', { class: role(state, r.agent) }, displayName(r.agent)));
      }));
    });
  }

  function textOf(state: MusterState, f: FeedItem): HTMLElement[] {
    const agents = state.agents.map((a) => a.id);
    return blocks(state, parseBlocks(f.text, { agents, taskRows: roleOf(state, f.from) === 'captain' }));
  }

  function hoverBar(f: FeedItem): HTMLElement {
    const mine = new Set((f.reactions ?? []).filter((r) => r.by === 'you').map((r) => r.emoji));
    return h('div.chover', null,
      REACTION_EMOJI.map((e) => h('button.e', { class: mine.has(e) && 'on', title: mine.has(e) ? `Remove ${e}` : `React ${e}`, onclick: () => void react(f.id, e) }, e)),
      h('span.sep'),
      h('button.r', { onclick: () => startReply(f) }, icon('reply', 13), 'Reply'));
  }

  /** Reaction chips, then "Seen by" (your lines) or "Read by" avatars (agents' lines). */
  function reactions(state: MusterState, f: FeedItem, opts: { mine?: boolean; resolved?: boolean; small?: boolean } = {}): HTMLElement | null {
    const sum = summarizeReactions(f.reactions);
    const readBy = (f.readBy ?? []).filter((x) => x !== f.from);
    if (!sum.length && !readBy.length && !opts.resolved) return null;
    const chipsEls = sum.map((r) => h('button.creact', {
      class: [r.by.includes('you') && 'me', r.emoji === '✅' && 'ok'],
      title: `${r.emoji} ${r.by.map(displayName).join(', ')}`,
      onclick: () => void react(f.id, r.emoji),
    }, h('span.em', null, r.emoji), h('span.n', null, r.by.length === 1 ? displayName(r.by[0]) : String(r.by.length))));
    let read: Child = null;
    if (readBy.length && !opts.small) {
      read = opts.mine
        ? h('span.seen', null, icon('ticks', 14, 2.4), h('span', null, `Seen by ${readBy.map(displayName).join(', ')}`))
        : h('span.readby', { title: `Read by ${readBy.map(displayName).join(', ')}` }, h('span', null, 'Read by'),
          h('span.minis', null, readBy.slice(0, 6).map((a) => h('span.mini', { class: role(state, a) }, initial(a)))),
          readBy.length > 6 ? h('span', null, `+${readBy.length - 6}`) : null);
    }
    return h('div.creacts', { class: [opts.mine && 'mine', opts.small && 'small'] },
      opts.resolved && !sum.some((r) => r.emoji === '✅') ? h('span.creact.ok.static', null, h('span.em', null, '✅')) : null,
      chipsEls,
      opts.resolved ? h('span.resolved', null, 'Resolved · note closed') : null,
      read);
  }

  function head(state: MusterState, f: FeedItem, target: Child, mine = false): HTMLElement {
    if (mine) return h('div.chead', null, h('span.t', null, `${displayName('you')}${f.to ? ` to ${displayName(f.to)}` : ''}`), h('span.tm', null, hhmm(f.at)));
    return h('div.chead', null,
      h('span.n', { class: role(state, f.from) }, displayName(f.from)),
      target,
      h('span.tm', null, hhmm(f.at)));
  }

  function targetOf(f: FeedItem): Child {
    if (f.kind === 'reply' && f.noteId) {
      const id = f.noteId;
      return h('a.t.link', { href: `#/board?note=${encodeURIComponent(id)}` }, `↳ ${id}`);
    }
    return f.to ? h('span.t', null, `to ${displayName(f.to)}`) : null;
  }

  function group(state: MusterState, list: FeedItem[]): HTMLElement {
    const first = list[0];
    const mine = first.from === 'you';
    const lines = list.map((f, i) => [
      h('div.cline', null,
        h('div.cbubble', { class: [mine && 'mine', i > 0 && 'cont', role(state, f.from)] }, textOf(state, f)),
        mine ? null : hoverBar(f)),
      reactions(state, f, { mine }),
    ]);
    if (mine) return h('div.cmsg.mine', null, h('div.ccol', null, head(state, first, null, true), lines));
    return h('div.cmsg', null, avatar(state, first.from), h('div.ccol', null, head(state, first, targetOf(first)), lines));
  }

  function card(state: MusterState, f: FeedItem, replies: FeedItem[]): HTMLElement {
    const note: Note | undefined = state.notes.find((n) => n.id === f.noteId);
    const type = f.noteType ?? note?.type ?? 'question';
    const [title, ...rest] = f.text.trim().split('\n');
    const agents = state.agents.map((a) => a.id);
    const taskId = f.taskId ?? note?.taskId;
    const to = f.to ?? note?.to;
    const what = type === 'escalation' ? 'asks you' : type === 'review' ? 'asks for your review' : type === 'approval' ? 'waits for your approval' : 'pinned to the board';
    const resolved = !!note && !note.open && !note.dismissed;
    return h('div.cmsg', null,
      avatar(state, f.from),
      h('div.ccol.wide', null,
        h('div.chead', null,
          h('span.n', { class: role(state, f.from) }, displayName(f.from)),
          h('span.t', null, to && to !== 'you' ? `${what} · for ${displayName(to)}` : what),
          h('span.tm', null, hhmm(f.at))),
        h('div.cline', null,
          h('div.ncard', { class: [`t-${type}`, resolved && 'closed'] },
            h('div.ntop', null,
              h('div.nmeta', null,
                h('span.badge', { class: NOTE_BADGE[type] }, noteLabel(type)),
                h('a.nid.mono', { href: `#/board?note=${encodeURIComponent(f.noteId ?? '')}`, title: 'Open on the bulletin board' }, [f.noteId, taskId].filter(Boolean).join(' · '))),
              h('div.ntitle', null, segs(state, parseBlocks(title, { agents }).flatMap((b) => (b.k === 'p' ? b.segs : [])))),
              rest.join('\n').trim() ? h('div.nrest', null, blocks(state, parseBlocks(rest.join('\n'), { agents }))) : null),
            replies.length ? h('div.nreplies', null, replies.map((r) => h('div.nreply', null,
              avatar(state, r.from, 'csm'),
              h('div.ccol', null,
                h('div.chead.sm', null, h('span.n', { class: role(state, r.from) }, displayName(r.from)), h('span.tm', null, hhmm(r.at))),
                textOf(state, r),
                reactions(state, r, { small: true }))))) : null),
          hoverBar(f)),
        reactions(state, f, { resolved })));
  }

  function notice(state: MusterState, f: FeedItem): HTMLElement {
    const t = f.noteType ?? 'progress';
    return h('div.ev.note.cnotice', null,
      h('span.badge', { class: NOTE_BADGE[t] }, noteLabel(t)),
      h('span.t', {
        style: f.noteId ? 'cursor:pointer' : '',
        onclick: () => { if (f.noteId) location.hash = `#/board?note=${f.noteId}`; },
      }, `${displayName(f.from)}: ${f.text}`),
      h('span.tm', null, hhmm(f.at)));
  }

  function row(state: MusterState, r: Row): HTMLElement {
    switch (r.t) {
      case 'day': return h('div.day', null, h('span.line'), h('span.lbl', null, dayLabel(r.at)), h('span.line'));
      case 'unread': return h('div.unread', null, h('span.line'), h('span.lbl', null, `UNREAD · ${r.count}`), h('span.line'));
      case 'events': return h('div.cpill-row', null, h('div.cpill', null,
        r.items.some((f) => f.taskId) ? icon('tasks', 12) : null,
        h('span.tx', null, r.items.map((f) => eventText(f)).join(' · ')),
        h('span.tm', null, hhmm(r.items[0].at))));
      case 'handoff': {
        const ho = r.handoff;
        return h('div.cmsg', null, avatar(state, r.item.from),
          h('div.hcard', { class: role(state, r.item.from) },
            icon('arrow', 16),
            h('div.hbody', null,
              h('div.ht', null, `${displayName(ho.from)} handed ${ho.taskId} to ${displayName(ho.to)}${ho.station ? ` · ${ho.station}` : ''}`),
              ho.note ? h('div.hn', null, `“${ho.note}”`) : null),
            h('span.tm', null, hhmm(r.item.at))));
      }
      case 'card': return card(state, r.item, r.replies);
      case 'notice': return notice(state, r.item);
      case 'group': return group(state, r.items);
    }
  }

  // ---------------------------------------------------------------- render

  function renderFeed(_force = false, scrollToEnd = false): void {
    if (!snap) return;
    const state = snap.state;
    const list = visibleItems();
    const newest = list[list.length - 1]?.id ?? '';
    const newItems = newest !== lastId;
    lastId = newest;
    const visible = el.isConnected && !el.hidden && feed.clientHeight > 0;
    // re-renders without new lines only follow the bottom when already there (so the unread divider stays in view)
    const stick = scrollToEnd || !visible || atBottom(newItems ? 60 : 4) || feed.scrollHeight <= feed.clientHeight;
    if (isVisible()) {
      if (anchor === undefined) anchor = readSeen();
      markSeen();
    }
    const out: HTMLElement[] = buildRows(list, { lastSeen: anchor ?? null }).map((r) => row(state, r));
    if (!out.length) out.push(h('div.empty', null, loaded ? 'No messages yet. The crew talks here: messages, note replies, claims and hand-offs.' : 'Loading…'));
    const typing = typingAgent([...items.values()].sort((a, b) => idNum(a.id) - idNum(b.id)), state.agents, state.notes);
    if (typing && (!agentFilter || agentFilter === typing)) {
      out.push(h('div.cmsg.typing', null, avatar(state, typing),
        h('div.tdots', { class: role(state, typing) }, h('span'), h('span'), h('span')),
        h('span.tt', null, `${displayName(typing)} is writing…`)));
    }
    setChildren(feed, out);
    grow.disconnect();
    for (const c of out) grow.observe(c);
    if (stick) toBottom();
    else if (newItems) jump.hidden = false;
  }

  function scrollToUnread(): void {
    const div = feed.querySelector<HTMLElement>('.unread');
    if (!div) return toBottom();
    jump.hidden = true;
    settle(() => {
      const top = div.offsetTop - 16;
      // show the divider at the top unless everything after it fits anyway
      feed.scrollTop = feed.scrollHeight - top <= feed.clientHeight ? feed.scrollHeight : top;
    });
  }

  async function load(): Promise<void> {
    try {
      const list = await api.feed({ limit: 200 });
      list.forEach((f) => { if (!items.has(f.id)) items.set(f.id, f); }); // the snapshot copy is fresher (reactions, readBy)
      loaded = true;
      renderFeed(true, true);
    } catch (e) {
      loaded = true;
      errToast(e);
      renderFeed(true);
    }
  }

  return {
    el,
    update(s) {
      const first = !snap;
      snap = s;
      if (!replyTo) input.placeholder = PLACEHOLDER(displayName('you'));
      s.state.feed.forEach((f) => items.set(f.id, f));
      if (s.state.feed.length) loaded = true;
      renderChips(s.state);
      renderFeed();
      if (first) load();
    },
    show() {
      renderFeed(true);
      scrollToUnread();
    },
    hide() {
      anchor = undefined;
      emojiPick.hidden = true;
    },
  };
}
