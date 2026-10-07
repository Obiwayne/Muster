// Notes page model (pure, tested): ordering, search, titles, what Copy puts on the clipboard.
import type { Jot } from '../../src/types';

/** Pinned first, then newest first. */
export function sortJots(list: Jot[]): Jot[] {
  const no = (j: Jot) => Number(j.id.replace(/\D/g, '')) || 0;
  return [...list].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.createdAt.localeCompare(a.createdAt) || no(b) - no(a));
}

/** Every word of the query must appear in the title, text or tags (case-insensitive). */
export function filterJots(list: Jot[], query: string): Jot[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((j) => {
    const hay = `${j.title ?? ''}\n${j.text}\n${j.tags.map((t) => `#${t} ${t}`).join(' ')}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The title shown on a card: the title, else the first non-empty line. */
export function jotTitle(j: Pick<Jot, 'title' | 'text'>): string {
  if (j.title?.trim()) return j.title.trim();
  const first = j.text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
  return first.length > 120 ? `${first.slice(0, 119)}…` : first;
}

/** The text under the title: without the first line when that line is the title. */
export function jotBody(j: Pick<Jot, 'title' | 'text'>): string {
  if (j.title?.trim()) return j.text;
  const lines = j.text.split(/\r?\n/);
  const i = lines.findIndex((l) => l.trim());
  return lines.slice(i + 1).join('\n').trim();
}

/** Long enough to fold behind "more" (about six lines on a card). */
export const isLong = (body: string) => body.split('\n').length > 6 || body.length > 420;

/** What Copy puts on the clipboard: the title (when it isn't already the first line), then the note, then its tags. */
export function copyText(j: Jot): string {
  const head = j.title?.trim() && !j.text.startsWith(j.title.trim()) ? `${j.title.trim()}\n\n` : '';
  const tags = j.tags.length ? `\n\n${j.tags.map((t) => `#${t}`).join(' ')}` : '';
  return `${head}${j.text}${tags}`;
}

/** Tags typed as "ideas, mobile #ux" → ["ideas", "mobile", "ux"]. */
export function parseTags(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).map((t) => t.replace(/^#/, '').trim().toLowerCase()).filter(Boolean))].slice(0, 8);
}

/** Header line: "12 notes · 3 via Claude · 2 pinned". */
export function summaryLine(list: Jot[]): string {
  const viaClaude = list.filter((j) => j.from === 'claude').length;
  const pinned = list.filter((j) => j.pinned).length;
  return [`${list.length} note${list.length === 1 ? '' : 's'}`, viaClaude ? `${viaClaude} via Claude` : '', pinned ? `${pinned} pinned` : ''].filter(Boolean).join(' · ');
}
