// Batches terminal output so one TUI repaint (erase + redraw, arriving as several ws messages) is drawn as one frame.

export type Schedule = (run: () => void) => () => void;

/** Runs on the next animation frame, or after `fallbackMs` if frames are paused (hidden window). */
export const frameOrTimeout =
  (fallbackMs = 100): Schedule =>
  (run) => {
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      run();
    };
    const raf = requestAnimationFrame(once);
    const timer = window.setTimeout(once, fallbackMs);
    return () => {
      done = true;
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  };

export class WriteBatcher {
  private queue: (string | Uint8Array)[] = [];
  private cancel: (() => void) | null = null;
  private decoder = new TextDecoder();

  constructor(
    private write: (data: string) => void,
    private schedule: Schedule,
  ) {}

  push(data: string | Uint8Array): void {
    this.queue.push(data);
    this.cancel ??= this.schedule(() => this.flush());
  }

  flush(): void {
    this.cancel?.();
    this.cancel = null;
    if (!this.queue.length) return;
    // One streaming decoder, so a glyph split across binary chunks isn't turned into U+FFFD.
    const text = this.queue.map((d) => (typeof d === 'string' ? d : this.decoder.decode(d, { stream: true }))).join('');
    this.queue = [];
    if (text) this.write(text);
  }

  /** Drops queued output and decoder state (new connection, or the view is gone). */
  clear(): void {
    this.cancel?.();
    this.cancel = null;
    this.queue = [];
    this.decoder = new TextDecoder();
  }
}
