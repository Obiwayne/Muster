// The desktop app's taskbar badge: a red circle with the needs-you count, drawn here (the page has
// fonts and a canvas) and handed to the Electron main process through the preload bridge.
import { badgeLabel } from './chatmodel';

interface NeedsYouBridge { setNeedsYou?: (count: number, png: string | null) => unknown }

/** 32×32 PNG data URL: red circle, white number ("1"…"9", "9+"), or null for 0. */
export function badgePng(count: number): string | null {
  const label = badgeLabel(count);
  if (!label) return null;
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const g = c.getContext('2d');
  if (!g) return null;
  g.beginPath();
  g.arc(16, 16, 15, 0, Math.PI * 2);
  g.fillStyle = '#f2555a';
  g.fill();
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `700 ${label.length > 1 ? 15 : 20}px "Segoe UI", system-ui, sans-serif`;
  g.fillText(label, 16, 17);
  return c.toDataURL('image/png');
}

let reported = -1;

/** Tells the desktop app (if this page runs inside it) the needs-you count; only when it changes. */
export function reportNeedsYou(count: number): void {
  const app = (window as unknown as { musterApp?: NeedsYouBridge }).musterApp;
  if (!app?.setNeedsYou || count === reported) return;
  reported = count;
  try {
    void app.setNeedsYou(count, badgePng(count));
  } catch {
    reported = -1; // an older desktop build: try again on the next change
  }
}
