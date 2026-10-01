import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Coalescer, resizeDeduper, SYNC_BEGIN, SYNC_END } from './coalesce.js';

describe('Coalescer', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('joins chunks arriving within the delay into one synchronized write', () => {
    const writes: string[] = [];
    const c = new Coalescer((b) => writes.push(b.toString()), 8);
    c.push(Buffer.from('a'));
    vi.advanceTimersByTime(5);
    c.push(Buffer.from('b'));
    expect(writes).toEqual([]);
    vi.advanceTimersByTime(3);
    expect(writes).toEqual([`${SYNC_BEGIN}ab${SYNC_END}`]);
    c.push(Buffer.from('c'));
    vi.advanceTimersByTime(8);
    expect(writes).toHaveLength(2);
  });

  it('holds a trailing screen clear for the rest of its repaint, but not forever', () => {
    const writes: string[] = [];
    const c = new Coalescer((b) => writes.push(b.toString()), 8, 60);
    c.push(Buffer.from('old[?25l[2J'));
    vi.advanceTimersByTime(20);
    expect(writes).toEqual([]);
    c.push(Buffer.from('[Hnew'));
    vi.advanceTimersByTime(8);
    expect(writes).toEqual([`${SYNC_BEGIN}old[?25l[2J[Hnew${SYNC_END}`]);
    c.push(Buffer.from('[2J'));
    vi.advanceTimersByTime(100);
    expect(writes).toHaveLength(2);
  });

  it('flushes pending output immediately on demand and writes nothing when empty', () => {
    const writes: string[] = [];
    const c = new Coalescer((b) => writes.push(b.toString()));
    c.flush();
    c.push(Buffer.from('x'));
    c.flush();
    vi.advanceTimersByTime(50);
    expect(writes).toEqual([`${SYNC_BEGIN}x${SYNC_END}`]);
  });
});

describe('resizeDeduper', () => {
  it('only passes changed, valid sizes', () => {
    const ok = resizeDeduper();
    expect(ok(undefined, 24)).toBe(false);
    expect(ok(80, 24)).toBe(true);
    expect(ok(80, 24)).toBe(false);
    expect(ok(81, 24)).toBe(true);
    expect(ok(80, 24)).toBe(true);
  });
});
