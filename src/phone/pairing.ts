// Pairing codes: 6 characters, valid 2 minutes, single use; a new code replaces the old one.
// 5 wrong codes within a minute lock /pair (429) until the oldest of them is a minute old.
import { randomInt } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_TTL_MS = 2 * 60_000;
export const MAX_FAILURES = 5;
export const FAILURE_WINDOW_MS = 60_000;

export const displayCode = (code: string): string => `${code.slice(0, 3)}-${code.slice(3)}`;

/** "k7m-4qx", "K7M 4QX" → "K7M4QX". */
export const normalizeCode = (raw: unknown): string => (typeof raw === 'string' ? raw.toUpperCase().replace(/[^A-Z0-9]/g, '') : '');

export type PairCheck = 'ok' | 'wrong' | 'expired' | 'limited';

export class Pairing {
  private code: { value: string; expiresAt: number } | null = null;
  private failures: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** A fresh code; the previous one stops working. */
  issue(): { code: string; expiresAt: number } {
    let value = '';
    for (let i = 0; i < 6; i++) value += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    this.code = { value, expiresAt: this.now() + CODE_TTL_MS };
    return { code: value, expiresAt: this.code.expiresAt };
  }

  /** When the live code expires, or null when there is none (the code itself is never handed out again). */
  activeUntil(): number | null {
    return this.code && this.now() <= this.code.expiresAt ? this.code.expiresAt : null;
  }

  /** Drops the live code (the desktop's "Cancel code"). */
  cancel(): boolean {
    const had = this.activeUntil() !== null;
    this.code = null;
    return had;
  }

  limited(): boolean {
    const t = this.now();
    this.failures = this.failures.filter((f) => t - f < FAILURE_WINDOW_MS);
    return this.failures.length >= MAX_FAILURES;
  }

  /** Checks (and on success consumes) a code. */
  redeem(raw: unknown): PairCheck {
    if (this.limited()) return 'limited';
    const given = Buffer.from(normalizeCode(raw));
    const current = this.code;
    const match = current !== null && given.length === current.value.length && timingSafeEqual(given, Buffer.from(current.value));
    if (match && this.now() <= current!.expiresAt) {
      this.code = null; // single use
      return 'ok';
    }
    this.failures.push(this.now());
    if (match) {
      this.code = null;
      return 'expired';
    }
    return 'wrong';
  }
}
