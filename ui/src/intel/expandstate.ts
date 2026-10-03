// Which Intel row has its details open, per list ("group"): at most one per group. Keyed by claim/source id rather than
// by element, so a re-render (intel WS events, snapshot ticks) rebuilds the same row open.

export class ExpandState {
  private open = new Map<string, string>();

  isOpen(group: string, key: string): boolean {
    return this.open.get(group) === key;
  }

  openKey(group: string): string | undefined {
    return this.open.get(group);
  }

  /** A click: open `key` (closing whatever else was open in its group), or close it when it is already open. Returns the key now open. */
  toggle(group: string, key: string): string | undefined {
    if (this.isOpen(group, key)) {
      this.open.delete(group);
      return undefined;
    }
    this.open.set(group, key);
    return key;
  }

  /** Close the group (only when `key` is the open one, if given). */
  close(group: string, key?: string): void {
    if (key === undefined || this.isOpen(group, key)) this.open.delete(group);
  }
}
