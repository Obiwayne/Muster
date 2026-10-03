// "How should scout browse?": the research browser mode for one intel job or research run (BrowseMode).
// Used by Intel → Add competitor and (package D) the New research modal. Opera stays disabled until
// Settings → Research browser has an allowlist (config.researchBrowser.operaAllow).
import './browsechoice.css';
import type { BrowseMode, MusterConfig, ResearchBrowserStatus } from '../../src/types';
import { h, icon, setChildren } from './dom';

export interface BrowseOption {
  mode: BrowseMode;
  title: string;
  sub: string;
  recommended?: boolean;
  warning?: string;
  disabled?: string; // why it can't be picked right now
}

/** The three options, with what's known about this PC. Pure: tested in intelmodel.test.ts. */
export function browseOptions(operaAllow: string[], status?: ResearchBrowserStatus | null): BrowseOption[] {
  const noBrowser = status && !status.available ? `${status.problem ?? 'The research browser is not available'}. scout reads public pages with its web tools.` : undefined;
  const connected = status?.sites.filter((s) => s.connected).map((s) => s.label) ?? [];
  return [
    {
      mode: 'profile',
      title: 'Muster research profile',
      sub: connected.length
        ? `Muster's own Chrome profile, signed in to ${connected.join(', ')}. Read-only, rate-limited.`
        : "Muster's own Chrome profile. Sign in to sites in Settings → Research browser. Read-only, rate-limited.",
      recommended: true,
      disabled: noBrowser,
    },
    {
      mode: 'public',
      title: 'Public pages only',
      sub: 'A fresh browser with no cookies. Pages behind a login are skipped.',
    },
    {
      mode: 'opera',
      title: 'My Opera profile',
      sub: operaAllow.length
        ? `Imports Opera cookies for ${operaAllow.join(', ')} only, then browses as the research profile.`
        : 'Imports Opera cookies for the sites you allow, then browses as the research profile.',
      warning: 'Uses your own signed-in accounts. scout can only read, never post, but those sites see your account visit.',
      disabled: !operaAllow.length
        ? 'Add sites to the Opera allowlist in Settings → Research browser first.'
        : noBrowser,
    },
  ];
}

/** The lock line under a modal for the chosen mode. */
export function browseFootnote(mode: BrowseMode): string {
  if (mode === 'public') return 'Public pages only. Never signs in or contacts them.';
  if (mode === 'opera') return 'Read-only with your Opera sign-ins for allow-listed sites. Never posts or contacts them.';
  return "Read-only, in Muster's research profile. Never posts or contacts them.";
}

/** The mode to start with: the config default, falling back when it can't be used. */
export function initialBrowseMode(config: Pick<MusterConfig, 'researchBrowser'> | null | undefined, status?: ResearchBrowserStatus | null): BrowseMode {
  const rb = config?.researchBrowser;
  const want: BrowseMode = rb?.mode ?? 'profile';
  const opt = browseOptions(rb?.operaAllow ?? [], status).find((o) => o.mode === want);
  if (opt && !opt.disabled) return want;
  return status && !status.available ? 'public' : 'profile';
}

export interface BrowseChoice {
  el: HTMLElement;
  value(): BrowseMode;
  set(mode: BrowseMode): void;
  /** Re-render with fresh status (e.g. once GET /api/browser answers). */
  setStatus(status: ResearchBrowserStatus | null, operaAllow?: string[]): void;
}

export function createBrowseChoice(opts: {
  value: BrowseMode;
  operaAllow: string[];
  status?: ResearchBrowserStatus | null;
  onChange?: (mode: BrowseMode) => void;
  label?: string; // default "HOW SHOULD SCOUT BROWSE?"
}): BrowseChoice {
  let mode = opts.value;
  let status = opts.status ?? null;
  let allow = opts.operaAllow;
  const list = h('div.bc-list', { role: 'radiogroup', 'aria-label': 'How should scout browse?' });
  const el = h('div.bc', null, h('div.section-label', null, opts.label ?? 'HOW SHOULD SCOUT BROWSE?'), list);

  function draw(): void {
    setChildren(list, browseOptions(allow, status).map((o) => {
      const on = o.mode === mode;
      const pick = () => {
        if (o.disabled || mode === o.mode) return;
        mode = o.mode;
        draw();
        opts.onChange?.(mode);
      };
      return h('div.bc-opt', {
        class: [on && 'on', o.disabled && 'disabled'],
        role: 'radio',
        'aria-checked': String(on),
        'aria-disabled': o.disabled ? 'true' : undefined,
        tabindex: o.disabled ? -1 : 0,
        title: o.disabled ?? '',
        onclick: pick,
        onkeydown: (e: KeyboardEvent) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); pick(); } },
      },
      h('span.bc-radio', null, on ? h('span.bc-dot') : null),
      h('div.bc-body', null,
        h('div.bc-title', null, o.title, o.recommended ? h('span.bc-rec', null, 'Recommended') : null),
        h('div.bc-sub', null, o.sub),
        o.warning ? h('div.bc-warn', null, icon('alert', 12), h('span', null, o.warning)) : null,
        o.disabled ? h('div.bc-off', null, o.disabled) : null));
    }));
  }
  draw();
  return {
    el,
    value: () => mode,
    set(m) { mode = m; draw(); },
    setStatus(s, operaAllow) {
      status = s;
      if (operaAllow) allow = operaAllow;
      // A mode that just became unusable falls back to a usable one.
      const cur = browseOptions(allow, status).find((o) => o.mode === mode);
      if (cur?.disabled) { mode = status && !status.available ? 'public' : 'profile'; opts.onChange?.(mode); }
      draw();
    },
  };
}
