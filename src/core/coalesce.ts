// Terminal output coalescing (server /ws/term and `muster attach`) and resize dedupe.

export const SYNC_BEGIN = '\x1b[?2026h';
export const SYNC_END = '\x1b[?2026l';

/**
 * Claude's TUI repaints in many small PTY chunks; written one by one they show half-drawn frames.
 * Collects chunks for `delayMs`, then writes them as one block; a block ending in a bare screen clear is
 * held (up to `maxHoldMs`) for the redraw that follows. With `sync`, each block is wrapped in
 * synchronized output (DEC 2026) so the terminal presents it at once.
 */
export class Coalescer {
  private pending: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private firstAt = 0;

  constructor(
    private write: (data: string) => void,
    private opts: { sync?: boolean; delayMs?: number; maxHoldMs?: number } = {},
  ) {}

  push(chunk: string): void {
    if (!this.pending.length) this.firstAt = Date.now();
    this.pending.push(chunk);
    this.timer ??= setTimeout(() => this.tick(), this.opts.delayMs ?? 8);
  }

  /** A repaint that starts with a screen clear arrives in pieces ~15ms apart; don't show the blank screen between them. */
  private tick(): void {
    this.timer = null;
    if (endsWithClear(this.pending[this.pending.length - 1]) && Date.now() - this.firstAt < (this.opts.maxHoldMs ?? 60)) {
      this.timer = setTimeout(() => this.tick(), this.opts.delayMs ?? 8);
      return;
    }
    this.flush();
  }

  /** Drops anything queued and stops the timer (the connection is gone). */
  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending.length) return;
    const body = this.pending.join('');
    this.pending = [];
    this.write(this.opts.sync ? SYNC_BEGIN + body + SYNC_END : body);
  }
}

const CLEAR_TAIL = /\x1b\[[23]J(?:\x1b\[[0-9;?]*[A-Za-z])*$/;

function endsWithClear(chunk: string): boolean {
  return CLEAR_TAIL.test(chunk.slice(-40));
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
