// Ship view: every few minutes the Kraken surfaces off the bow. The sky turns to storm with lightning, two tentacles
// rise and the crew fire the bow cannon at them until they sink again. Pure timing (seconds in, numbers out) so it is
// tested without a DOM; the drawing lives in shipart.ts and pages/ship.ts.

/** Seconds between visits. */
export const KRAKEN_EVERY = 240;
/** The first visit comes this long after the Ship view opens. */
export const KRAKEN_FIRST = 30;
/** How long one visit lasts, from the first cloud to clear sky. */
export const KRAKEN_LEN = 28;
/** Seconds a cannonball is in the air. */
export const SHOT_FLIGHT = 0.8;

/** When the cannon fires (seconds into the visit) and at which tentacle: 0 = the big one, 1 = the small one. */
const SHOTS: [number, 0 | 1][] = [[8.5, 0], [10.8, 1], [13, 0], [15.4, 0], [17.6, 1]];
/** Lightning strikes (seconds into the visit). */
const BOLTS = [2.2, 5.6, 9.6, 14.6, 19.2, 23];
const BOLT_LEN = 0.3;

export interface Shot {
  target: 0 | 1;
  since: number; // seconds since it was fired
  fly: number; // 0..1 along its flight; 1 = it has hit
}

export interface KrakenFrame {
  gloom: number; // 0 clear sky … 1 full storm
  rise: [number, number]; // how far each tentacle is out of the water, 0..1
  flinch: [number, number]; // 0..1, just after a cannonball hits
  shots: Shot[]; // shots still worth drawing (in flight, hit spark, smoke)
  bolt: number | null; // which lightning strike is showing
  flash: number; // 0..1 brightness of the lightning flash
  recoil: number; // 0..1 the cannon kicks back just after firing
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const ease = (v: number) => { const k = clamp(v); return k * k * (3 - 2 * k); };
/** 0 before `a`, rising to 1 at `b`, holding, falling back to 0 between `c` and `d`. */
const ramp = (u: number, a: number, b: number, c: number, d: number) => Math.min(ease((u - a) / (b - a)), ease((d - u) / (d - c)));

/** One frame of a visit, `u` seconds after it began; null outside the visit. */
export function krakenAt(u: number): KrakenFrame | null {
  if (u < 0 || u >= KRAKEN_LEN) return null;
  const shots: Shot[] = [];
  const flinch: [number, number] = [0, 0];
  let recoil = 0;
  for (const [at, target] of SHOTS) {
    const since = u - at;
    if (since < 0 || since > 2) continue;
    shots.push({ target, since, fly: clamp(since / SHOT_FLIGHT) });
    recoil = Math.max(recoil, 1 - since / 0.25);
    const hit = since - SHOT_FLIGHT;
    if (hit >= 0) flinch[target] = Math.max(flinch[target], 1 - hit / 0.6);
  }
  const bolt = BOLTS.findIndex((b) => u >= b && u < b + BOLT_LEN);
  return {
    gloom: ramp(u, 0, 3, KRAKEN_LEN - 4, KRAKEN_LEN),
    rise: [ramp(u, 3, 7, 21, 24), ramp(u, 5, 9, 20, 23)],
    flinch: [clamp(flinch[0]), clamp(flinch[1])],
    shots,
    bolt: bolt < 0 ? null : bolt,
    flash: bolt < 0 ? 0 : 1 - (u - BOLTS[bolt]) / BOLT_LEN,
    recoil: clamp(recoil),
  };
}

/** The visit showing `t` seconds after the Ship view opened, if any. */
export function krakenFrame(t: number): KrakenFrame | null {
  const local = t - KRAKEN_FIRST;
  return local < 0 ? null : krakenAt(local % KRAKEN_EVERY);
}
