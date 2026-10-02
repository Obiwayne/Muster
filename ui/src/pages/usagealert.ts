// Bulletin board view for a weekly usage alert note (type 'system', topic 'weekly_usage'):
// a meter with the alert marker, and "What next?": remind again at N%, not this week, never.
import type { Note } from '../../../src/types';
import { h, icon, setChildren, toast } from '../dom';
import { events, type Snapshot } from '../events';
import { api } from '../api';
import { displayName } from '../util';
import { REMIND_OPTIONS, customError, defaultRemind, durationShort, meter, remindAllowed, resetDate, weeklyThreshold } from '../usagealert';

type Choice = 'remind_at' | 'snooze_week' | 'never';

export function createWeeklyAlertView(opts: { dismiss: (noteId: string) => Promise<void> }): {
  el: HTMLElement; update(s: Snapshot): void; show(n: Note): void;
} {
  let snap: Snapshot | null = null;
  let note: Note | null = null;
  let choice: Choice = 'remind_at';
  let percent: number | null = null; // chosen chip; null = custom
  let busy = false;
  let error = '';

  const head = h('div.ua-head');
  const options = h('div.ua-options');
  const custom = h('input.ua-custom-input', { inputmode: 'numeric', placeholder: '__', maxlength: 3 }) as HTMLInputElement;
  const customBox = h('label.ua-custom', null, custom, h('span', null, '%'));
  const err = h('div.ua-err', { hidden: true });
  const justBtn = h('button.btn.lg', null, 'Just dismiss') as HTMLButtonElement;
  const saveBtn = h('button.btn.lg.primary', null, 'Save & dismiss') as HTMLButtonElement;
  const foot = h('div.ua-foot', null, h('div.flex1.faint', null, 'You can change this any time in Settings → Usage.'), justBtn, saveBtn);
  const el = h('div.ua', { hidden: true }, head, h('div.ua-body', null, h('div.section-label', null, 'WHAT NEXT?'), options, err, h('div.flex1'), foot));

  const nowPct = () => snap?.state.usage.sevenDay?.usedPercentage ?? 0;
  const setError = (t: string) => { error = t; err.textContent = t; err.hidden = !t; };

  custom.addEventListener('focus', () => { if (choice !== 'remind_at' || percent !== null) { choice = 'remind_at'; percent = null; draw(); custom.focus(); } });
  custom.addEventListener('input', () => { custom.value = custom.value.replace(/[^\d]/g, ''); if (error) setError(''); });
  custom.addEventListener('keydown', (e) => { if (e.key === 'Enter') void save(); });

  async function dismiss(): Promise<void> {
    if (!note || busy) return;
    busy = true;
    try { await opts.dismiss(note.id); } finally { busy = false; }
  }
  justBtn.onclick = () => void dismiss();

  async function save(): Promise<void> {
    if (!note || busy) return;
    let pct: number | undefined;
    if (choice === 'remind_at') {
      if (percent === null) {
        const e = customError(custom.value, nowPct());
        if (e) { setError(e); custom.focus(); return; }
        pct = Number(custom.value);
      } else pct = percent;
    }
    busy = true;
    saveBtn.disabled = true;
    setError('');
    try {
      const r = await api.weeklyAlert({ action: choice, ...(pct !== undefined ? { percent: pct } : {}), noteId: note.id });
      if (events.snapshot && r?.config) events.set({ state: { ...events.snapshot.state, usage: r.usage ?? events.snapshot.state.usage }, config: r.config });
      toast(choice === 'remind_at' ? `You'll get one more note at ${pct}%` : choice === 'snooze_week' ? 'No more weekly alerts until the reset' : 'Weekly alerts are off');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busy = false;
      saveBtn.disabled = false;
    }
  }
  saveBtn.onclick = () => void save();

  function option(c: Choice, title: string, sub: string, extra?: HTMLElement): HTMLElement {
    const on = choice === c;
    return h('div.ua-opt', {
      class: on && 'on',
      role: 'radio',
      'aria-checked': String(on),
      tabindex: 0,
      onclick: () => { if (choice !== c) { choice = c; setError(''); draw(); } },
      onkeydown: (e: KeyboardEvent) => { if ((e.key === ' ' || e.key === 'Enter') && e.target === e.currentTarget) { e.preventDefault(); choice = c; draw(); } },
    },
    h('span.ua-radio', null, on ? h('span') : null),
    h('div.flex1', null, h('div.ua-opt-t', null, title), h('div.ua-opt-s', null, sub), extra ?? null));
  }

  function draw(): void {
    if (!snap || !note) return;
    const { state, config } = snap;
    const now = nowPct();
    const alertAt = weeklyThreshold(state.usage, config);
    const m = meter(now, alertAt);
    const resetsAt = state.usage.sevenDay?.resetsAt;
    setChildren(head,
      h('div.ua-row', null,
        h('span.badge.b-warm', null, 'usage'),
        h('span.ua-ref', null, `${note.id} · ${displayName(note.from)}${note.to ? ` → ${displayName(note.to)}` : ''}`),
        h('button.btn.sm', { onclick: () => void dismiss() }, icon('x', 12), 'Dismiss')),
      h('div.ua-title', null, `Weekly usage is at ${Math.round(now)}%`),
      h('div.ua-meter', { title: `Alert at ${alertAt}%` },
        h('div.ua-fill', { style: { width: `${m.fill}%` } }),
        h('div.ua-marker', { style: { left: `${m.marker}%` } })),
      h('div.ua-meter-row', null,
        h('span.flex1', null, `alert at ${alertAt}% · now ${Math.round(now)}%`),
        resetsAt ? h('span', null, `resets ${resetDate(resetsAt)} · ${durationShort(Date.parse(resetsAt) - Date.now())}`) : null));

    if (percent === null && choice === 'remind_at' && !custom.value && document.activeElement !== custom) percent = defaultRemind(now);
    const chips = h('div.ua-chips', { onclick: (e: MouseEvent) => e.stopPropagation() },
      REMIND_OPTIONS.map((p) => h('button.ua-chip', {
        class: choice === 'remind_at' && percent === p && 'on',
        disabled: !remindAllowed(p, now),
        title: remindAllowed(p, now) ? undefined : `Already past ${p}%`,
        onclick: () => { choice = 'remind_at'; percent = p; custom.value = ''; setError(''); draw(); },
      }, `${p}%`)),
      customBox);
    customBox.classList.toggle('on', choice === 'remind_at' && percent === null);
    const resetDay = resetsAt ? resetDate(resetsAt, false) : '';
    setChildren(options,
      option('remind_at', 'Remind me again at', 'One more note when weekly usage reaches this', chips),
      option('snooze_week', "Don't remind me again this week", resetDay ? `Alerts come back after the reset on ${resetDay}` : 'Alerts come back after the weekly reset'),
      option('never', 'Never remind me', `Turns weekly alerts off. The 5-hour pause at ${config.pauseAtFiveHourPct}% still protects you.`));
  }

  return {
    el,
    update(s) { snap = s; if (!el.hidden && document.activeElement !== custom) draw(); },
    show(n) {
      if (note?.id === n.id && document.activeElement === custom) return; // don't rebuild under the cursor
      if (note?.id !== n.id) {
        choice = 'remind_at';
        percent = null;
        custom.value = '';
        setError('');
      }
      note = n;
      draw();
    },
  };
}
