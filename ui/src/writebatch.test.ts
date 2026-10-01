import { describe, expect, it } from 'vitest';
import { WriteBatcher, type Schedule } from './writebatch';

function setup() {
  const out: string[] = [];
  let pending: (() => void) | null = null;
  const schedule: Schedule = (run) => {
    pending = run;
    return () => void (pending = null);
  };
  const b = new WriteBatcher((s) => out.push(s), schedule);
  return { b, out, tick: () => pending?.() };
}

describe('WriteBatcher', () => {
  it('writes everything queued before the frame as one string, in order', () => {
    const { b, out, tick } = setup();
    b.push('\x1b[2J');
    b.push(new TextEncoder().encode('\x1b[Hnew'));
    b.push('!');
    expect(out).toEqual([]);
    tick();
    expect(out).toEqual(['\x1b[2J\x1b[Hnew!']);
  });

  it('keeps a multi-byte glyph split across binary chunks intact', () => {
    const { b, out, tick } = setup();
    const bytes = new TextEncoder().encode('a✻b');
    b.push(bytes.subarray(0, 2)); // 'a' + first byte of ✻
    b.push(bytes.subarray(2));
    tick();
    expect(out).toEqual(['a✻b']);
  });

  it('carries a split glyph over a flush boundary', () => {
    const { b, out, tick } = setup();
    const bytes = new TextEncoder().encode('✻');
    b.push(bytes.subarray(0, 1));
    tick();
    b.push(bytes.subarray(1));
    tick();
    expect(out.join('')).toBe('✻');
  });

  it('clear drops queued output and any half-decoded glyph', () => {
    const { b, out, tick } = setup();
    const bytes = new TextEncoder().encode('✻');
    b.push(bytes.subarray(0, 1));
    tick();
    b.push('old');
    b.clear();
    tick();
    b.push('new');
    b.flush();
    expect(out).toEqual(['new']);
  });
});
