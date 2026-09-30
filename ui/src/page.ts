import type { Snapshot } from './events';

/** A page is created once and kept alive (hidden) while you are on another page. */
export interface Page {
  el: HTMLElement;
  /** Called with every new snapshot while the page is visible, and when it is shown. */
  update(s: Snapshot): void;
  /** Hash query params (e.g. #/board?note=N14). */
  params?(p: URLSearchParams): void;
  show?(): void;
  hide?(): void;
}
