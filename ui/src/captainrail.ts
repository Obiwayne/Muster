// "Talk to Captain" rail on Intel → Opportunities (Vellum 5547-0). Per idea it uses the idea's thread (ask/advise,
// POST /api/intel/ask with ideaId); "All gaps" uses IntelStore.captainThread (POST /api/intel/ask without one).
// Below the thread: "On approve, Captain will" (the Captain's plan lines minus any re-check line of his + the re-check
// line from config.intel.recheck and check.watchFor; once approved, from the idea's watch), quick prompts, the input, and Not now (leaves the idea open: the page just
// moves on) / Approve & add to roadmap (disabled without a fresh intel check; a 409 from the server is shown with "Run intel check").
import './intelcheck.css';
import type { IdeaMessage, IntelStore, MusterConfig, ResearchIdea } from '../../src/types';
import { h, icon, setChildren } from './dom';
import { displayName } from './util';
import { parsePlanItem, splitAdvice } from './research';
import { checkStatus, planLines, recheckLine, watchLine } from './intelcheck';

export type RailMode = 'idea' | 'all';

export interface QuickPrompt { label: string; text: string; ideaId?: string }

export interface CaptainRailState {
  mode: RailMode;
  idea?: ResearchIdea;
  store: IntelStore;
  config: Pick<MusterConfig, 'intel'> | null;
  prompts: QuickPrompt[];
  /** The last approve answered 409 (check missing/stale/running). */
  blocked?: string;
  busy?: boolean;
}

export interface CaptainRailCallbacks {
  onMode(mode: RailMode): void;
  /** Send to the Captain; resolves when the server took it. Throws to show the error under the input. */
  onSend(text: string, ideaId?: string): Promise<void>;
  onApprove(idea: ResearchIdea): void;
  onNotNow(idea: ResearchIdea): void;
  onRunCheck(idea: ResearchIdea): void;
}

/** Quick prompts for the rail: the design's three, the test one only when an idea is "test first". */
export function quickPrompts(ideas: Pick<ResearchIdea, 'id' | 'status' | 'opportunity'>[]): QuickPrompt[] {
  const out: QuickPrompt[] = [
    { label: 'Add all quick wins', text: 'Add all the quick wins to the roadmap. Which goal or stage does each go in, and what moves?' },
    { label: 'What would you drop?', text: 'If we take on the gaps worth doing, what would you drop or push back to make room?' },
  ];
  const test = ideas.find((i) => i.status === 'new' && i.opportunity?.testFirst);
  if (test) out.push({ label: `Plan the ${test.id} test`, text: `How would we test ${test.id} before building it? Keep it small.`, ideaId: test.id });
  return out;
}

/** Thread for the current mode. */
export function railThread(mode: RailMode, idea: Pick<ResearchIdea, 'thread'> | undefined, store: Pick<IntelStore, 'captainThread'>): IdeaMessage[] {
  return mode === 'idea' && idea ? idea.thread : store.captainThread;
}

/** The Captain answers soon: the last message is yours. */
export function awaitingCaptain(thread: IdeaMessage[]): boolean {
  return thread.length > 0 && thread[thread.length - 1].from === 'you';
}

export function createCaptainRail(cb: CaptainRailCallbacks): { el: HTMLElement; update(s: CaptainRailState): void } {
  let state: CaptainRailState | null = null;
  let sending = false;
  let sendErr = '';
  const drafts = new Map<string, string>();
  const key = () => (state?.mode === 'idea' && state.idea ? state.idea.id : '*');

  const head = h('div.cr-head');
  const thread = h('div.cr-thread');
  const bottom = h('div.cr-bottom');
  const input = h('input.cr-input', { placeholder: 'Ask Captain about the gaps…' }) as HTMLInputElement;
  const inputBox = h('label.cr-ask', null, input, h('span.cr-kbd', null, 'Enter'));
  const err = h('div.cr-err', { hidden: true });
  const plan = h('div.cr-plan-wrap');
  const prompts = h('div.cr-prompts');
  const gate = h('div.cr-gate', { hidden: true });
  const actions = h('div.cr-actions');
  setChildren(bottom, plan, prompts, inputBox, err, gate, actions);
  const el = h('aside.cr', null, head, thread, bottom);
  let shownKey = '';

  async function send(text: string, ideaId?: string): Promise<void> {
    if (!text.trim() || sending) return;
    sending = true;
    input.disabled = true;
    sendErr = '';
    const k = key();
    try {
      await cb.onSend(text.trim(), ideaId);
      drafts.delete(k);
      if (key() === k) input.value = '';
    } catch (e) {
      sendErr = e instanceof Error ? e.message : String(e);
    } finally {
      sending = false;
      input.disabled = false;
      if (state) update(state);
      input.focus();
    }
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) void send(input.value, state?.mode === 'idea' ? state.idea?.id : undefined);
  });
  input.addEventListener('input', () => { drafts.set(key(), input.value); if (sendErr) { sendErr = ''; err.hidden = true; } });

  function update(s: CaptainRailState): void {
    state = s;
    const idea = s.mode === 'idea' ? s.idea : undefined;
    const k = key();
    if (k !== shownKey) { shownKey = k; input.value = drafts.get(k) ?? ''; sendErr = ''; }

    setChildren(head,
      h('div.cr-avatar', null, h('span')),
      h('div.cr-head-t', null,
        h('div.cr-title', null, 'Talk to Captain'),
        h('div.cr-sub', null, idea ? `about ${idea.id} · sees the roadmap and evidence` : 'about all the gaps · sees the roadmap and evidence')),
      s.idea
        ? h('button.cr-mode', { onclick: () => cb.onMode(s.mode === 'idea' ? 'all' : 'idea'), title: s.mode === 'idea' ? 'Talk about all the gaps' : `Back to ${s.idea.id}` },
          s.mode === 'idea' ? 'All gaps' : `${s.idea.id} only`)
        : null);

    const msgs = railThread(s.mode, idea, s.store);
    const items: HTMLElement[] = msgs.map((m) => {
      if (m.from === 'you') return h('div.cr-msg.you', { title: m.at }, m.text);
      const { lead, rest } = splitAdvice(m.text);
      return h('div.cr-msg.captain', { title: m.at },
        h('div.cr-who', null, displayName(m.from)),
        h('div.cr-text', null, lead),
        rest ? rest.split(/\n\s*\n/).map((p) => h('div.cr-text', null, p)) : null);
    });
    if (!msgs.length) {
      items.push(h('div.cr-hint', null, idea
        ? `Ask what ${idea.id} would cost, where it fits, or what it would push back. The Captain answers here.`
        : 'Ask the Captain which gaps are worth closing and what they would move. Answers land here.'));
    }
    if (awaitingCaptain(msgs)) items.push(h('div.cr-hint', null, h('span.rs-typing'), 'The Captain will answer here.'));
    const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
    setChildren(thread, items);
    if (nearBottom || k !== thread.dataset.k) { thread.scrollTop = thread.scrollHeight; thread.dataset.k = k; }

    // On approve, Captain will…
    if (idea && idea.status === 'new') {
      const st = checkStatus(idea, s.store, s.config);
      const re = recheckLine(st.check, s.config);
      const lines = planLines(idea.plan).map((line) => {
        const p = parsePlanItem(line);
        const start = /^start\b/i.test(p.text);
        const keep = /\bstays\b|\bunchanged\b/i.test(p.text) && p.sign === '•';
        const sign = start ? '▶' : keep ? '=' : p.sign;
        const cls = sign === '+' || sign === '▶' ? 'add' : sign === '~' ? 'move' : sign === '−' ? 'drop' : 'keep';
        return h('div.cr-plan-row', null, h('span.cr-sign', { class: cls }, sign), h('span.cr-plan-text', { class: cls === 'keep' && 'muted' }, p.text), p.meta ? h('span.cr-meta', { title: p.meta }, p.meta) : null);
      });
      setChildren(plan, h('div.cr-plan', null,
        h('div.cr-plan-t', null, 'ON APPROVE, CAPTAIN WILL'),
        lines.length ? lines : h('div.cr-plan-row', null, h('span.cr-sign.keep', null, '·'), h('span.cr-plan-text.muted', null, 'Ask the Captain for a plan: goals, stage and what moves.')),
        re ? h('div.cr-plan-row', null, h('span.cr-sign.watch', null, '◉'), h('span.cr-plan-text', null, re.text), re.meta ? h('span.cr-meta.watch', null, re.meta) : null) : null,
        st.check ? h('div.cr-plan-row', null, h('span.cr-sign.keep', null, '↳'), h('span.cr-plan-text.muted', null, `Attach intel check ${st.check.id} to the new goal`)) : null));
    } else if (idea && idea.status === 'approved') {
      const watched = watchLine(idea, s.store);
      setChildren(plan, h('div.cr-plan.done', null,
        h('div.cr-plan-t', null, idea.goalId ? `ON THE ROADMAP AS ${idea.goalId}` : 'APPROVED · CAPTAIN IS ADDING IT'),
        planLines(idea.plan).map((line) => {
          const p = parsePlanItem(line);
          const cls = p.sign === '+' ? 'add' : p.sign === '~' ? 'move' : p.sign === '−' ? 'drop' : 'keep';
          return h('div.cr-plan-row', null, h('span.cr-sign', { class: cls }, p.sign), h('span.cr-plan-text', null, p.text), p.meta ? h('span.cr-meta', { title: p.meta }, p.meta) : null);
        }),
        watched ? h('div.cr-plan-row', null, h('span.cr-sign.watch', null, '◉'), h('span.cr-plan-text', null, watched.text), watched.meta ? h('span.cr-meta.watch', null, watched.meta) : null) : null));
    } else setChildren(plan);

    setChildren(prompts, s.prompts.map((q) => h('button.cr-prompt', { disabled: sending, onclick: () => void send(q.text, q.ideaId) }, q.label)));
    input.placeholder = idea ? (idea.thread.length ? 'Ask a follow-up…' : `Ask Captain about ${idea.id}…`) : 'Ask Captain about the gaps…';
    err.textContent = sendErr;
    err.hidden = !sendErr;

    // Gate + decision
    if (idea && idea.status === 'new') {
      const st = checkStatus(idea, s.store, s.config);
      const msg = s.blocked ?? (st.canApprove ? '' : st.reason);
      gate.hidden = !msg;
      setChildren(gate,
        icon('alert', 13),
        h('span.flex1', null, msg),
        (s.blocked || st.canRun) && st.state !== 'running' && st.state !== 'queued'
          ? h('button.btn.sm', { disabled: !!s.busy, onclick: () => cb.onRunCheck(idea) }, 'Run intel check')
          : null);
      setChildren(actions,
        h('button.cr-big', { disabled: !!s.busy, onclick: () => cb.onNotNow(idea), title: 'Leave it open and move on; nothing is rejected' }, 'Not now'),
        h('button.cr-big.ok', {
          disabled: !!s.busy || !st.canApprove,
          title: st.canApprove ? 'Approve; the Captain adds it to the roadmap' : st.reason,
          onclick: () => cb.onApprove(idea),
        }, 'Approve & add to roadmap'));
    } else {
      gate.hidden = true;
      setChildren(actions, idea && idea.status === 'rejected'
        ? h('div.cr-decided', null, `${idea.id} was set aside. Reopen it on Roadmap → Research.`)
        : null);
    }
  }

  return { el, update };
}
