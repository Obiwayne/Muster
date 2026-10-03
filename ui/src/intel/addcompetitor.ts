// "Add a competitor" (5038-0): paste a URL → POST /api/intel/probe → identity card (legal entity, Companies House,
// "not them? pick another entity") → where scout will look (+ Add source) → research areas (Select all) → keep
// watching → how scout should browse → estimate → Add & start research (POST /api/intel/competitors { start: true }).
import { INTEL_AREAS, type IntelArea, type IntelCompetitor, type IntelProbe, type IntelSiteSource, type MusterConfig, type WatchCadence } from '../../../src/types';
import { closeFloating, h, icon, setChildren, showMenu, toast } from '../dom';
import { addCompetitor, ApiError, getBrowserStatus, probe as probeSite } from '../intelapi';
import { AREA_LABELS, COMPANY_COLOURS, domainOf, fmtDate, jobEstimate } from '../intelmodel';
import { browseFootnote, createBrowseChoice, initialBrowseMode } from '../browsechoice';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Areas ticked by default: everything but marketing & social and the org chart (the slow, low-yield ones). */
export const DEFAULT_AREAS: IntelArea[] = INTEL_AREAS.filter((a) => a !== 'marketing' && a !== 'org');
const WATCH: { value: WatchCadence; label: string }[] = [
  { value: 'off', label: 'Off' }, { value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' },
];
const SOURCE_LABEL: Partial<Record<IntelSiteSource['kind'], string>> = {
  pricing: 'Pricing page', roadmap: 'Public roadmap', changelog: 'Changelog', help: 'Help centre', app_store: 'App Store', google_play: 'Google Play',
  g2: 'G2', capterra: 'Capterra', reddit: 'Reddit', forum: 'Forum', linkedin: 'LinkedIn', youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram',
  x: 'X', facebook: 'Facebook', companies_house: 'Companies House', jobs: 'Jobs page', press: 'Press', rss: 'RSS feed', site: 'Website',
};
export function sourceChipLabel(s: IntelSiteSource): string {
  return s.label || SOURCE_LABEL[s.kind] || domainOf(s.url);
}

/** Normalise what was typed into a URL the probe accepts ("padlet.com" → "https://padlet.com"). */
export function normaliseUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const withProto = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withProto);
    if (!u.hostname.includes('.')) return null;
    return u.toString().replace(/\/$/, '');
  } catch { return null; }
}

/** The site's own spelling of the legal name when it is the same company as the Companies House match. */
export function sameCompany(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\b(limited|ltd|plc|llp|inc)\b\.?/g, '').replace(/[^a-z0-9]/g, '');
  return norm(a) === norm(b);
}

/** Town from a registered office ("1 Long Lane, London, SE1 4PG" → "London"). */
function town(address?: string): string {
  if (!address) return '';
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2]! : parts[0] ?? '';
}

export function openAddCompetitor(opts: { config: MusterConfig | null; existing: IntelCompetitor[]; onAdded?: (c: IntelCompetitor) => void; url?: string }): void {
  closeFloating();
  const rivals = opts.existing.filter((c) => !c.isUs && c.id !== 'us');
  const colour = COMPANY_COLOURS[rivals.length % COMPANY_COLOURS.length]!;
  let url = '';
  let probed: IntelProbe | null = null;
  let probeState: 'idle' | 'probing' | 'found' | 'notfound' | 'error' = 'idle';
  let probeError = '';
  let company = 0; // index into probed.companies (-1 = none of them)
  let name = '';
  let sources: IntelSiteSource[] = [];
  let areas = new Set<IntelArea>(DEFAULT_AREAS);
  let watch: WatchCadence = 'weekly';
  let busy = false;
  let addingSource = false;

  const urlInput = h('input.ac-url-input', { placeholder: 'https://their-site.com', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const urlStatus = h('div.ac-url-status');
  const urlBox = h('label.ac-url', null, icon('globe', 14), urlInput, urlStatus);
  const identity = h('div.ac-sec.ac-identity');
  const sourcesSec = h('div.ac-sec');
  const areasSec = h('div.ac-sec');
  const watchRow = h('div.ac-watch');
  const footNote = h('div.flex1.ac-foot-note');
  const error = h('div.ac-err', { hidden: true });
  const startBtn = h('button.btn.ac-start', null, 'Add & start research') as HTMLButtonElement;
  const browse = createBrowseChoice({
    value: initialBrowseMode(opts.config),
    operaAllow: opts.config?.researchBrowser?.operaAllow ?? [],
    onChange: () => drawFoot(),
  });
  getBrowserStatus().then((s) => { browse.setStatus(s, opts.config?.researchBrowser?.operaAllow); drawFoot(); }, () => {});

  const showError = (msg: string) => { error.textContent = msg; error.hidden = !msg; };

  // ---------------------------------------------------------------- probe
  let probeSeq = 0;
  async function runProbe(): Promise<void> {
    const norm = normaliseUrl(urlInput.value);
    if (!norm) { probeState = urlInput.value.trim() ? 'error' : 'idle'; probeError = urlInput.value.trim() ? "That doesn't look like a website" : ''; draw(); return; }
    if (norm === url && probeState !== 'error') return;
    url = norm;
    const my = ++probeSeq;
    probeState = 'probing';
    draw();
    try {
      const p = await probeSite(norm);
      if (my !== probeSeq) return;
      probed = p;
      probeState = p.found ? 'found' : 'notfound';
      company = p.companies.length ? 0 : -1;
      name = p.name || domainOf(p.url || norm).split('.')[0]!.replace(/^./, (c) => c.toUpperCase());
      sources = p.sources.slice();
    } catch (e) {
      if (my !== probeSeq) return;
      probed = null;
      probeState = 'error';
      probeError = e instanceof ApiError && e.status === 404 ? 'This orchestrator cannot look sites up yet. Add it anyway; scout will find the sources.' : errText(e);
      name = domainOf(norm).split('.')[0]!.replace(/^./, (c) => c.toUpperCase());
      sources = [];
    }
    draw();
  }
  let typingTimer: ReturnType<typeof setTimeout> | undefined;
  urlInput.addEventListener('input', () => { clearTimeout(typingTimer); typingTimer = setTimeout(() => void runProbe(), 700); });
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(typingTimer); void runProbe(); } });
  urlInput.addEventListener('blur', () => { clearTimeout(typingTimer); void runProbe(); });

  // ---------------------------------------------------------------- sections
  function drawUrl(): void {
    urlBox.classList.toggle('focus', probeState === 'found' || probeState === 'probing');
    setChildren(urlStatus,
      probeState === 'probing' ? [h('span.ac-spin'), h('span.faint', null, 'Looking…')]
      : probeState === 'found' ? [h('span.ac-dot.ok'), h('span.ok', null, 'Found')]
      : probeState === 'notfound' ? [h('span.ac-dot.warn'), h('span.warn', null, 'Partly found')]
      : probeState === 'error' ? [h('span.ac-dot.bad'), h('span.bad', null, 'Not found')]
      : null);
  }

  function pickEntity(anchor: HTMLElement): void {
    const list = probed?.companies ?? [];
    const r = anchor.getBoundingClientRect();
    showMenu([
      ...list.map((c, i) => ({ label: `${c.name} · ${c.number} · ${c.status}`, current: i === company, onClick: () => { company = i; draw(); } })),
      ...(list.length ? ['sep' as const] : []),
      { label: 'None of these (no UK company)', current: company === -1, tone: 'muted' as const, onClick: () => { company = -1; draw(); } },
    ], r.left, r.bottom + 4);
  }

  function drawIdentity(): void {
    if (probeState === 'idle' || probeState === 'probing') { identity.hidden = true; return; }
    identity.hidden = false;
    const ch = probed && company >= 0 ? probed.companies[company] : undefined;
    const legal = probed?.legal[0];
    const nameInput = h('input.ac-name', { value: name, 'aria-label': 'Name', spellcheck: 'false' }) as HTMLInputElement;
    nameInput.addEventListener('input', () => { name = nameInput.value; });
    const other = h('button.ac-link', null, 'not them? pick another entity');
    other.onclick = (e: MouseEvent) => { e.stopPropagation(); pickEntity(other); };
    const fact = (label: string, value: string, mono = false) => h('div.ac-fact', null, h('div.ac-fact-l', null, label), h('div.ac-fact-v', { class: mono && 'mono' }, value));
    setChildren(identity, h('div.ac-card', null,
      h('div.ac-avatar', { style: { background: colour } }, (name || '?').trim().charAt(0).toLowerCase()),
      h('div.ac-card-body', null,
        h('div.ac-card-head', null, nameInput, probed?.tagline ? h('div.ac-tagline', null, probed.tagline) : null),
        h('div.ac-facts', null,
          fact('Legal entity', ch && legal && sameCompany(ch.name, legal.name) ? legal.name : ch?.name ?? legal?.name ?? 'Not found'),
          ch ? fact('Companies House', `${ch.number} · ${ch.status}`, true) : fact('Companies House', probed?.companies.length ? 'None picked' : 'No match'),
          ch?.incorporated ? fact('Incorporated', [fmtDate(ch.incorporated), town(ch.address)].filter(Boolean).join(' · ')) : null),
        h('div.ac-matched', null,
          probeState === 'error' ? probeError
            : legal ? `Matched from the ${legal.matchedFrom}` : probed?.notes[0] ?? 'No legal name on the site',
          probed?.companies.length ? [' · ', other] : null))));
  }

  function drawSources(): void {
    if (probeState === 'idle' || probeState === 'probing') { sourcesSec.hidden = true; return; }
    sourcesSec.hidden = false;
    const add = addingSource
      ? (() => {
          const input = h('input.ac-src-input', { placeholder: 'https://… then Enter' }) as HTMLInputElement;
          let done = false;
          const finish = (commit: boolean) => {
            if (done) return;
            done = true;
            const u = commit ? normaliseUrl(input.value) : null;
            if (u && !sources.some((s) => s.url === u)) sources.push({ kind: 'other', url: u, label: domainOf(u) });
            addingSource = false;
            drawSources();
          };
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
          });
          input.addEventListener('blur', () => finish(true));
          setTimeout(() => input.focus());
          return input;
        })()
      : null;
    setChildren(sourcesSec,
      h('div.ac-sec-head', null,
        h('div.section-label.flex1', null, `WHERE SCOUT WILL LOOK · ${sources.length} FOUND`),
        h('button.ac-link.blue', { onclick: () => { addingSource = true; drawSources(); } }, '+ Add source')),
      h('div.ac-src-list', null,
        sources.map((s) => h('span.ac-src', { title: s.url },
          h('span', null, sourceChipLabel(s)),
          s.note ? h('span.faint', null, s.note) : null,
          h('button.x', { title: 'Remove', onclick: () => { sources = sources.filter((x) => x !== s); drawSources(); } }, '×'))),
        add,
        !sources.length && !add ? h('span.faint.ac-none', null, 'No sources found on the site. scout searches for them.') : null));
  }

  function drawAreas(): void {
    const all = areas.size === INTEL_AREAS.length;
    setChildren(areasSec,
      h('div.ac-sec-head', null,
        h('div.section-label.flex1', null, `RESEARCH · ${areas.size} OF ${INTEL_AREAS.length}`),
        h('button.ac-link', { onclick: () => { areas = new Set(all ? [] : INTEL_AREAS); drawAreas(); drawWatch(); } }, all ? 'Clear' : 'Select all')),
      h('div.ac-areas', null, INTEL_AREAS.map((a) => {
        const on = areas.has(a);
        return h('button.ac-area', {
          class: on && 'on', role: 'checkbox', 'aria-checked': String(on),
          onclick: () => { if (on) areas.delete(a); else areas.add(a); drawAreas(); drawWatch(); },
        }, on ? icon('tick', 11, 3) : h('span.ac-box'), AREA_LABELS[a]);
      })));
  }

  function drawWatch(): void {
    setChildren(watchRow,
      h('div.section-label.ac-watch-l', null, 'KEEP WATCHING'),
      h('div.ac-seg', null, WATCH.map((w) => h('button', { class: w.value === watch && 'on', onclick: () => { watch = w.value; drawWatch(); } }, w.label))),
      h('div.flex1'),
      h('div.ac-est', null, jobEstimate(areas.size)));
  }

  function drawFoot(): void {
    setChildren(footNote, browseFootnote(browse.value()));
  }

  function draw(): void {
    drawUrl();
    drawIdentity();
    drawSources();
    drawAreas();
    drawWatch();
    drawFoot();
    startBtn.disabled = busy || probeState === 'idle' || probeState === 'probing' || !areas.size;
  }

  // ---------------------------------------------------------------- submit
  startBtn.onclick = async () => {
    if (busy) return;
    if (!url) { showError('Paste their website first.'); return; }
    if (!name.trim()) { showError('Give them a name.'); return; }
    if (!areas.size) { showError('Pick at least one area to research.'); return; }
    busy = true;
    draw();
    showError('');
    const ch = probed && company >= 0 ? probed.companies[company] : undefined;
    const legal = probed?.legal[0];
    try {
      const r = await addCompetitor({
        ...(probed?.suggestedId ? { id: probed.suggestedId } : {}),
        name: name.trim(),
        url: probed?.url || url,
        ...(probed?.tagline ? { tagline: probed.tagline } : {}),
        identity: {
          ...(ch && legal && sameCompany(ch.name, legal.name) ? { legalName: legal.name } : ch?.name ?? legal?.name ? { legalName: ch?.name ?? legal?.name } : {}),
          ...(legal ? { matchedFrom: legal.matchedFrom } : {}),
          ...(ch ? { companiesHouse: { number: ch.number, status: ch.status, ...(ch.incorporated ? { incorporated: ch.incorporated } : {}), ...(ch.address ? { registeredOffice: ch.address } : {}), url: ch.url } } : {}),
        },
        sources,
        areas: INTEL_AREAS.filter((a) => areas.has(a)),
        watch,
        browse: browse.value(),
        start: true,
      });
      close();
      toast(r.job ? (r.job.status === 'running' ? `scout started researching ${r.competitor.name}` : `${r.competitor.name} added. Research ${r.job.id} is queued`) : `${r.competitor.name} added`);
      opts.onAdded?.(r.competitor);
    } catch (e) {
      showError(e instanceof ApiError && e.status === 409 ? `${e.message}. It's already tracked.` : errText(e));
    } finally {
      busy = false;
      draw();
    }
  };

  // ---------------------------------------------------------------- shell
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('hashchange', close);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const modal = h('div.modal.ac-modal', { role: 'dialog', 'aria-label': 'Add a competitor' },
    h('div.ac-head', null,
      h('div.ac-icon', null, icon('radar', 18)),
      h('div.flex1.ac-head-text', null,
        h('div.ac-title', null, 'Add a competitor'),
        h('div.ac-sub', null, 'Paste their website. scout works out who they are and where to look, then you pick what to research.')),
      h('button.icon-btn', { title: 'Close', onclick: close }, icon('x', 14))),
    h('div.ac-body', null,
      h('div.ac-sec.ac-url-sec', null, h('div.section-label', null, 'WEBSITE'), urlBox),
      identity,
      sourcesSec,
      areasSec,
      h('div.ac-sec', null, browse.el)),
    watchRow,
    error,
    h('div.ac-foot', null, icon('lock', 13), footNote, h('button.btn.ac-cancel', { onclick: close }, 'Cancel'), startBtn));
  const back = h('div.modal-back', { onmousedown: (e: MouseEvent) => { if (e.target === back) close(); } }, modal);
  document.body.appendChild(back);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('hashchange', close);
  draw();
  if (opts.url) { urlInput.value = opts.url; void runProbe(); } else setTimeout(() => urlInput.focus());
}
