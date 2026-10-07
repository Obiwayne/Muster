// Reconnecting client for ws://<host>/ws/events. Holds the latest {state, config}
// snapshot and forwards toast events.
import type { IntelSummary, MediaSummary, MusterConfig, MusterEvent, MusterState } from '../../src/types';
import { api, getToken, refreshToken } from './api';

export interface Snapshot { state: MusterState; config: MusterConfig }

type SnapListener = (s: Snapshot) => void;
type ToastListener = (t: { level: 'info' | 'warn'; text: string }) => void;
type ConnListener = (connected: boolean) => void;
type IntelListener = (summary: IntelSummary) => void;
type MediaListener = (summary: MediaSummary) => void;

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(getToken())}`;
}

class EventClient {
  snapshot: Snapshot | null = null;
  connected = false;
  /** The latest intel summary (GET /api/intel/summary on load, then each `intel` event). */
  intel: IntelSummary | null = null;
  /** The latest media summary (GET /api/media/summary on load, then each `media` event). */
  media: MediaSummary | null = null;
  private ws: WebSocket | null = null;
  private retry = 0;
  private snapL = new Set<SnapListener>();
  private toastL = new Set<ToastListener>();
  private connL = new Set<ConnListener>();
  private intelL = new Set<IntelListener>();
  private mediaL = new Set<MediaListener>();

  start(): void {
    // Fetch once over HTTP so the first paint doesn't wait on the socket.
    api.state().then((r) => { if (!this.snapshot) this.set({ state: r.state, config: r.config }); }).catch(() => {});
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(wsUrl('/ws/events'));
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.setConn(true); };
    ws.onmessage = (ev) => {
      let msg: MusterEvent;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.type === 'state') this.set({ state: msg.state, config: msg.config });
      else if (msg.type === 'toast') this.toastL.forEach((l) => l({ level: msg.level, text: msg.text }));
      else if (msg.type === 'intel') this.setIntel(msg.summary);
      else if (msg.type === 'media') this.setMedia(msg.summary);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.setConn(false);
      const delay = Math.min(5000, 500 * 2 ** this.retry++);
      // A restarted orchestrator has a new token: pick it up before trying again.
      setTimeout(() => void refreshToken().finally(() => this.connect()), delay);
    };
    ws.onerror = () => ws.close();
  }

  private setConn(v: boolean): void {
    if (this.connected === v) return;
    this.connected = v;
    this.connL.forEach((l) => l(v));
  }

  /** Apply a snapshot locally (e.g. after PATCH /api/config) and notify listeners. */
  set(s: Snapshot): void {
    this.snapshot = s;
    this.snapL.forEach((l) => l(s));
  }

  /** Keep a newer intel summary (by rev) and notify listeners: the nav badge and the Intel page refetch. */
  setIntel(summary: IntelSummary): void {
    if (this.intel && summary.rev < this.intel.rev) return;
    this.intel = summary;
    this.intelL.forEach((l) => l(summary));
  }

  /** Keep a newer media summary (by rev) and notify listeners: the nav badge and the Media page refetch. */
  setMedia(summary: MediaSummary): void {
    if (this.media && summary.rev < this.media.rev) return;
    this.media = summary;
    this.mediaL.forEach((l) => l(summary));
  }

  onSnapshot(l: SnapListener): () => void { this.snapL.add(l); return () => this.snapL.delete(l); }
  onToast(l: ToastListener): () => void { this.toastL.add(l); return () => this.toastL.delete(l); }
  onConnection(l: ConnListener): () => void { this.connL.add(l); return () => this.connL.delete(l); }
  onIntel(l: IntelListener): () => void { this.intelL.add(l); return () => this.intelL.delete(l); }
  onMedia(l: MediaListener): () => void { this.mediaL.add(l); return () => this.mediaL.delete(l); }
}

export const events = new EventClient();
