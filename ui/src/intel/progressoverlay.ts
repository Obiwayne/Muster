// The research-in-progress overlay over the Intel page's content (Vellum "Intel — researching (overlay)", 7031-0):
// a scrim and a centred card with a radar, "scout is researching <Competitor>", N of M areas + bar, pages · elapsed ·
// ≈ left, area chips, the latest claim, and Cancel (confirmed inline) / Peek at results.
import { h, icon, setChildren } from '../dom';
import type { OverlayModel } from '../intelprogress';

export interface ProgressOverlay {
  el: HTMLElement;
  render(model: OverlayModel | null): void;
}

export function createProgressOverlay(o: { onCancel(jobId: string): Promise<boolean>; onPeek(jobId: string): void }): ProgressOverlay {
  let model: OverlayModel | null = null;
  let confirming = false;
  let busy = false;
  let chipKey = '';

  const radar = h('div.ip-radar', { 'aria-hidden': 'true' }, h('div.ip-ring'), h('div.ip-sweep'), h('div.ip-dot'));
  const title = h('div.ip-title');
  const line = h('div.ip-line');
  const count = h('div.ip-count');
  const meta = h('div.ip-meta');
  const fill = h('div.ip-fill');
  const bar = h('div.ip-bar', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill);
  const chips = h('div.ip-chips');
  const foot = h('div.ip-foot');
  const card = h('div.ip-card', { role: 'dialog', 'aria-modal': 'false', 'aria-live': 'polite' },
    h('div.ip-head', null, radar, title, line),
    h('div.ip-progress', null, h('div.ip-row', null, count, h('div.flex1'), meta), bar),
    chips,
    foot);
  const el = h('div.ip-overlay', { hidden: true }, h('div.ip-scrim'), card);

  function renderFoot(): void {
    if (!model) return;
    const m = model;
    if (confirming) {
      setChildren(foot,
        h('div.ip-latest.warn', null, m.mode === 'queued' ? 'Take this job out of the queue?' : 'Stop this research? What scout found so far is kept.'),
        h('button.btn.ip-btn', { disabled: busy, onclick: () => { confirming = false; renderFoot(); } }, 'Keep going'),
        h('button.btn.ip-btn.danger', {
          disabled: busy,
          onclick: async () => {
            busy = true; renderFoot();
            const ok = await o.onCancel(m.jobId);
            busy = false; confirming = !ok ? false : confirming; renderFoot();
          },
        }, busy ? 'Stopping…' : m.mode === 'queued' ? 'Remove from queue' : 'Stop research'));
      return;
    }
    setChildren(foot,
      h('div.ip-latest', { title: m.latest ?? '' }, m.latest ?? (m.mode === 'queued' ? 'Nothing recorded yet.' : 'Nothing recorded yet: scout is reading.')),
      h('button.btn.ip-btn', { onclick: () => { confirming = true; renderFoot(); } }, 'Cancel'),
      h('button.btn.ip-btn.strong', { onclick: () => o.onPeek(m.jobId) }, 'Peek at results'));
  }

  function render(next: OverlayModel | null): void {
    if (!next) { el.hidden = true; model = null; confirming = false; chipKey = ''; return; }
    if (next.jobId !== model?.jobId || next.mode !== model?.mode) { confirming = false; busy = false; }
    const footChanged = !model || next.latest !== model.latest || next.jobId !== model.jobId || next.mode !== model.mode;
    model = next;
    el.hidden = false;
    card.classList.toggle('queued', next.mode === 'queued');
    title.textContent = next.title;
    line.textContent = next.line;
    count.textContent = next.mode === 'queued' ? 'Waiting to start' : `${next.done} of ${next.total} area${next.total === 1 ? '' : 's'}`;
    meta.textContent = next.meta;
    fill.style.width = `${next.pct}%`;
    bar.setAttribute('aria-valuenow', String(next.pct));
    const key = JSON.stringify(next.chips);
    if (key !== chipKey) {
      chipKey = key;
      setChildren(chips, next.chips.map((c) => h('div.ip-chip', { class: c.state, title: c.count ? `${c.count} claim${c.count === 1 ? '' : 's'}` : '' },
        c.state === 'done' ? icon('tick', 10, 3) : h('span.ip-chip-dot'),
        h('span', null, c.reading ? `${c.label} · reading ${c.reading}` : c.label))));
    }
    if (footChanged) renderFoot();
  }

  return { el, render };
}
