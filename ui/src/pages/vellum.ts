// Vellum boards: the Vellum MCP connection, its files, the design crew, and the design checks it has posted.
import type { MusterState, Note, VellumFile, VellumStatus } from '../../../src/types';
import { h, icon, setChildren } from '../dom';
import type { Snapshot } from '../events';
import type { Page } from '../page';
import { openAddAgent, run } from '../actions';
import { api } from '../api';
import { ago, agentStatusLong, ms } from '../util';
import { parseCheck, type DesignCheck } from '../vellumchecks';

const SWATCH = ['linear-gradient(135deg,#1e3a5f,#2563eb)', 'linear-gradient(135deg,#3b0d0d,#ef4444)', 'linear-gradient(135deg,#171A1F,#F2A93B)', 'linear-gradient(135deg,#2a2048,#A78BFA)'];
const EDIT_BADGE: Record<string, string> = { ask: 'Edits when asked', always: 'Design crew can edit', never: 'Read only' };
const STATE_TITLE: Record<VellumStatus['status'], string> = {
  connected: 'Vellum connected', not_configured: 'Vellum not configured', unreachable: 'Vellum unreachable', error: 'Vellum error',
};

export function createVellum(): Page {
  let snap: Snapshot | null = null;
  let info: VellumStatus | null = null;
  let loading = false;
  let pending = ''; // framework file just clicked, until config catches up
  const left = h('div.v-left');
  const right = h('div.v-right');
  const el = h('div.page', null, h('div.split', null, left, right));

  /** `fresh` bypasses the server's cache (Test connection). */
  function check(fresh: boolean): void {
    if (loading) return;
    loading = true;
    render();
    api.vellum(fresh).then((i) => { info = i; }, (e) => {
      info = { status: 'error', message: e instanceof Error ? e.message : String(e), checkedAt: new Date().toISOString(), files: [] };
    }).then(() => { loading = false; render(); });
  }

  function pick(f: VellumFile): void {
    pending = f.id;
    render();
    void run(api.patchConfig({ vellumFile: f.id })).then((r) => { if (!r) { pending = ''; render(); } });
  }

  function render(): void {
    if (!snap) return;
    const { state, config } = snap;
    const design = state.agents.find((a) => a.role === 'design');
    const v = config.vellum;
    const cmd = v ? [v.command.split(/[\\/]/).pop()?.replace(/\.exe$/i, ''), ...v.args].join(' ') : '';
    const files = info?.files ?? [];
    if (pending && config.vellumFile === pending) pending = '';
    const frameworkId = pending || config.vellumFile || '';
    const framework = files.find((f) => f.id === frameworkId);

    const addBtn = h('button.btn.sm.secondary', null, icon('plus', 12), 'Add design crew');
    addBtn.onclick = () => openAddAgent(addBtn, 'left');
    const testBtn = h('button.btn.sm', { disabled: loading }, loading ? 'Testing…' : 'Test connection');
    testBtn.onclick = () => check(true);

    const st = info?.status;
    const dotColor = st === 'connected' ? 'var(--color-crew)' : st === 'unreachable' || st === 'error' ? 'var(--color-stuck)' : 'var(--color-faint)';
    const detail = info?.message ?? (st === 'not_configured' ? 'Set the Vellum MCP path in Settings' : cmd);
    const title = info ? STATE_TITLE[info.status] : 'Checking Vellum…';

    setChildren(left,
      h('div.conn-card', null,
        h('span.dot', { style: { background: dotColor } }),
        h('div', { style: 'display:flex;flex-direction:column;gap:2px;flex:1;min-width:0' },
          h('div.t', null, title),
          h('div.s', { title: v ? [v.command, ...v.args].join(' ') : '' }, detail),
          info ? h('div.s', null, `checked ${ago(info.checkedAt)}`) : null),
        st === 'connected'
          ? h('span.badge.b-design', { style: 'font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase', title: 'Whether the design crew may change Vellum designs (Settings → Agents and permissions)' }, EDIT_BADGE[config.vellumEdit ?? 'ask'])
          : null),
      h('div', { style: 'margin-top:-12px;display:flex;justify-content:flex-end' }, testBtn),
      h('div.v-sec', null,
        h('div.section-label', null, 'Design framework file'),
        files.length
          ? files.map((f, i) => fileCard(f, i, f.id === frameworkId))
          : h('div.v-text', null, st === 'connected' ? 'No files found in Vellum.' : info ? 'Files appear here once Vellum is connected.' : 'Loading…')),
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

    // design checks: PASS/DRIFT reports posted by the design crew (any agent that is or was "design")
    const designIds = new Set(state.agents.filter((a) => a.role === 'design').map((a) => a.id));
    const checks = state.notes
      .filter((n) => designIds.has(n.from) || n.from.startsWith('design'))
      .map((n) => ({ n, c: parseCheck(n.text) }))
      .filter((x): x is { n: Note; c: DesignCheck } => x.c !== null)
      .sort((a, b) => ms(b.n.createdAt) - ms(a.n.createdAt));
    const passed = checks.filter((x) => x.c.verdict === 'pass').length;
    const drift = checks.length - passed;
    const latest = checks[0]?.n.createdAt;

    setChildren(right,
      h('div.v-head', null,
        h('div', { style: 'display:flex;flex-direction:column;gap:3px;flex:1;min-width:0' },
          h('div.t', null, 'Design checks'),
          h('div.s', null, design || checks.length
            ? `By the design crew${framework ? ` against ${framework.name}` : ''}${latest ? ` · last run ${ago(latest)}` : ' · nothing posted yet'}`
            : 'Reports from the design crew show up here')),
        passed ? h('span', { style: 'font-size:12px;color:var(--color-crew)' }, `${passed} passed`) : null,
        drift ? h('span', { style: 'font-size:12px;color:var(--color-stuck)' }, `${drift} drift`) : null),
      h('div.checks-list', null, checks.length ? checks.map(({ n, c }) => checkRow(state, n, c))
        : h('div.empty', null, design ? `${design.id} hasn't posted a design check yet.` : 'No design crew yet.')),
    );
  }

  function fileCard(f: VellumFile, i: number, on: boolean): HTMLElement {
    const sub = [`${f.pages} page${f.pages === 1 ? '' : 's'}`, f.updated ? `updated ${ago(f.updated)}` : null].filter(Boolean).join(' · ');
    return h('button.agent-card' + (on ? '' : '.plain'), { style: 'width:100%;text-align:left', title: on ? 'Design framework file' : 'Use as the design framework file', onclick: () => { if (!on) pick(f); } },
      h('div.sw', { style: { background: SWATCH[i % SWATCH.length] } }),
      h('div', { style: 'display:flex;flex-direction:column;gap:2px;flex:1;min-width:0' },
        h('div.t', { style: on ? '' : 'font-weight:550' }, f.name), h('div.s', null, sub)),
      on ? icon('check', 16) : null);
  }

  function checkRow(state: MusterState, n: Note, c: DesignCheck): HTMLElement {
    const badge = c.verdict === 'drift' ? h('span.badge.b-stuck', null, 'Drift') : h('span.badge.b-crew', null, 'Pass');
    const meta = [c.taskId, n.branch, n.to ? `told ${n.to}` : null, n.replies.length ? `${n.replies.length} replies` : null, ago(n.createdAt)].filter(Boolean).join(' · ');
    void state;
    return h('button.dcheck', { style: 'width:100%;text-align:left', onclick: () => { location.hash = `#/board?note=${n.id}`; } },
      h('div.type', null, badge),
      h('div.body', null,
        h('div.text', null, c.summary),
        c.diffs.map((d) => h('div.meta.diff', null, `${d.path}${d.line ? `:${d.line}` : ''} — ${d.text}`)),
        h('div.meta', null, meta)));
  }

  return { el, update(s) { snap = s; if (!info && !loading) check(false); else render(); } };
}
