import { describe, expect, it } from 'vitest';
import type { AskQuestion } from '../../src/types';
import { answerLines, answersPayload, canSubmit, emptyDraft, optionViews, setOther, toggleChoice } from './askmodel';

const art: AskQuestion = { header: 'Art model', question: 'Which image model?', multiSelect: false, options: [{ label: 'Flux (Recommended)', description: 'Best quality' }, { label: 'SDXL' }, { label: 'Imagen (Recommended)' }] };
const size: AskQuestion = { header: '', question: 'Caption sizes?', multiSelect: true, options: [{ label: 'Small' }, { label: 'Medium' }, { label: 'Large' }] };
const ask = [art, size];

describe('askmodel', () => {
  it('tags and strips Recommended on the first option only', () => {
    expect(optionViews(art)).toEqual([
      { label: 'Flux', value: 'Flux (Recommended)', description: 'Best quality', recommended: true },
      { label: 'SDXL', value: 'SDXL', recommended: false },
      { label: 'Imagen (Recommended)', value: 'Imagen (Recommended)', recommended: false },
    ]);
    expect(optionViews(size)[0]!.recommended).toBe(false);
  });

  it('picks one option on single-select and toggles on multi-select', () => {
    let d = emptyDraft(ask);
    d = toggleChoice(d, ask, 0, 'SDXL');
    d = toggleChoice(d, ask, 0, 'Flux (Recommended)');
    expect(d[0]!.choices).toEqual(['Flux (Recommended)']);
    d = toggleChoice(d, ask, 1, 'Large');
    d = toggleChoice(d, ask, 1, 'Small');
    d = toggleChoice(d, ask, 1, 'Large');
    expect(d[1]!.choices).toEqual(['Small']);
  });

  it('enables Submit once every question has a choice or text', () => {
    let d = emptyDraft(ask);
    expect(canSubmit(ask, d)).toBe(false);
    d = toggleChoice(d, ask, 0, 'SDXL');
    expect(canSubmit(ask, d)).toBe(false);
    d = setOther(d, 1, '   ');
    expect(canSubmit(ask, d)).toBe(false);
    d = setOther(d, 1, 'none at all');
    expect(canSubmit(ask, d)).toBe(true);
  });

  it('builds the answers body with the real labels in option order', () => {
    let d = emptyDraft(ask);
    d = toggleChoice(d, ask, 0, 'Flux (Recommended)');
    d = setOther(d, 0, ' cheap please ');
    d = toggleChoice(d, ask, 1, 'Large');
    d = toggleChoice(d, ask, 1, 'Small');
    expect(answersPayload(ask, d)).toEqual([{ choices: ['Flux (Recommended)'], other: 'cheap please' }, { choices: ['Small', 'Large'] }]);
  });

  it('reads answers back for a closed note', () => {
    expect(answerLines(ask, [{ header: 'Art model', choices: ['Flux (Recommended)'], other: 'cheap' }, { header: '', choices: [], other: 'skip' }])).toEqual([
      { header: 'Art model', question: 'Which image model?', text: 'Flux (note: cheap)' },
      { header: 'Q2', question: 'Caption sizes?', text: 'skip' },
    ]);
  });
});
