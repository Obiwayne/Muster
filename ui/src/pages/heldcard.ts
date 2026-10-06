// Held remote writes on the Bulletin board (docs/REMOTE.md, "Needs-you Send card"): the HELD rows at the top of the
// list and the Send card in the thread pane. The tap on Send is the protection, so the card shows exactly what Send
// sends, in full, and Send posts back the digest of the card that was rendered. No confirm dialogs on Send or Discard.
// Text from Claude and from agents is only ever rendered as text nodes.
import type { MusterState } from '../../../src/types';
import { h, icon, toast } from '../dom';
import { api, ApiError } from '../api';
import { errToast } from '../actions';
import { hhmm, roleOf } from '../util';
import {
  answerViews, askedAgo, exactLabel, failedText, fmtLeft, forProject, heldTitle, isOverdue, isWarm, KIND_LABEL, lockText, msLeft,
  overdueText, projectKeyInput, recipients, rowMeta, rowText, sendLabel, sortHeld, targetNote, type HeldStatus, type PendingRemote,
} from '../heldmodel';

export const POLL_MS = 5_000;
const BACKOFF_MS = 60_000; // gateway down or remote off: try again now and then, quietly

export interface HeldEntry { p: PendingRemote; status: HeldStatus; error?: string }

/** This project's id as the gateway knows it: asked from the orchestrator, else sha256(projectKeyInput(root)).slice(0, 16)
 *  like repoKey (an older server); null when neither works. */
export async function projectId(root: string): Promise<string | null> {
  try {
    return (await api.projectId()).id;
  } catch {
    /* an orchestrator without /api/project/id: hash it here */
  }
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const buf = await subtle.digest('SHA-256', new TextEncoder().encode(projectKeyInput(root)));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  } catch {
    return null;
  }
}

/** The board's held writes: polled from the gateway, filtered to this project, with each card's local state. */
export function createHeldStore(onChange: () => void) {
  const entries = new Map<string, HeldEntry>(); // by pending id ("P8")
  const dismissed = new Set<string>();
  let project: { root: string; id: string | null; name: string } | null = null;
  let loading = false;
  let lastLoad = 0;
  let retryAt = 0;
  let sig = '';

  // overdue-ness is in it so a failed card re-renders when its countdown gives way to "Waiting since"
  const signature = () => [...entries.values()].map((e) => `${e.p.pendingId}:${e.p.digest}:${e.p.expiresAt}:${e.status}:${isOverdue(e.p)}:${e.error ?? ''}`).join('|');
  const changed = (): boolean => {
    const s = signature();
    if (s === sig) return false;
    sig = s;
    onChange();
    return true;
  };

  async function setProject(root: string, name: string): Promise<void> {
    if (project?.root === root && project.name === name) return;
    const id = await projectId(root);
    project = { root, id, name };
  }

  async function load(force = false): Promise<void> {
    const now = Date.now();
    if (!project || loading || (!force && now - lastLoad < 1_000) || now < retryAt) return;
    loading = true;
    lastLoad = now;
    try {
      const list = forProject(await api.remotePending(), project);
      const seen = new Set<string>();
      for (const p of list) {
        if (dismissed.has(p.pendingId)) continue;
        seen.add(p.pendingId);
        const e = entries.get(p.pendingId);
        if (!e) entries.set(p.pendingId, { p, status: isOverdue(p) ? 'overdue' : 'idle' });
        else if (e.status !== 'sending') e.p = p; // a held write never changes; take the server's copy anyway
      }
      for (const [id, e] of entries) {
        if (seen.has(id) || e.status === 'sending') continue;
        // gone from the gateway: sent or discarded from the phone, so it just goes (a 'gone' card stays until dismissed)
        if (e.status === 'gone') continue;
        entries.delete(id);
      }
    } catch {
      retryAt = Date.now() + BACKOFF_MS; // nothing to show; no toast, no error
    } finally {
      loading = false;
    }
    changed();
  }

  /** Once a second: waiting cards past their 15 minutes turn overdue (still sendable). True when something changed. */
  function tick(now = Date.now()): boolean {
    for (const e of entries.values()) if (e.status === 'idle' && isOverdue(e.p, now)) e.status = 'overdue';
    return changed();
  }

  /** Send exactly the card you saw: `shown` is the write as rendered (its digest goes back to the gateway). */
  async function send(shown: PendingRemote): Promise<void> {
    const e = entries.get(shown.pendingId);
    if (!e || e.status === 'sending') return;
    e.status = 'sending';
    e.error = undefined;
    changed();
    try {
      const r = await api.remoteSend(shown.pendingId, shown.digest);
      entries.delete(shown.pendingId);
      toast(r.summary ? `Sent: ${r.summary}` : `Sent ${shown.pendingId}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        e.status = 'gone'; // already sent or discarded (a held write never times out)
        e.error = err.message;
      } else {
        e.status = 'failed';
        e.error = err instanceof Error ? err.message : String(err);
      }
    }
    changed();
  }

  async function discard(id: string): Promise<void> {
    const e = entries.get(id);
    if (!e || e.status === 'sending') return;
    try {
      await api.remoteDiscard(id);
      toast(`Discarded ${id}. Nothing was sent.`);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) { errToast(err); return; }
    }
    entries.delete(id);
    changed();
  }

  /** Gone: client-side only (the gateway no longer holds it). */
  function dismiss(id: string): void {
    dismissed.add(id);
    entries.delete(id);
    changed();
  }

  return {
    setProject,
    load,
    tick,
    send,
    discard,
    dismiss,
    /** Oldest first (overdue ones lead); gone cards after the held ones. */
    list(): HeldEntry[] {
      const all = [...entries.values()];
      const live = all.filter((e) => e.status !== 'gone');
      const over = all.filter((e) => e.status === 'gone');
      return [...sortHeld(live.map((e) => ({ ...e.p, e }))).map((x) => x.e), ...over];
    },
    get(id: string): HeldEntry | undefined { return entries.get(id); },
    /** Held writes still waiting on you, overdue ones too (they count in Needs you). */
    waiting(): number { return [...entries.values()].filter((e) => e.status !== 'gone').length; },
  };
}

export type HeldStore = ReturnType<typeof createHeldStore>;

const captainOf = (state: MusterState) => state.agents.find((a) => a.role === 'captain')?.id ?? 'captain';
const over = (s: HeldStatus) => s === 'gone';
/** Overdue by the clock (a failed send can be overdue too): the countdown gives way to "Waiting since". */
const late = (e: HeldEntry) => e.status !== 'gone' && isOverdue(e.p);

/** Updates every live countdown under `root` (rows and the card's chip) without re-rendering. */
export function tickCountdowns(root: ParentNode, now = Date.now()): void {
  root.querySelectorAll<HTMLElement>('[data-expires]').forEach((el) => {
    const left = Math.max(0, Date.parse(el.dataset.expires!) - now);
    const txt = el.querySelector<HTMLElement>('.cd-t') ?? el;
    txt.textContent = el.dataset.suffix ? `${fmtLeft(left)}${el.dataset.suffix}` : fmtLeft(left);
    el.classList.toggle('warm', isWarm(left));
  });
}

/** A HELD row at the top of the board list: full text, never clipped, with its countdown. */
export function heldRow(state: MusterState, e: HeldEntry, selected: boolean, onSelect: () => void): HTMLElement {
  const p = e.p;
  const captain = captainOf(state);
  const done = over(e.status);
  const left = msLeft(p);
  return h('button.note-row.held-row', { class: [selected && 'sel', done && 'over', late(e) && 'late'], onclick: onSelect },
    h('div.type', null, h('span.held-badge', { class: done && 'over' }, done ? 'GONE' : 'HELD')),
    h('div.body', null,
      h('div.held-text', null, done ? heldTitle(p, { captain, past: true }) + (p.text ? `: ${p.text}` : '') : rowText(p, captain)),
      h('div.meta', null, rowMeta(p, captain))),
    h('div.side', null,
      done
        ? h('span.faint', null, 'gone')
        : late(e)
        ? [h('span.held-left.warm', null, `since ${hhmm(p.createdAt)}`),
          e.status === 'failed' ? h('span.held-failed', null, 'failed') : h('span.faint', null, 'not sent')]
        : [h('span.held-left', { class: isWarm(left) && 'warm', dataset: { expires: p.expiresAt } }, fmtLeft(left)),
          e.status === 'failed' ? h('span.held-failed', null, 'failed') : h('span.faint', null, 'left')]));
}

/** The Send card for the thread pane. `shown` is captured here: Send posts this render's digest, nothing newer. */
export function heldCard(state: MusterState, e: HeldEntry, store: HeldStore): HTMLElement {
  const p: PendingRemote = e.p;
  const captain = captainOf(state);
  const done = over(e.status);
  const left = msLeft(p);
  const note = targetNote(p, state.notes);

  // ---- header
  const countdown = done
    ? h('span.cd-chip.over', null, icon('timer', 13), h('span.cd-t', null, 'no longer held'))
    : late(e)
    ? h('span.cd-chip.warm', null, icon('timer', 13), h('span.cd-t', null, overdueText(p)))
    : h('span.cd-chip', { class: isWarm(left) && 'warm', dataset: { expires: p.expiresAt, suffix: ' left' } }, icon('timer', 13), h('span.cd-t', null, `${fmtLeft(left)} left`));
  const chips = recipients(p, captain).map((r) => r.kind === 'task'
    ? h('span.to-chip.task', null, h('span.mono', null, r.id), state.tasks.find((t) => t.id === r.id)?.title ?? p.taskTitle ?? '')
    : h('span.to-chip', { class: `r-${roleOf(state, r.id)}` }, h('span.dot6'), r.label));
  const head = h('div.hc-head', null,
    h('div.hc-top', null,
      h('span.held-badge', { class: done && 'over' }, done ? 'GONE' : `HELD · ${KIND_LABEL[p.kind]}`),
      h('span.hc-ref', null, [p.pendingId, `from ${p.client}`, askedAgo(p.createdAt)].join(' · ')),
      h('span.flex1'),
      countdown),
    h('div.hc-title', null, heldTitle(p, { captain, past: done })),
    h('div.hc-to', null,
      h('span.lbl', null, done ? 'Would have gone to' : 'Goes to'),
      chips,
      h('span.lbl', null, `in ${p.projectName}`)));

  // ---- body (scrolls behind the pinned footer)
  const quote = p.replyTo && (p.kind === 'reply' || p.kind === 'answer')
    ? h('div.hc-quote', null,
        h('div.hc-qhead', null,
          h('span.cap', null, 'REPLYING TO'),
          h('span.mono', null, `${p.replyTo.id} · ${note?.type ?? 'note'} from`),
          h('span.mono', { class: `who r-${roleOf(state, p.replyTo.from)}` }, p.replyTo.from)),
        h('div.hc-qtext', null, p.replyTo.text),
        h('div.hc-qnote', null, `Written by an agent. Shown as it was when ${p.client} asked.`))
    : null;
  let exact: HTMLElement;
  if (p.kind === 'answer') {
    exact = h('div.hc-exact.answers', { class: done && 'over' },
      h('div.cap.pad', null, exactLabel(p, done)),
      answerViews(p, note?.ask).map((a) => h('div.hc-ans', null,
        h('div.hc-q', null, `${a.n} · ${a.question}`),
        a.choices.length ? h('div.hc-choices', null, a.choices.map((c) => h('span.hc-choice', null, c))) : null,
        a.other ? [h('div.cap', null, 'OTHER (FREE TEXT)'), h('div.hc-text', null, a.other)] : null,
        !a.choices.length && !a.other ? h('div.faint', null, '(no answer)') : null)));
  } else if (p.kind === 'approve') {
    exact = h('div.hc-exact', { class: done && 'over' },
      h('div.cap', null, exactLabel(p, done)),
      h('div.hc-text', null, `Approve ${[p.taskId, p.taskTitle].filter(Boolean).join(' ')} for merge. The Captain then merges it and pushes to GitHub.`));
  } else {
    exact = h('div.hc-exact', { class: done && 'over' },
      h('div.cap', null, exactLabel(p, done)),
      h('div.hc-text', null, p.text ?? ''));
  }
  const scroller = h('div.hc-body', null, quote, exact);
  const hint = h('div.hc-fade', null, h('span.hc-hint', null, icon('chevron', 12), 'Scroll to read the rest before sending'));
  const bodyWrap = h('div.hc-bodywrap', null, scroller, hint);
  const syncHint = () => {
    const overflows = scroller.scrollHeight > scroller.clientHeight + 2;
    const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 8;
    bodyWrap.classList.toggle('overflows', overflows && !atEnd && !done);
  };
  scroller.addEventListener('scroll', syncHint);
  new ResizeObserver(syncHint).observe(scroller);
  requestAnimationFrame(syncHint);

  // ---- pinned footer
  let callout: HTMLElement;
  let actions: HTMLElement;
  if (done) {
    callout = h('div.hc-callout.neutral', null, icon('timer', 16),
      h('div.cc', null,
        h('div.cb', null, 'No longer held. Nothing was sent from here.'),
        h('div.cs', null, `${e.error ? `${e.error.replace(/\.?$/, '.')} ` : ''}It may have been sent or discarded on your phone.`)));
    actions = h('div.hc-actions', null, h('button.hc-btn', { onclick: () => store.dismiss(p.pendingId) }, 'Dismiss'));
  } else {
    const failed = e.status === 'failed';
    const sending = e.status === 'sending';
    callout = failed
      ? h('div.hc-callout.failed', null, icon('alert', 16),
          h('div.cc', null, h('div.cb', null, 'Send failed. Nothing was sent.'), h('div.cs', null, failedText(e.error ?? ''))))
      : h('div.hc-callout', null, icon('lock2', 16),
          h('div.cc', null, h('div.cb', null, 'Nothing has been sent yet.'), h('div.cs', null, lockText(p, captain))));
    const shown = { ...p }; // what this card shows; Send quotes its digest
    actions = h('div.hc-actions', null,
      h('button.hc-btn.send', { disabled: sending, onclick: () => void store.send(shown) },
        icon(failed ? 'refresh' : 'send', 16, 2.2), sending ? 'Sending…' : failed ? 'Try again' : sendLabel(p)),
      h('button.hc-btn', { disabled: sending, onclick: () => void store.discard(p.pendingId) }, icon('x', 16, 2.2), 'Discard'));
  }
  const foot = h('div.hc-foot', null, callout, actions);
  return h('div.held-card', { class: done && 'over' }, head, bodyWrap, foot);
}
