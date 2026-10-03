import { describe, expect, it } from 'vitest';
import { ExpandState } from './expandstate';

describe('ExpandState (inline Intel details)', () => {
  it('opens a row on click and closes it on a second click', () => {
    const s = new ExpandState();
    expect(s.isOpen('changes', 'IX1')).toBe(false);
    expect(s.toggle('changes', 'IX1')).toBe('IX1');
    expect(s.isOpen('changes', 'IX1')).toBe(true);
    expect(s.toggle('changes', 'IX1')).toBeUndefined();
    expect(s.isOpen('changes', 'IX1')).toBe(false);
    expect(s.openKey('changes')).toBeUndefined();
  });

  it('opening another row in the same list closes the previous one', () => {
    const s = new ExpandState();
    s.toggle('matrix', 'F1:padlet');
    expect(s.toggle('matrix', 'F2:us')).toBe('F2:us');
    expect(s.isOpen('matrix', 'F1:padlet')).toBe(false);
    expect(s.openKey('matrix')).toBe('F2:us');
  });

  it('keeps lists independent', () => {
    const s = new ExpandState();
    s.toggle('changes', 'IX1');
    s.toggle('ic:R1', 'pricing');
    expect(s.isOpen('changes', 'IX1')).toBe(true);
    expect(s.isOpen('ic:R1', 'pricing')).toBe(true);
    s.toggle('changes', 'IX1');
    expect(s.isOpen('ic:R1', 'pricing')).toBe(true);
  });

  it('survives a re-render: state is keyed by id, so the rebuilt row reads as open', () => {
    const s = new ExpandState();
    s.toggle('comments', 'SO2');
    // a re-render (intel WS event) rebuilds every row and asks again by id
    const rendered = ['SO1', 'SO2', 'SO3'].filter((id) => s.isOpen('comments', id));
    expect(rendered).toEqual(['SO2']);
    // the same row clicked after the re-render closes it
    expect(s.toggle('comments', 'SO2')).toBeUndefined();
  });

  it('Esc closes only the row that is open', () => {
    const s = new ExpandState();
    s.toggle('wins', 'SO4');
    s.close('wins', 'SO5');
    expect(s.isOpen('wins', 'SO4')).toBe(true);
    s.close('wins', 'SO4');
    expect(s.isOpen('wins', 'SO4')).toBe(false);
  });
});
