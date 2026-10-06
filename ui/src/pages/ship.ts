// Dashboard → Ship: the crew as pixel sailors on a pirate ship (design: Vellum "Muster" › Ship).
// Anything that needs you is loud (Captain's bubble, treasure chest, fire, a sailor stuck in the rigging); the rest is ambient.
// The scene is a 1220×720 canvas; overlays are HTML placed in % of the scene so their text stays crisp at any size.
import type { MusterState } from '../../../src/types';
import { h, icon, setChildren, toast } from '../dom';
import type { Snapshot } from '../events';
import { api } from '../api';
import { approveAllMerges, commitCheckout, run, stashCheckout } from '../actions';
import { agentStatusLong, ageShort, taskById } from '../util';
import { SCENE_H, SCENE_W, shipView, type Sailor, type ShipView } from '../shipmodel';
import { chestSprite, drawBolt, drawClouds, drawHalo, drawRain, drawSea, drawSky, drawSmoke, fireSprite, foot, sailorSprite } from '../shipart';
import shipPng from '../assets/ship/ship.png';
import flagPng from '../assets/ship/flag.png';
import wheelPng from '../assets/ship/wheel.png';
import cannonPng from '../assets/ship/cannon.png';
import barrelPng from '../assets/ship/barrel.png';
import anchorPng from '../assets/ship/anchor.png';
import './ship.css';

const FPS = 8;
const SPRITE_H = 60; // a sailor is ~15 grid rows of 4px

function img(src: string): HTMLImageElement {
  const i = new Image();
  i.src = src;
  return i;
}
const IMG = { ship: img(shipPng), flag: img(flagPng), wheel: img(wheelPng), cannon: img(cannonPng), barrel: img(barrelPng), anchor: img(anchorPng) };
const ready = (i: HTMLImageElement) => i.complete && i.naturalWidth > 0;
const onImagesLoaded = (cb: () => void) => Object.values(IMG).forEach((i) => i.addEventListener('load', cb));

const pctX = (x: number) => `${(x / SCENE_W) * 100}%`;
const pctY = (y: number) => `${(y / SCENE_H) * 100}%`;

/** Show that agent's terminal on the Dashboard. */
function openTerminal(id: string): void {
  location.hash = `#/dashboard?agent=${encodeURIComponent(id)}&view=terminals`;
}

export interface ShipView$ {
  el: HTMLElement;
  update(s: Snapshot): void;
  show(): void;
  hide(): void;
}

export function createShipView(): ShipView$ {
  const canvas = h('canvas.ship-canvas', { width: SCENE_W, height: SCENE_H }) as HTMLCanvasElement;
  const g = canvas.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  const overlay = h('div.ship-overlay');
  const stage = h('div.ship-stage', null, canvas, overlay);
  const stageHost = h('div.ship-stage-host', null, stage);
  const status = h('div.ship-status');
  const log = h('div.ship-log');
  const hint = h('div.ship-hint');
  const strip = h('div.ship-strip', null, status, h('div.ship-sep'), log, hint);
  const el = h('div.ship', null, stageHost, strip);

  let view: ShipView | null = null;
  let state: MusterState | null = null;
  let visible = false;
  let raf = 0;
  let last = 0;
  let hovered: string | null = null;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Fit the 1220×720 stage inside the space left above the strip.
  const fit = () => {
    const r = stageHost.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const s = Math.min(r.width / SCENE_W, r.height / SCENE_H);
    stage.style.width = `${Math.floor(SCENE_W * s)}px`;
    stage.style.height = `${Math.floor(SCENE_H * s)}px`;
  };
  new ResizeObserver(fit).observe(stageHost);
  onImagesLoaded(() => { if (visible) draw(reduced ? 0 : performance.now() / 1000); });

  // ---------------------------------------------------------------- canvas

  function draw(t: number): void {
    const v = view;
    g.clearRect(0, 0, SCENE_W, SCENE_H);
    const weather = v?.weather ?? 'clear';
    const frame = Math.floor(t * 2);
    drawSky(g, SCENE_W, weather, t);
    if (weather !== 'clear') drawClouds(g);
    if (weather === 'storm' && t % 6 < 0.35) drawBolt(g, 1010, 110);
    drawSea(g, SCENE_W, SCENE_H, weather, t);
    if (!v) return;

    const bob = reduced ? 0 : Math.round(Math.sin(t * 1.3)) * 2; // gentle swell, moves everything aboard
    g.save();
    g.translate(0, bob);
    if (ready(IMG.ship)) g.drawImage(IMG.ship, 150, 9);
    if (ready(IMG.flag)) foot(g, IMG.flag, 172, 452);
    if (ready(IMG.wheel)) foot(g, IMG.wheel, 312, 514);
    if (ready(IMG.cannon)) foot(g, IMG.cannon, 700, 503);
    if (ready(IMG.barrel)) foot(g, IMG.barrel, 762, 494);
    if (v.chest.length) {
      drawHalo(g, 512, 545, 110, reduced ? 1 : (Math.sin(t * 3) + 1) / 2);
      foot(g, chestSprite(), 512, 562);
    }
    for (const s of v.sailors) foot(g, sailorSprite(s.pose, s.role, reduced ? 0 : frame, s.flip), s.x, s.feet);
    if (v.fire) {
      drawSmoke(g, 590, 470, reduced ? 0 : t);
      [570, 600, 628].forEach((x, i) => foot(g, fireSprite((reduced ? 0 : frame) + i), x, 562));
    }
    if (v.anchored && ready(IMG.anchor)) {
      g.fillStyle = 'rgb(120,122,134)';
      g.fillRect(862, 470, 4, 92);
      foot(g, IMG.anchor, 864, 600);
    }
    g.restore();
    if (weather === 'storm') drawRain(g, SCENE_W, SCENE_H, reduced ? 0 : t);
  }

  function loop(now: number): void {
    raf = requestAnimationFrame(loop);
    if (document.hidden || now - last < 1000 / FPS) return;
    last = now;
    draw(now / 1000);
  }

  // ---------------------------------------------------------------- overlays

  function tag(s: Sailor): HTMLElement {
    return h('div.ship-tag', { class: [`r-${s.role}`, s.pose === 'sit' && 'quiet'], style: { left: pctX(s.x), top: pctY(s.feet - SPRITE_H - 6 - (s.tagLift ?? 0)) } },
      h('span.dot'), h('b', null, s.id), h('span', null, s.word));
  }

  function card(s: Sailor, st: MusterState): HTMLElement {
    const a = st.agents.find((x) => x.id === s.id);
    const task = taskById(st, a?.taskId);
    const where = task ? `${a?.branch} · ${task.stations.slice(task.stationIndex).join(' → ')}` : a?.branch ?? '';
    return h('div.ship-card', { class: `r-${s.role}`, style: { left: pctX(s.x), top: pctY(s.feet - SPRITE_H - 10) } },
      h('div.row', null, h('span.badge', { class: `b-${s.role}` }, s.role), h('b', null, s.id), h('span.grow'), h('span.mono.faint', null, a ? ageShort(a.lastActivityAt) : '')),
      task ? h('div.title', null, `${task.id} · ${task.title}`) : h('div.title.faint', null, a ? agentStatusLong(st, a).text : ''),
      where && h('div.mono.faint', null, where),
      h('div.link', null, 'Open terminal →'));
  }

  function hit(s: Sailor): HTMLElement {
    return h('button.ship-hit', {
      title: `${s.id}: open terminal`,
      style: { left: pctX(s.x - 26), top: pctY(s.feet - SPRITE_H - 4), width: pctX(52), height: pctY(SPRITE_H + 8) },
      onmouseenter: () => { hovered = s.id; renderOverlay(); },
      onmouseleave: () => { if (hovered === s.id) { hovered = null; renderOverlay(); } },
      onclick: () => openTerminal(s.id),
    });
  }

  function bubble(v: ShipView): HTMLElement | null {
    const n = v.question;
    const cap = v.sailors.find((s) => s.role === 'captain');
    if (!n || !cap) return null;
    const q = n.ask?.length === 1 && !n.ask[0].multiSelect && n.ask[0].options.length <= 3 ? n.ask[0] : null;
    const text = (q?.question ?? n.text).replace(/\s+/g, ' ');
    const answer = (label: string) => {
      void run(api.answerAsk(n.id, [{ choices: [label] }])).then((r) => r && toast(`Answered the Captain: ${label}`));
    };
    return h('div.ship-bubble', { style: { left: pctX(cap.x), top: pctY(cap.feet - SPRITE_H - 18) } },
      h('div.row', null, h('span.pill', null, 'CAPTAIN ASKS'), h('span.grow'), h('span.mono', null, `${n.id} · ${ageShort(n.createdAt)}`)),
      h('div.q', null, text.length > 180 ? `${text.slice(0, 179)}…` : text),
      h('div.actions', null,
        q?.options.map((o, i) => h('button', { class: i === 0 ? 'primary' : 'outline', title: o.description ?? '', onclick: () => answer(o.label) }, o.label)),
        h('button.ghost', { onclick: () => { location.hash = `#/board?note=${n.id}`; } }, 'Answer…')),
      h('div.tail'));
  }

  function chestCallout(v: ShipView): HTMLElement | null {
    if (!v.chest.length) return null;
    return h('div.ship-callout.crew', { style: { left: pctX(512), top: pctY(596) } },
      h('div.txt', null, h('b', null, `${v.chest.length} ready to approve`), h('span', null, `${v.chest.map((t) => t.id).join(' · ')} · reviewed by the Captain`)),
      h('button.go.crew', { onclick: () => void approveAllMerges(v.chest) }, icon('ticks', 14, 2.4), v.chest.length > 1 ? 'Approve all' : 'Approve'));
  }

  function fireCallout(v: ShipView): HTMLElement | null {
    if (!v.fire) return null;
    const first = v.fire.text.split('\n')[0];
    return h('div.ship-callout.warm', { style: { left: pctX(760), top: pctY(598) } },
      h('div.txt', null, h('b', null, 'Merge blocked · fire on deck'), h('span', null, first.length > 70 ? `${first.slice(0, 69)}…` : first)),
      h('button.go.warm', { onclick: () => void commitCheckout() }, 'Commit & merge'),
      h('button.ghost', { onclick: () => void stashCheckout() }, 'Stash'));
  }

  function stuckCallout(e: ShipView['stuck'][number]): HTMLElement {
    const s = e.sailor;
    const said = e.note?.text.replace(/\s+/g, ' ');
    const right = s.x > 400;
    return h('div.ship-callout.stuck.col', { class: right ? 'right' : 'left', style: { left: pctX(right ? s.x + 30 : s.x - 34), top: pctY(right ? s.feet - SPRITE_H + 6 : s.feet - SPRITE_H / 2) } },
      h('div.row', null, h('span.bang', null, '!'), h('b', null, `${s.id} is stuck`), h('span.grow'), h('span.mono.faint', null, ageShort(e.note?.createdAt))),
      said && h('div.said', null, `“${said.length > 110 ? `${said.slice(0, 109)}…` : said}”`),
      h('button.link', { onclick: () => openTerminal(s.id) }, 'Open terminal →'));
  }

  function weatherCallout(v: ShipView): HTMLElement | null {
    if (v.weather === 'clear') return null;
    return h('div.ship-callout.storm.col', { style: { left: pctX(1010), top: pctY(336) } },
      h('div.row', null, h('b', null, `${v.weather === 'storm' ? 'Storm' : 'Clouds'} · weekly usage ${v.weeklyPct}%`)),
      h('div.said', null, 'Clouds roll in at your weekly warning, rain and lightning from 90%. Clears when usage resets.'));
  }

  let overlayKey = '';
  function renderOverlay(): void {
    const v = view;
    const st = state;
    if (!v || !st) return setChildren(overlay);
    const key = JSON.stringify([hovered, v.sailors, v.below, v.anchored, v.weather, v.weeklyPct, v.question?.id, v.question?.text, v.chest.map((t) => t.id),
      v.fire?.text, v.stuck.map((e) => [e.sailor.id, e.note?.id]), st.agents.length, hovered && st.agents.find((a) => a.id === hovered)]);
    if (key === overlayKey) return;
    overlayKey = key;
    const stuckIds = new Set(v.stuck.map((e) => e.sailor.id));
    const captainAsking = !!v.question;
    setChildren(overlay,
      v.sailors.map(hit),
      v.sailors.filter((s) => s.id !== hovered && !stuckIds.has(s.id) && !(s.role === 'captain' && captainAsking)).map(tag),
      v.below > 0 && h('div.ship-tag.quiet', { style: { left: pctX(512), top: pctY(660) } }, h('b', null, `+${v.below}`), h('span', null, 'below deck')),
      v.anchored && h('div.ship-tag.quiet', { style: { left: pctX(864), top: pctY(632) } }, h('b', null, 'Anchored'), h('span', null, 'paused until the 5-hour reset')),
      weatherCallout(v),
      v.stuck.map(stuckCallout),
      chestCallout(v),
      fireCallout(v),
      bubble(v),
      hovered ? (() => { const s = v.sailors.find((x) => x.id === hovered); return s ? card(s, st) : null; })() : null,
      !st.agents.length && h('div.ship-empty', null, h('b', null, 'No crew aboard'), h('span', null, 'Start the Captain with muster up, or add an agent.')));
  }

  function renderStrip(v: ShipView): void {
    setChildren(status, h('div.row', null, h('span.dot', { class: v.tone }), h('b', { class: v.tone }, v.title)), h('div.sub', null, v.sub));
    setChildren(log, h('div.lbl', null, "SHIP'S LOG"),
      v.log.length ? v.log.map((l) => h('div.line', null, h('span.mono', null, l.at), h('span', null, l.text))) : h('div.line.faint', null, 'Quiet so far'));
    hint.textContent = v.tone === 'ok'
      ? 'Hover a sailor for their task · click to open their terminal'
      : 'Fire, a stuck sailor, the chest or the Captain’s bubble: click it to act';
  }

  return {
    el,
    update(s) {
      state = s.state;
      view = shipView(s.state, s.config);
      renderOverlay();
      renderStrip(view);
      if (!visible) return;
      if (reduced) draw(0);
    },
    show() {
      if (visible) return;
      visible = true;
      requestAnimationFrame(fit);
      if (reduced) draw(0);
      else raf = requestAnimationFrame(loop);
    },
    hide() {
      visible = false;
      cancelAnimationFrame(raf);
    },
  };
}
