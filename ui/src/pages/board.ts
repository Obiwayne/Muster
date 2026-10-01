// Bulletin board: filter chips, note list, selected thread with replies and a reply box.
import type { MusterState, Note, NoteType } from '../../../src/types';
import { h, icon, setChildren } from '../dom';
import type { Snapshot } from '../events';
import type { Page } from '../page';
import { api } from '../api';
import { mergeTask, run } from '../actions';
import { NOTE_BADGE, ageShort, ago, displayName, initial, isEscalated, isNeedsYou, ms, noteLabel, roleOf, taskById } from '../util';

type Filter = 'open' | 'stuck' | 'question' | 'waiting' | 'review' | 'all' | 'needsYou';

const TYPE_ORDER: Partial<Record<NoteType, number>> = { escalation: 0, stuck: 1, question: 2 };

function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1;
    const ta = TYPE_ORDER[a.type] ?? 9;
    const tb = TYPE_ORDER[b.type] ?? 9;
    if (ta !== tb) return ta - tb;
    return ms(b.createdAt) - ms(a.createdAt);
  });
}

function matches(n: Note, f: Filter): boolean {
  switch (f) {
    case 'open': return n.open;
    case 'stuck': case 'question': case 'waiting': case 'review': return n.open && n.type === f;
    case 'needsYou': return isNeedsYou(n);
    case 'all': return true;
  }
}

/** Split a note into a title (first line / sentence pair) and the rest. */
function splitText(text: string): { title: string; rest: string } {
  const nl = text.indexOf('\n');
  if (nl > 0) return { title: text.slice(0, nl).trim(), rest: text.slice(nl + 1).trim() };
  return { title: text, rest: '' };
}

export function createBoard(): Page {
  let filter: Filter = 'open';
  let selected: string | null = null;
  let snap: Snapshot | null = null;

  const filterbar = h('div.filterbar');
  const list = h('div.notes');
  const left = h('div.board-list', null, filterbar, list);
  const head = h('div.thread-head');
  const replies = h('div.replies');
  const replyInput = h('input.field', { placeholder: 'Reply as you…' }) as HTMLInputElement;
  const clearBtn = h('button.btn.lg', null, 'Clear note') as HTMLButtonElement;
  const replyBtn = h('button.btn.lg.accent', null, 'Reply') as HTMLButtonElement;
  const composer = h('div.composer', null, replyInput, clearBtn, replyBtn);
  const thread = h('div.thread', null, head, replies, composer);
  const el = h('div.page', null, h('div.split', null, left, thread));
  let lastThreadKey = '';

  const sendReply = async () => {
    const text = replyInput.value.trim();
    if (!text || !selected) return;
    replyBtn.disabled = true;
    const r = await run(api.reply(selected, text));
    replyBtn.disabled = false;
    if (r) replyInput.value = '';
  };
  replyBtn.onclick = sendReply;
  replyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) sendReply(); });
  clearBtn.onclick = async () => {
    if (!selected) return;
    await run(api.closeNote(selected), `Cleared ${selected}`);
  };

  function renderFilters(state: MusterState): void {
    const open = state.notes.filter((n) => n.open);
    const count = (t: NoteType) => open.filter((n) => n.type === t).length;
    const needs = state.notes.filter(isNeedsYou).length;
    const chip = (f: Filter, label: string, n?: number, cls = '') => h('button.chip', {
      class: [filter === f && 'active', cls],
      onclick: () => { filter = f; selected = null; render(); },
    }, n === undefined ? label : f === 'open' ? `${label} · ${n}` : `${label} ${n}`);
    setChildren(filterbar,
      chip('open', 'Open', open.length),
      chip('stuck', 'Stuck', count('stuck'), count('stuck') ? 'c-stuck' : ''),
      chip('question', 'Question', count('question')),
      chip('waiting', 'Waiting', count('waiting')),
      chip('review', 'Review', count('review')),
      chip('all', 'All', undefined, 'c-faint'),
      h('button.chip.dashed', {
        class: [filter === 'needsYou' && 'active', needs > 0 && 'hot'],
        onclick: () => { filter = 'needsYou'; selected = null; render(); },
      }, 'Needs you', h('span.cnt', null, String(needs))),
    );
  }

  function metaLine(state: MusterState, n: Note): string {
    const parts = [n.to ? `${displayName(n.from)} → ${displayName(n.to)}` : displayName(n.from)];
    if (n.taskId) parts.push(n.taskId);
    if (n.branch && !(n.to && n.type === 'waiting')) parts.push(n.branch);
    if (n.open && (n.type === 'stuck' || n.type === 'question') && !isEscalated(state, n)) {
      const cap = n.replies.some((r) => roleOf(state, r.from) === 'captain');
      if (n.type === 'question' && !cap) parts.push('Captain answering');
    }
    return parts.join(' · ');
  }

  function row(state: MusterState, n: Note): HTMLElement {
    const t = n.type;
    const selColor = t === 'stuck' ? 'var(--color-stuck)' : t === 'question' ? 'var(--color-captain)' : t === 'waiting' ? 'var(--color-design)' : t === 'review' ? 'var(--color-crew)' : t === 'escalation' ? 'var(--color-warm)' : 'var(--color-muted)';
    const task = taskById(state, n.taskId);
    const side = n.type === 'review' && n.open && task?.status === 'ready_for_merge'
      ? h('span.merge', {
          role: 'button',
          onclick: (e: MouseEvent) => { e.stopPropagation(); mergeTask(state, task); },
        }, 'Merge')
      : (n.open || n.replies.length) && n.type !== 'progress' && n.type !== 'system'
        ? h('span.faint', null, `${n.replies.length} ${n.replies.length === 1 ? 'reply' : 'replies'}`) : null;
    return h('button.note-row', {
      class: [n.id === selected && 'sel', !n.open && 'closed'],
      style: { '--sel': selColor },
      onclick: () => { selected = n.id; render(); },
    },
    h('div.type', null, h('span.badge', { class: NOTE_BADGE[t] }, noteLabel(t))),
    h('div.body', null, h('div.text', null, n.text), h('div.meta', null, metaLine(state, n))),
    h('div.side', null, h('span.muted', null, ageShort(n.createdAt)), side));
  }

  function renderThread(state: MusterState, n: Note | undefined): void {
    const key = n ? `${n.id}:${n.replies.length}:${n.open}:${state.notes.length}` : '';
    composer.hidden = !n;
    if (!n) {
      setChildren(head, h('div.thread-text', null, 'Nothing selected.'));
      setChildren(replies, h('div.empty', null, filter === 'needsYou' ? 'Nothing needs you right now. The crew is handling it.' : 'No notes here.'));
      lastThreadKey = key;
      return;
    }
    clearBtn.disabled = !n.open;
    clearBtn.textContent = n.open ? 'Clear note' : 'Cleared';
    if (key === lastThreadKey) return;
    const wasBottom = replies.scrollHeight - replies.scrollTop - replies.clientHeight < 40;
    lastThreadKey = key;
    const task = taskById(state, n.taskId);
    const { title, rest } = splitText(n.text);
    const author = state.agents.find((a) => a.id === n.from);
    setChildren(head,
      h('div.row', null,
        h('span.badge', { class: NOTE_BADGE[n.type] }, noteLabel(n.type)),
        h('span.ref', null, [n.id, n.to ? `${displayName(n.from)} → ${displayName(n.to)}` : displayName(n.from), task ? `${task.id} ${task.title}` : n.taskId].filter(Boolean).join(' · ')),
        author ? h('button.btn.sm', { onclick: () => { location.hash = `#/dashboard?agent=${encodeURIComponent(author.id)}`; } }, 'Open terminal') : null),
      h('div.thread-title', null, title),
      rest ? h('div.thread-text', null, rest) : null,
    );
    const items: HTMLElement[] = n.replies.map((r) => h('div.msg', null,
      h('div.avatar', { class: `r-${roleOf(state, r.from)}` }, initial(r.from)),
      h('div.content', null,
        h('div.who', null, h('span.n', null, displayName(r.from)), h('span.t', null, ago(r.at))),
        h('div.txt', null, r.text))));
    if (!n.replies.length) items.push(h('div.faint', { style: 'font-size:13px' }, 'No replies yet.'));
    if (n.open && (n.type === 'stuck' || n.type === 'question' || n.type === 'waiting') && !isEscalated(state, n)) {
      items.push(h('div.banner', null, icon('users', 16), h('div.flex1', null, 'Being handled by the crew. This only reaches you if the Captain escalates it.')));
    } else if (isNeedsYou(n) || (n.open && isEscalated(state, n))) {
      const msg = n.type === 'review'
        ? 'Ready for review: the Captain has checked this branch. Merge it from Tasks or Branches, or reply to send it back.'
        : 'Needs you: the Captain escalated this. Reply below; the answer goes to the agents involved.';
      const act = n.type === 'review' && task?.status === 'ready_for_merge'
        ? h('button.btn.sm.merge', { onclick: () => mergeTask(state, task) }, 'Merge') : null;
      items.push(h('div.banner.warm', null, icon('alert', 16), h('div.flex1', null, msg), act));
    }
    setChildren(replies, items);
    if (wasBottom) replies.scrollTop = replies.scrollHeight;
  }

  function render(): void {
    if (!snap) return;
    const state = snap.state;
    renderFilters(state);
    const notes = sortNotes(state.notes.filter((n) => matches(n, filter)));
    if (!selected || !state.notes.some((n) => n.id === selected)) selected = notes[0]?.id ?? null;
    const scroll = list.scrollTop;
    setChildren(list, notes.length ? notes.map((n) => row(state, n)) : h('div.empty', null, filter === 'needsYou' ? 'Nothing needs you right now.' : 'No notes.'));
    list.scrollTop = scroll;
    renderThread(state, state.notes.find((n) => n.id === selected));
  }

  return {
    el,
    update(s) { snap = s; replyInput.placeholder = `Reply as ${displayName('you')}…`; render(); },
    params(p) {
      const id = p.get('note');
      if (id) {
        selected = id;
        const n = snap?.state.notes.find((x) => x.id === id);
        if (n && !matches(n, filter)) filter = 'all';
        render();
        history.replaceState(null, '', '#/board');
      }
    },
  };
}
