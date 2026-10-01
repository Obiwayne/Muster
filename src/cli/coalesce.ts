// Output coalescing and resize dedupe for `muster attach`.

export const SYNC_BEGIN = '\x1b[?2026h';
export const SYNC_END = '\x1b[?2026l';

/**
 * Claude's TUI repaints in many small PTY chunks; written one by one they show half-drawn frames.
 * Collects chunks for `delayMs`, then writes them as one block wrapped in synchronized output
 * (DEC 2026) so the terminal presents the whole repaint at once.
 */
export class Coalescer {
  private pending: Buffer[] = [];
  private timer: NodeJS.Timeout | null = null;
  private firstAt = 0;

  constructor(
    private write: (data: Buffer) => void,
    private delayMs = 8,
    private maxHoldMs = 60,
  ) {}

  push(chunk: Buffer): void {
    if (!this.pending.length) this.firstAt = Date.now();
    this.pending.push(chunk);
    this.timer ??= setTimeout(() => this.tick(), this.delayMs);
  }

  /** A repaint that starts with a screen clear arrives in pieces ~15ms apart; don't show the blank screen between them. */
  private tick(): void {
    this.timer = null;
    if (endsWithClear(this.pending[this.pending.length - 1]) && Date.now() - this.firstAt < this.maxHoldMs) {
      this.timer = setTimeout(() => this.tick(), this.delayMs);
      return;
    }
    this.flush();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending.length) return;
    const body = Buffer.concat(this.pending);
    this.pending = [];
    this.write(Buffer.concat([Buffer.from(SYNC_BEGIN), body, Buffer.from(SYNC_END)]));
  }
}

const CLEAR_TAIL = /\[[23]J(?:\[[0-9;?]*[A-Za-z])*$/;

function endsWithClear(chunk: Buffer): boolean {
  return CLEAR_TAIL.test(chunk.subarray(-40).toString('latin1'));
}

/** Remembers the last size sent and says whether a new one is worth sending. */
export function resizeDeduper(): (cols: number | undefined, rows: number | undefined) => boolean {
  let last = '';
  return (cols, rows) => {
    if (!cols || !rows) return false;
    const key = `${cols}x${rows}`;
    if (key === last) return false;
    last = key;
    return true;
  };
}
