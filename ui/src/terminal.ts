// One live xterm.js terminal per agent tile, attached over ws://<host>/ws/term/<id>.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
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
      this.ro.observe(this.host);
      this.doFit();
      this.connect();
    });
  }

  private connect(): void {
    if (this.disposed) return;
    const ws = new WebSocket(wsUrl(`/ws/term/${encodeURIComponent(this.agentId)}`));
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.onConnectionChange?.(true);
      // The server replays the backlog on connect; start from a clean screen.
      if (this.hadData) this.term.reset();
      this.lastSize = '';
      this.doFit();
    };
    ws.onmessage = (ev) => {
      this.hadData = true;
      if (typeof ev.data === 'string') this.term.write(ev.data);
      else if (ev.data instanceof Blob) ev.data.arrayBuffer().then((b) => this.term.write(new Uint8Array(b)));
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
    this.ro.disconnect();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.term.dispose();
  }
}
