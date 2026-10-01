import { describe, expect, it } from 'vitest';
import { parseCheck } from './vellumchecks';

describe('parseCheck', () => {
  it('parses a PASS line', () => {
    expect(parseCheck('PASS T6 Invite email matches the board\nChecked: email')).toEqual({
      verdict: 'pass', taskId: 'T6', summary: 'Invite email matches the board', diffs: [],
    });
  });

  it('parses DRIFT with path:line differences', () => {
    const c = parseCheck('DRIFT T4 ShareDialog button is hard-coded\nsrc/ui/ShareDialog.tsx:42 — #2563EB, framework uses var(--color-primary)\nui/styles.css:9 - radius 8px, design says 12px\n\nScreens: share dialog');
    expect(c?.verdict).toBe('drift');
    expect(c?.taskId).toBe('T4');
    expect(c?.diffs).toEqual([
      { path: 'src/ui/ShareDialog.tsx', line: 42, text: '#2563EB, framework uses var(--color-primary)' },
      { path: 'ui/styles.css', line: 9, text: 'radius 8px, design says 12px' },
    ]);
  });

  it('tolerates leading blank lines, lowercase and bullets', () => {
    const c = parseCheck('\n  drift t12: spacing off\n- a/b.ts:3 — gap 4px');
    expect(c).toMatchObject({ verdict: 'drift', taskId: 'T12', summary: 'spacing off' });
    expect(c?.diffs).toEqual([{ path: 'a/b.ts', line: 3, text: 'gap 4px' }]);
  });

  it('keeps a difference without a line number', () => {
    expect(parseCheck('DRIFT T1 x\nsrc/a.css — wrong font')?.diffs).toEqual([{ path: 'src/a.css', text: 'wrong font' }]);
  });

  it('returns null for anything else', () => {
    expect(parseCheck('')).toBeNull();
    expect(parseCheck('Looks good, passes everything')).toBeNull();
    expect(parseCheck('PASS the review')).toBeNull();
    expect(parseCheck('Intro line\nPASS T1 later')).toBeNull();
  });

  it('ignores prose lines that are not differences', () => {
    expect(parseCheck('DRIFT T2 x\nThis is fine — really\nsrc/a.ts:1 — real')?.diffs).toHaveLength(1);
  });
});
