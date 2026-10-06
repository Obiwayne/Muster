// The QA gate on cards: a score badge ("QA 4/5 · round 2"), the failed rubric checks and the findings the builder has to fix.
import type { QaFinding, Task } from '../../src/types';
import { h, icon, showModal } from './dom';
import { ago } from './util';
import { CHECKS, failedChecks, qaHistory, qaLabel, qaTone } from './qamodel';

const where = (f: QaFinding) => (f.line ? `${f.file}:${f.line}` : f.file);

/** The badge alone. Click opens the findings; `compact` for list rows. */
export function qaBadge(task: Task, compact = false): HTMLElement | null {
  const label = qaLabel(task);
  const tone = qaTone(task);
  if (!label || !tone) return null;
  const last = task.qa?.last;
  const failed = last ? failedChecks(last.rubric) : [];
  const tip = [label, last ? `Scored ${ago(last.at)}` : '', failed.length ? `Failed: ${failed.join(', ')}` : '', task.qa?.escalated ? 'Three failed rounds: the Captain and you decide.' : ''].filter(Boolean).join('\n');
  // a span, not a <button>: the board puts it inside a row that is itself a button
  const open = (e: Event) => { e.stopPropagation(); showQaFindings(task); };
  return h('span.qa-badge', {
    class: [tone, compact && 'compact'],
    role: 'button',
    tabindex: '0',
    title: tip,
    onclick: open,
    onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); } },
  }, icon(tone === 'pass' ? 'check' : 'alert', 12), label);
}

/** Badge plus the first finding, for task cards and review notes. Null when there is nothing to say. */
export function qaStrip(task: Task, max = 1, withHistory = false): HTMLElement | null {
  const badge = qaBadge(task);
  if (!badge) return null;
  const findings = task.qa?.last?.findings ?? [];
  const shown = findings.slice(0, max);
  const history = withHistory ? qaHistory(task) : null;
  return h('div.qa-strip', null, badge, history ? h('div.qa-history', null, history) : null,
    shown.map((f) => h('div.qa-find', { title: `${where(f)}\n${f.problem}\nFix: ${f.fix}` }, h('span.qa-loc', null, where(f)), h('span.qa-prob', null, f.problem))),
    findings.length > shown.length ? h('button.qa-more', { onclick: (e: MouseEvent) => { e.stopPropagation(); showQaFindings(task); } }, `+${findings.length - shown.length} more`) : null);
}

/** Full findings and rubric in a modal. */
export function showQaFindings(task: Task): void {
  const qa = task.qa;
  if (!qa) return;
  const last = qa.last;
  const body: (HTMLElement | null)[] = [];
  if (qa.escalated) body.push(h('div.banner.warm', null, icon('alert', 16), h('div.flex1', null, 'QA failed three rounds. The builder is done trying: the Captain and you decide what happens to this task.')));
  const history = qaHistory(task);
  if (history) body.push(h('div.qa-history', null, history));
  if (last) {
    body.push(h('div.qa-rubric', null, CHECKS.map((c) => h('span.qa-check', { class: last.rubric[c.key] ? 'ok' : 'bad' }, icon(last.rubric[c.key] ? 'check' : 'x', 12), c.label))));
    body.push(last.findings.length
      ? h('div.qa-list', null, last.findings.map((f) => h('div.qa-item', null,
          h('div.qa-loc', null, where(f)),
          h('div.qa-prob', null, f.problem),
          h('div.qa-fix', null, h('span.faint', null, 'Fix'), f.fix))))
      : h('div.faint', null, last.score >= 5 ? 'No findings. Full marks.' : 'No findings were listed.'));
  } else body.push(h('div.faint', null, 'QA has not scored this task yet.'));
  showModal({ title: `${task.id} · ${qaLabel(task) ?? 'QA'}${last ? ` · ${ago(last.at)}` : ''}`, body: body.filter((n): n is HTMLElement => !!n), cancelLabel: 'Close' });
}
