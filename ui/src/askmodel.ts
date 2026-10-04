// The Captain's question menu on the Bulletin board (docs/ASK.md): option labels as shown, the answer
// draft you fill in, whether Submit is enabled and the body POST /api/notes/:id/answer takes.
import type { AskAnswer, AskQuestion } from '../../src/types';

export interface AskOptionView { label: string; value: string; description?: string; recommended: boolean }
export interface AskDraftItem { choices: string[]; other: string }
export type AskDraft = AskDraftItem[];

const RECOMMENDED = /\s*\(Recommended\)\s*$/i;

/** Options as shown: only the first one carries the Recommended tag, and only when its label ends in "(Recommended)". */
export function optionViews(q: AskQuestion): AskOptionView[] {
  return q.options.map((o, i) => {
    const recommended = i === 0 && RECOMMENDED.test(o.label);
    return { label: recommended ? o.label.replace(RECOMMENDED, '') : o.label, value: o.label, ...(o.description ? { description: o.description } : {}), recommended };
  });
}

export const emptyDraft = (ask: AskQuestion[]): AskDraft => ask.map(() => ({ choices: [], other: '' }));

/** Picks (or for multi-select toggles) an option of question qi. Returns a new draft. */
export function toggleChoice(draft: AskDraft, ask: AskQuestion[], qi: number, value: string): AskDraft {
  return draft.map((d, i) => {
    if (i !== qi) return d;
    if (!ask[i]?.multiSelect) return { ...d, choices: [value] };
    return { ...d, choices: d.choices.includes(value) ? d.choices.filter((c) => c !== value) : [...d.choices, value] };
  });
}

export const setOther = (draft: AskDraft, qi: number, other: string): AskDraft => draft.map((d, i) => (i === qi ? { ...d, other } : d));

/** Submit is enabled once every question has a choice or some text. */
export const canSubmit = (ask: AskQuestion[], draft: AskDraft): boolean =>
  draft.length === ask.length && draft.every((d) => d.choices.length > 0 || d.other.trim() !== '');

/** The answers body, choices in option order. */
export function answersPayload(ask: AskQuestion[], draft: AskDraft): { choices: string[]; other?: string }[] {
  return ask.map((q, i) => {
    const d = draft[i] ?? { choices: [], other: '' };
    const other = d.other.trim();
    return { choices: q.options.map((o) => o.label).filter((l) => d.choices.includes(l)), ...(other ? { other } : {}) };
  });
}

/** One read-only line per answered question: header (or Q<n>), then the choices (Recommended stripped) and the note. */
export function answerLines(ask: AskQuestion[], answers: AskAnswer[]): { header: string; question: string; text: string }[] {
  return answers.map((a, i) => {
    const q = ask[i];
    const shown = a.choices.map((c) => c.replace(RECOMMENDED, ''));
    const text = shown.length ? `${shown.join(', ')}${a.other ? ` (note: ${a.other})` : ''}` : a.other ?? '';
    return { header: a.header || `Q${i + 1}`, question: q?.question ?? '', text };
  });
}
