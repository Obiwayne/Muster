import { describe, expect, it } from 'vitest';
import { KRAKEN_EVERY, KRAKEN_FIRST, KRAKEN_LEN, SHOT_FLIGHT, krakenAt, krakenFrame } from './kraken';

describe('the Kraken', () => {
  it('stays away until its first visit, then comes back every few minutes', () => {
    expect(krakenFrame(0)).toBeNull();
    expect(krakenFrame(KRAKEN_FIRST - 1)).toBeNull();
    expect(krakenFrame(KRAKEN_FIRST + 10)).not.toBeNull();
    expect(krakenFrame(KRAKEN_FIRST + KRAKEN_LEN + 1)).toBeNull();
    expect(krakenFrame(KRAKEN_FIRST + KRAKEN_EVERY + 10)).toEqual(krakenFrame(KRAKEN_FIRST + 10));
  });

  it('the storm rolls in first, the tentacles rise, then everything clears', () => {
    expect(krakenAt(0)!.gloom).toBe(0);
    expect(krakenAt(1.5)!.gloom).toBeGreaterThan(0);
    expect(krakenAt(1.5)!.rise).toEqual([0, 0]);
    expect(krakenAt(12)!.gloom).toBe(1);
    expect(krakenAt(12)!.rise).toEqual([1, 1]);
    expect(krakenAt(24.5)!.rise).toEqual([0, 0]);
    expect(krakenAt(KRAKEN_LEN - 0.01)!.gloom).toBeLessThan(0.01);
    expect(krakenAt(KRAKEN_LEN)).toBeNull();
  });

  it('fires the cannon only while a tentacle is up, and the hit makes it flinch', () => {
    for (let u = 0; u < KRAKEN_LEN; u += 0.05) {
      const f = krakenAt(u)!;
      for (const s of f.shots) if (s.since < 0.05) expect(f.rise[s.target]).toBe(1);
    }
    const fired = krakenAt(8.5)!;
    expect(fired.shots[0]).toMatchObject({ target: 0, fly: 0 });
    expect(fired.recoil).toBe(1);
    expect(krakenAt(8.5 + SHOT_FLIGHT / 2)!.flinch[0]).toBe(0);
    expect(krakenAt(8.5 + SHOT_FLIGHT + 0.05)!.flinch[0]).toBeGreaterThan(0.8);
  });

  it('lightning flashes now and then', () => {
    const lit = Array.from({ length: KRAKEN_LEN * 20 }, (_, i) => krakenAt(i / 20)!).filter((f) => f.bolt !== null);
    expect(lit.length).toBeGreaterThan(10);
    expect(Math.max(...lit.map((f) => f.flash))).toBeLessThanOrEqual(1);
  });
});
