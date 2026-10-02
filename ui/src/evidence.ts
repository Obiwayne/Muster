// Evidence on review cards: thumbnails of the screenshots a task's last station attached, and a viewer
// with before/after pairs, videos and text files. Files come from GET /api/tasks/:id/evidence/:entry/:file,
// which needs the token header, so they are fetched as blobs (cached per file).
import type { Evidence, EvidenceFile, Task } from '../../src/types';
import { api } from './api';
import { h, icon, showModal } from './dom';
import { ago } from './util';

const blobs = new Map<string, Promise<string>>();
const ready = new Map<string, string>();

function fileUrl(task: Task, e: Evidence, f: EvidenceFile): Promise<string> {
  const key = `${task.id}/${e.id}/${f.name}`;
  let p = blobs.get(key);
  if (!p) {
    p = api.evidenceFile(task.id, e.id, f.name).then((b) => {
      const url = URL.createObjectURL(b);
      ready.set(key, url);
      return url;
    });
    p.catch(() => blobs.delete(key));
    blobs.set(key, p);
  }
  return p;
}

/** An <img>/<video> whose source loads from the API; set at once when it is already cached (no flash on re-render). */
function media(task: Task, e: Evidence, f: EvidenceFile, cls: string): HTMLElement {
  const el = f.kind === 'video'
    ? (h(`video.${cls}`, { controls: true, preload: 'metadata' }) as HTMLVideoElement)
    : (h(`img.${cls}`, { alt: f.name, title: f.name, loading: 'lazy' }) as HTMLImageElement);
  const cached = ready.get(`${task.id}/${e.id}/${f.name}`);
  if (cached) el.setAttribute('src', cached);
  else void fileUrl(task, e, f).then((u) => el.setAttribute('src', u)).catch(() => el.classList.add('broken'));
  return el;
}

const count = (task: Task) => (task.evidence ?? []).reduce((n, e) => n + e.files.length, 0);

/** "older" when the evidence was taken on a commit other than the one the Captain flagged for merge. */
function staleness(task: Task, e: Evidence): string | null {
  if (!e.sha || !task.reviewedSha || e.sha === task.reviewedSha) return null;
  return `Taken at ${e.sha.slice(0, 8)}; the reviewed commit is ${task.reviewedSha.slice(0, 8)}`;
}

/** A compact strip for cards: up to 4 thumbnails and an "Evidence" button. A warning chip when there is none. */
export function evidenceStrip(task: Task): HTMLElement {
  const list = task.evidence ?? [];
  if (!list.length) return h('div.ev-strip.none', { title: 'No proof attached: ask the Captain to send it back for evidence' }, icon('alert', 12), 'No evidence attached');
  const images = list.flatMap((e) => e.files.filter((f) => f.kind === 'image').map((f) => ({ e, f })));
  const thumbs = images.slice(0, 4).map(({ e, f }) => media(task, e, f, 'ev-thumb'));
  const more = count(task) - thumbs.length;
  return h('button.ev-strip', { title: list.map((e) => `${e.id}: ${e.summary}`).join('\n'), onclick: (ev: MouseEvent) => { ev.stopPropagation(); showEvidence(task); } },
    thumbs,
    h('span.ev-label', null, icon('check', 12), thumbs.length ? (more > 0 ? `+${more} more` : 'Evidence') : `Evidence · ${count(task)} file${count(task) === 1 ? '' : 's'}`));
}

/** Pairs NN-before-x / NN-after-x images so they sit side by side. */
function pairUp(files: EvidenceFile[]): (EvidenceFile | [EvidenceFile, EvidenceFile])[] {
  const out: (EvidenceFile | [EvidenceFile, EvidenceFile])[] = [];
  const used = new Set<string>();
  const key = (n: string, side: string) => n.toLowerCase().replace(new RegExp(`(^|[-_ .])${side}([-_ .]|$)`), '$1#$2');
  for (const f of files) {
    if (used.has(f.name)) continue;
    if (f.kind === 'image' && /(^|[-_ .])before([-_ .]|$)/i.test(f.name)) {
      const partner = files.find((g) => g.kind === 'image' && !used.has(g.name) && g !== f && key(g.name, 'after') === key(f.name, 'before'));
      if (partner) {
        used.add(f.name).add(partner.name);
        out.push([f, partner]);
        continue;
      }
    }
    used.add(f.name);
    out.push(f);
  }
  return out;
}

function textBlock(task: Task, e: Evidence, f: EvidenceFile): HTMLElement {
  const pre = h('pre.ev-text', null, 'Loading…');
  void api.evidenceFile(task.id, e.id, f.name).then((b) => b.text()).then((t) => {
    pre.textContent = t.length > 20_000 ? `${t.slice(0, 20_000)}\n… (${t.length - 20_000} more characters)` : t;
  }).catch((err) => { pre.textContent = err instanceof Error ? err.message : String(err); });
  return h('div.ev-file', null, h('div.ev-name', null, f.name), pre);
}

function entry(task: Task, e: Evidence): HTMLElement {
  const stale = staleness(task, e);
  const body = pairUp(e.files).map((item) => {
    if (Array.isArray(item)) {
      return h('div.ev-pair', null,
        h('figure', null, media(task, e, item[0], 'ev-img'), h('figcaption', null, 'Before · ', item[0].name)),
        h('figure', null, media(task, e, item[1], 'ev-img'), h('figcaption', null, 'After · ', item[1].name)));
    }
    if (item.kind === 'image' || item.kind === 'video') return h('figure.ev-one', null, media(task, e, item, 'ev-img'), h('figcaption', null, item.name));
    if (item.kind === 'text') return textBlock(task, e, item);
    const link = h('button.btn.sm', null, `Download ${item.name}`);
    link.onclick = () => void fileUrl(task, e, item).then((u) => {
      const a = h('a', { href: u, download: item.name }) as HTMLAnchorElement;
      a.click();
    });
    return h('div.ev-file', null, link);
  });
  return h('section.ev-entry', null,
    h('div.ev-head', null,
      h('span.ev-id', null, e.id),
      h('span', null, `${e.station} · ${e.by} · ${ago(e.at)}`),
      e.sha ? h('span.mono.faint', null, e.sha.slice(0, 8)) : null,
      stale ? h('span.ev-stale', { title: stale }, icon('alert', 12), 'older commit') : null),
    h('div.ev-summary', null, e.summary),
    body);
}

export function showEvidence(task: Task): void {
  const list = task.evidence ?? [];
  showModal({
    title: `Evidence · ${task.id} ${task.title}`,
    wide: true,
    cancelLabel: 'Close',
    body: list.length
      ? h('div.ev-list', null, list.map((e) => entry(task, e)))
      : h('div.empty', null, `${task.id} has no evidence yet. Its last station attaches it with add_evidence before review.`),
  });
}
