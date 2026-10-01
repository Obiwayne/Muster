// One live xterm.js terminal per agent tile, attached over ws://<host>/ws/term/<id>.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import type { TermClientMessage } from '../../src/types';
import { wsUrl } from './events';
import { frameOrTimeout, WriteBatcher } from './writebatch';

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
  private webgl: WebglAddon | null = null;
  private glRetries = 0;
  private dprQuery: MediaQueryList | null = null;
  private out = new WriteBatcher((d) => this.term.write(d), frameOrTimeout());
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
      this.watchGlyphMetrics();
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
      webgl.onContextLoss(() => {
        webgl.dispose();
        if (this.webgl === webgl) this.webgl = null;
        // The DOM renderer takes over; try WebGL again a couple of times (the GPU process may have just reset).
        if (!this.disposed && this.glRetries++ < 3) setTimeout(() => !this.disposed && !this.webgl && this.useWebgl(), 500);
        this.repaint();
      });
      this.term.loadAddon(webgl);
      this.webgl = webgl;
      this.repaint();
    } catch {
      // DOM renderer stays in place
    }
  }

  /** Throws away the glyph texture atlas and redraws, so smeared or wrongly sized glyphs are re-rasterized. */
  private repaint(): void {
    if (this.disposed || !this.term.element) return;
    try {
      this.term.clearTextureAtlas();
      this.term.refresh(0, this.term.rows - 1);
    } catch {
      // not rendered yet
    }
  }

  /** The atlas bakes glyphs at one font and pixel ratio; rebuild it when either changes after the fact. */
  private watchGlyphMetrics(): void {
    document.fonts.addEventListener('loadingdone', this.onFontsLoaded);
    void document.fonts.ready.then(this.onFontsLoaded);
    this.armDprWatch();
  }

  private onFontsLoaded = (): void => {
    if (!this.disposed) this.repaint();
  };

  private armDprWatch(): void {
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this.dprQuery.addEventListener('change', this.onDprChange);
  }

  private onDprChange = (): void => {
    if (this.disposed) return;
    this.armDprWatch();
    this.scheduleFit();
    this.repaint();
  };

  private connect(): void {
    if (this.disposed) return;
    const ws = new WebSocket(wsUrl(`/ws/term/${encodeURIComponent(this.agentId)}`));
    ws.binaryType = 'arraybuffer'; // read synchronously, so chunks can't reorder
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.onConnectionChange?.(true);
      // The server replays the backlog on connect; start from a clean screen.
      this.out.clear();
      if (this.hadData) this.term.reset();
      this.lastSize = '';
      this.doFit();
    };
    ws.onmessage = (ev) => {
      this.hadData = true;
      if (typeof ev.data === 'string') this.out.push(ev.data);
      else if (ev.data instanceof ArrayBuffer) this.out.push(new Uint8Array(ev.data));
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
  refresh(): void {
    this.scheduleFit();
    this.repaint();
  }

  focus(): void { this.term.focus(); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.resizeTimer);
    this.ro.disconnect();
    document.fonts.removeEventListener('loadingdone', this.onFontsLoaded);
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.out.clear();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.term.dispose();
  }
}
