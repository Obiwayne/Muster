import { describe, expect, it } from 'vitest';
import { sanitizeTyped } from './sanitize.js';

describe('sanitizeTyped', () => {
  it('turns line breaks into spaces', () => {
    expect(sanitizeTyped('line one\nline two\r\nthree\rfour')).toBe('line one line two three four');
  });
  it('drops escape sequences: CSI, bracketed-paste markers, OSC, lone ESC', () => {
    expect(sanitizeTyped('a\x1b[201~b\x1b[200~c')).toBe('abc');
    expect(sanitizeTyped('up\x1b[Aarrow\x1b[1;5Cword')).toBe('uparrowword');
    expect(sanitizeTyped('x\x1b]0;title\x07y\x1b]8;;http://e\x1b\\z')).toBe('xyz');
    expect(sanitizeTyped('esc\x1bcreset\x1b')).toBe('escreset');
    expect(sanitizeTyped('c1\x9b31mred\x9d0;t\x9cok')).toBe('c1redok');
  });
  it('drops control characters (Ctrl-C, Backspace, Tab becomes a space)', () => {
    expect(sanitizeTyped('stop\x03\x04\x08\x7f\x00now')).toBe('stopnow');
    expect(sanitizeTyped('a\tb')).toBe('a b');
  });
  it('keeps ordinary text and unicode', () => {
    expect(sanitizeTyped('Fix the "share" dialog — ok? 100% ✓')).toBe('Fix the "share" dialog — ok? 100% ✓');
  });
});
