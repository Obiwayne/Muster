// One live xterm.js terminal per agent tile, attached over ws://<host>/ws/term/<id>.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import type { TermClientMessage } from '../../src/types';
import { wsUrl } from './events';

const THEME = {
  background: '#0C0C0E',
  foreground: '#F4F4F5',
  cursor: '#F4F4F5',
  cursorAccent: '#0C0C0E',
  selectionBackground: 'rgba(155,155,164,0.35)',
  black: '#19191C',
  brightBlack: '#62626B',
  red: '#F2555A',
  brightRed: '#FF7A7E',
  green: '#34C77B',
  brightGreen: '#5FDB9A',
  yellow: '#F5A524',
  brightYellow: '#FFC15E',
  blue: '#4F7BFF',
  brightBlue: '#7C9CFF',
  magenta: '#A78BFA',
  brightMagenta: '#C4B2FC',
  cyan: '#2DD4BF',
  brightCyan: '#6CE5D5',
  white: '#9B9BA4',
  brightWhite: '#F4F4F5',
};

let fontsReady: Promise<unknown> | null = null;
function waitForFonts(): Promise<unknown> {
  fontsReady ??= Promise.race([
    Promise.all([document.fonts.load('12px "Geist Mono"'), document.fonts.load('bold 12px "Geist Mono"')]),
    new Promise((r) => setTimeout(r, 1500)),
  ]);
  return fontsReady;
}

export class TermView {
  readonly term: Terminal;
  private fit = new FitAddon();
  private ws: WebSocket | null = null;
  private disposed = false;
  private retry = 0;
  private ro: ResizeObserver;
  private resizeTimer: number | undefined;
  private lastSize = '';
  private hadData = false;
  private pending = '';
  private flushRaf = 0;
  private flushTimer: number | undefined;
  onConnectionChange?: (connected: boolean) => void;

  constructor(private host: HTMLElement, readonly agentId: string) {
    this.term = new Terminal({
      theme: THEME,
      fontFamily: '"Geist Mono", ui-monospace, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.35,
      cursorBlink: false,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: true,
      convertEol: false,
      drawBoldTextInBrightColors: false,
    });
    this.term.loadAddon(this.fit);
    this.term.onData((data) => this.send({ type: 'input', data }));
    this.ro = new ResizeObserver(() => this.scheduleFit());
    waitForFonts().then(() => {
      if (this.disposed) return;
      this.term.open(this.host);
      this.useWebgl();
      this.ro.observe(this.host);
      this.doFit();
      this.connect();
    });
  }

  /**
   * Claude's TUI repaints its screen many times a second (spinner, status line). The default DOM
   * renderer rebuilds every row as elements on each repaint, which flickers; WebGL draws to a canvas.
   * Falls back to the DOM renderer when WebGL isn't available or its context is lost.
   */
  private useWebgl(): void {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      this.term.loadAddon(webgl);
    } catch {
      // DOM renderer stays in place
    }
  }

  private connect(): void {
    if (this.disposed) return;
    const ws = new WebSocket(wsUrl(`/ws/term/${encodeURIComponent(this.agentId)}`));
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.onConnectionChange?.(true);
      // The server replays the backlog on connect; start from a clean screen.
      this.pending = '';
      if (this.hadData) this.term.reset();
      this.lastSize = '';
      this.doFit();
    };
    ws.onmessage = (ev) => {
      this.hadData = true;
      if (typeof ev.data === 'string') this.queueWrite(ev.data);
      else if (ev.data instanceof Blob) ev.data.arrayBuffer().then((b) => this.queueWrite(new TextDecoder().decode(b, { stream: true })));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onConnectionChange?.(false);
      if (this.disposed) return;
      const delay = Math.min(8000, 700 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  /**
   * The PTY delivers a TUI repaint as several small chunks (erase, then redraw). Writing each one as it
   * arrives lets a frame land between them and shows a half-drawn screen; batch to one write per frame.
   */
  private queueWrite(data: string): void {
    this.pending += data;
    if (this.flushRaf || this.flushTimer) return;
    this.flushRaf = requestAnimationFrame(() => this.flush());
    // rAF is paused in hidden windows; keep draining so the backlog doesn't grow unbounded.
    this.flushTimer = window.setTimeout(() => this.flush(), 100);
  }

  private flush(): void {
    cancelAnimationFrame(this.flushRaf);
    clearTimeout(this.flushTimer);
    this.flushRaf = 0;
    this.flushTimer = undefined;
    const data = this.pending;
    this.pending = '';
    if (data && !this.disposed) this.term.write(data);
  }

  private send(msg: TermClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private scheduleFit(): void {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => this.doFit(), 60);
  }

  private doFit(): void {
    if (this.disposed || !this.host.isConnected || this.host.offsetWidth < 40 || this.host.offsetHeight < 30) return;
    try { this.fit.fit(); } catch { return; }
    const size = `${this.term.cols}x${this.term.rows}`;
    if (size !== this.lastSize && this.ws?.readyState === WebSocket.OPEN) {
      this.lastSize = size;
      this.send({ type: 'resize', cols: this.term.cols, rows: this.term.rows });
    }
  }

  /** Re-fit after the tile is moved or shown again. */
  refresh(): void { this.scheduleFit(); }

  focus(): void { this.term.focus(); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.resizeTimer);
    cancelAnimationFrame(this.flushRaf);
    clearTimeout(this.flushTimer);
    this.ro.disconnect();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.term.dispose();
  }
}
