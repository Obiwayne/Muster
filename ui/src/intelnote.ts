// The Bulletin board's "research is ready" / "stopped early" note (Note.intel): title, body, verdict chips and which
// actions it offers. Pure, so tested; ui/src/pages/board.ts renders it.
import type { IntelJobNote, Note } from '../../src/types';

export type IntelNoteAction = 'open' | 'gaps' | 'dismiss' | 'again';
export interface IntelNoteView {
  tone: 'ready' | 'stopped';
  title: string;
  body: string;
  chips: { text: string; tone: 'gap' | 'edge' | 'open' | 'plain' }[];
  actions: IntelNoteAction[];
}

export const isIntelJobNote = (n: Pick<Note, 'topic' | 'intel'>): n is Pick<Note, 'topic'> & { intel: IntelJobNote } => n.topic === 'intel' && !!n.intel;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function intelNoteView(n: Pick<Note, 'text' | 'intel'> & { intel: IntelJobNote }): IntelNoteView {
  const nl = n.text.indexOf('\n');
  const title = nl > 0 ? n.text.slice(0, nl).trim() : n.text;
  const body = nl > 0 ? n.text.slice(nl + 1).trim() : '';
  const d = n.intel;
  if (d.outcome === 'stopped') return { tone: 'stopped', title, body, chips: [], actions: ['open', 'again'] };
  const chips: IntelNoteView['chips'] = [];
  if (d.gaps) chips.push({ text: plural(d.gaps, 'gap'), tone: 'gap' });
  if (d.edges) chips.push({ text: plural(d.edges, 'edge'), tone: 'edge' });
  if (d.open) chips.push({ text: `${d.open} open`, tone: 'open' });
  if (d.ideas) chips.push({ text: `${plural(d.ideas, 'idea')} for the roadmap`, tone: 'plain' });
  return { tone: 'ready', title, body, chips, actions: ['open', 'gaps', 'dismiss'] };
}

/** "Run again": one competitor's research again, or a sweep over the same competitors. */
export function runAgainBody(d: IntelJobNote): { kind: 'competitor' | 'sweep'; competitorIds: string[] } {
  return d.kind === 'competitor' && d.competitorIds.length === 1 ? { kind: 'competitor', competitorIds: d.competitorIds } : { kind: 'sweep', competitorIds: d.competitorIds };
}
