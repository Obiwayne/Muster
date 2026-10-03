// Crew chat v2: pure helpers (no DOM) for structured text, grouping, the unread divider,
// reactions and the needs-you badge. Rendered by pages/chat.ts and main.ts.
import type { FeedItem, FeedReaction, Note, NoteType } from '../../src/types';
import { REACTION_EMOJI } from '../../src/types';

// ---------------------------------------------------------------- structured text

export type Seg =
  | { k: 'text'; t: string }
  | { k: 'task'; t: string } // T3
  | { k: 'code'; t: string } // `spans`, file paths, foo()
  | { k: 'color'; t: string } // #2563EB
  | { k: 'mention'; t: string }; // @crew-2 (without the @)

const FILE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|md|json|css|scss|html|py|rs|go|java|kt|swift|rb|php|sh|ps1|yml|yaml|toml|txt|sql|svg|png|vue|svelte|lock|env)$/i;
const LEAD = /^[("'[“‘]+/;
const TRAIL = /[)"'\].,;:!?”’]+$/;

/** A token that reads as a file or branch: has an extension, or is a path with real-looking parts. */
export function isPathLike(w: string): boolean {
  if (/^https?:\/\//i.test(w)) return true;
  if (/^[\w@~./-]+$/.test(w) && FILE_EXT.test(w) && /[A-Za-z]/.test(w.replace(FILE_EXT, ''))) return true;
  if (!w.includes('/')) return false;
  if (!/^(\.{1,2}\/|~\/|\/)?[\w@.-]+(\/[\w@.-]+)+\/?$/.test(w)) return false;
  const parts = w.split('/').filter(Boolean);
  return /^(\.{1,2}|~)?\//.test(w) || parts.length >= 3 || parts.some((p) => /[._-]/.test(p));
}

function classify(core: string, agents?: readonly string[]): Seg['k'] {
  if (/^#[0-9a-fA-F]{6}$/.test(core)) return 'color';
  if (/^T\d+$/.test(core)) return 'task';
  if (/^@[\w-]+$/.test(core) && (!agents || agents.includes(core.slice(1)) || core === '@you' || core === '@everyone')) return 'mention';
  if (/^[A-Za-z_$][\w$.]*\(\)$/.test(core)) return 'code';
  if (isPathLike(core)) return 'code';
  return 'text';
}

/** Splits one line of text into plain text and chips. Never returns HTML: render each segment as a text node. */
export function tokenize(text: string, agents?: readonly string[]): Seg[] {
  const out: Seg[] = [];
  const push = (k: Seg['k'], t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (k === 'text' && last?.k === 'text') last.t += t;
    else out.push({ k, t } as Seg);
  };
  const parts = text.split(/(`[^`\n]+`)/);
  for (const part of parts) {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      push('code', part.slice(1, -1));
      continue;
    }
    for (const word of part.split(/(\s+)/)) {
      if (!word || /^\s+$/.test(word)) { push('text', word); continue; }
      const lead = LEAD.exec(word)?.[0] ?? '';
      let rest = word.slice(lead.length);
      let trail = TRAIL.exec(rest)?.[0] ?? '';
      // keep the () of foo() and the closing ) of a path inside (…)
      if (trail.startsWith(')') && /\($/.test(rest.slice(0, rest.length - trail.length))) trail = trail.slice(1);
      rest = rest.slice(0, rest.length - trail.length);
      const k = rest ? classify(rest, agents) : 'text';
      if (k === 'text') { push('text', word); continue; }
      push('text', lead);
      push(k, k === 'mention' ? rest.slice(1) : rest);
      push('text', trail);
    }
  }
  return out;
}

export interface TaskRow { taskId: string; title: string; agent: string }

/** "- T3 Invite API endpoints → crew-2", "T4: Share dialog UI (crew-3)", "T5 Tests — crew-5" */
export function parseTaskRow(line: string, agents: readonly string[]): TaskRow | null {
  const s = line.replace(/^\s*(?:[-•*]|\d+[.)])\s+/, '').trim();
  const m = /^(T\d+)\b[\s:.\-–—]*(.*)$/.exec(s);
  if (!m) return null;
  const rest = m[2];
  const am = /\s*(?:→|->|—|–|-|·|:|,|\bfor\b|\b(?:assigned )?to\b)?\s*\(?@?([\w-]+)\)?\s*\.?$/i.exec(rest);
  if (!am || !agents.includes(am[1])) return null;
  const title = rest.slice(0, am.index).replace(/[\s:,\-–—→·]+$/, '').trim();
  return { taskId: m[1], title, agent: am[1] };
}

export type Block =
  | { k: 'p'; segs: Seg[] }
  | { k: 'list'; items: Seg[][] }
  | { k: 'tasks'; rows: TaskRow[] };

/** Lines → paragraphs, "- " / "• " lists and (for the captain) task rows with assignees. */
export function parseBlocks(text: string, opts: { agents?: readonly string[]; taskRows?: boolean } = {}): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ k: 'p', segs: tokenize(para.join('\n'), opts.agents) });
    para = [];
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const row = opts.taskRows && opts.agents ? parseTaskRow(line, opts.agents) : null;
    const last = blocks[blocks.length - 1];
    if (row) {
      flush();
      if (last?.k === 'tasks' && !para.length) last.rows.push(row);
      else blocks.push({ k: 'tasks', rows: [row] });
      continue;
    }
    const li = /^\s*[-•]\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const prev = blocks[blocks.length - 1];
      if (prev?.k === 'list') prev.items.push(tokenize(li[1], opts.agents));
      else blocks.push({ k: 'list', items: [tokenize(li[1], opts.agents)] });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (para.length === 0 && (last?.k === 'list' || last?.k === 'tasks') && /^\s{2,}/.test(line)) {
      // continuation of a list item
      if (last.k === 'list') { last.items[last.items.length - 1].push({ k: 'text', t: ' ' }, ...tokenize(line.trim(), opts.agents)); continue; }
    }
    para.push(line);
  }
  flush();
  return blocks;
}

// ---------------------------------------------------------------- events and hand-offs

export interface Handoff { from: string; taskId: string; to: string; station?: string; note: string }

/** "handed T3 to crew-5: endpoints done" (orchestrator) or "ada handed T3 to cleo (test station): "…"" */
export function parseHandoff(f: Pick<FeedItem, 'kind' | 'from' | 'text'>): Handoff | null {
  if (f.kind !== 'event') return null;
  const m = /^(?:(\S+) )?handed (T\d+) to (.+?)(?: \(([^)]*)\))?: ([\s\S]*)$/.exec(f.text.trim());
  if (!m) return null;
  if (m[1] && m[1] !== f.from) return null;
  const note = m[5].trim().replace(/^["“](.*)["”]$/s, '$1');
  return { from: f.from, taskId: m[2], to: m[3], station: m[4], note: note === '(no note)' ? '' : note };
}

/** Event text with its actor: the orchestrator writes "claimed T3 …" and the actor separately. */
export function eventText(f: Pick<FeedItem, 'from' | 'text'>): string {
  const t = f.text.trim();
  if (f.from === 'muster' || t.startsWith(`${f.from} `) || !/^[a-z]/.test(t)) return t;
  return `${f.from} ${t}`;
}

// ---------------------------------------------------------------- rows (grouping, cards, unread)

/** Notes that render as cards with their replies inside. */
export const CARD_NOTES: readonly NoteType[] = ['stuck', 'question', 'waiting', 'review', 'escalation', 'approval'];
export const GROUP_MS = 5 * 60_000;
export const EVENT_MERGE_MS = 60_000;

export type Row =
  | { t: 'day'; at: string }
  | { t: 'unread'; count: number }
  | { t: 'events'; items: FeedItem[] }
  | { t: 'handoff'; item: FeedItem; handoff: Handoff }
  | { t: 'card'; item: FeedItem; replies: FeedItem[] }
  | { t: 'notice'; item: FeedItem } // a note that isn't a card (progress, done, system…)
  | { t: 'group'; items: FeedItem[] }; // messages / loose replies from one sender

const tms = (iso: string) => { const t = Date.parse(iso); return Number.isNaN(t) ? 0 : t; };
const dayOf = (iso: string) => new Date(tms(iso)).toDateString();
export const feedNum = (id: string | null | undefined): number => Number(String(id ?? '').replace(/\D/g, '')) || 0;

/** Index of the first top-level line you haven't seen (lines you wrote don't count), or -1. */
export function unreadIndex(lines: Pick<FeedItem, 'id' | 'from'>[], lastSeen: string | null | undefined): number {
  if (!lastSeen) return -1;
  const seen = feedNum(lastSeen);
  return lines.findIndex((f) => feedNum(f.id) > seen && f.from !== 'you');
}

function sameGroup(a: FeedItem, b: FeedItem): boolean {
  if (a.kind !== b.kind || (a.kind !== 'message' && a.kind !== 'reply')) return false;
  if (a.from !== b.from || (a.to ?? '') !== (b.to ?? '') || (a.noteId ?? '') !== (b.noteId ?? '')) return false;
  if (dayOf(a.at) !== dayOf(b.at)) return false;
  return tms(b.at) - tms(a.at) < GROUP_MS && tms(b.at) >= tms(a.at);
}

/**
 * Turns the visible feed (oldest → newest) into rows: day dividers, the unread divider,
 * merged event pills, hand-off cards, note cards with their replies, and sender groups.
 */
export function buildRows(list: FeedItem[], opts: { lastSeen?: string | null } = {}): Row[] {
  // note cards pull in their replies
  const cards = new Map<string, { item: FeedItem; replies: FeedItem[] }>();
  for (const f of list) {
    if (f.kind === 'note' && f.noteId && f.noteType && CARD_NOTES.includes(f.noteType) && !cards.has(f.noteId)) cards.set(f.noteId, { item: f, replies: [] });
  }
  const top: FeedItem[] = [];
  for (const f of list) {
    const card = f.kind === 'reply' && f.noteId ? cards.get(f.noteId) : undefined;
    if (card && feedNum(f.id) > feedNum(card.item.id)) card.replies.push(f);
    else top.push(f);
  }

  const ui = unreadIndex(top, opts.lastSeen);
  const rows: Row[] = [];
  let day = '';
  for (let i = 0; i < top.length; i++) {
    const f = top[i];
    const d = dayOf(f.at);
    if (d !== day) { day = d; rows.push({ t: 'day', at: f.at }); }
    if (i === ui) rows.push({ t: 'unread', count: top.slice(i).filter((x) => x.from !== 'you').length });
    const prev = rows[rows.length - 1];
    if (f.kind === 'event') {
      const handoff = parseHandoff(f);
      if (handoff) { rows.push({ t: 'handoff', item: f, handoff }); continue; }
      if (prev?.t === 'events') {
        const last = prev.items[prev.items.length - 1];
        if (tms(f.at) - tms(last.at) < EVENT_MERGE_MS && dayOf(last.at) === d) { prev.items.push(f); continue; }
      }
      rows.push({ t: 'events', items: [f] });
    } else if (f.kind === 'note') {
      const card = f.noteId ? cards.get(f.noteId) : undefined;
      if (card && card.item === f) rows.push({ t: 'card', item: f, replies: card.replies });
      else rows.push({ t: 'notice', item: f });
    } else {
      if (prev?.t === 'group' && sameGroup(prev.items[prev.items.length - 1], f)) prev.items.push(f);
      else rows.push({ t: 'group', items: [f] });
    }
  }
  return rows;
}

// ---------------------------------------------------------------- reactions, typing

export interface ReactionSummary { emoji: string; by: string[] }

/** One entry per emoji in REACTION_EMOJI order, with who reacted (in order). */
export function summarizeReactions(reactions: FeedReaction[] | undefined): ReactionSummary[] {
  if (!reactions?.length) return [];
  const order = REACTION_EMOJI as readonly string[];
  const map = new Map<string, string[]>();
  for (const r of reactions) {
    const by = map.get(r.emoji) ?? [];
    if (!by.includes(r.by)) by.push(r.by);
    map.set(r.emoji, by);
  }
  return [...map.entries()]
    .sort((a, b) => (order.indexOf(a[0]) + 99) % 99 - (order.indexOf(b[0]) + 99) % 99)
    .map(([emoji, by]) => ({ emoji, by }));
}

export const TYPING_MS = 10 * 60_000;

/**
 * The agent shown as "… is writing": the latest message (or note reply) was addressed to it,
 * it is working, and that message is recent.
 */
export function typingAgent(
  feed: FeedItem[],
  agents: { id: string; status: string }[],
  notes: Pick<Note, 'id' | 'from'>[] = [],
  now = Date.now(),
): string | null {
  for (let i = feed.length - 1; i >= 0; i--) {
    const f = feed[i];
    if (f.kind !== 'message' && f.kind !== 'reply') continue;
    if (now - tms(f.at) > TYPING_MS) return null;
    const to = f.kind === 'reply' ? notes.find((n) => n.id === f.noteId)?.from : f.to;
    if (!to || to === f.from || to === 'everyone' || to === 'you') return null;
    const a = agents.find((x) => x.id === to);
    return a && a.status === 'working' ? a.id : null;
  }
  return null;
}

// ---------------------------------------------------------------- needs-you badge

/** Open notes that wait on you: escalation, review, approval, or addressed to you. Dismissed ones don't count. */
export function needsYouCount(notes: Pick<Note, 'open' | 'type' | 'to' | 'dismissed'>[]): number {
  return notes.filter((n) => n.open && !n.dismissed && (n.type === 'escalation' || n.type === 'review' || n.type === 'approval' || n.to === 'you')).length;
}

/** Badge text: "" for 0, "1"…"9", then "9+". */
export function badgeLabel(n: number): string {
  if (!(n > 0)) return '';
  return n > 9 ? '9+' : String(Math.floor(n));
}
