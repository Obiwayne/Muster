// Vellum boards: the Vellum MCP connection, the design crew, and the design checks it has posted.
import type { MusterState, Note } from '../../../src/types';
import { h, icon, setChildren } from '../dom';
import type { Snapshot } from '../events';
import type { Page } from '../page';
import { openAddAgent } from '../actions';
import { NOTE_BADGE, ago, agentStatusLong, ms, noteLabel } from '../util';

type Verdict = 'drift' | 'pass' | null;

const DRIFT = /\b(drift|drifts|drifted|mismatch|doesn'?t match|does not match|doesn'?t follow|does not follow|off[- ]framework|hard-?coded|no matching board|not in the framework|violat)/i;
const PASS = /\b(pass(es|ed)?|matches|follows|on[- ]framework|looks right|consistent with)\b/i;

function verdict(n: Note): Verdict {
  if (DRIFT.test(n.text)) return 'drift';
  if (n.type === 'done' || PASS.test(n.text)) return 'pass';
  return null;
}

export function createVellum(): Page {
  let snap: Snapshot | null = null;
  const left = h('div.v-left');
  const right = h('div.v-right');
  const el = h('div.page', null, h('div.split', null, left, right));

  function render(): void {
    if (!snap) return;
    const { state, config } = snap;
    const design = state.agents.find((a) => a.role === 'design');
    const v = config.vellum;
    const cmd = v ? [v.command.split(/[\\/]/).pop()?.replace(/\.exe$/i, ''), ...v.args].join(' ') : '';

    const addBtn = h('button.btn.sm.secondary', null, icon('plus', 12), 'Add design crew');
    addBtn.onclick = () => openAddAgent(addBtn, 'left');

    setChildren(left,
      h('div.conn-card', null,
        h('span.dot', { style: { background: v ? 'var(--color-crew)' : 'var(--color-faint)' } }),
        h('div', { style: 'display:flex;flex-direction:column;gap:2px;flex:1;min-width:0' },
          h('div.t', null, v ? 'Vellum connected' : 'Vellum not configured'),
          h('div.s', { title: v ? [v.command, ...v.args].join(' ') : '' }, v ? cmd : 'Set the Vellum MCP path in Settings')),
        v ? h('span.badge.b-design', { style: 'font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase' }, 'Read only') : null),
      h('div.v-sec', null,
        h('div.section-label', null, 'Design crew'),
        design
          ? h('button.agent-card', { style: 'width:100%;text-align:left', onclick: () => { location.hash = `#/dashboard?agent=${encodeURIComponent(design.id)}`; } },
              h('div.sw'),
              h('div', { style: 'display:flex;flex-direction:column;gap:2px;flex:1;min-width:0' },
                h('div.t', null, design.id),
                h('div.s.ellipsis', null, `${design.branch} · ${agentStatusLong(state, design).text} · ${design.model}`)),
              icon('terminal', 16))
          : h('div', { style: 'display:flex;flex-direction:column;gap:10px;align-items:flex-start' },
              h('div.v-text', null, 'No agent is the Vellum design crew. Add one, or right-click a terminal and choose "Set as Vellum design crew".'),
              addBtn)),
      h('div.v-sec', null,
        h('div.section-label', null, 'What the design crew checks'),
        h('div.v-text', null, 'Colours use framework tokens · type scale and fonts · spacing and radius · button and form patterns · new screens have a matching Vellum board')),
    );

    // design checks: notes posted by the design crew (any agent that is or was "design")
    const designIds = new Set(state.agents.filter((a) => a.role === 'design').map((a) => a.id));
    const notes = state.notes
      .filter((n) => (designIds.has(n.from) || n.from.startsWith('design')) && n.type !== 'message' && n.type !== 'system')
      .sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    const checks = notes.map((n) => ({ n, v: verdict(n) }));
    const passed = checks.filter((c) => c.v === 'pass').length;
    const drift = checks.filter((c) => c.v === 'drift').length;
    const latest = notes[0]?.createdAt;

    setChildren(right,
      h('div.v-head', null,
        h('div', { style: 'display:flex;flex-direction:column;gap:3px;flex:1;min-width:0' },
          h('div.t', null, 'Design checks'),
          h('div.s', null, design ? `By the design crew (${design.id})${latest ? ` · last run ${ago(latest)}` : ' · nothing posted yet'}` : 'Notes posted by the design crew show up here')),
        passed ? h('span', { style: 'font-size:12px;color:var(--color-crew)' }, `${passed} passed`) : null,
        drift ? h('span', { style: 'font-size:12px;color:var(--color-stuck)' }, `${drift} drift`) : null),
      h('div.checks-list', null, checks.length ? checks.map(({ n, v: vd }) => checkRow(state, n, vd))
        : h('div.empty', null, design ? `${design.id} hasn't posted any design notes yet.` : 'No design crew yet.')),
    );
  }

  function checkRow(state: MusterState, n: Note, v: Verdict): HTMLElement {
    const badge = v === 'drift' ? h('span.badge.b-stuck', null, 'Drift')
      : v === 'pass' ? h('span.badge.b-crew', null, 'Pass')
        : h('span.badge', { class: NOTE_BADGE[n.type] }, noteLabel(n.type));
    const meta = [n.taskId, n.branch, n.to ? `told ${n.to}` : null, n.replies.length ? `${n.replies.length} replies` : null, ago(n.createdAt)].filter(Boolean).join(' · ');
    void state;
    return h('button.dcheck', { style: 'width:100%;text-align:left', onclick: () => { location.hash = `#/board?note=${n.id}`; } },
      h('div.type', null, badge),
      h('div.body', null, h('div.text', null, n.text), h('div.meta', null, `${n.id} · ${meta}`)));
  }

  return { el, update(s) { snap = s; render(); } };
}
