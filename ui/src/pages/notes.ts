// Notes: ideas you keep, typed here or saved through Claude ("put this in notes" → the muster_note connector tool).
// A note reaches no agent until you press Send to Captain. Notes live in the state snapshot (state.jots), so the page
// redraws on every state event.
import '../notes.css';
import type { Jot } from '../../../src/types';
import { confirmDialog, h, icon, setChildren, toast } from '../dom';
import type { Snapshot } from '../events';
import type { Page } from '../page';
import { api } from '../api';
import { errToast, run } from '../actions';
import { agoLong } from '../util';
import { copyText, filterJots, isLong, jotBody, jotTitle, parseTags, sortJots, summaryLine } from '../notesmodel';

export function createNotes(): Page {
  let snap: Snapshot | null = null;
  let query = '';
  let editing: string | null = null; // the note being edited inline
  const open = new Set<string>(); // long notes you expanded

  const meta = h('div.nt-meta');
  const search = h('input.field.nt-search', { type: 'search', placeholder: 'Search notes', 'aria-label': 'Search notes' }) as HTMLInputElement;
  search.oninput = () => {
    query = search.value;
    render();
  };
  const newBtn = h('button.btn.primary.nt-new', null, icon('plus', 14, 2.4), 'New note');
  const quick = h('textarea.field.nt-quick', { rows: 3, placeholder: 'Jot an idea… (Ctrl+Enter saves)' }) as HTMLTextAreaElement;
  const quickTags = h('input.field.nt-quick-tags', { placeholder: 'tags, optional' }) as HTMLInputElement;
  const quickSave = h('button.btn.sm.secondary', null, 'Save note');
  const list = h('div.nt-list');
  const el = h('div.page.nt-page', null,
    h('div.nt-sub', null,
      h('div.nt-sub-t', null, h('div.nt-title', null, 'Notes'), meta),
      search,
      newBtn),
    h('div.nt-scroll', null,
      h('div.nt-quickbox', null, quick, h('div.nt-quick-row', null, quickTags, h('span.nt-hint', null, 'Tell Claude "put this in notes" and it lands here too. Nothing reaches the Captain until you send it.'), quickSave)),
      list));

  newBtn.onclick = () => quick.focus();
  const save = async () => {
    const text = quick.value.trim();
    if (!text) {
      quick.focus();
      return;
    }
    quickSave.setAttribute('disabled', '');
    try {
      await api.addJot({ text, tags: parseTags(quickTags.value) });
      quick.value = '';
      quickTags.value = '';
      toast('Saved to Notes');
    } catch (e) {
      errToast(e);
    } finally {
      quickSave.removeAttribute('disabled');
    }
  };
  quickSave.onclick = () => void save();
  quick.onkeydown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save();
    }
  };

  function fromChip(j: Jot): HTMLElement {
    if (j.from === 'claude') return h('span.via-chip', { title: `Saved through ${j.client ?? 'Claude'} with the remote connector` }, icon('sparkle', 11, 2.2), `via ${j.client && j.client !== 'Claude' ? j.client : 'Claude'}`);
    return h('span.nt-from', null, j.from === 'captain' ? 'Captain' : 'you');
  }

  function editor(j: Jot): HTMLElement {
    const title = h('input.field.nt-edit-title', { value: j.title ?? '', placeholder: 'Title (optional: the first line is used)' }) as HTMLInputElement;
    const text = h('textarea.field.nt-edit-text', { rows: Math.min(14, Math.max(4, j.text.split('\n').length + 1)) }) as HTMLTextAreaElement;
    text.value = j.text;
    const tags = h('input.field.nt-edit-tags', { value: j.tags.join(', '), placeholder: 'tags' }) as HTMLInputElement;
    const saveEdit = async () => {
      const r = await run(api.editJot(j.id, { title: title.value, text: text.value, tags: parseTags(tags.value) }), 'Note saved');
      if (r) {
        editing = null;
        render();
      }
    };
    text.onkeydown = (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void saveEdit();
      } else if (e.key === 'Escape') {
        editing = null;
        render();
      }
    };
    queueMicrotask(() => text.focus());
    return h('div.nt-card.editing', null, title, text, tags,
      h('div.nt-actions', null,
        h('button.btn.sm.primary', { onclick: () => void saveEdit() }, 'Save'),
        h('button.btn.sm', { onclick: () => { editing = null; render(); } }, 'Cancel'),
        h('span.nt-hint', null, 'Ctrl+Enter saves · Esc cancels')));
  }

  function card(j: Jot): HTMLElement {
    if (editing === j.id) return editor(j);
    const body = jotBody(j);
    const long = isLong(body);
    const expanded = open.has(j.id);
    const actions = h('div.nt-actions', null,
      h('button.nt-act', { title: j.pinned ? 'Unpin' : 'Pin to the top', class: j.pinned && 'on', onclick: () => void run(api.pinJot(j.id, !j.pinned)) }, icon('pin', 13, 2), j.pinned ? 'Pinned' : 'Pin'),
      h('button.nt-act', { onclick: () => { editing = j.id; render(); } }, 'Edit'),
      h('button.nt-act', {
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(copyText(j));
            toast('Copied');
          } catch {
            toast('Could not copy: the clipboard is blocked', 'error');
          }
        },
      }, icon('copy', 13, 2), 'Copy'),
      h('button.nt-act', {
        onclick: async () => {
          const again = j.sentAt ? ` You already sent it ${agoLong(j.sentAt)}.` : '';
          if (!(await confirmDialog('Send to the Captain?', `"${jotTitle(j)}" becomes the Captain's goal, as if you typed it to them.${again}`, 'Send to Captain'))) return;
          await run(api.sendJot(j.id), 'Sent to the Captain');
        },
      }, icon('send', 13, 2), 'Send to Captain'),
      h('span.flex1'),
      h('button.nt-act.danger', {
        onclick: async () => {
          if (!(await confirmDialog('Delete this note?', `"${jotTitle(j)}" will be gone for good.`, 'Delete', 'danger'))) return;
          await run(api.deleteJot(j.id), 'Note deleted');
        },
      }, 'Delete'));
    return h('div.nt-card', { class: j.pinned && 'pinned', id: `nt-${j.id}` },
      h('div.nt-head', null,
        j.pinned ? h('span.nt-pin', { title: 'Pinned' }, icon('pin', 12, 2.2)) : null,
        h('div.nt-card-title', null, jotTitle(j)),
        fromChip(j),
        h('span.nt-time', { title: new Date(j.createdAt).toLocaleString() }, agoLong(j.createdAt))),
      body ? h('div.nt-text', { class: long && !expanded && 'folded' }, body) : null,
      long ? h('button.nt-more', { onclick: () => { if (expanded) open.delete(j.id); else open.add(j.id); render(); } }, expanded ? 'less' : 'more') : null,
      j.tags.length ? h('div.nt-tags', null, j.tags.map((t) => h('button.nt-tag', { title: `Show notes tagged #${t}`, onclick: () => { search.value = `#${t}`; query = search.value; render(); } }, `#${t}`))) : null,
      j.sentAt ? h('div.nt-sent', null, icon('check', 12, 2.6), `Sent to the Captain · ${agoLong(j.sentAt)}`) : null,
      actions);
  }

  function render(): void {
    if (!snap) return;
    const all = snap.state.jots ?? [];
    meta.textContent = summaryLine(all);
    const shown = sortJots(filterJots(all, query));
    if (!all.length) {
      setChildren(list, h('div.nt-empty', null,
        h('div.nt-empty-t', null, 'No notes yet'),
        h('div', null, 'Write one above, or tell Claude "put this in notes" while you talk about Muster. Ideas wait here until you send them to the Captain.')));
      return;
    }
    if (!shown.length) {
      setChildren(list, h('div.nt-empty', null, `No notes match "${query.trim()}".`));
      return;
    }
    setChildren(list, shown.map(card));
  }

  return {
    el,
    update(s) {
      snap = s;
      // Don't redraw under an inline edit (the text would reset while you type); the next state event after Save does it.
      if (!editing) render();
    },
    show() {
      render();
    },
  };
}
