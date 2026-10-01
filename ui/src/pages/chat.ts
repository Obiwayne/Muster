// Crew chat: one chronological log of messages, replies, notes and events, plus a composer.
import type { FeedItem, MusterState } from '../../../src/types';
import { h, icon, setChildren, toggle } from '../dom';
import type { Snapshot } from '../events';
import type { Page } from '../page';
import { api } from '../api';
import { errToast, run } from '../actions';
import { NOTE_BADGE, dayLabel, displayName, hhmm, idNum, initial, ms, noteLabel, roleOf, sortedAgents } from '../util';

const SHOW_EVENTS_KEY = 'muster.chat.showEvents';

export function createChat(): Page {
  let snap: Snapshot | null = null;
  let agentFilter: string | null = null;
  let showEvents = (() => { try { return localStorage.getItem(SHOW_EVENTS_KEY) !== '0'; } catch { return true; } })();
  const items = new Map<string, FeedItem>();
  let loaded = false;
  let lastKey = '';

  const chips = h('div', { style: 'display:flex;align-items:center;gap:6px;flex:1;min-width:0;flex-wrap:wrap' });
  const tgl = toggle(showEvents, (v) => {
    showEvents = v;
    try { localStorage.setItem(SHOW_EVENTS_KEY, v ? '1' : '0'); } catch { /* ignore */ }
    renderFeed(true);
  }, true);
  const filterbar = h('div.filterbar.chat-filter', null, chips, h('span.faint', { style: 'font-size:12px' }, 'Show hand-offs and notes'), tgl);
  const feed = h('div.feed');
  const jump = h('button.btn.sm.secondary.jump', { hidden: true, onclick: () => { feed.scrollTop = feed.scrollHeight; jump.hidden = true; } }, icon('down', 12), 'New messages');
  const toSel = h('select') as HTMLSelectElement;
  const input = h('input.field', { placeholder: 'Message the crew as you…' }) as HTMLInputElement;
  const send = h('button.btn.lg.accent', null, 'Send') as HTMLButtonElement;
  const composer = h('div.composer', null, h('label.to-select', null, h('span.to', null, 'To'), toSel, icon('chevron', 12, 2.5)), input, send);
  const el = h('div.page', null, filterbar, feed, jump, composer);

  feed.addEventListener('scroll', () => { if (atBottom()) jump.hidden = true; });

  const doSend = async () => {
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    const r = await run(api.message(toSel.value || 'everyone', text));
    send.disabled = false;
    if (r) {
      input.value = '';
      items.set(r.id, r);
      renderFeed(true, true);
    }
  };
  send.onclick = doSend;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) doSend(); });

  function toBottom(): void {
    feed.scrollTop = feed.scrollHeight;
    jump.hidden = true;
    // fonts and wrapping can change heights after this frame
    requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; });
    document.fonts?.ready.then(() => { if (!jump.hidden) return; feed.scrollTop = feed.scrollHeight; });
  }

  function atBottom(): boolean { return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60; }

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

  function renderFeed(force = false, scrollToEnd = false): void {
    if (!snap) return;
    const state = snap.state;
    const list = visibleItems();
    const key = `${list.length}:${list[list.length - 1]?.id}:${agentFilter}:${showEvents}:${state.agents.map((a) => a.id + a.role).join()}`;
    if (!force && key === lastKey) return;
    const newItems = key.split(':')[1] !== lastKey.split(':')[1];
    lastKey = key;
    const visible = el.isConnected && !el.hidden && feed.clientHeight > 0;
    const stick = scrollToEnd || !visible || atBottom() || feed.scrollHeight <= feed.clientHeight;

    const out: HTMLElement[] = [];
    let lastDay = '';
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const day = new Date(ms(f.at)).toDateString();
      if (day !== lastDay) {
        lastDay = day;
        out.push(h('div.day', null, h('span.line'), h('span.lbl', null, `${dayLabel(f.at)} · ${hhmm(f.at)}`), h('span.line')));
      }
      if (f.kind === 'event') {
        // fold consecutive events within two minutes into one line
        const parts = [f.text];
        while (list[i + 1]?.kind === 'event' && ms(list[i + 1].at) - ms(f.at) < 120_000 && new Date(ms(list[i + 1].at)).toDateString() === day) {
          parts.push(list[++i].text);
        }
        out.push(h('div.ev', null, `${hhmm(f.at)} ${parts.join(' · ')}`));
      } else if (f.kind === 'note') {
        const t = f.noteType ?? 'progress';
        const text = f.text.startsWith(f.from) ? f.text : `${f.from} pinned ${f.noteId ?? ''}: ${f.text}`.replace(' : ', ': ');
        out.push(h('div.ev.note', null,
          h('span.badge', { class: NOTE_BADGE[t] }, noteLabel(t)),
          h('span.t', {
            style: f.noteId ? 'cursor:pointer' : '',
            onclick: () => { if (f.noteId) location.hash = `#/board?note=${f.noteId}`; },
          }, text),
          h('span.tm', null, hhmm(f.at))));
      } else {
        const target = f.kind === 'reply' ? `↳ ${f.noteId ?? ''}` : f.to ? `→ ${displayName(f.to)}` : '';
        out.push(h('div.msg', null,
          h('div.avatar', { class: `r-${roleOf(state, f.from)}` }, initial(f.from)),
          h('div.content', { style: 'gap:3px' },
            h('div.who', null,
              h('span.n', null, displayName(f.from)),
              target ? h('span.t', {
                style: f.kind === 'reply' && f.noteId ? 'cursor:pointer' : '',
                onclick: () => { if (f.kind === 'reply' && f.noteId) location.hash = `#/board?note=${f.noteId}`; },
              }, target) : null,
              h('span.tm', null, hhmm(f.at))),
            h('div.txt', null, f.text))));
      }
    }
    if (!out.length) out.push(h('div.empty', null, loaded ? 'No messages yet. The crew talks here: messages, note replies, claims and hand-offs.' : 'Loading…'));
    setChildren(feed, out);
    if (stick) {
      toBottom();
    } else if (newItems) {
      jump.hidden = false;
    }
  }

  async function load(): Promise<void> {
    try {
      const list = await api.feed({ limit: 200 });
      list.forEach((f) => items.set(f.id, f));
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
      input.placeholder = `Message the crew as ${displayName('you')}…`;
      s.state.feed.forEach((f) => items.set(f.id, f));
      if (s.state.feed.length) loaded = true;
      renderChips(s.state);
      renderFeed();
      if (first) load();
    },
    show() { toBottom(); },
  };
}
