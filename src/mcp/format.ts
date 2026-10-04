// Pure formatting helpers for muster-mcp tool results. Agents read these, so keep them short.
import { formatEvidence } from '../core/evidence.js';
import { INTEL_CHECK_AREAS } from '../types.js';
import type { Agent, IdeaEvidence, InboxItem, IntelCheck, IntelJob, IntelStore, Note, NoteType, ResearchIdea, Roadmap, RoadmapHealth, RoadmapProgress, Task } from '../types.js';

export function relTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '?';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '?';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1).trimEnd() + '…' : one;
}

function replies(n: number): string {
  return n === 1 ? '1 reply' : `${n} replies`;
}

/** `N14 [stuck] crew-3 · T4 · 4m ago · "Which token format…" (1 reply)` */
export function formatNoteLine(n: Note, now: number = Date.now(), maxText = 140): string {
  const parts = [`${n.id} [${n.type}] ${n.from}${n.to ? ` → ${n.to}` : ''}`];
  if (n.taskId) parts.push(n.taskId);
  parts.push(relTime(n.createdAt, now));
  let line = `${parts.join(' · ')} · "${clip(n.text, maxText)}"`;
  if (n.replies?.length) line += ` (${replies(n.replies.length)})`;
  if (!n.open && ['stuck', 'question', 'waiting', 'review', 'approval', 'escalation'].includes(n.type)) line += ' [closed]';
  return line;
}

/** Board listing: one line per note, plus the latest replies of open notes indented below. */
export function formatBoard(notes: Note[], now: number = Date.now(), opts: { limit?: number; showReplies?: number } = {}): string {
  if (!notes.length) return 'The board is clear: no matching notes.';
  const limit = opts.limit ?? 40;
  const show = opts.showReplies ?? 2;
  const lines: string[] = [];
  for (const n of notes.slice(0, limit)) {
    lines.push(formatNoteLine(n, now));
    if (n.open && show > 0 && n.replies?.length) {
      for (const r of n.replies.slice(-show)) lines.push(`    ↳ ${r.from} · ${relTime(r.at, now)}: ${clip(r.text, 200)}`);
    }
  }
  if (notes.length > limit) lines.push(`… ${notes.length - limit} more (narrow the filter)`);
  return lines.join('\n');
}

export const BOARD_FILTERS = [
  'open', 'all', 'mine', 'to-me', 'needs-you',
  'stuck', 'question', 'waiting', 'progress', 'done', 'review', 'approval', 'escalation', 'message', 'system',
] as const;
export type BoardFilter = (typeof BOARD_FILTERS)[number];

/** Query string for GET /api/notes. */
export function boardQuery(filter: BoardFilter | undefined, me: string): string {
  const q = new URLSearchParams();
  switch (filter ?? 'open') {
    case 'open':
      q.set('open', '1');
      break;
    case 'all':
      break;
    case 'mine':
      q.set('from', me);
      break;
    case 'to-me':
      q.set('to', me);
      break;
    case 'needs-you':
      q.set('needsYou', '1');
      break;
    default:
      q.set('type', filter as NoteType);
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function formatAgentLine(a: Agent): string {
  const parts = [`${a.id} (${a.role})`, a.status, a.branch];
  if (a.taskId) parts.push(`task ${a.taskId}`);
  if (a.costUsd) parts.push(`$${a.costUsd.toFixed(2)}`);
  return parts.join(' · ');
}

export function formatAgents(agents: Agent[]): string {
  if (!agents.length) return 'No agents.';
  return agents.map(formatAgentLine).join('\n');
}

export function stationLabel(t: Task): string {
  const st = t.stations?.[t.stationIndex];
  return st ? `${st} ${t.stationIndex + 1}/${t.stations.length}` : '-';
}

export function formatTaskLine(t: Task): string {
  const parts = [`${t.id} [${t.status}] ${clip(t.title, 80)}`, `station ${stationLabel(t)}`];
  if (t.goalId) parts.push(`goal ${t.goalId}`);
  if (t.assignee) parts.push(`@${t.assignee}`);
  if (t.dependsOn?.length) parts.push(`needs ${t.dependsOn.join(',')}`);
  if (t.branch) parts.push(t.branch);
  return parts.join(' · ');
}

export function formatTasks(tasks: Task[]): string {
  if (!tasks.length) return 'No tasks on the board.';
  return tasks.map(formatTaskLine).join('\n');
}

export function formatTaskDetail(t: Task): string {
  const lines = [formatTaskLine(t)];
  if (t.stations?.length) lines.push(`Stations: ${t.stations.join(' → ')}`);
  if (t.description) lines.push('', t.description.trim());
  if (t.evidence?.length) lines.push('', formatEvidence(t));
  return lines.join('\n');
}

/** One line per item; `feedIds` prefixes the text with its crew-chat line ("[F12] message from ...") so agents can react to it. */
export function formatInbox(items: InboxItem[], now: number = Date.now(), feedIds = true): string {
  if (!items.length) return 'Inbox empty.';
  return items
    .map((i) => {
      const ref = [i.noteId, i.taskId].filter(Boolean).join(' ');
      const feed = feedIds && i.feedId ? `[${i.feedId}] ` : '';
      return `${i.id} ${i.kind} from ${i.from}${ref ? ` (${ref})` : ''} · ${relTime(i.at, now)}: ${feed}${i.text.trim()}`;
    })
    .join('\n');
}

export function truncateTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `… (${text.length - maxChars} chars cut)\n` + text.slice(text.length - maxChars);
}

export function truncateHead(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n… (${text.length - maxChars} more chars; ask the crew or use git locally for the rest)`;
}

export function formatDiff(d: { branch?: string; base?: string; stat?: string; diff?: string }, maxChars = 24000): string {
  const head = `${d.branch ?? '?'} vs ${d.base ?? '?'}`;
  const stat = (d.stat ?? '').trim();
  const diff = (d.diff ?? '').trim();
  if (!stat && !diff) return `${head}: no changes.`;
  return [head, stat, '', truncateHead(diff, maxChars)].join('\n').trim();
}

export function formatTests(r: { command?: string; exitCode?: number | null; output?: string }, maxChars = 12000): string {
  const ok = r.exitCode === 0;
  return `${ok ? 'PASS' : 'FAIL'} (exit ${r.exitCode ?? '?'}) · ${r.command ?? ''}\n${truncateTail((r.output ?? '').trim(), maxChars)}`.trim();
}

/** Is `s` an existing task id like "T3"? */
export function isTaskId(s: string): boolean {
  return /^T\d+$/i.test(s.trim());
}

// ---- roadmap -------------------------------------------------------------------

const HEALTH: Record<RoadmapHealth, string> = { on_track: 'on track', at_risk: 'at risk', late: 'late', not_started: 'not started', done: 'done' };

export const NO_ROADMAP = 'No roadmap yet — draft one with set_roadmap before posting build tasks.';

function dateRange(start?: string, due?: string): string {
  if (!start && !due) return 'no dates';
  return `${start ?? '?'} → ${due ?? '?'}`;
}

function launchLine(r: Roadmap, days: number | undefined): string {
  if (!r.launchDate) return 'no launch date';
  if (days === undefined) return `launch ${r.launchDate}`;
  if (days > 0) return `launch ${r.launchDate} (${days} day${days === 1 ? '' : 's'} to go)`;
  if (days === 0) return `launch ${r.launchDate} (today)`;
  return `launch ${r.launchDate} (${-days} day${days === -1 ? '' : 's'} past)`;
}

/** `{ roadmap, progress }` from GET /api/roadmap as a compact outline: header, one line per stage, the current stage's goals and open exit criteria. */
export function formatRoadmap(data: { roadmap: Roadmap | null; progress: RoadmapProgress | null } | null | undefined, now: number = Date.now()): string {
  const r = data?.roadmap;
  if (!r) return NO_ROADMAP;
  const p = data?.progress ?? null;
  const status = r.status === 'draft' ? `DRAFT rev ${r.revision}, waiting for the user's approval${r.noteId ? ` (${r.noteId})` : ''}` : `approved rev ${r.revision}`;
  const overall = p ? `${p.overall.percent}% (${p.overall.done}/${p.overall.total} tasks) · ${HEALTH[p.health]}` : '';
  const lines = [[`Roadmap: ${clip(r.title, 80)}`, status, overall, launchLine(r, p?.daysToLaunch)].filter(Boolean).join(' · ')];
  if (r.statusLine) lines.push(`Last status (${relTime(r.statusLine.at, now)}): ${clip(r.statusLine.text, 400)}`);
  if (p?.overall.unlinked) lines.push(`${p.overall.unlinked} task${p.overall.unlinked === 1 ? '' : 's'} not on any goal: put them on the goal they deliver with link_tasks.`);
  const current = p?.currentStageId;
  const goalById = new Map(r.goals.map((g) => [g.id, g]));
  for (const s of r.stages) {
    const sp = p?.stages[s.id];
    const crit = `criteria ${sp?.criteriaDone ?? s.exitCriteria.filter((c) => c.done).length}/${sp?.criteriaTotal ?? s.exitCriteria.length}`;
    const prog = sp ? `${sp.percent}% ${HEALTH[sp.health]}` : '';
    const mark = s.id === current ? '▶ ' : '  ';
    lines.push(`${mark}${s.id} ${clip(s.title, 60)} · ${dateRange(s.start, s.due)} · ${s.status}${prog ? ` · ${prog}` : ''} · ${crit}`);
    if (s.id !== current) continue;
    for (const gid of s.goalIds) {
      const g = goalById.get(gid);
      if (!g) continue;
      const gp = p?.goals[g.id];
      const parts = [`${g.id} [${g.status}]${g.id === p?.currentGoalId ? ' ◀ current' : ''} ${clip(g.title, 70)}`];
      if (gp) parts.push(`${gp.percent}% (${gp.done}/${gp.total} tasks)`);
      if (g.start || g.due) parts.push(dateRange(g.start, g.due));
      if (gp?.agents.length) parts.push(gp.agents.join(', '));
      lines.push(`      ${parts.join(' · ')}`);
    }
    const open = s.exitCriteria.map((c, i) => ({ c, n: i + 1 })).filter(({ c }) => !c.done);
    if (open.length) {
      lines.push(`    Exit criteria left (check_criterion ${s.id} <n>):`);
      for (const { c, n } of open) lines.push(`      ${n}. ${clip(c.text, 140)}`);
    } else if (s.exitCriteria.length && s.status !== 'done') {
      lines.push(`    All exit criteria ticked: complete_stage ${s.id}.`);
    }
  }
  return lines.join('\n');
}

// ---- research ideas --------------------------------------------------------------

function ideaStatus(i: ResearchIdea): string {
  if (i.status === 'approved') return i.goalId ? `approved → ${i.goalId}` : 'approved, not on the roadmap yet';
  return i.status;
}

/** `R7 [new] Moderation queue · impact high · effort M · fits M3 · 4 evidence · advised` */
export function formatIdeaLine(i: ResearchIdea): string {
  const parts = [`${i.id} [${ideaStatus(i)}] ${clip(i.title, 80)}`, `impact ${i.impact}`, `effort ${i.effort}`];
  if (i.origin === 'intel' && i.opportunity) parts.push(`intel ${i.opportunity.kind} (value ${i.opportunity.valueScore}/5, effort ${i.opportunity.effortScore}/5)`);
  if (i.checkId) parts.push(`check ${i.checkId}`);
  if (i.stageId) parts.push(`fits ${i.stageId}`);
  if (i.overlapsGoalId) parts.push(`overlaps ${i.overlapsGoalId}`);
  parts.push(`${i.evidence?.length ?? 0} evidence`);
  const last = i.thread?.at(-1);
  if (last && last.from !== 'captain') parts.push('question waiting for your advice');
  else if (last) parts.push('advised');
  return parts.join(' · ');
}

export function formatIdeas(ideas: ResearchIdea[]): string {
  if (!ideas.length) return 'No research ideas match.';
  return ideas.map(formatIdeaLine).join('\n');
}

function evidenceLine(e: IdeaEvidence): string {
  const head = `[${e.kind}] ${clip(e.source, 100)}${e.count ? ` (+${e.count} similar)` : ''}`;
  const quote = e.text ? `: "${clip(e.text, 300)}"` : '';
  return `- ${head}${quote}${e.url ? ` <${e.url}>` : ''}`;
}

/** One idea in full: summary, evidence with quotes and links, the thread with the user, the Captain's plan. */
export function formatIdeaDetail(i: ResearchIdea, now: number = Date.now()): string {
  const lines = [formatIdeaLine(i), '', i.summary.trim()];
  if (i.evidence?.length) lines.push('', 'Evidence:', ...i.evidence.map(evidenceLine));
  if (i.thread?.length) {
    lines.push('', 'Thread:');
    for (const m of i.thread) lines.push(`- ${m.from} · ${relTime(m.at, now)}: ${m.text.trim()}`);
  }
  if (i.plan?.length) lines.push('', 'Plan on approval:', ...i.plan.map((p) => `- ${p}`));
  const o = i.opportunity;
  if (o) {
    lines.push(
      '',
      `Opportunity (${o.kind}, priority ${o.priority}${o.testFirst ? ', test first' : ''}${o.atRisk ? `, at risk: ${o.atRisk}` : ''}) on ${o.capabilityIds.join(', ') || 'no capability'}:`,
      `- Problem: ${o.problem}`,
      `- Today they: ${o.alternatives}`,
      `- Proposal: ${o.proposal}`,
      `- Value: ${o.value} (${o.valueScore}/5)`,
      `- Effort: ${o.effortNote} (${o.effortScore}/5)`,
      `- Validate: ${o.validation}`,
      `- ${o.claim.label}, ${o.claim.confidence}: ${o.claim.implication ?? ''}`,
    );
  }
  return lines.join('\n');
}

// ---- competitive intelligence ----------------------------------------------------

const verdictWords = (v: string) => v.replace(/_/g, ' ');

/** `IJ3 [running] competitor · padlet · by you · 12 pages` */
export function formatJobLine(j: IntelJob): string {
  const parts = [`${j.id} [${j.status}] ${j.kind}`];
  if (j.ideaId) parts.push(j.ideaId);
  if (j.competitorIds.length) parts.push(j.competitorIds.join(', '));
  parts.push(`by ${j.by}`);
  if (j.pagesBrowsed) parts.push(`${j.pagesBrowsed} pages`);
  if (j.error) parts.push(`error: ${clip(j.error, 80)}`);
  return parts.join(' · ');
}

/** An idea's intel check: verdict, confidence, coverage, rows, what it watches for and its history. */
export function formatCheck(c: IntelCheck, idea?: ResearchIdea): string {
  const head = `${c.id} for ${c.ideaId}${idea ? ` ${clip(idea.title, 60)}` : ''} · rev ${c.revision} · ${c.status}`;
  if (c.status === 'skipped') return `${head} (${c.skippedReason ?? 'skipped'}). Approval may go ahead.`;
  if (c.status === 'queued' || c.status === 'running') return `${head}. Scout is on it${c.jobId ? ` (${c.jobId})` : ''}; approval waits for it.`;
  if (c.status === 'failed') return `${head}${c.skippedReason ? ` (${c.skippedReason})` : ''}. Request a new one with request_intel_check.`;
  const lines = [
    head,
    `Verdict: ${verdictWords(c.verdict)} (${c.confidence} confidence, ${c.sourceCount} source${c.sourceCount === 1 ? '' : 's'}, coverage ${c.rows.length} of ${INTEL_CHECK_AREAS.length})${c.doneAt ? ` · checked ${c.doneAt.slice(0, 10)}` : ''}`,
    c.verdictText,
  ];
  if (c.capabilityIds.length) lines.push(`Capabilities: ${c.capabilityIds.join(', ')}`);
  for (const r of c.rows) lines.push(`- ${r.area}: ${clip(r.finding, 120)} [${r.signal}, ${r.label}, ${r.confidence}]${r.changed ? ' (changed)' : ''}`);
  if (c.watchFor) lines.push(`Watch for: ${c.watchFor}`);
  if (c.goalId) lines.push(`Goal: ${c.goalId}`);
  if (c.history.length) lines.push(`History: ${c.history.map((h) => `rev ${h.revision} ${verdictWords(h.verdict)} (${h.confidence}, ${h.doneAt.slice(0, 10)})`).join('; ')}`);
  return lines.join('\n');
}

/** intel_overview: competitors, gaps / edges / open spaces with their idea ids, unseen changes, jobs, your thread. */
export function formatIntelOverview(store: IntelStore, ideas: ResearchIdea[], now: number = Date.now()): string {
  const name = (id: string) => store.competitors.find((c) => c.id === id)?.name ?? id;
  const live = store.competitors.filter((c) => !c.isUs && !c.removed);
  const out: string[] = [];
  out.push(live.length ? `Tracking ${live.length}: ${live.map((c) => `${c.name} (${c.id}${c.lastSweptAt ? `, swept ${relTime(c.lastSweptAt, now)}` : ', not swept yet'})`).join(', ')}.` : 'No competitors tracked yet.');
  const ideaTag = (id?: string) => {
    const i = id ? ideas.find((x) => x.id === id) : undefined;
    return i ? ` · ${i.id} [${i.status}${i.goalId ? ` → ${i.goalId}` : ''}]` : ' · no idea yet';
  };
  for (const [verdict, title] of [['gap', 'Gaps (they have it, we don\'t)'], ['edge', 'Edges (where we win)'], ['open', 'Open (nobody does it)']] as const) {
    const caps = store.capabilities.filter((c) => c.verdict === verdict);
    out.push('', `${title}: ${caps.length}`);
    for (const c of caps) out.push(`- ${c.id} ${clip(c.name, 70)}${c.verdictVs.length ? ` vs ${c.verdictVs.map(name).join(', ')}` : ''}${c.verdictStage ? ` (${verdict === 'gap' ? 'closing' : 'at'} ${c.verdictStage})` : ''}${ideaTag(c.ideaId)}`);
  }
  const intelIdeas = ideas.filter((i) => i.origin === 'intel' && i.status === 'new');
  if (intelIdeas.length) out.push('', 'Intel ideas waiting for a decision:', ...intelIdeas.map((i) => `- ${formatIdeaLine(i)}`));
  const unseen = store.changes.filter((c) => !c.seen);
  if (unseen.length) {
    out.push('', `Unseen changes: ${unseen.length}`);
    for (const c of unseen.slice(-10)) out.push(`- ${c.id} ${c.at} ${name(c.competitorId)} [${c.area}] ${clip(c.title, 90)} · plan ${c.planImpact}${c.suggestion ? ` · you suggested: ${clip(c.suggestion, 80)}` : c.planImpact === 'respond' ? ' · needs your intel_suggest' : ''}`);
  }
  const running = store.jobs.find((j) => j.status === 'running');
  const queued = store.jobs.filter((j) => j.status === 'queued');
  out.push('', running ? `Running: ${formatJobLine(running)}` : 'No intel job running.');
  if (queued.length) out.push(`Queued: ${queued.map((j) => `${j.id} ${j.kind}`).join(', ')}`);
  const last = store.captainThread.at(-1);
  if (last && last.from !== 'captain') out.push('', `The user asked about the gaps (${relTime(last.at, now)}): ${clip(last.text, 300)} — answer with intel_reply.`);
  return out.join('\n');
}
