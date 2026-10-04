// "Update" on the Bulletin board: the desktop app reports whether the code on disk is newer than what runs
// ('build' = sources changed since the last build, 'restart' = a newer build is waiting) and restarts into it.
import { confirmDialog, h, icon, toast } from './dom';

export type UpdateStatus = 'build' | 'restart' | 'current';
interface UpdateBridge {
  updateStatus?(): Promise<UpdateStatus | null>;
  restartToUpdate?(): Promise<{ ok: boolean; error?: string }>;
}
const desk = () => (window as unknown as { musterApp?: UpdateBridge }).musterApp;

export function updateText(s: UpdateStatus): string {
  return s === 'build'
    ? "Muster's code changed since this version started. Update builds it (about a minute) and restarts Muster."
    : 'A newer Muster build is ready. Update restarts Muster to run it.';
}

/** The strip at the top of the Bulletin board; hidden unless an update is waiting (and outside the desktop app). */
export function createUpdateBar(): { el: HTMLElement; check(): Promise<void> } {
  const text = h('div.flex1');
  const btn = h('button.btn.sm.merge', null, 'Update') as HTMLButtonElement;
  const el = h('div.banner.warm.update-bar', { hidden: true }, icon('refresh', 16), text, btn);
  let status: UpdateStatus = 'current';

  btn.onclick = async () => {
    const bridge = desk();
    if (!bridge?.restartToUpdate) return;
    const ok = await confirmDialog(
      'Update Muster?',
      `${status === 'build' ? 'Muster builds the new version, then restarts. ' : 'Muster restarts on the new version. '}` +
        'The crew stops for a moment and every agent resumes where it was when this project reopens.',
      'Update now', 'merge');
    if (!ok) return;
    btn.disabled = true;
    text.textContent = status === 'build' ? 'Building the update… Muster restarts when it is done.' : 'Restarting…';
    const r = await bridge.restartToUpdate().catch((e: unknown) => ({ ok: false, error: String(e) }));
    if (!r.ok) {
      btn.disabled = false;
      text.textContent = updateText(status);
      toast(r.error || 'The update failed.', 'error');
    }
  };

  return {
    el,
    async check() {
      const bridge = desk();
      if (!bridge?.updateStatus || btn.disabled) return;
      status = (await bridge.updateStatus().catch(() => null)) ?? 'current';
      text.textContent = updateText(status);
      el.hidden = status === 'current';
    },
  };
}
