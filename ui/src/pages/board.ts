// Bulletin board: filter chips, note list, selected thread with replies and a reply box.
import type { AskQuestion, MusterState, Note, NoteType, Task } from '../../../src/types';
import { h, icon, setChildren } from '../dom';
import type { Snapshot } from '../events';
import type { Page } from '../page';
import { api } from '../api';
import { approveAllMerges, approveMerge, approveRoadmap, approveTask, commitCheckout, isRoadmapNote, mergeTask, run, sendBackApproval, sendBackRoadmap, showDiffModal, stashCheckout } from '../actions';
import { evidenceStrip } from '../evidence';
import { qaBadge, qaStrip } from '../qa';
import { NOTE_BADGE, ageShort, ago, displayName, initial, isEscalated, isNeedsYou, branchOwnerId, ms, noteLabel, roleOf, taskById } from '../util';
import { isUsageNote, isWeeklyNote, weeklyThreshold } from '../usagealert';
import { createWeeklyAlertView } from './usagealert';
import { intelNoteView, isIntelJobNote, runAgainBody, type IntelNoteAction } from '../intelnote';
import { startJob } from '../intelapi';
import { createUpdateBar } from '../update';
import { answerLines, answersPayload, canSubmit, emptyDraft, optionViews, setOther, toggleChoice, type AskDraft } from '../askmodel';
import { createHeldStore, heldCard, heldRow, POLL_MS, tickCountdowns } from './heldcard';

type Filter = 'open' | 'stuck' | 'question' | 'waiting' | 'review' | 'approval' | 'all' | 'needsYou';

const TYPE_ORDER: Partial<Record<string, number>> = { approval: 0, escalation: 0, stuck: 1, question: 2 };

function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1;
    const ta = isUsageNote(a) ? 0 : TYPE_ORDER[a.type] ?? 9; // a usage alert is as urgent as an escalation
    const tb = isUsageNote(b) ? 0 : TYPE_ORDER[b.type] ?? 9;
    if (ta !== tb) return ta - tb;
    return ms(b.createdAt) - ms(a.createdAt);
  });
}

function matches(n: Note, f: Filter): boolean {
  switch (f) {
    case 'open': return n.open;
    case 'stuck': case 'question': case 'waiting': case 'review': case 'approval': return n.open && (n.type as string) === f;
    case 'needsYou': return isNeedsYou(n);
    case 'all': return true;
  }
}

/** Tasks the Captain flagged ready that you have not approved yet (one per open review note). */
function awaitingApproval(state: MusterState): Task[] {
  const out: Task[] = [];
  for (const n of state.notes) {
    if (n.type !== 'review' || !n.open) continue;
    const t = taskById(state, n.taskId);
    if (t && t.status === 'ready_for_merge' && !t.mergeApproval && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Split a note into a title (first line / sentence pair) and the rest. */
function splitText(text: string): { title: string; rest: string } {
  const nl = text.indexOf('\n');
  if (nl > 0) return { title: text.slice(0, nl).trim(), rest: text.slice(nl + 1).trim() };
  return { title: text, rest: '' };
}

/** Dismissed notes stay in state for history; the board leaves them out. */
function visibleState(state: MusterState): MusterState {
  return state.notes.some((n) => n.dismissed) ? { ...state, notes: state.notes.filter((n) => !n.dismissed) } : state;
}

function badge(n: Note): HTMLElement {
  if (isUsageNote(n)) return h('span.badge.b-warm', null, 'usage');
  return h('span.badge', { class: NOTE_BADGE[n.type] }, noteLabel(n.type));
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
  const weekly = createWeeklyAlertView({ dismiss: (id) => dismiss(id) });
  const heldPane = h('div.thread.held-pane', { hidden: true }); // the Send card for a held remote write
  const update = createUpdateBar(); // "Update" when a newer Muster build is waiting (desktop app only)
  const el = h('div.page', null, update.el, h('div.split', null, left, thread, weekly.el, heldPane));
  let updateTimer: ReturnType<typeof setInterval> | undefined;
  // Writes Claude asked for through the remote connector, held for your tap (docs/REMOTE.md): polled while visible.
  const held = createHeldStore(() => render());
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let heldKey = '';

  async function dismiss(id: string): Promise<void> {
    if (await run(api.dismissNote(id), `Dismissed ${id}`)) {
      if (selected === id) selected = null;
      // hide it right away; the next snapshot carries dismissed: true
      if (snap) snap = { ...snap, state: { ...snap.state, notes: snap.state.notes.map((x) => (x.id === id ? { ...x, dismissed: true, open: false } : x)) } };
      render();
    }
  }
  let lastThreadKey = '';
  const drafts = new Map<string, AskDraft>(); // your half-filled answers to the Captain's question menus, by note id

  /** An open question menu: header chip, question, option rows, an "Other…" field per question, then one Submit. */
  function askForm(id: string, ask: AskQuestion[]): HTMLElement {
    let draft = drafts.get(id) ?? emptyDraft(ask);
    const submit = h('button.btn.lg.accent', { disabled: !canSubmit(ask, draft) }, 'Submit') as HTMLButtonElement;
    const save = (d: AskDraft) => { draft = d; drafts.set(id, d); submit.disabled = !canSubmit(ask, d); };
    submit.onclick = async () => {
      submit.disabled = true;
      if (await run(api.answerAsk(id, answersPayload(ask, draft)), 'Answer sent to the Captain')) drafts.delete(id);
      else submit.disabled = !canSubmit(ask, draft);
    };
    return h('div.ask', null,
      ask.map((q, qi) => h('div.ask-q', null,
        h('div.ask-qhead', null, q.header ? h('span.ask-chip', null, q.header) : null, q.multiSelect ? h('span.faint', null, 'Pick any') : null),
        h('div.ask-question', null, q.question),
        h('div.ask-opts', null, optionViews(q).map((o) => h('label.ask-opt', null,
          h('input', { type: q.multiSelect ? 'checkbox' : 'radio', name: `ask-${id}-${qi}`, checked: draft[qi]!.choices.includes(o.value), onchange: () => save(toggleChoice(draft, ask, qi, o.value)) }),
          h('div.ask-otext', null,
            h('div.ask-olabel', null, o.label, o.recommended ? h('span.badge.b-captain', null, 'Recommended') : null),
            o.description ? h('div.ask-odesc', null, o.description) : null)))),
        h('input.field.ask-other', { placeholder: 'Other…', value: draft[qi]!.other, oninput: (e: Event) => save(setOther(draft, qi, (e.target as HTMLInputElement).value)) }))),
      h('div.ask-foot', null, h('span.faint', null, 'Goes to the Captain as your reply and clears the note.'), submit));
  }

  /** A closed question menu: what you answered. */
  function askAnswers(n: Note & { ask: AskQuestion[] }): HTMLElement {
    const lines = n.answers ? answerLines(n.ask, n.answers) : [];
    return h('div.ask.done', null,
      lines.length ? lines.map((l) => h('div.ask-q', null,
        h('div.ask-qhead', null, h('span.ask-chip', null, l.header)),
        h('div.ask-question', null, l.question),
        h('div.ask-answer', null, icon('check', 14), l.text)))
        : h('div.faint', { style: 'font-size:13px' }, 'Cleared without a menu answer. Any reply is above.'));
  }

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
    const needs = state.notes.filter(isNeedsYou).length + held.waiting();
    const approvable = awaitingApproval(state);
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
      ...(count('approval' as NoteType) || filter === 'approval' ? [chip('approval', 'Approval', count('approval' as NoteType), 'c-stuck')] : []),
      chip('all', 'All', undefined, 'c-faint'),
      h('button.chip.dashed', {
        class: [filter === 'needsYou' && 'active', needs > 0 && 'hot'],
        onclick: () => { filter = 'needsYou'; selected = null; render(); },
      }, 'Needs you', h('span.cnt', null, String(needs))),
      approvable.length > 1
        ? h('button.btn.sm.merge', { style: 'margin-left:auto', title: 'Tell the Captain to merge and push every reviewed task', onclick: () => void approveAllMerges(approvable) }, `Approve all ${approvable.length}`)
        : null,
    );
  }

  function metaLine(state: MusterState, n: Note): string {
    if (isWeeklyNote(n) && snap) return `${displayName(n.from)} · alert at ${weeklyThreshold(state.usage, snap.config)}%`;
    const parts = [n.to ? `${displayName(n.from)} → ${displayName(n.to)}` : displayName(n.from)];
    if (n.taskId) parts.push(n.taskId);
    const br = n.branch ?? ((n.type as string) === 'approval' ? taskById(state, n.taskId)?.branch : undefined);
    if (br && !(n.to && n.type === 'waiting')) parts.push(br);
    if (n.open && (n.type === 'stuck' || n.type === 'question') && !isEscalated(state, n)) {
      const cap = n.replies.some((r) => roleOf(state, r.from) === 'captain');
      if (n.type === 'question' && !cap) parts.push('Captain answering');
    }
    return parts.join(' · ');
  }

  /** The actions of an intel "research is ready" / "stopped early" note. Acting on it closes it (it stops counting as for you). */
  function intelActions(n: Note, actions: IntelNoteAction[], inRow: boolean): HTMLElement {
    const close = () => (n.open ? run(api.closeNote(n.id)) : Promise.resolve(true));
    const go = (hash: string) => async (e: MouseEvent) => { e.stopPropagation(); await close(); location.hash = hash; };
    const btn = (label: string, cls: string, onclick: (e: MouseEvent) => void) =>
      inRow ? h('span.in-btn', { class: cls, role: 'button', tabindex: '0', onclick, onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') onclick(e as unknown as MouseEvent); } }, label)
        : h('button.btn.sm', { class: cls === 'primary' ? 'primary' : '', onclick }, label);
    return h('div.in-actions', null, actions.map((a) => {
      switch (a) {
        case 'open': return btn('Open Intel →', actions.includes('gaps') ? 'primary' : '', go('#/intel'));
        case 'gaps': return btn('See gaps', '', go('#/intel/opportunities'));
        case 'dismiss': return btn('Dismiss', 'quiet', (e) => { e.stopPropagation(); void dismiss(n.id); });
        case 'again': return btn('Run again', '', async (e) => {
          e.stopPropagation();
          const job = await run(startJob(runAgainBody(n.intel!)), 'scout will run it again');
          if (job) await close();
        });
      }
    }));
  }

  function intelRow(n: Note & { intel: NonNullable<Note['intel']> }): HTMLElement {
    const v = intelNoteView(n);
    return h('div.note-row.in-note', {
      class: [v.tone, n.id === selected && 'sel', !n.open && 'closed'],
      role: 'button',
      tabindex: '0',
      onclick: () => { selected = n.id; render(); },
    },
    h('div.in-icon', null, v.tone === 'ready' ? icon('radar', 16) : null),
    h('div.body', null,
      h('div.in-head', null, h('span.in-from', null, displayName(n.from)), h('span.in-title', null, v.title), h('span.in-age', null, ageShort(n.createdAt))),
      v.body ? h('div.in-body', null, v.body) : null,
      v.chips.length ? h('div.in-chips', null, v.chips.map((c) => h('span.in-chip', { class: c.tone }, c.text))) : null,
      intelActions(n, v.actions, true)));
  }

  function row(state: MusterState, n: Note): HTMLElement {
    if (isIntelJobNote(n)) return intelRow(n as Note & { intel: NonNullable<Note['intel']> });
    const t = n.type;
    const selColor = isUsageNote(n) ? 'var(--color-warm)' : t === 'stuck' ? 'var(--color-stuck)' : t === 'question' ? 'var(--color-captain)' : t === 'waiting' ? 'var(--color-design)' : t === 'review' ? 'var(--color-crew)' : (t as string) === 'approval' ? 'var(--color-warm)' : t === 'escalation' ? 'var(--color-warm)' : 'var(--color-muted)';
    const task = taskById(state, n.taskId);
    const side0 = n.type === 'review' && n.open && task?.status === 'ready_for_merge'
      ? task.mergeApproval
        ? h('span.faint', { title: 'Approved: the Captain is merging and pushing it' }, 'Approved')
        : h('span.merge', {
            role: 'button',
            title: 'Happy with it: the Captain merges and pushes',
            onclick: (e: MouseEvent) => { e.stopPropagation(); void approveMerge(task); },
          }, 'Approve')
      : (n.open || n.replies.length) && n.type !== 'progress' && n.type !== 'system'
        ? h('span.faint', null, `${n.replies.length} ${n.replies.length === 1 ? 'reply' : 'replies'}`) : null;
    const isApproval = (n.type as string) === 'approval' && n.open && (task?.status as string) === 'awaiting_approval';
    const roadmapDraft = n.open && isRoadmapNote(state, n) && state.roadmap?.status === 'draft';
    const approveSide = isApproval ? h('span.merge', { role: 'button', onclick: (e: MouseEvent) => { e.stopPropagation(); void approveTask(task!); } }, 'Approve')
      : roadmapDraft ? h('span.merge', { role: 'button', title: 'Approve the roadmap draft', onclick: (e: MouseEvent) => { e.stopPropagation(); void approveRoadmap(); } }, 'Approve')
      : null;
    const side = approveSide ?? side0;
    return h('button.note-row', {
      class: [n.id === selected && 'sel', !n.open && 'closed'],
      style: { '--sel': selColor },
      onclick: () => { selected = n.id; render(); },
    },
    h('div.type', null, badge(n)),
    h('div.body', null, h('div.text', null, n.text), h('div.meta', null, metaLine(state, n))),
    h('div.side', null, h('span.muted', null, ageShort(n.createdAt)), task && n.open && (n.type === 'review' || n.type === 'escalation') ? qaBadge(task, true) : null, side,
      n.type === 'system' ? h('span.note-x', {
        role: 'button',
        title: 'Dismiss: remove it from the board',
        onclick: (e: MouseEvent) => { e.stopPropagation(); void dismiss(n.id); },
      }, icon('x', 12)) : null));
  }

  /** The Send card of a held write in the thread pane (rebuilt only when what it shows changes, so scrolling stays). */
  function renderHeld(state: MusterState, id: string | null): boolean {
    const e = id ? held.get(id) : undefined;
    heldPane.hidden = !e;
    if (!e) { heldKey = ''; return false; }
    thread.hidden = true;
    weekly.el.hidden = true;
    lastThreadKey = '';
    const key = `${e.p.pendingId}:${e.p.digest}:${e.status}:${e.error ?? ''}:${e.p.replyTo?.id}:${state.agents.length}`;
    if (key !== heldKey) {
      heldKey = key;
      setChildren(heldPane, heldCard(state, e, held));
    }
    return true;
  }

  function renderThread(state: MusterState, n: Note | undefined): void {
    const weeklyOn = !!n && isWeeklyNote(n);
    weekly.el.hidden = !weeklyOn;
    thread.hidden = weeklyOn;
    if (weeklyOn) { weekly.show(n!); lastThreadKey = ''; return; }
    const key = n ? `${n.id}:${n.replies.length}:${n.open}:${state.notes.length}:${taskById(state, n.taskId)?.status}:${!!taskById(state, n.taskId)?.mergeApproval}:${state.roadmap?.status}:${state.roadmap?.revision}` : '';
    composer.hidden = !n;
    if (!n) {
      setChildren(head, h('div.thread-text', null, 'Nothing selected.'));
      setChildren(replies, h('div.empty', null, filter === 'needsYou' ? 'Nothing needs you right now. The crew is handling it.' : 'No notes here.'));
      lastThreadKey = key;
      return;
    }
    clearBtn.disabled = !n.open;
    clearBtn.textContent = n.open ? 'Clear note' : 'Cleared';
    replyInput.placeholder = n.ask && n.open ? 'Or reply in your own words…' : `Reply as ${displayName('you')}…`;
    if (key === lastThreadKey) return;
    const wasBottom = replies.scrollHeight - replies.scrollTop - replies.clientHeight < 40;
    lastThreadKey = key;
    const task = taskById(state, n.taskId);
    const { title, rest } = n.ask
      ? { title: n.ask.length > 1 ? `The Captain asks you ${n.ask.length} questions` : 'The Captain asks you', rest: n.open || n.answers ? '' : n.text }
      : splitText(n.text);
    const author = state.agents.find((a) => a.id === n.from);
    setChildren(head,
      h('div.row', null,
        badge(n),
        h('span.ref', null, [n.id, n.to ? `${displayName(n.from)} → ${displayName(n.to)}` : displayName(n.from), task ? `${task.id} ${task.title}` : n.taskId].filter(Boolean).join(' · ')),
        author ? h('button.btn.sm', { onclick: () => { location.hash = `#/dashboard?agent=${encodeURIComponent(author.id)}`; } }, 'Open terminal') : null,
        n.type === 'system' ? h('button.btn.sm', { onclick: () => void dismiss(n.id) }, icon('x', 12), 'Dismiss') : null),
      h('div.thread-title', null, title),
      rest ? h('div.thread-text', null, rest) : null,
    );
    const items: HTMLElement[] = n.replies.map((r) => h('div.msg', null,
      h('div.avatar', { class: `r-${roleOf(state, r.from)}` }, initial(r.from)),
      h('div.content', null,
        h('div.who', null, h('span.n', null, displayName(r.from)), h('span.t', null, ago(r.at))),
        h('div.txt', null, r.text))));
    if (!n.replies.length && !n.ask) items.push(h('div.faint', { style: 'font-size:13px' }, 'No replies yet.'));
    if (n.open && (n.type === 'stuck' || n.type === 'question' || n.type === 'waiting') && !isEscalated(state, n)) {
      items.push(h('div.banner', null, icon('users', 16), h('div.flex1', null, 'Being handled by the crew. This only reaches you if the Captain escalates it.')));
    } else if (isIntelJobNote(n)) {
      const v = intelNoteView(n as Note & { intel: NonNullable<Note['intel']> });
      items.push(h('div.banner', null, icon('radar', 16), h('div.flex1', null, v.tone === 'ready' ? 'scout finished. Open Intel to read it, or see the gaps it found.' : 'scout stopped before it finished. What it found is kept on the Intel page.'),
        intelActions(n, v.actions.filter((a) => a !== 'dismiss'), false)));
    } else if (n.topic === 'checkout') {
      items.push(n.open
        ? h('div.banner.warm', null, icon('alert', 16), h('div.flex1', null, 'Merges wait for this. Commit the files to keep them, or set them aside; the Captain then merges what you approved.'),
            h('span.flex', { style: 'display:flex;gap:6px' },
              h('button.btn.sm', { onclick: () => void stashCheckout() }, 'Set aside & merge'),
              h('button.btn.sm.merge', { onclick: () => void commitCheckout() }, 'Commit & merge')))
        : h('div.banner', null, icon('alert', 16), h('div.flex1', null, 'Sorted: the checkout is clean and the Captain was told to merge.')));
    } else if (n.ask) {
      items.push(n.open ? askForm(n.id, n.ask) : askAnswers(n as Note & { ask: AskQuestion[] }));
    } else if (n.type === 'system') {
      items.push(h('div.banner', null, icon('alert', 16), h('div.flex1', null, 'Posted by Muster. Nothing to answer: dismiss it once you have read it.')));
    } else if (isNeedsYou(n) || (n.open && isEscalated(state, n))) {
      const diffOwner = task ? branchOwnerId(state, task) : undefined;
      const isApproval = (n.type as string) === 'approval' && (task?.status as string) === 'awaiting_approval';
      const isRoadmap = isRoadmapNote(state, n);
      const roadmapDraft = isRoadmap && state.roadmap?.status === 'draft';
      const msg = isRoadmap
        ? roadmapDraft
          ? 'The Captain drafted a roadmap and waits for your approval. Look it over, then approve it or send it back with what should change.'
          : 'This roadmap note is settled. The roadmap page shows the current plan.'
        : isApproval
        ? 'Waiting for your approval. Approve to move the task on, or send it back with what needs to change.'
        : n.type === 'review' && task?.mergeApproval
        ? 'You approved this. The Captain is merging it and pushing to GitHub.'
        : n.type === 'review'
        ? 'Ready for review: the Captain has checked this branch. Approve it and the Captain merges and pushes, merge it yourself, or reply to send it back.'
        : n.type === 'escalation'
        ? 'Needs you: the Captain escalated this. Reply below; the answer goes to the agents involved.'
        : `Addressed to you. Reply below; the answer goes to ${displayName(n.from)}.`;
      const hint = isApproval && task?.line === 'new-app'
        ? h('div.faint', { style: 'font-size:12px;margin-top:4px' }, 'Pick the product name in Settings → Project, then back it up to GitHub from Settings → GitHub.') : null;
      const act = isRoadmap
        ? h('span.flex', { style: 'display:flex;gap:6px' },
            h('button.btn.sm', { onclick: () => { location.hash = '#/roadmap'; } }, 'Open roadmap'),
            roadmapDraft ? h('button.btn.sm', { onclick: () => void sendBackRoadmap() }, 'Send back') : null,
            roadmapDraft ? h('button.btn.sm.merge', { onclick: () => void approveRoadmap() }, 'Approve') : null)
        : isApproval
        ? h('span.flex', { style: 'display:flex;gap:6px' },
            diffOwner ? h('button.btn.sm', { onclick: () => void showDiffModal(diffOwner, task!.branch) }, 'View diff') : null,
            h('button.btn.sm', { onclick: () => void sendBackApproval(task!) }, 'Send back'),
            h('button.btn.sm.merge', { onclick: () => void approveTask(task!) }, 'Approve'))
        : n.type === 'review' && task?.status === 'ready_for_merge'
        ? h('span.flex', { style: 'display:flex;gap:6px' },
            h('button.btn.sm', { onclick: () => mergeTask(state, task) }, 'Merge myself'),
            task.mergeApproval ? null : h('button.btn.sm.merge', { onclick: () => void approveMerge(task) }, 'Approve'))
        : null;
      items.push(h('div.banner.warm', null, icon('alert', 16), h('div.flex1', null, msg, hint), act));
      if (n.type === 'review' && task) items.push(evidenceStrip(task));
    }
    const qa = task?.qa && n.open && (n.type === 'review' || n.type === 'escalation' || (n.type as string) === 'approval') ? qaStrip(task, 5, true) : null;
    if (qa) items.push(qa);
    setChildren(replies, items);
    if (n.ask && n.open && !n.replies.length) replies.scrollTop = 0; // a fresh question menu reads from its first question
    else if (wasBottom) replies.scrollTop = replies.scrollHeight;
  }

  function render(): void {
    if (!snap) return;
    const state = visibleState(snap.state);
    renderFilters(state);
    const notes = sortNotes(state.notes.filter((n) => matches(n, filter)));
    // held remote writes sit at the top of Open, Needs you and All
    const heldList = filter === 'open' || filter === 'needsYou' || filter === 'all' ? held.list() : [];
    const ids = [...heldList.map((e) => e.p.pendingId), ...notes.map((n) => n.id)];
    const heldSel = heldList.some((e) => e.p.pendingId === selected);
    if (!selected || !(heldSel || state.notes.some((n) => n.id === selected))) selected = ids[0] ?? null;
    const scroll = list.scrollTop;
    const rows = [
      ...heldList.map((e) => heldRow(state, e, e.p.pendingId === selected, () => { selected = e.p.pendingId; render(); })),
      ...notes.map((n) => row(state, n)),
    ];
    setChildren(list, rows.length ? rows : h('div.empty', null, filter === 'needsYou' ? 'Nothing needs you right now.' : 'No notes.'));
    list.scrollTop = scroll;
    if (!renderHeld(state, heldList.some((e) => e.p.pendingId === selected) ? selected : null)) renderThread(state, state.notes.find((n) => n.id === selected));
  }

  function projectName(s: Snapshot): string {
    return s.config.projectName || s.state.repoRoot.split(/[\\/]/).filter(Boolean).pop() || '';
  }

  return {
    el,
    show() {
      void update.check();
      updateTimer ??= setInterval(() => void update.check(), 60_000);
      if (snap) void held.setProject(snap.state.repoRoot, projectName(snap)).then(() => held.load(true));
      pollTimer ??= setInterval(() => void held.load(), POLL_MS);
      tickTimer ??= setInterval(() => { if (!held.tick()) tickCountdowns(el); }, 1_000);
    },
    hide() {
      clearInterval(updateTimer);
      updateTimer = undefined;
      clearInterval(pollTimer);
      pollTimer = undefined;
      clearInterval(tickTimer);
      tickTimer = undefined;
    },
    update(s) {
      snap = s;
      weekly.update(s);
      render();
      void held.setProject(s.state.repoRoot, projectName(s)).then(() => held.load()); // the events refresh polls too
    },
    params(p) {
      const id = p.get('note');
      if (id) {
        selected = id;
        const n = snap?.state.notes.find((x) => x.id === id && !x.dismissed);
        if (n && !matches(n, filter)) filter = 'all';
        render();
        history.replaceState(null, '', '#/board');
      }
    },
  };
}
