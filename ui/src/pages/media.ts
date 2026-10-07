// Media (docs/MEDIA.md, Vellum "Muster" page "Media"): herald writes social posts, articles, website text, video
// scripts and demo GIFs from what really shipped. #/media is the library (herald's suggestions, the pieces table, "What herald
// writes from"); #/media/MP3 opens one piece in its editor. Everything is plain text. Social posts can go out through your own Chrome (herald fills them in, you press Post).
// GET /api/media on show and after each `media` event (debounced). Your text edits save on their own (debounced
// POST …/edit); while herald drafts, the editor is read-only.
import '../media.css';
import type {
  MediaAbout, MediaClaim, MediaConversation, MediaDesign, MediaDesignStyle, MediaGif, MediaGifFrame, MediaImage, MediaKind, MediaPiece, MediaPlatform, MediaPost,
  MediaPublishJob, MediaPurpose, MediaShot, MediaStore, MediaSuggestion, MusterState,
} from '../../../src/types';
import { closeFloating, confirmDialog, h, icon, setChildren, showMenu, showModal, showPopover, toast, type Child } from '../dom';
import { events, type Snapshot } from '../events';
import type { Page } from '../page';
import { api } from '../api';
import { errToast, run } from '../actions';
import { ago } from '../util';
import * as mapi from '../mediaapi';
import {
  DEFAULT_PLATFORMS, EMPTY_MEDIA, KINDS, KIND_HINT, KIND_LABEL, KIND_TAB, attachableGifs, clampSeconds, formatBytes, formatSeconds, frameStart,
  gifFile, gifFits, moveFrame, recordingLine, totalSeconds, PLATFORMS, PLATFORM_LABEL, STATUS, charCount, evidenceImages, filterPieces,
  isBusy, isUnsourced, kindCounts, openSuggestions, pieceFor, pieceMeta, postText, reviewCount, scriptText, sectionsText, shotCounts,
  shotListCsv, sortPieces, sourceCounts, sourceTone, suggestionTag, unsourcedCount, versionLetter, type KindFilter,
  DESIGN_STYLES, PLATFORM_SHORT, cleanTag, conversationsFor, conversationsLine, designSizesLine, fullPostText, hashtagHint, isLiveJob, jobLine, jobsFor,
  postRows, publishChip, replyBlock, replyPolicy, researchLine, showPublishRail, sortedDesigns, themeTone,
} from '../mediamodel';

type SocialView = 'post' | 'research' | 'conversations';

const go = (hash: string) => { location.hash = hash; };
const svg = (paths: string, size = 14) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24'); el.setAttribute('fill', 'none'); el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '2'); el.setAttribute('stroke-linecap', 'round'); el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('width', String(size)); el.setAttribute('height', String(size));
  el.innerHTML = paths;
  return el;
};
const KIND_ICON: Record<MediaKind, string> = {
  social: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  article: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  website: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3z"/>',
  gif: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 4v16M17 4v16M2 9h5M2 15h5M17 9h5M17 15h5"/>',
};
const LOCK = '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>';

async function copy(text: string, what = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    toast('Could not copy: the clipboard is blocked', 'error');
  }
}

// ---------------------------------------------------------------- copy and save images
// The desktop app has no right-click menu, so images get their own Copy and Save buttons. In the app they go through
// its preload bridge (Electron clipboard; a Save dialog that opens on the Desktop); in a browser, the web APIs.

interface MediaBridge { copyImage?: (bytes: Uint8Array) => Promise<boolean>; saveFile?: (name: string, bytes: Uint8Array) => Promise<string | null> }
const bridge = () => (window as unknown as { musterApp?: MediaBridge }).musterApp;

/** Clipboards take PNG: anything else (JPEG, WebP) is redrawn as one. */
async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('it could not be converted'))), 'image/png'));
}

/** Copy image: puts a still image on the clipboard, ready to paste into a post. */
async function copyImage(url: string): Promise<void> {
  try {
    const png = await toPng(await (await fetch(url)).blob());
    const b = bridge();
    if (b?.copyImage) {
      if (!(await b.copyImage(new Uint8Array(await png.arrayBuffer())))) throw new Error('it could not be read');
    } else await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    toast('Image copied. Paste it into your post.');
  } catch (e) {
    toast(`Could not copy the image: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
}

/** Save: a Save dialog on the Desktop in the app, a normal download in a browser. */
async function saveImage(url: string, name: string): Promise<void> {
  try {
    const b = bridge();
    if (b?.saveFile) {
      const where = await b.saveFile(name, new Uint8Array(await (await fetch(url)).arrayBuffer()));
      if (where) toast(`Saved to ${where}`);
      return;
    }
    const a = h('a', { href: url, download: name }) as HTMLAnchorElement;
    document.body.append(a);
    a.click();
    a.remove();
  } catch (e) {
    errToast(e);
  }
}

/** Copy and Save buttons for a thumbnail's caption row (GIFs get Save only: a clipboard can't hold an animation). */
function imageButtons(url: Promise<string>, name: string, still: boolean): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (still) out.push(h('button.md-x', { title: 'Copy image', onclick: () => void url.then(copyImage, errToast) }, icon('copy', 12, 2.2)));
  out.push(h('button.md-x', { title: 'Save…', onclick: () => void url.then((u) => saveImage(u, name), errToast) }, icon('down', 12, 2.4)));
  return out;
}

// ---------------------------------------------------------------- evidence images (blob URLs, cached)

const imgCache = new Map<string, Promise<string>>();
function evidenceUrl(taskId: string, evidenceId: string, name: string): Promise<string> {
  const key = `${taskId}/${evidenceId}/${name}`;
  let p = imgCache.get(key);
  if (!p) {
    p = api.evidenceFile(taskId, evidenceId, name).then((b) => URL.createObjectURL(b));
    p.catch(() => imgCache.delete(key));
    imgCache.set(key, p);
  }
  return p;
}
function evidenceImg(taskId: string, evidenceId: string, name: string, cls = 'md-thumb'): HTMLElement {
  const box = h(`div.${cls}`, { title: `${taskId}/${evidenceId} · ${name}` });
  void evidenceUrl(taskId, evidenceId, name).then((url) => {
    const img = h('img', { src: url, alt: name }) as HTMLImageElement;
    img.onclick = () => showModal({
      title: `${taskId} · ${name}`,
      body: h('img.md-full', { src: url, alt: name }),
      cancelLabel: 'Close',
      actions: [{ label: 'Copy image', onClick: () => copyImage(url) }, { label: 'Save…', kind: 'primary', onClick: () => saveImage(url, `${taskId}-${name}`) }],
    });
    box.replaceChildren(img);
  }, () => box.classList.add('missing'));
  return box;
}

// ---------------------------------------------------------------- demo GIF files (blob URLs, cached per render)

const gifCache = new Map<string, Promise<string>>();
function gifUrl(p: MediaPiece, source: MediaGif['source']): Promise<string> | null {
  const g = p.gif;
  const f = g && (source === 'recording' ? g.recording?.file : g.slideshow);
  if (!f) return null;
  const key = `${p.id}:${source}:${f.renderedAt}`;
  let u = gifCache.get(key);
  if (!u) {
    u = mapi.gifBlob(p.id, source).then((b) => URL.createObjectURL(b));
    u.catch(() => gifCache.delete(key));
    gifCache.set(key, u);
  }
  return u;
}
/** A GIF piece's current file as an <img> (click opens it full size); an empty box until it is rendered. */
function gifImg(p: MediaPiece, cls = 'md-thumb'): HTMLElement {
  const box = h(`div.${cls}`, { title: `${p.id} · ${p.title}` });
  const u = p.gif ? gifUrl(p, p.gif.source) : null;
  if (!u) { box.classList.add('missing'); return box; }
  const alt = p.gif?.altText || p.title;
  void u.then((url) => {
    const img = h('img', { src: url, alt }) as HTMLImageElement;
    img.onclick = () => showModal({
      title: `${p.id} · ${p.title}`,
      body: h('img.md-full', { src: url, alt }),
      cancelLabel: 'Close',
      actions: [{ label: 'Save GIF…', kind: 'primary', onClick: () => saveImage(url, `${p.id}-${p.gif!.source}.gif`) }],
    });
    box.replaceChildren(img);
  }, () => box.classList.add('missing'));
  return box;
}
/** Save GIF: download the current file as MP5-slideshow.gif. */
async function saveGif(p: MediaPiece): Promise<void> {
  const u = p.gif ? gifUrl(p, p.gif.source) : null;
  if (!u) { toast('The GIF is not ready yet', 'error'); return; }
  try {
    await saveImage(await u, `${p.id}-${p.gif!.source}.gif`);
  } catch (e) {
    errToast(e);
  }
}

// ---------------------------------------------------------------- About picker (stages, goals, merged tasks, last 7 days)

function aboutLabel(state: MusterState | undefined, a: Pick<MediaAbout, 'kind' | 'ref'>): string {
  const rm = state?.roadmap;
  if (a.kind === 'stage') { const s = rm?.stages.find((x) => x.id === a.ref); return s ? `Stage ${s.id} · ${s.title}` : `Stage ${a.ref}`; }
  if (a.kind === 'goal') { const g = rm?.goals.find((x) => x.id === a.ref); return g ? `${g.id} ${g.title}` : a.ref; }
  if (a.kind === 'task') { const t = state?.tasks.find((x) => x.id === a.ref); return t ? `${t.id} ${t.title}` : a.ref; }
  if (a.kind === 'range') { const [from, to] = a.ref.split('..'); return `${from} to ${to}`; }
  if (a.kind === 'product') return 'The whole product';
  return a.ref;
}

function lastDays(n: number): string {
  const to = new Date();
  const from = new Date(to.getTime() - (n - 1) * 86_400_000);
  const d = (x: Date) => x.toISOString().slice(0, 10);
  return `${d(from)}..${d(to)}`;
}

function openAboutPicker(anchor: HTMLElement, state: MusterState | undefined, onPick: (a: Pick<MediaAbout, 'kind' | 'ref'>) => void): void {
  const rm = state?.roadmap;
  const items: ({ label: string; onClick: () => void; tone?: 'muted' } | 'sep')[] = [];
  items.push({ label: 'The whole product', onClick: () => onPick({ kind: 'product', ref: 'product' }) });
  items.push({ label: 'Last 7 days of merged work', onClick: () => onPick({ kind: 'range', ref: lastDays(7) }) });
  const stages = (rm?.stages ?? []).filter((s) => s.status !== 'planned');
  if (stages.length) items.push('sep');
  for (const s of stages) items.push({ label: `Stage ${s.id} · ${s.title}${s.status === 'done' ? ' (done)' : ''}`, onClick: () => onPick({ kind: 'stage', ref: s.id }) });
  const goals = (rm?.goals ?? []).filter((g) => g.status === 'done').slice(-8);
  if (goals.length) items.push('sep');
  for (const g of goals) items.push({ label: `${g.id} ${g.title}`, onClick: () => onPick({ kind: 'goal', ref: g.id }) });
  const tasks = (state?.tasks ?? []).filter((t) => t.status === 'merged').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10);
  if (tasks.length) items.push('sep');
  for (const t of tasks) items.push({ label: `${t.id} ${t.title}`, onClick: () => onPick({ kind: 'task', ref: t.id }) });
  const r = anchor.getBoundingClientRect();
  showMenu(items, r.left, r.bottom + 6);
}

// ---------------------------------------------------------------- New piece dialog

interface NewDraft { kind: MediaKind; about: Pick<MediaAbout, 'kind' | 'ref'>[]; note: string; platforms: MediaPlatform[]; purpose: MediaPurpose; link: string; suggestionId?: string }

const PURPOSES: { id: MediaPurpose; label: string }[] = [
  { id: 'progress', label: 'Progress update' },
  { id: 'announce', label: "Announce it's coming" },
  { id: 'testers', label: 'Find testers' },
  { id: 'launch', label: "It's out now" },
];

export function openNewPiece(prefill?: MediaSuggestion): void {
  const state = events.snapshot?.state;
  const d: NewDraft = {
    kind: prefill?.plan[0]?.kind ?? 'social',
    about: prefill ? prefill.about.map((a) => ({ kind: a.kind, ref: a.ref })) : [],
    note: '',
    platforms: prefill?.plan.find((p) => p.platforms)?.platforms ?? [...DEFAULT_PLATFORMS],
    purpose: 'progress',
    link: '',
    suggestionId: prefill?.id,
  };
  const body = h('div.md-new');
  const err = h('div.md-err', { hidden: true });

  const draw = () => {
    const kinds = h('div.md-kinds', null, KINDS.map((k) => h('button.md-kind', {
      class: d.kind === k && 'on',
      onclick: () => { d.kind = k; draw(); },
    }, h('div.md-kind-t', null, KIND_LABEL[k]), h('div.md-kind-s', null, KIND_HINT[k]))));
    const addBtn = h('button.md-about-add', null, '+ the whole product, a stage, task or date range');
    addBtn.onclick = () => openAboutPicker(addBtn, state, (a) => {
      if (!d.about.some((x) => x.kind === a.kind && x.ref === a.ref)) d.about.push(a);
      if (a.kind === 'product' && d.purpose === 'progress') d.purpose = 'announce'; // a whole-product piece is rarely a progress update
      draw();
    });
    const about = h('div.md-about', null,
      d.about.map((a, i) => h('span.md-about-chip', null, aboutLabel(state, a), h('button.md-x', { title: 'Remove', onclick: () => { d.about.splice(i, 1); draw(); } }, icon('x', 11, 2.5)))),
      addBtn);
    const note = h('textarea.field.md-note', { rows: 3, placeholder: 'e.g. Aim it at primary teachers. Mention it\'s free for one class.' }) as HTMLTextAreaElement;
    note.value = d.note;
    note.oninput = () => { d.note = note.value; };
    const plats = d.kind === 'social'
      ? h('div.md-field', null, h('div.md-label', null, 'PLATFORMS'),
          h('div.md-plats', null, PLATFORMS.map((p) => h('button.chip', {
            class: d.platforms.includes(p) && 'active',
            onclick: () => { d.platforms = d.platforms.includes(p) ? d.platforms.filter((x) => x !== p) : PLATFORMS.filter((x) => x === p || d.platforms.includes(x)); draw(); },
          }, PLATFORM_LABEL[p]))),
          h('div.md-hint', null, '3 versions for each platform, in your house style.'))
      : null;
    const purpose = h('div.md-field', null, h('div.md-label', null, "WHAT IT'S FOR"),
      h('div.md-plats', null, PURPOSES.map((x) => h('button.chip', { class: d.purpose === x.id && 'active', onclick: () => { d.purpose = x.id; draw(); } }, x.label))));
    let linkField: HTMLElement | null = null;
    if (d.purpose !== 'progress') {
      const input = h('input.field.md-link', { type: 'url', placeholder: d.purpose === 'testers' ? 'Sign-up link, e.g. https://syncprompt.app/beta (optional)' : 'Link, e.g. https://syncprompt.app (optional)' }) as HTMLInputElement;
      input.value = d.link;
      input.oninput = () => { d.link = input.value; };
      linkField = h('div.md-field', null, h('div.md-label', null, 'LINK (OPTIONAL)'), input, h('div.md-hint', null, 'herald puts it in the text exactly as you type it.'));
    }
    setChildren(body,
      h('div.md-field', null, h('div.md-label', null, 'WHAT'), kinds),
      h('div.md-field', null, h('div.md-label', null, 'ABOUT'), about),
      purpose,
      linkField,
      h('div.md-field', null, h('div.md-label', null, 'ANYTHING HERALD SHOULD KNOW (OPTIONAL)'), note),
      plats,
      err);
  };
  draw();

  showModal({
    title: h('span.md-modal-title', null, h('span.md-rose-dot'), 'New piece'),
    body,
    actions: [{
      label: 'Ask herald to write it',
      kind: 'primary',
      onClick: async (close) => {
        err.hidden = true;
        if (!d.about.length) { err.textContent = 'Pick what it is about: the whole product, a stage, a task or a date range.'; err.hidden = false; return; }
        if (d.kind === 'social' && !d.platforms.length) { err.textContent = 'Pick at least one platform.'; err.hidden = false; return; }
        try {
          const p = await mapi.createPiece({
            kind: d.kind, about: d.about, note: d.note.trim() || undefined,
            purpose: d.purpose === 'progress' ? undefined : d.purpose, link: d.purpose === 'progress' ? undefined : d.link.trim() || undefined,
            platforms: d.kind === 'social' ? d.platforms : undefined, suggestionId: d.suggestionId,
          });
          close();
          toast(`herald is on it: ${p.id}`);
          void refresh();
        } catch (e) {
          err.textContent = e instanceof Error ? e.message : String(e);
          err.hidden = false;
        }
      },
    }],
  });
}

function openHouseStyle(current: string): void {
  const ta = h('textarea.field.md-style', { rows: 9 }) as HTMLTextAreaElement;
  ta.value = current;
  showModal({
    title: 'House style',
    body: [h('p', null, 'herald follows this in everything it writes. Plain words work best.'), ta],
    actions: [{ label: 'Save', kind: 'primary', onClick: async (close) => { if (await run(mapi.saveStyle(ta.value.trim()), 'House style saved')) { close(); void refresh(); } } }],
  });
}

// ---------------------------------------------------------------- page

let store: MediaStore = EMPTY_MEDIA;
let loaded = false;
let refreshAll: () => Promise<void> = async () => {};
const refresh = () => refreshAll();

export function createMedia(): Page {
  const el = h('div.page.md-page');
  let filter: KindFilter = 'all';
  let openId: string | null = null;
  let visible = false;
  let snap: Snapshot | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let loadError = '';

  // editor state for the open piece
  let draft: MediaPiece | null = null; // your copy while you type
  let dirty = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let platform: MediaPlatform | null = null;
  let showAllShots = false;
  let frameSel: number | null = null; // the demo GIF frame you are editing
  let view: SocialView = 'post'; // a social piece's tab
  let noVellum = false; // the design route said Vellum isn't set up: hide "+ Make an image"

  refreshAll = async () => {
    try {
      store = await mapi.getMedia();
      loaded = true;
      loadError = '';
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
    render();
  };
  const soon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; if (visible) void refreshAll(); }, 250);
  };
  events.onMedia(() => soon());

  function render(): void {
    if (!visible) return;
    if (openId) return renderEditor();
    draft = null;
    dirty = false;
    renderLibrary();
  }

  // ---------------------------------------------------------------- library

  function renderLibrary(): void {
    const pieces = sortPieces(store.pieces);
    const counts = kindCounts(store.pieces);
    const review = reviewCount(store.pieces);
    const sub = h('div.md-sub', null,
      h('div.md-sub-t', null,
        h('div.md-title', null, 'Media'),
        h('div.md-meta', null, `${store.pieces.length} piece${store.pieces.length === 1 ? '' : 's'} · ${review} waiting on your review · written by herald from what actually shipped`)),
      h('button.btn', { onclick: () => openHouseStyle(store.houseStyle) }, 'House style'),
      h('button.btn.primary', { onclick: () => openNewPiece() }, icon('plus', 14, 2.4), 'New piece'));
    const tabs = h('div.md-tabs', null,
      (['all', ...KINDS] as KindFilter[]).map((k) => h('button.md-tab', { class: filter === k && 'on', onclick: () => { filter = k; renderLibrary(); } },
        `${k === 'all' ? 'All' : KIND_TAB[k]} ${counts[k]}`)),
      h('div.flex1'),
      (['drafting', 'review', 'approved', 'used'] as const).map((s) => h('div.md-legend', { class: `t-${STATUS[s].tone}` }, h('span.md-dot'), s === 'drafting' ? 'Drafting' : STATUS[s].label)));

    const sugg = openSuggestions(store);
    const suggestions = sugg.length
      ? h('div.md-sugg', null,
          h('div.md-sec-head', null,
            h('div.md-label', null, 'HERALD SUGGESTS'),
            h('div.md-sec-sub', null, sinceLine()),
            h('div.flex1'),
            h('button.md-link', { onclick: () => void run(mapi.dismissAllSuggestions()).then(() => refresh()) }, 'Dismiss all')),
          h('div.md-cards', null, sugg.slice(0, 3).map((s, i) => suggestionCard(s, i === 0 && s.trigger === 'stage'))))
      : null;

    const list = filterPieces(pieces, filter);
    const table = h('div.md-table', null,
      h('div.md-row.md-head', null, h('div.md-c-ic'), h('div.md-c-main', null, 'PIECE'), h('div.md-c-for', null, 'FOR'), h('div.md-c-st', null, 'STATUS'), h('div.md-c-up', null, 'UPDATED')),
      list.length
        ? list.map(pieceRow)
        : h('div.md-empty', null,
            store.pieces.length ? `No ${KIND_TAB[filter as MediaKind]?.toLowerCase() ?? 'pieces'} yet.` : 'Nothing written yet. Ask herald for a post, an article, website text, a video script or a demo GIF.',
            store.pieces.length ? null : h('button.btn.primary.sm', { onclick: () => openNewPiece() }, icon('plus', 12, 2.4), 'New piece')));

    setChildren(el,
      sub, tabs,
      h('div.md-scroll', null,
        loadError ? h('div.md-banner', null, `Could not load Media: ${loadError}`) : null,
        !loaded && !loadError ? h('div.md-empty', null, 'Loading…') : null,
        suggestions,
        h('div.md-lower', null, table, sourcesRail())));
  }

  function sinceLine(): string {
    const used = store.pieces.filter((p) => p.usedAt).map((p) => p.usedAt!).sort().pop();
    return used ? `from things that landed since your last post · ${new Date(used).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : 'from things that landed recently';
  }

  function suggestionCard(s: MediaSuggestion, hot: boolean): HTMLElement {
    return h('div.md-card', { class: hot && 'hot' },
      h('div.md-card-top', null, h('div.md-tag', null, suggestionTag(s)), h('div.flex1'), h('div.md-ago', null, ago(s.createdAt))),
      h('div.md-card-t', null, s.title),
      h('div.md-card-s', null, s.summary),
      h('div.md-card-acts', null,
        h('button.btn.sm.primary', { onclick: () => void run(mapi.acceptSuggestion(s.id), 'herald is on it').then(() => refresh()) }, 'Write it'),
        h('button.btn.sm', { onclick: () => openNewPiece(s) }, 'Change the plan'),
        h('button.md-link', { onclick: () => void run(mapi.dismissSuggestion(s.id)).then(() => refresh()) }, 'Dismiss')));
  }

  function statusEl(p: MediaPiece): HTMLElement {
    const st = STATUS[p.status];
    return h('div.md-status', { class: `t-${st.tone}` }, h('span.md-dot'), st.label);
  }

  function pieceRow(p: MediaPiece): HTMLElement {
    return h('a.md-row', { href: `#/media/${p.id}`, class: p.status === 'used' && 'used' },
      h('div.md-c-ic', null, h('span.md-ic', null, svg(KIND_ICON[p.kind]))),
      h('div.md-c-main', null, h('div.md-row-t', null, p.title), h('div.md-row-s', null, pieceMeta(p))),
      h('div.md-c-for', null, pieceFor(p)),
      h('div.md-c-st', null, statusEl(p)),
      h('div.md-c-up', null, ago(p.updatedAt)));
  }

  function sourcesRail(): HTMLElement {
    const state = snap?.state;
    const c = state ? sourceCounts(state, store.pieces) : null;
    const row = (label: string, value: string) => h('div.md-src', null, h('div.flex1', null, label), h('div.md-src-v', null, value));
    return h('div.md-rail', null,
      h('div.md-rail-head', null,
        h('div.md-rail-t', null, 'What herald writes from'),
        h('div.md-rail-s', null, 'Only things that really happened in this project. Every claim in a draft links back to one of these.')),
      h('div.md-srcs', null,
        row('Roadmap stages done', c?.stages.length ? c.stages.join(' ') : 'none yet'),
        row(c?.since ? `Merged tasks since ${new Date(c.since).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : 'Merged tasks so far', String(c?.merged ?? 0)),
        row('Before/after screenshots', String(c?.screenshots ?? 0)),
        row('Intel edges vs competitors', String(events.intel?.edges ?? 0)),
        row('Crew chat messages', String(c?.chat ?? 0))),
      h('div.md-style-box', null,
        h('div.md-label', null, 'HOUSE STYLE'),
        h('div.md-style-t', null, store.houseStyle || 'Not set yet.'),
        h('button.md-link', { onclick: () => openHouseStyle(store.houseStyle) }, 'Edit')),
      h('div.md-never', null, svg(LOCK), h('div', null, 'Muster never posts for you. Approved pieces are copied as text, and you publish them.')));
  }

  // ---------------------------------------------------------------- editor

  function current(): MediaPiece | undefined {
    return store.pieces.find((p) => p.id === openId);
  }

  /** Your working copy: the server's piece unless you have unsaved edits. */
  function working(server: MediaPiece): MediaPiece {
    if (!draft || draft.id !== server.id || (!dirty && draft.updatedAt !== server.updatedAt) || isBusy(server)) {
      draft = structuredClone(server);
      dirty = false;
    } else {
      draft.status = server.status; // status, claims and progress always follow the server
      draft.claims = server.claims;
      draft.progress = server.progress;
      draft.requests = server.requests;
      if (draft.gif && server.gif) { draft.gif.slideshow = server.gif.slideshow; draft.gif.renderError = server.gif.renderError; draft.gif.recording = server.gif.recording; }
    }
    return draft;
  }

  function scheduleSave(p: MediaPiece): void {
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(p), 800);
  }
  async function save(p: MediaPiece): Promise<void> {
    saveTimer = null;
    try {
      const body = p.kind === 'social' ? { title: p.title, posts: p.posts, images: p.images, gifIds: p.gifIds ?? [] }
        : p.kind === 'gif' ? { title: p.title, gif: p.gif ? { source: p.gif.source, frames: p.gif.frames, steps: p.gif.steps, altText: p.gif.altText } : undefined }
        : p.kind === 'video' ? { title: p.title, hooks: p.hooks, hookChosen: p.hookChosen, shots: p.shots }
        : { title: p.title, sections: p.sections, target: p.kind === 'website' ? p.target : undefined };
      const saved = await mapi.editPiece(p.id, body);
      dirty = false;
      if (draft && draft.id === saved.id) {
        draft.updatedAt = saved.updatedAt; draft.editedAt = saved.editedAt; draft.status = saved.status;
        if (draft.gif && saved.gif) { draft.gif.slideshow = saved.gif.slideshow; draft.gif.renderError = saved.gif.renderError; draft.gif.recording = saved.gif.recording; }
      }
      const i = store.pieces.findIndex((x) => x.id === saved.id);
      if (i >= 0) store.pieces[i] = saved;
    } catch (e) {
      errToast(e);
    }
  }
  const flush = async () => { if (saveTimer && draft) { clearTimeout(saveTimer); await save(draft); } };

  function renderEditor(): void {
    const server = current();
    if (!server) {
      setChildren(el, h('div.md-ebar', null, backLink()), h('div.md-empty', null, loaded ? `No piece ${openId}. It may have been deleted.` : 'Loading…'));
      return;
    }
    // Leave the DOM alone while you type: the next refresh after the save brings it up to date.
    const active = document.activeElement;
    if (dirty && active && el.contains(active) && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) return;
    const p = working(server);
    const ro = isBusy(p);
    const bodyEl = p.kind === 'social' ? socialBody(p, ro) : p.kind === 'video' ? videoBody(p, ro) : p.kind === 'gif' ? gifBody(p, ro) : sectionsBody(p, ro);
    setChildren(el, editorBar(p), h('div.md-scroll', null, bodyEl));
  }

  function backLink(): HTMLElement {
    return h('a.md-back', { href: '#/media', onclick: () => void flush() }, icon('back', 14, 2), 'Media');
  }

  function editorBar(p: MediaPiece): HTMLElement {
    const st = STATUS[p.status];
    const ro = isBusy(p);
    const title = h('input.md-etitle', { value: p.title, disabled: ro, title: ro ? 'herald is writing' : 'Edit the title' }) as HTMLInputElement;
    title.oninput = () => { p.title = title.value; scheduleSave(p); };
    const metaBits = p.kind === 'gif' ? gifMeta(p) : [KIND_LABEL[p.kind].toLowerCase(), pieceFor(p) !== 'Website' ? pieceFor(p) : '', p.about.map((a) => a.label || a.ref).join(', '), p.purpose ? PURPOSES.find((x) => x.id === p.purpose)!.label.toLowerCase() : '', `herald · ${ago(p.updatedAt)}`].filter(Boolean);
    const target = p.kind === 'website'
      ? (() => {
          const t = h('input.md-target', { value: p.target ?? '', placeholder: '/features/…', disabled: ro, title: 'Where it goes on your site' }) as HTMLInputElement;
          t.oninput = () => { p.target = t.value; scheduleSave(p); };
          return t;
        })()
      : null;
    const jobs = p.kind === 'social' ? jobsFor(store, p.id) : [];
    const posting = jobs.some((j) => j.kind === 'post' && isLiveJob(j));
    const chipText = ro ? `${p.status === 'queued' ? 'Queued' : 'Drafting'}${p.progress ? ` · ${p.progress}` : ''}` : publishChip(jobs) ?? st.label;
    const chipTone = posting ? 'media' : st.tone;
    const unsourced = unsourcedCount(p);
    const noFile = p.kind === 'gif' && !(p.gif && gifFile(p.gif));
    const copyBtns: Child = p.kind === 'gif'
      ? [h('button.btn', { disabled: noFile, onclick: () => void saveGif(p) }, 'Save GIF'),
         h('button.btn', { disabled: !p.gif?.altText, onclick: () => void copy(p.gif?.altText ?? '', 'Alt text copied') }, 'Copy alt text')]
      : p.kind === 'video'
      ? [h('button.btn', { onclick: () => void copy(scriptText(p), 'Script copied') }, 'Copy script'),
         h('button.btn', { onclick: () => void copy(shotListCsv(p.shots ?? []), 'Shot list copied as CSV') }, 'Copy shot list')]
      : h('button.btn', { disabled: ro, onclick: () => void copy(p.kind === 'social' ? postText(p, platform ?? p.posts?.[0]?.platform ?? 'x') : sectionsText(p), 'Text copied') }, 'Copy text');
    let main: Child = null;
    if (p.status === 'review' || ro) {
      main = h('button.btn.primary', {
        disabled: ro || unsourced > 0 || noFile,
        title: ro ? 'herald is still writing' : unsourced ? `Confirm or cut ${unsourced} unsourced claim${unsourced === 1 ? '' : 's'} first` : noFile ? 'Wait for the GIF to render' : 'Approve it',
        onclick: () => void flush().then(() => run(mapi.approvePiece(p.id), p.kind === 'social' ? 'Approved' : 'Approved. Copy it and mark it used once it is posted')).then(async (ok) => {
          await refresh();
          const now = current();
          if (ok && now?.kind === 'social') openPostDialog(now, true);
        }),
      }, 'Approve');
    } else if (p.kind === 'social' && (p.status === 'approved' || p.status === 'used')) {
      main = [
        p.status === 'approved' ? h('button.btn', { onclick: () => void run(mapi.usedPiece(p.id), 'Marked used').then(() => refresh()) }, 'Mark used') : null,
        posting
          ? h('button.btn.primary', { onclick: () => void confirmDialog('Stop posting?', 'herald cancels the posts that are not out yet and discards their drafts in Chrome. Posts already out stay up.', 'Stop posting', 'danger').then((ok) => {
              if (ok) void run(mapi.stopPublish(p.id), 'Stopped').then(() => refresh());
            }) }, 'Stop posting')
          : h('button.btn.primary', { onclick: () => openPostDialog(p, false) }, 'Post it for me'),
      ];
    } else if (p.status === 'approved') {
      main = h('button.btn.primary', { onclick: () => void run(mapi.usedPiece(p.id), 'Marked used').then(() => refresh()) }, 'Mark used');
    } else if (p.status === 'failed') {
      main = h('button.btn.primary', { onclick: () => void run(mapi.retryPiece(p.id), 'herald will try again').then(() => refresh()) }, 'Retry');
    }
    const more = h('button.icon-btn.md-more', { title: 'More' }, icon('more', 16));
    more.onclick = () => {
      const r = more.getBoundingClientRect();
      showMenu([{ label: 'Delete this piece', tone: 'danger', onClick: () => void confirmDialog(`Delete ${p.id}?`, `"${p.title}" goes for good.`, 'Delete', 'danger').then((ok) => {
        if (ok) void run(mapi.deletePiece(p.id), 'Deleted').then(() => { go('#/media'); void refresh(); });
      }) }], r.right, r.bottom + 6, 'right');
    };
    return h('div.md-ebar', null,
      backLink(),
      h('div.md-vsep'),
      h('div.md-etitle-wrap', null, title, h('div.md-meta', null, metaBits.join(' · '), target ? ' · ' : null, target)),
      h('div.md-chip', { class: `t-${chipTone}` }, h('span.md-dot', { class: (ro || posting) && 'pulse' }), chipText),
      copyBtns, main, more);
  }

  /** "demo GIF · slideshow from 4 screenshots · 800×500 · 9.5 s · 1.8 MB · from T38, T43" */
  function gifMeta(p: MediaPiece): string[] {
    const g = p.gif;
    const f = g && gifFile(g);
    const src = !g ? '' : g.source === 'recording' ? 'real recording' : `slideshow from ${g.frames.length} screenshot${g.frames.length === 1 ? '' : 's'}`;
    return ['demo GIF', src, f ? `${f.width}×${f.height}` : '', f ? formatSeconds(f.seconds) : '', f ? formatBytes(f.bytes) : '', p.about.length ? `from ${p.about.map((a) => a.ref).join(', ')}` : ''].filter(Boolean);
  }

  // ---- shared: Ask herald, claims rail ----

  function askBox(p: MediaPiece, chips: string[]): HTMLElement {
    const input = h('input.md-ask-in', { placeholder: 'Ask herald to change it, e.g. "end with a question for teachers"' }) as HTMLInputElement;
    const send = async (text: string) => {
      if (!text.trim()) return;
      await flush();
      if (await run(mapi.askPiece(p.id, text.trim()), 'Sent to herald')) { input.value = ''; void refresh(); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void send(input.value); } });
    const open = p.requests.filter((r) => !r.doneAt);
    return h('div.md-ask', null,
      h('div.md-ask-row', null, h('span.md-rose-dot'), input, h('span.md-kbd', null, 'Enter')),
      h('div.md-ask-chips', null, chips.map((c) => h('button.md-pill', { onclick: () => void send(c) }, c))),
      open.length ? h('div.md-ask-open', null, `Waiting on herald: ${open.map((r) => `"${r.text}"`).join(', ')}`) : null);
  }

  function claimsRail(p: MediaPiece, after: string): HTMLElement {
    const claims = p.claims;
    return h('div.md-rail', null,
      h('div.md-rail-head', null,
        h('div.md-rail-t', null, 'Where every line comes from'),
        h('div.md-rail-s', null, "herald can't post a claim it can't point to. Unsourced lines block Approve until you confirm or cut them.")),
      h('div.md-claims', null, claims.length ? claims.map((c) => claimRow(p, c)) : h('div.md-rail-s', { style: 'padding:12px 0' }, isBusy(p) ? 'Claims appear as herald writes.' : 'No claims recorded.')),
      h('div.md-style-box', null, h('div.md-label', null, 'AFTER YOU APPROVE'), h('div.md-style-t', null, after)));
  }

  function claimRow(p: MediaPiece, c: MediaClaim): HTMLElement {
    const chips = isUnsourced(c) && isBusy(p)
      ? [h('span.md-src-chip.t-unsourced', null, 'no source yet')]
      : isUnsourced(c)
      ? [h('span.md-src-chip.t-unsourced', null, 'no source'),
         h('button.md-pill.sm', { onclick: () => void run(mapi.confirmClaim(p.id, c.id), 'Kept as your own words').then(() => refresh()) }, 'Confirm'),
         h('button.md-pill.sm', { onclick: () => void run(mapi.askPiece(p.id, `Cut this unsourced line: "${c.quote}"`), 'Sent to herald').then(() => refresh()) }, 'Ask herald to cut it')]
      : c.sources.map((s) => h('span.md-src-chip', { class: `t-${sourceTone(s)}`, title: s.ref }, s.label));
    return h('div.md-claim', null, h('div.md-claim-q', null, `"${c.quote}"`), h('div.md-claim-src', null, chips));
  }

  // ---- social ----

  /** Post | Research | Conversations, with what herald read or found on the right. */
  function socialTabs(p: MediaPiece): HTMLElement {
    const convs = conversationsFor(store, p.id);
    const drafts = convs.filter((c) => c.status === 'draft').length;
    const meta = view === 'research'
      ? (p.research ? [`${researchLine(p.research)} · ${ago(p.research.at)} · `, h('button.md-vlink', { disabled: isBusy(p), onclick: () => void run(mapi.researchPiece(p.id), 'herald will research it again').then(() => refresh()) }, 'Refresh')] : null)
      : view === 'conversations' ? conversationsLine(convs, replyPolicy(store)) : null;
    const tab = (id: SocialView, label: string, badge?: number) =>
      h('button.md-vtab', { class: view === id && 'on', onclick: () => { view = id; renderEditor(); } }, label, badge ? h('span.md-vbadge', null, String(badge)) : null);
    return h('div.md-vtabs', null, tab('post', 'Post'), tab('research', 'Research'), tab('conversations', 'Conversations', drafts), h('div.flex1'), h('div.md-vmeta', null, meta));
  }

  function socialBody(p: MediaPiece, ro: boolean): HTMLElement {
    const inner = view === 'research' ? researchBody(p) : view === 'conversations' ? conversationsBody(p) : postBody(p, ro);
    return h('div.md-social', null, socialTabs(p), inner);
  }

  function postBody(p: MediaPiece, ro: boolean): HTMLElement {
    const posts = p.posts ?? [];
    const plats = posts.length ? posts.map((x) => x.platform) : (p.platforms ?? []);
    if (!platform || !plats.includes(platform)) platform = plats[0] ?? null;
    const post = posts.find((x) => x.platform === platform);
    const tabs = h('div.md-ptabs', null, plats.map((pl) => {
      const ps = posts.find((x) => x.platform === pl);
      const cc = charCount(pl, ps && ps.versions.length ? fullPostText(ps) : '');
      return h('button.md-ptab', { class: pl === platform && 'on', onclick: () => { platform = pl; renderEditor(); } },
        PLATFORM_LABEL[pl], ps ? h('span.md-cc', { class: cc.over ? 'over' : cc.limit ? 'ok' : '' }, cc.text) : null);
    }));

    let card: HTMLElement;
    if (!post || !post.versions.length) {
      card = h('div.md-textcard', null, h('div.md-wait', null, ro ? 'herald is writing this one…' : 'No text for this platform yet.'));
    } else {
      const idx = Math.min(post.chosen, post.versions.length - 1);
      const ta = h('textarea.md-posttext', { disabled: ro, rows: 8 }) as HTMLTextAreaElement;
      ta.value = post.versions[idx];
      const cc = h('span.md-cc');
      const upd = () => { const c = charCount(post.platform, fullPostText(post, idx)); cc.textContent = c.text; cc.className = `md-cc ${c.over ? 'over' : c.limit ? 'ok' : ''}`; };
      upd();
      ta.oninput = () => { post.versions[idx] = ta.value; upd(); scheduleSave(p); };
      autosize(ta);
      card = h('div.md-textcard', null, ta,
        hashtagRow(p, post, ro),
        h('div.md-textfoot', null,
          h('div.flex1', null, `Version ${versionLetter(idx)} of ${post.versions.length}${p.editedAt ? ` · edited by you ${ago(p.editedAt)}` : ''}`),
          cc,
          h('div.md-vers', null, post.versions.map((_, i) => h('button.md-ver', {
            class: i === idx && 'on', disabled: ro,
            onclick: () => { post.chosen = i; scheduleSave(p); renderEditor(); },
          }, versionLetter(i))))));
    }

    const jobs = jobsFor(store, p.id);
    const rail = showPublishRail(jobs) ? postingRail(p, jobs) : claimsRail(p, 'Copy the chosen version for each platform and post it yourself, or press Post it for me and herald fills each post in your Chrome for you to check. Mark it used once it is posted.');
    return h('div.md-ebody', null,
      h('div.md-col', null, tabs, card, attachmentsRow(p, ro), ro ? null : askBox(p, ['Shorter', 'More personal', 'Make a thread', 'Another version'])),
      rail);
  }

  /** "#edtech ✕  #teachers ✕  + hashtag" with the platform's rule on the right. */
  function hashtagRow(p: MediaPiece, post: MediaPost, ro: boolean): HTMLElement {
    const tags = post.hashtags ?? [];
    const hint = hashtagHint(post.platform, tags.length);
    const chips = tags.map((t, i) => h('span.md-tag-chip', null, `#${t}`,
      ro ? null : h('button.md-tag-x', { title: `Remove #${t}`, onclick: () => { post.hashtags = tags.filter((_, j) => j !== i); scheduleSave(p); renderEditor(); } }, icon('x', 10, 2.6))));
    const add = ro ? null : h('button.md-tag-add', null, '+ hashtag');
    if (add) {
      add.onclick = () => {
        const input = h('input.md-tag-in', { placeholder: 'hashtag', maxLength: 51 }) as HTMLInputElement;
        const commit = () => {
          const raw = input.value.trim();
          if (raw) {
            const t = cleanTag(raw);
            if (!t) { toast('A hashtag is letters, digits and _ only, with no spaces', 'error'); return; }
            if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) { post.hashtags = [...tags, t]; scheduleSave(p); }
          }
          renderEditor();
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') renderEditor(); });
        input.addEventListener('blur', commit);
        add.replaceWith(input);
        input.focus();
      };
    }
    return h('div.md-tags', null, chips, add, h('div.flex1'), h('div.md-tag-hint', { class: hint.warn && 'warn' }, hint.text));
  }

  // ---- attachments: Vellum designs, screenshots, demo GIFs ----

  const designCache = new Map<string, Promise<string>>();
  function designUrl(p: MediaPiece, d: MediaDesign): Promise<string> {
    const key = `${p.id}/${d.file}/${d.createdAt}`;
    let u = designCache.get(key);
    if (!u) {
      u = mapi.designBlob(p.id, d.file).then((b) => URL.createObjectURL(b));
      u.catch(() => designCache.delete(key));
      designCache.set(key, u);
    }
    return u;
  }

  function designCard(p: MediaPiece, d: MediaDesign): HTMLElement {
    const square = d.width <= d.height * 1.2;
    const name = `${p.id}-${d.platform}-${d.width}x${d.height}.png`;
    const box = h('div.md-thumb.md-design-thumb', { class: square && 'sq', title: d.caption });
    const url = designUrl(p, d);
    void url.then((u) => {
      const img = h('img', { src: u, alt: d.caption }) as HTMLImageElement;
      img.onclick = () => showModal({
        title: `${PLATFORM_LABEL[d.platform]} · ${d.width}×${d.height}`,
        body: h('img.md-full', { src: u, alt: d.caption }),
        cancelLabel: 'Close',
        actions: [{ label: 'Copy image', onClick: () => copyImage(u) }, { label: 'Save…', kind: 'primary', onClick: () => saveImage(u, name) }],
      });
      box.replaceChildren(img);
    }, () => box.classList.add('missing'));
    const open = d.vellum
      ? h('button.md-vellum-open', { title: `Vellum file ${d.vellum.fileId}, artboard ${d.vellum.nodeId}`, onclick: () => toast(`Open Vellum: it's on the Media page of your project's file, artboard "${p.id} · ${PLATFORM_LABEL[d.platform]} ${d.width}×${d.height}"`) }, 'Open in Vellum ↗')
      : null;
    return h('div.md-img', { class: square ? 'sq' : 'wide' },
      box,
      h('div.md-img-cap', null, h('span.md-vellum-tag', null, 'VELLUM'), h('span.flex1', null, `${PLATFORM_LABEL[d.platform]} · ${d.width}×${d.height}`), imageButtons(url, name, true)),
      open ? h('div.md-img-cap', null, open) : null);
  }

  function attachmentsRow(p: MediaPiece, ro: boolean): HTMLElement {
    const state = snap?.state;
    const imgs = p.images ?? [];
    const pickable = state ? evidenceImages(state, p).filter((e) => !imgs.some((i) => i.taskId === e.taskId && i.evidenceId === e.evidenceId && i.name === e.name)) : [];
    const gifIds = p.gifIds ?? [];
    const gifs = gifIds.map((id) => store.pieces.find((x) => x.id === id)).filter((x): x is MediaPiece => !!x);
    const pickGifs = attachableGifs(store.pieces).filter((g) => !gifIds.includes(g.id));
    const pickBtn = h('button.md-pick', { disabled: ro || imgs.length + gifIds.length >= 6 || (!pickable.length && !pickGifs.length) }, '+ Screenshot or demo GIF');
    pickBtn.onclick = () => {
      const gifItems = pickGifs.slice(0, 8).map((g) => h('button.md-pickitem', {
        title: g.title,
        onclick: () => { closeFloating(); p.gifIds = [...gifIds, g.id]; scheduleSave(p); renderEditor(); },
      }, gifImg(g, 'md-pickthumb'), h('div.md-pickcap', null, `${g.id} · demo GIF`)));
      const grid = h('div.md-pickgrid', null, gifItems, pickable.slice(0, 24).map((e) => h('button.md-pickitem', {
        title: `${e.taskId}/${e.evidenceId} · ${e.summary}`,
        onclick: () => {
          closeFloating();
          const img: MediaImage = { taskId: e.taskId, evidenceId: e.evidenceId, name: e.name, caption: e.summary.slice(0, 80) };
          p.images = [...imgs, img];
          scheduleSave(p);
          renderEditor();
        },
      }, evidenceImg(e.taskId, e.evidenceId, e.name, 'md-pickthumb'), h('div.md-pickcap', null, `${e.taskId} · ${e.name}`))));
      showPopover(pickBtn, grid, 'left');
    };
    return h('div.md-attach', null,
      h('div.md-sec-head', null, h('div.md-label', null, 'ATTACHED'), h('div.md-sec-sub', null, 'post images made in Vellum, screenshots and demo GIFs')),
      h('div.md-imgs', null,
        sortedDesigns(p).map((d) => designCard(p, d)),
        imgs.map((im, i) => h('div.md-img', null,
          evidenceImg(im.taskId, im.evidenceId, im.name),
          h('div.md-img-cap', null, h('span.flex1', null, im.caption || `${im.taskId} · ${im.name}`),
            imageButtons(evidenceUrl(im.taskId, im.evidenceId, im.name), `${im.taskId}-${im.name}`, true),
            ro ? null : h('button.md-x', { title: 'Remove', onclick: () => { p.images = imgs.filter((_, j) => j !== i); scheduleSave(p); renderEditor(); } }, icon('x', 11, 2.5))))),
        gifs.map((g) => h('div.md-img', null,
          gifImg(g),
          h('div.md-img-cap', null, h('span.md-gif-tag', null, 'GIF'), h('a.flex1.md-img-link', { href: `#/media/${g.id}` }, g.title),
            g.gif && gifUrl(g, g.gif.source) ? imageButtons(gifUrl(g, g.gif.source)!, `${g.id}-${g.gif.source}.gif`, false) : null,
            ro ? null : h('button.md-x', { title: 'Remove', onclick: () => { p.gifIds = gifIds.filter((x) => x !== g.id); scheduleSave(p); renderEditor(); } }, icon('x', 11, 2.5))))),
        pickBtn,
        makeImageCard(p, ro)));
  }

  /** "+ Make an image in Vellum": hidden when the project has no Vellum file (or the server said so). */
  function makeImageCard(p: MediaPiece, ro: boolean): HTMLElement | null {
    if (!snap?.config.vellumFile || noVellum) return null;
    if (p.designRequest) {
      return h('div.md-make.busy', null, h('span.md-dot.pulse.t-media'), h('div', null, 'Making images'), h('div.md-make-s', null, `in Vellum · ${p.designRequest.platforms.map((x) => PLATFORM_LABEL[x]).join(', ')}`));
    }
    const btn = h('button.md-make', { disabled: ro }, h('div', null, '+ Make an image'), h('div.md-make-s', null, 'in Vellum')) as HTMLButtonElement;
    btn.onclick = () => openMakeImage(btn, p);
    return btn;
  }

  function openMakeImage(anchor: HTMLElement, p: MediaPiece): void {
    const plats = (p.posts?.length ? p.posts.map((x) => x.platform) : p.platforms ?? DEFAULT_PLATFORMS);
    let style: MediaDesignStyle = 'headline';
    const styles = h('div.md-styles');
    const drawStyles = () => setChildren(styles, DESIGN_STYLES.map((s) => h('button.md-style-opt', { class: style === s.id && 'on', onclick: () => { style = s.id; drawStyles(); } }, s.label)));
    drawStyles();
    const note = h('input.field.md-make-note', { placeholder: 'Anything to change? e.g. "use the queue screenshot"', maxLength: 500 }) as HTMLInputElement;
    const err = h('div.md-err', { hidden: true });
    const make = h('button.btn.primary', null, `Make ${plats.length} image${plats.length === 1 ? '' : 's'}`) as HTMLButtonElement;
    let close: () => void = () => {};
    make.onclick = async () => {
      make.disabled = true;
      try {
        await mapi.designPiece(p.id, { style, note: note.value.trim() || undefined, platforms: plats });
        close();
        toast('herald is designing them in Vellum');
        void refresh();
      } catch (e) {
        if (e instanceof mapi.ApiError && e.status === 409 && /vellum/i.test(e.message)) { noVellum = true; close(); renderEditor(); }
        err.textContent = e instanceof Error ? e.message : String(e);
        err.hidden = false;
      } finally { make.disabled = false; }
    };
    const body = h('div.md-makepop', null,
      h('div.md-rail-head', null, h('div.md-rail-t', null, 'Make a post image in Vellum'),
        h('div.md-rail-s', null, 'herald designs it in your design system, on the Media page of your Vellum file, then attaches the PNG.')),
      h('div.md-field', null, h('div.md-label', null, 'STYLE'), styles),
      h('div.md-field', null, h('div.md-label', null, 'SIZES (FROM YOUR PLATFORMS)'), h('div.md-rail-s', null, designSizesLine(plats))),
      note, err,
      h('div.md-makepop-foot', null, h('button.btn', { onclick: () => close() }, 'Cancel'), make));
    close = showPopover(anchor, body, 'right');
  }

  // ---- posting through your Chrome ----

  /** A filled-in post or reply waiting for you: what herald read back from the composer, then Post / Cancel. */
  function readyCard(j: MediaPublishJob): HTMLElement {
    const where = PLATFORM_LABEL[j.platform];
    return h('div.md-ready', null,
      h('div.md-ready-top', null, h('div.md-ready-t', null, j.kind === 'reply' ? `Reply on ${where}` : where), h('div.md-ready-s', null, 'Ready: check and post')),
      h('div.md-composer', null, j.composer ?? j.text),
      h('div.md-ready-note', null, `${j.attached ?? 0} image${j.attached === 1 ? '' : 's'} attached · this is the text in the ${where} tab in Chrome. Check the tab, then post.`),
      h('div.md-ready-acts', null,
        h('button.btn.primary.flex1', { onclick: () => void run(mapi.publishGo(j.id), `Posting on ${where}…`).then(() => refresh()) }, j.kind === 'reply' ? `Reply on ${where}` : `Post on ${where}`),
        h('button.btn', { onclick: () => void run(mapi.publishCancel(j.id), 'Cancelled: herald discards the draft').then(() => refresh()) }, 'Cancel')));
  }

  function jobRow(p: MediaPiece, j: MediaPublishJob): HTMLElement {
    if (j.status === 'ready') return readyCard(j);
    const line = jobLine(j);
    const retry = j.status === 'signin' || j.status === 'failed'
      ? h('button.md-pill.sm', { onclick: () => void run(mapi.publishPiece(p.id, [j.platform]), 'herald will try again').then(() => refresh()) }, 'Retry')
      : null;
    const right: Child = j.status === 'posted' && j.url
      ? h('a.md-job-link', { href: j.url, target: '_blank', rel: 'noreferrer' }, 'Posted · View post ↗')
      : h('div.md-job-s', { class: `t-${line.tone}` }, line.text);
    return h('div.md-job', { class: j.status === 'posted' && 'done' },
      h('span.md-dot', { class: `t-${line.tone} ${j.status === 'filling' || j.status === 'posting' ? 'pulse' : ''}` }),
      h('div.md-job-t', null, PLATFORM_LABEL[j.platform]), h('div.flex1'), right, retry);
  }

  function postingRail(p: MediaPiece, jobs: MediaPublishJob[]): HTMLElement {
    const posts = jobs.filter((j) => j.kind === 'post' && j.status !== 'cancelled');
    return h('div.md-rail.md-post-rail', null,
      h('div.md-rail-head', null,
        h('div.md-rail-t', null, 'Posting in your Chrome'),
        h('div.md-rail-s', null, 'Each post waits for your Post. Check the tab in Chrome: what you see there is exactly what will go out.')),
      posts.map((j) => jobRow(p, j)),
      h('div.md-hint', null, "Not signed in on a site? herald stops on that one and asks you to sign in in Chrome. When every post is out, the piece is marked Used."));
  }

  /** "Approved. Want me to post it for you?" — one row per platform. */
  function openPostDialog(p: MediaPiece, approvedNow: boolean): void {
    const rows = postRows(p);
    if (!rows.length) { toast('There is no text to post yet', 'error'); return; }
    const picked = new Set(rows.filter((r) => r.checked).map((r) => r.platform));
    const list = h('div.md-postrows');
    let yes: HTMLButtonElement | null = null;
    const label = () => `Yes, get ${picked.size} post${picked.size === 1 ? '' : 's'} ready`;
    const draw = () => {
      setChildren(list, rows.map((r) => h('button.md-postrow', {
        class: [picked.has(r.platform) && 'on', r.disabled && 'off'].filter(Boolean).join(' '), disabled: !!r.disabled,
        onclick: () => { if (picked.has(r.platform)) picked.delete(r.platform); else picked.add(r.platform); draw(); },
      }, h('span.md-check', null, picked.has(r.platform) ? icon('check', 11, 3.2) : null), h('span.md-postrow-t', null, PLATFORM_LABEL[r.platform]), h('span.md-postrow-s', null, r.line))));
      if (yes) { yes.textContent = label(); yes.disabled = !picked.size; }
    };
    draw();
    const close = showModal({
      title: h('span.md-modal-title', null, h('span.md-rose-dot'), approvedNow ? 'Approved. Want me to post it for you?' : 'Want me to post it for you?'),
      body: [h('p.md-post-intro', null, "I'll fill in each post in your Chrome, where you're signed in, and show you it ready to go. Nothing goes out until you press Post for that platform."), list,
        h('div.md-hint', null, 'You can also post later from this page with Post it for me.')],
      cancelLabel: "No, I'll copy it myself",
      actions: [{
        label: label(), kind: 'primary', onClick: async (done) => {
          if (await run(mapi.publishPiece(p.id, [...picked]), `herald is filling in ${picked.size} post${picked.size === 1 ? '' : 's'} in Chrome`)) { done(); view = 'post'; void refresh(); }
        },
      }],
    });
    yes = [...document.querySelectorAll<HTMLButtonElement>('.modal-foot .btn.primary')].pop() ?? null;
    draw();
    void close;
  }

  // ---- research ----

  function researchBody(p: MediaPiece): HTMLElement {
    const r = p.research;
    if (!r) {
      return h('div.md-empty', null,
        isBusy(p) ? 'herald is researching the platforms before it writes…' : 'No research yet. herald reads what people already say about this on your platforms, then writes.',
        isBusy(p) ? null : h('button.btn.primary', { onclick: () => void run(mapi.researchPiece(p.id), 'herald will research it').then(() => refresh()) }, 'Research now'));
    }
    const top = h('div.md-panel', null,
      h('div.md-panel-head', null, h('div.md-panel-t', null, "What's doing well on this subject"), h('div.md-panel-q', null, r.query.map((q) => `"${q}"`).join(' · '))),
      r.top.length ? r.top.map((t) => h('div.md-rpost', null,
        h('div.md-rpost-p', null, t.platform === 'article' ? 'Article' : PLATFORM_LABEL[t.platform]),
        h('div.md-rpost-b', null,
          h('div.md-rpost-q', null, t.platform === 'article' ? t.text : `"${t.text}"`),
          h('div.md-rpost-m', null, [t.who, t.engagement].filter(Boolean).join(', '), t.at ? ` · ${t.at}` : '', t.url ? [' · ', h('a', { href: t.url, target: '_blank', rel: 'noreferrer' }, 'open ↗')] : null))))
        : h('div.md-rail-s', { style: 'padding:14px 16px' }, 'Nothing stood out.'));
    const themes = h('div.md-panel.pad', null,
      h('div.md-panel-t', null, 'What people keep saying'),
      r.themes.map((t, i) => h('div.md-theme', null, h('div.md-theme-n', { class: `t-${themeTone(i)}` }, `${t.count}×`), h('div.md-theme-t', null, t.text))));
    const used = h('div.md-panel.pad.rose', null,
      h('div.md-panel-t', null, 'How herald used it'),
      r.used.length ? r.used.map((u) => h('div.md-used', null, h('span.md-used-dot'), h('div', null, u))) : h('div.md-rail-s', null, 'Not used yet: herald writes after it researches.'));
    const tags = h('div.md-panel.pad', null,
      h('div.md-panel-t', null, 'Hashtags people actually use'),
      r.hashtags.map((t) => h('div.md-rtag', null, h('div.md-rtag-t', null, `#${t.tag}`), h('div.md-rtag-s', null, [t.platforms.map((x) => PLATFORM_SHORT[x]).join(' '), t.note].filter(Boolean).join(' · ')))),
      h('div.md-hint', null, "herald picks the post's hashtags from these, per platform."));
    return h('div.md-cols', null,
      h('div.md-col', null, top, themes),
      h('div.md-col.md-side', null, used, tags, h('div.md-hint', null, "Read in Muster's research browser with your sign-ins. Themes are what people said, not facts.")));
  }

  // ---- conversations ----

  function conversationsBody(p: MediaPiece): HTMLElement {
    const list = conversationsFor(store, p.id);
    const policy = replyPolicy(store);
    const shown = list.filter((c) => c.status !== 'skipped');
    const skipped = list.length - shown.length;
    const cards = shown.length
      ? shown.map((c) => conversationCard(c))
      : [h('div.md-empty', null, isBusy(p) ? 'herald looks for conversations while it researches.' : 'No conversations yet. herald finds them when it researches, and checks comments on your posts once a day.')];
    const per = h('input.field.md-num', { type: 'number', min: 0, max: 20, value: String(policy.perDay) }) as HTMLInputElement;
    per.onchange = () => {
      const n = Math.max(0, Math.min(20, Math.round(Number(per.value) || 0)));
      void run(mapi.saveReplyPolicy({ perDay: n }), `Up to ${n} repl${n === 1 ? 'y' : 'ies'} a day`).then(() => refresh());
    };
    const watch = h('button.md-switch', { class: policy.watchOwn && 'on', title: policy.watchOwn ? 'On' : 'Off', onclick: () => void run(mapi.saveReplyPolicy({ watchOwn: !policy.watchOwn }), policy.watchOwn ? 'herald stops checking comments on your posts' : 'herald checks comments on your posts once a day').then(() => refresh()) }, h('span'));
    const rules = h('div.md-panel.pad.md-rules', null,
      h('div.md-panel-t', null, 'How herald replies'),
      h('div.md-rule', null, 'Only where you have something useful to add: an answer, your experience, a real fix.'),
      h('div.md-rule', null, "No copy-paste promo. It mentions your product only when someone asks for a tool, and says it's yours."),
      h('div.md-rule', null, `At most ${policy.perDay} repl${policy.perDay === 1 ? 'y' : 'ies'} a day, never more than one per thread.`),
      h('div.md-rule', null, 'Every reply waits for your Reply: herald fills it in, you check the tab in Chrome.'),
      h('div.md-rule-sep'),
      h('div.md-setting', null, h('div.flex1', null, 'Replies a day'), per),
      h('div.md-setting', null, h('div.flex1', null, 'Watch replies to my posts'), watch),
      skipped ? h('div.md-hint', null, `${skipped} skipped`) : null);
    return h('div.md-cols', null, h('div.md-col', null, cards), h('div.md-side.narrow', null, rules));
  }

  function conversationCard(c: MediaConversation): HTMLElement {
    const job = (store.publish ?? []).filter((j) => j.conversationId === c.id).pop();
    const block = replyBlock(c, store);
    const unsourced = c.claims.filter(isUnsourced);
    const editing = c.status === 'draft';
    const ta = h('textarea.md-reply-in', { disabled: !editing, rows: 3 }) as HTMLTextAreaElement;
    ta.value = c.draft;
    autosize(ta);
    let timer: ReturnType<typeof setTimeout> | null = null;
    ta.oninput = () => {
      c.draft = ta.value;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void mapi.editConversation(c.id, c.draft).catch(errToast); }, 700);
    };
    const kindLine = c.kind === 'own'
      ? h('div.md-conv-k.own', null, `Comment on YOUR post${c.engagement ? ` · ${c.engagement}` : ''} · ${ago(c.createdAt)}`)
      : h('div.md-conv-k', null, [c.why, c.engagement].filter(Boolean).join(' · '));
    let foot: Child;
    if (job && job.status === 'ready') foot = readyCard(job);
    else if (c.status === 'posted') foot = h('div.md-conv-foot', null, c.postedUrl ? h('a.md-job-link', { href: c.postedUrl, target: '_blank', rel: 'noreferrer' }, 'Replied · View reply ↗') : h('div.md-job-s.t-success', null, 'Replied'));
    else if (c.status === 'queued') foot = h('div.md-conv-foot', null, h('span.md-dot.pulse.t-media'), h('div.md-job-s', null, job ? jobLine(job).text : 'Going out through Chrome'),
      job && (job.status === 'signin' || job.status === 'failed') ? h('button.md-pill.sm', { onclick: () => void run(mapi.replyConversation(c.id), 'herald will try again').then(() => refresh()) }, 'Retry') : null);
    else {
      foot = h('div.md-conv-foot', null,
        h('button.btn.primary.sm', { disabled: !!block, title: block ?? 'herald fills it in in Chrome; you press Reply', onclick: () => void (async () => {
          if (timer) { clearTimeout(timer); timer = null; await mapi.editConversation(c.id, c.draft).catch(errToast); }
          if (await run(mapi.replyConversation(c.id), 'herald is filling in the reply in Chrome')) void refresh();
        })() }, 'Reply for me'),
        h('button.btn.sm', { onclick: () => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }, 'Edit'),
        h('button.md-link', { onclick: () => void run(mapi.skipConversation(c.id), 'Skipped').then(() => refresh()) }, 'Skip'),
        h('div.flex1'),
        block && block !== 'Write a reply first' ? h('div.md-conv-why.t-stuck', null, block) : c.mentionsProduct ? h('div.md-conv-why', null, 'Mentions your product: someone asked') : null);
    }
    return h('div.md-conv', null,
      h('div.md-conv-top', null, h('span.md-plat-tag', null, PLATFORM_LABEL[c.platform]), kindLine, h('div.flex1'), h('a.md-conv-open', { href: c.url, target: '_blank', rel: 'noreferrer' }, c.kind === 'own' ? 'Open ↗' : 'Open thread ↗')),
      h('div.md-conv-q', null, `"${c.quote}"`, h('span.md-conv-who', null, ` · ${c.who}`)),
      h('div.md-reply', { class: unsourced.length > 0 && 'warn' },
        h('div.md-reply-head', null, h('div.md-reply-l', null, c.status === 'posted' ? 'YOUR REPLY' : 'YOUR REPLY (DRAFT)'), h('div.flex1'),
          unsourced.length ? h('div.md-reply-need', null, `${unsourced.length} claim${unsourced.length === 1 ? '' : 's'} need${unsourced.length === 1 ? 's' : ''} you`) : null),
        ta,
        unsourced.length && editing ? h('div.md-reply-claims', null, unsourced.map((u) => h('div.md-reply-claim', null, h('span.flex1', null, `"${u.quote}"`),
          h('button.md-pill.sm', { onclick: () => void run(mapi.confirmConversationClaim(c.id, u.id), 'Kept as your own words').then(() => refresh()) }, 'Confirm')))) : null),
      foot);
  }

  // ---- article / website ----

  function sectionsBody(p: MediaPiece, ro: boolean): HTMLElement {
    const secs = p.sections ?? [];
    const outline = h('div.md-outline', null,
      h('div.md-label', { style: 'padding:0 10px 8px' }, 'OUTLINE'),
      secs.map((s) => h('button.md-oitem', { class: s.status === 'writing' && 'on', onclick: () => document.getElementById(`md-sec-${s.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
        h('span.md-oic', { class: `s-${s.status}` }, s.status === 'done' ? icon('check', 12, 2.6) : h('span')),
        h('span.md-ot', null, s.heading || 'Opening'))),
      h('div.md-hint', { style: 'padding:12px 10px 0' }, ro ? 'You can edit once herald finishes.' : 'Every section is editable. Your changes save on their own.'));
    const doc = h('div.md-doc', null,
      h('div.md-doc-title', null, p.title),
      secs.filter((s) => !(ro && s.status === 'todo' && !s.text.trim())).map((s) => {
        const head = h('input.md-h', { value: s.heading, placeholder: 'Heading (optional)', disabled: ro }) as HTMLInputElement;
        head.oninput = () => { s.heading = head.value; scheduleSave(p); };
        const ta = h('textarea.md-para', { disabled: ro }) as HTMLTextAreaElement;
        ta.value = s.text;
        ta.oninput = () => { s.text = ta.value; scheduleSave(p); };
        autosize(ta);
        return h('div.md-section', { id: `md-sec-${s.id}`, class: s.status !== 'done' && `s-${s.status}` }, (s.heading || !ro) ? head : null, s.text || !ro ? ta : null);
      }),
      isBusy(p) ? h('div.md-live', null, h('span.md-live-bar'), `herald is writing${p.progress ? ` · ${p.progress}` : ''}`) : null,
      !secs.length && !isBusy(p) ? h('div.md-wait', null, 'No text yet.') : null);
    return h('div.md-ebody', null,
      h('div.md-col.md-col-row', null, outline, h('div.md-doccol', null, doc, ro ? null : askBox(p, ['Shorter', 'More personal', 'Simpler words', 'Stronger opening']))),
      claimsRail(p, p.kind === 'website'
        ? 'Copy the text and paste it into your site. Each heading is on its own line, ready for a section of the page.'
        : 'Copy the finished article as plain text and paste it wherever you publish. No HTML or files, just the words.'));
  }

  // ---- video ----

  function videoBody(p: MediaPiece, ro: boolean): HTMLElement {
    const shots = p.shots ?? [];
    const shown = showAllShots ? shots : shots.slice(0, 4);
    const row = (s: MediaShot) => {
      const vo = h('textarea.md-vo', { disabled: ro, rows: 2 }) as HTMLTextAreaElement;
      vo.value = s.voiceover;
      vo.oninput = () => { s.voiceover = vo.value; scheduleSave(p); };
      autosize(vo);
      const os = h('textarea.md-os', { disabled: ro, rows: 1, placeholder: '—' }) as HTMLTextAreaElement;
      os.value = s.onScreen ?? '';
      os.oninput = () => { s.onScreen = os.value || undefined; scheduleSave(p); };
      autosize(os);
      return h('div.md-shot', null,
        h('div.md-s-at', null, s.at),
        h('div.md-s-shot', null,
          s.evidence ? evidenceImg(s.evidence.taskId, s.evidence.evidenceId, s.evidence.name, 'md-shotimg') : h('div.md-shotimg.record'),
          h('div.md-s-cap', { class: s.evidence ? 't-task' : 't-record' }, s.evidence ? `evidence · ${s.evidence.taskId} ${s.shot}` : `record · ${s.shot}`)),
        h('div.md-s-vo', null, vo),
        h('div.md-s-os', null, os));
    };
    const table = h('div.md-shots', null,
      h('div.md-shot.md-head', null, h('div.md-s-at', null, 'TIME'), h('div.md-s-shot', null, 'SHOT'), h('div.md-s-vo', null, 'VOICEOVER'), h('div.md-s-os', null, 'ON SCREEN')),
      shown.length ? shown.map(row) : h('div.md-wait', null, ro ? 'herald is writing the shot list…' : 'No shots yet.'),
      shots.length > 4
        ? h('div.md-shots-foot', null,
            h('div.flex1', null, showAllShots ? `${shots.length} shots` : `${shots.length - 4} more shots · ${shots[4].at} to ${shots[shots.length - 1].at}`),
            h('button.md-link', { onclick: () => { showAllShots = !showAllShots; renderEditor(); } }, showAllShots ? 'Show fewer' : 'Show all'))
        : null);
    const hooks = p.hooks ?? [];
    const chosen = p.hookChosen ?? 0;
    const counts = shotCounts(shots);
    const rail = h('div.md-rail', null,
      h('div.md-rail-head', null, h('div.md-rail-t', null, 'Opening hook'), h('div.md-rail-s', null, `herald wrote ${hooks.length || 'no'} hook${hooks.length === 1 ? '' : 's'}. Pick the one for the first 3 seconds.`)),
      h('div.md-hooks', null, hooks.map((t, i) => h('button.md-hook', {
        class: i === chosen && 'on', disabled: ro,
        onclick: () => { p.hookChosen = i; scheduleSave(p); renderEditor(); },
      }, h('span.md-radio'), h('span', null, `"${t}"`)))),
      h('div.md-shotcounts', null,
        h('div.md-label', null, 'SHOTS'),
        h('div.md-src', null, h('div.flex1', null, 'From task evidence'), h('div.md-src-v.t-task', null, String(counts.evidence))),
        h('div.md-src', null, h('div.flex1', null, 'You need to record'), h('div.md-src-v.t-captain', null, String(counts.record))),
        h('div.md-hint', null, 'Copy shot list puts a CSV with the times on your clipboard, ready to paste into a sheet for your Resolve edit.')),
      p.claims.length ? h('div.md-claims', null, p.claims.map((c) => claimRow(p, c))) : null);
    return h('div.md-ebody', null,
      h('div.md-col', null, table, ro ? null : askBox(p, ['Shorter', 'Punchier hook', 'Fewer shots to record', 'Another version'])),
      rail);
  }

  // ---- demo GIF ----

  function gifBody(p: MediaPiece, ro: boolean): HTMLElement {
    const g = p.gif;
    if (!g) {
      return h('div.md-ebody', null,
        h('div.md-col', null, h('div.md-gif-preview.empty', null, h('div.md-wait', null, ro ? 'herald is picking the frames…' : 'No frames yet.'))),
        claimsRail(p, 'Save the GIF and attach it to a post, or use it on your website.'));
    }
    const frames = g.frames;
    if (frameSel !== null && frameSel >= frames.length) frameSel = null;
    const hasRec = !!g.recording?.file;
    const setSource = (src: MediaGif['source']) => { if (g.source !== src) { g.source = src; frameSel = null; scheduleSave(p); renderEditor(); } };
    const switcher = h('div.md-gif-switch', null,
      h('div.md-seg', null,
        h('button.md-seg-b', { class: g.source === 'slideshow' && 'on', disabled: ro, onclick: () => setSource('slideshow') }, 'Slideshow from screenshots'),
        h('button.md-seg-b', { class: g.source === 'recording' && 'on', disabled: ro || !hasRec, title: hasRec ? 'Use the real recording' : 'No recording yet', onclick: () => setSource('recording') }, 'Real recording')),
      h('div.md-hint.flex1', null, g.source === 'recording' ? 'The real recording, with the frame captions spread over it.' : 'herald built this from task evidence. Swap to a real recording whenever you want one.'));

    // Preview: the GIF itself; a selected frame shows that still with its caption, as the GIF will.
    const file = gifFile(g);
    let preview: HTMLElement;
    if (frameSel !== null && g.source === 'slideshow') {
      const f = frames[frameSel];
      preview = h('div.md-gif-preview', null,
        evidenceImg(f.taskId, f.evidenceId, f.name, 'md-gif-still'),
        f.caption ? h('div.md-gif-cap', null, f.caption) : null,
        h('div.md-gif-pos', null, `frame ${frameSel + 1} / ${frames.length} · ${frameStart(frames, frameSel)}`));
    } else if (file) {
      preview = h('div.md-gif-preview', null, gifImg(p, 'md-gif-still'),
        h('div.md-gif-pos', null, `${g.source === 'slideshow' ? `${frames.length} frames · ` : ''}${formatSeconds(file.seconds)} · ${file.width}×${file.height}`));
    } else {
      preview = h('div.md-gif-preview.empty', null, h('div.md-wait', null,
        g.renderError ? `Could not render the GIF: ${g.renderError}` : ro ? 'herald is picking the frames…' : 'Rendering the GIF…'));
    }

    // Frame strip: click to edit, drag to reorder, × to remove, + Frame to pick from evidence.
    let dragFrom: number | null = null;
    const strip = h('div.md-frames', null,
      frames.map((f, i) => {
        const cell = h('div.md-frame', {
          class: frameSel === i && 'on',
          draggable: ro ? undefined : 'true',
          title: ro ? f.caption : 'Click to edit, drag to reorder',
          onclick: () => { frameSel = frameSel === i ? null : i; renderEditor(); },
        },
          h('div.md-frame-img', null, evidenceImg(f.taskId, f.evidenceId, f.name, 'md-frame-thumb'),
            ro ? null : h('button.md-x.md-frame-x', { title: 'Remove this frame', onclick: (e: Event) => {
              e.stopPropagation();
              g.frames = frames.filter((_, j) => j !== i);
              frameSel = null;
              scheduleSave(p); renderEditor();
            } }, icon('x', 11, 2.5))),
          h('div.md-frame-cap', null, f.caption || '(no caption)'),
          h('div.md-frame-meta', null, `${formatSeconds(f.seconds)} · ${f.taskId}/${f.evidenceId}`));
        cell.addEventListener('dragstart', (e) => { dragFrom = i; e.dataTransfer?.setData('text/plain', String(i)); cell.classList.add('dragging'); });
        cell.addEventListener('dragend', () => cell.classList.remove('dragging'));
        cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.classList.add('drop'); });
        cell.addEventListener('dragleave', () => cell.classList.remove('drop'));
        cell.addEventListener('drop', (e) => {
          e.preventDefault();
          cell.classList.remove('drop');
          if (dragFrom === null || dragFrom === i) return;
          g.frames = moveFrame(frames, dragFrom, i);
          frameSel = i;
          dragFrom = null;
          scheduleSave(p); renderEditor();
        });
        return cell;
      }),
      ro || frames.length >= 12 ? null : addFrameButton(p, g));

    // The selected frame's caption and seconds.
    let frameEdit: HTMLElement | null = null;
    if (frameSel !== null && !ro && g.source === 'slideshow') {
      const f = frames[frameSel];
      const cap = h('input.field.md-frame-in', { value: f.caption, maxlength: 60, placeholder: 'Caption (60 characters)' }) as HTMLInputElement;
      cap.oninput = () => { f.caption = cap.value; scheduleSave(p); };
      const secs = h('input.field.md-frame-secs', { type: 'number', min: '0.5', max: '8', step: '0.5', value: String(f.seconds) }) as HTMLInputElement;
      secs.onchange = () => { f.seconds = clampSeconds(Number(secs.value)); secs.value = String(f.seconds); scheduleSave(p); };
      frameEdit = h('div.md-frame-edit', null,
        h('div.md-label', null, `FRAME ${frameSel + 1}`), cap, secs, h('span.md-hint', null, 'seconds'),
        h('div.flex1'), h('span.md-hint', null, `Total ${formatSeconds(totalSeconds(frames))}`));
    }

    const alt = h('textarea.field.md-alt', { rows: 2, maxlength: 400, disabled: ro, placeholder: "Alt text: what the GIF shows, for people who can't see it" }) as HTMLTextAreaElement;
    alt.value = g.altText;
    alt.oninput = () => { g.altText = alt.value; scheduleSave(p); };
    autosize(alt);

    return h('div.md-ebody', null,
      h('div.md-col', null, switcher, preview, g.source === 'slideshow' ? strip : null, frameEdit,
        h('div.md-field', null, h('div.md-label', null, 'ALT TEXT'), alt),
        g.renderError && file ? h('div.md-err', null, `The last render failed: ${g.renderError}`) : null,
        ro ? null : askBox(p, ['Fewer frames', 'Shorter captions', 'Slower', 'Different screenshots'])),
      recordingRail(p, g, ro, file?.bytes));
  }

  function addFrameButton(p: MediaPiece, g: MediaGif): HTMLElement {
    const state = snap?.state;
    const pickable = state ? evidenceImages(state, p) : [];
    const btn = h('button.md-frame-add', { disabled: !pickable.length, title: pickable.length ? 'Add a screenshot from task evidence' : 'No evidence screenshots to pick from' }, '+ Frame');
    btn.onclick = () => {
      const grid = h('div.md-pickgrid', null, pickable.slice(0, 24).map((e) => h('button.md-pickitem', {
        title: `${e.taskId}/${e.evidenceId} · ${e.summary}`,
        onclick: () => {
          closeFloating();
          const f: MediaGifFrame = { taskId: e.taskId, evidenceId: e.evidenceId, name: e.name, caption: e.summary.slice(0, 60), seconds: 2.5 };
          g.frames = [...g.frames, f];
          frameSel = g.frames.length - 1;
          scheduleSave(p); renderEditor();
        },
      }, evidenceImg(e.taskId, e.evidenceId, e.name, 'md-pickthumb'), h('div.md-pickcap', null, `${e.taskId} · ${e.name}`))));
      showPopover(btn, grid, 'left');
    };
    return btn;
  }

  function recordingRail(p: MediaPiece, g: MediaGif, ro: boolean, bytes?: number): HTMLElement {
    const steps = g.steps;
    const stepRow = (t: string, i: number) => {
      const inp = h('textarea.md-step-in', { rows: 1, disabled: ro, maxlength: 200 }) as HTMLTextAreaElement;
      inp.value = t;
      inp.oninput = () => { g.steps[i] = inp.value; scheduleSave(p); };
      autosize(inp);
      return h('div.md-step', null, h('div.md-step-n', null, String(i + 1)), inp,
        ro || steps.length <= 1 ? null : h('button.md-x', { title: 'Remove this step', onclick: () => { g.steps = steps.filter((_, j) => j !== i); scheduleSave(p); renderEditor(); } }, icon('x', 11, 2.5)));
    };
    const r = g.recording;
    const busy = !!r && (r.status === 'requested' || r.status === 'recording');
    const label = r?.status === 'done' ? 'Record it again' : r?.status === 'failed' ? 'Try recording again'
      : r?.status === 'requested' ? 'Asked the Captain' : r?.status === 'recording' ? 'Recording…' : 'Record a real demo';
    const recBtn = h('button.btn.md-rec-btn', {
      disabled: ro || busy || p.status === 'used',
      onclick: () => void flush().then(() => run(mapi.recordDemo(p.id), 'Sent to the Captain')).then(() => refresh()),
    }, label);
    const fits = bytes !== undefined ? gifFits(bytes) : [];
    return h('div.md-rail', null,
      h('div.md-rail-head', null,
        h('div.md-rail-t', null, 'Real recording'),
        h('div.md-rail-s', null, 'A crew member runs the app, follows these steps and records them. The recording becomes the GIF, with the same captions.')),
      h('div.md-steps', null, steps.map(stepRow),
        ro || steps.length >= 12 ? null : h('button.md-link.md-step-add', { onclick: () => { g.steps = [...steps, '']; scheduleSave(p); renderEditor(); } }, '+ Step')),
      recBtn,
      h('div.md-hint.md-rec-line', { class: r?.status === 'failed' && 't-stuck' }, recordingLine(g)),
      h('div.md-style-box', null,
        h('div.md-label', null, 'FITS'),
        bytes === undefined
          ? h('div.md-style-t', null, 'The size shows once the GIF is rendered.')
          : [h('div.md-fits', null, fits.map((f) => h('div.md-fit', { class: f.ok ? 't-success' : 't-stuck' }, h('span.flex1', null, f.label), h('span.md-fit-v', null, f.ok ? `${formatBytes(bytes)} ok` : `over ${formatBytes(f.limit)}`)))),
             h('div.md-style-t', null, 'Attach it to any social post, or save it for your website.')]),
      p.claims.length ? h('div.md-claims', null, p.claims.map((c) => claimRow(p, c))) : null);
  }

  function autosize(ta: HTMLTextAreaElement): void {
    const fit = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 2}px`; };
    ta.addEventListener('input', fit);
    requestAnimationFrame(fit);
  }

  return {
    el,
    update(s) { snap = s; if (visible && !openId) renderLibrary(); },
    params(p) {
      const id = p.get('id');
      const next = id ? id.toUpperCase() : null;
      if (next !== openId) {
        void flush();
        openId = next;
        draft = null;
        dirty = false;
        platform = null;
        showAllShots = false;
        frameSel = null;
        view = 'post';
      }
      render();
      // #/media?new=1 opens New piece (a link from elsewhere); the hash is cleaned so Back doesn't reopen it.
      if (!next && p.get('new')) {
        history.replaceState(null, '', '#/media');
        setTimeout(() => openNewPiece());
      }
    },
    show() { visible = true; snap = events.snapshot; render(); void refreshAll(); },
    hide() { visible = false; void flush(); },
  };
}

/** The media nav badge number: pieces waiting on your review plus posts filled in and waiting for your Post. */
export function mediaBadge(): number {
  return (events.media?.review ?? 0) + (events.media?.publishReady ?? 0);
}
