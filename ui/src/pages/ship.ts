// Dashboard → Ship: the crew as pixel sailors on a pirate ship (design: Vellum "Muster" › Ship).
// Anything that needs you is loud (Captain's bubble, treasure chest, fire, a sailor stuck in the rigging); the rest is ambient.
// The scene is drawn at its true pixel size (470×277) and scaled up evenly; overlays are HTML placed in % of the scene so
// their text stays crisp at any size.
import type { MusterState } from '../../../src/types';
import { h, icon, setChildren, toast } from '../dom';
import type { Snapshot } from '../events';
import { api } from '../api';
import { approveAllMerges, commitCheckout, run, stashCheckout } from '../actions';
import { agentStatusLong, ageShort, taskById } from '../util';
import { SCENE_H, SCENE_W, SHIP_X, SHIP_Y, WATERLINE, shipView, type Sailor, type ShipView } from '../shipmodel';
import { barrelSprite, chestSprite, drawBolt, drawCannonball, drawClouds, drawHalo, drawHit, drawMuzzle, drawRain, drawSea, drawSky, drawSmoke, drawSplash,
  drawTentacle, drawWater, fireSprite, foot, HORIZON as HORIZON_Y, sailorSprite, type SpinePoint, type Tentacle } from '../shipart';
import { SHOT_FLIGHT, krakenFrame } from '../kraken';
import shipPng from '../assets/ship/ship.png';
import flagPng from '../assets/ship/flag.png';
import wheelPng from '../assets/ship/wheel.png';
import cannonPng from '../assets/ship/cannon.png';
import barrelPng from '../assets/ship/barrel.png';
import anchorPng from '../assets/ship/anchor.png';
import './ship.css';

const FPS = 8;
const SPRITE_H = 21; // a sailor is ~21 art pixels tall

function img(src: string): HTMLImageElement {
  const i = new Image();
  i.src = src;
  return i;
}
const IMG = { ship: img(shipPng), flag: img(flagPng), wheel: img(wheelPng), cannon: img(cannonPng), barrel: img(barrelPng), anchor: img(anchorPng) };
const ready = (i: HTMLImageElement) => i.complete && i.naturalWidth > 0;
const onImagesLoaded = (cb: () => void) => Object.values(IMG).forEach((i) => i.addEventListener('load', cb));

/** The Kraken's two tentacles, off the bow (art pixels). */
const TENTACLES: Tentacle[] = [
  { x: 418, sea: 238, len: 118, thick: 8, lean: -0.3, bend: 0.5, curl: 3.6, dir: -1, phase: 0 },
  { x: 452, sea: 246, len: 74, thick: 5.5, lean: -0.15, bend: 0.6, curl: 4.2, dir: -1, phase: 2 },
];
/** Where the bow cannon's mouth is, and where on each tentacle it aims (0 base … 1 tip). */
const MUZZLE = { x: SHIP_X + 250, y: SHIP_Y + 187 };
const AIM = [0.42, 0.5];
/** Lightning during a visit: where each strike comes down. */
const STRIKES = [30, 440, 408, 52, 462, 18]; // clear of the ship, so a bolt never seems to hit the crew
/** The barrel rolls this far either side of the middle of the main deck. */
const ROLL = 10;

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
  let shownAt = 0; // the Kraken keeps its own clock from when the Ship view opened
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
    const k = v && !reduced ? krakenFrame(t - shownAt) : null;
    const gloom = k?.gloom ?? 0;
    drawSky(g, SCENE_W, weather, t, gloom);
    drawClouds(g, weather !== 'clear' ? 1 : gloom);
    if (weather === 'storm' && t % 6 < 0.35) drawBolt(g, 393, 43);
    if (k?.bolt != null) drawBolt(g, STRIKES[k.bolt], 34, k.bolt + 1, HORIZON_Y - 34);
    drawSea(g, SCENE_W, SCENE_H, weather, t, gloom);
    if (!v) return;

    // the Kraken, off the bow
    const spines: SpinePoint[][] = [];
    if (k) {
      TENTACLES.forEach((T, i) => {
        spines.push(drawTentacle(g, T, k.rise[i], t, k.flinch[i]));
        drawSplash(g, T.x, T.sea, T.thick + 2, k.rise[i], t);
      });
    }

    const bob = reduced ? 0 : Math.round(Math.sin(t * 1.3) * (k && gloom > 0.5 ? 2 : 1)); // the swell; rougher while the Kraken is here
    const X = SHIP_X;
    const Y = SHIP_Y;
    g.save();
    g.translate(0, bob);
    if (ready(IMG.ship)) g.drawImage(IMG.ship, X, Y);
    drawWater(g, SCENE_W, SCENE_H + 2, WATERLINE, weather, reduced ? 0 : t, gloom);
    if (ready(IMG.flag)) foot(g, IMG.flag, X + 10, Y + 184);
    if (ready(IMG.wheel)) foot(g, IMG.wheel, X + 100, Y + 206);
    if (ready(IMG.cannon)) foot(g, IMG.cannon, X + 236 - Math.round((k?.recoil ?? 0) * 2), Y + 202);
    if (ready(IMG.barrel)) foot(g, IMG.barrel, X + 262, Y + 198);
    if (v.chest.length) {
      drawHalo(g, X + 154, Y + 220, 44, reduced ? 1 : (Math.sin(t * 3) + 1) / 2);
      foot(g, chestSprite(), X + 154, Y + 227);
    }
    // the barrel game: the pushers first so the barrel rolls in front of their legs
    const roll = reduced ? 0 : Math.round(ROLL * Math.sin(t * 0.9));
    const moving = !reduced && Math.abs(Math.cos(t * 0.9)) > 0.2;
    for (const s of v.sailors) if (s.pose === 'push') foot(g, sailorSprite('push', s.role, moving ? Math.floor(roll / 2) : 0, s.flip), s.x + roll, s.feet);
    for (const s of v.sailors) if (s.pose === 'barrel') foot(g, barrelSprite(roll, s.role), s.x + roll, s.feet);
    g.fillStyle = 'rgb(236,186,144)'; // the pushers' hands on top of the barrel
    for (const s of v.sailors) if (s.pose === 'push') g.fillRect(s.x + roll + (s.flip ? -7 : 5), s.feet - 14, 3, 2);
    for (const s of v.sailors) if (s.pose !== 'push' && s.pose !== 'barrel') foot(g, sailorSprite(s.pose, s.role, reduced ? 0 : frame, s.flip), s.x, s.feet);
    if (v.fire) {
      drawSmoke(g, X + 194, Y + 190, reduced ? 0 : t);
      [X + 186, X + 197, X + 208].forEach((x, i) => foot(g, fireSprite((reduced ? 0 : frame) + i), x, Y + 224));
    }
    if (v.anchored && ready(IMG.anchor)) {
      g.fillStyle = 'rgb(120,122,134)';
      g.fillRect(X + 316, Y + 180, 1, 52);
      foot(g, IMG.anchor, X + 317, Y + 250);
    }
    for (const s of k?.shots ?? []) drawMuzzle(g, MUZZLE.x, MUZZLE.y, s.since);
    g.restore();

    // cannonballs on their way to the tentacles, and the sparks where they land
    for (const s of k?.shots ?? []) {
      const spine = spines[s.target];
      if (!spine?.length) continue;
      const aim = spine[Math.floor((spine.length - 1) * AIM[s.target])];
      if (s.fly < 1) {
        const path = (f: number) => [MUZZLE.x + (aim.x - MUZZLE.x) * f, MUZZLE.y + bob + (aim.y - MUZZLE.y - bob) * f - 26 * 4 * f * (1 - f)]; // a high arc, clear of the barrel on the bow
        const [x, y] = path(s.fly);
        const [px, py] = path(Math.max(0, s.fly - 0.15));
        drawCannonball(g, x, y, px, py);
      } else if (s.since - SHOT_FLIGHT < 0.5) {
        drawHit(g, aim.x, aim.y, (s.since - SHOT_FLIGHT) / 0.5);
      }
    }
    if (weather === 'storm' || gloom > 0.6) drawRain(g, SCENE_W, SCENE_H, reduced ? 0 : t);
    if (k?.flash) {
      g.fillStyle = `rgba(226,232,255,${0.22 * k.flash})`;
      g.fillRect(0, 0, SCENE_W, SCENE_H);
    }
  }

  function loop(now: number): void {
    raf = requestAnimationFrame(loop);
    if (document.hidden || now - last < 1000 / FPS) return;
    last = now;
    draw(now / 1000);
  }

  // ---------------------------------------------------------------- overlays

  function tag(s: Sailor): HTMLElement {
    return h('div.ship-tag', { class: [`r-${s.role}`, s.pose === 'sit' && 'quiet'], style: { left: pctX(s.x), top: pctY(s.feet - SPRITE_H - 3 - (s.tagLift ?? 0)) } },
      h('span.dot'), h('b', null, s.id), h('span', null, s.word));
  }

  function card(s: Sailor, st: MusterState): HTMLElement {
    const a = st.agents.find((x) => x.id === s.id);
    const task = taskById(st, a?.taskId);
    const where = task ? `${a?.branch} · ${task.stations.slice(task.stationIndex).join(' → ')}` : a?.branch ?? '';
    return h('div.ship-card', { class: `r-${s.role}`, style: { left: pctX(s.x), top: pctY(s.feet - SPRITE_H - 4) } },
      h('div.row', null, h('span.badge', { class: `b-${s.role}` }, s.role), h('b', null, s.id), h('span.grow'), h('span.mono.faint', null, a ? ageShort(a.lastActivityAt) : '')),
      task ? h('div.title', null, `${task.id} · ${task.title}`) : h('div.title.faint', null, a ? agentStatusLong(st, a).text : ''),
      where && h('div.mono.faint', null, where),
      h('div.link', null, 'Open terminal →'));
  }

  function hit(s: Sailor): HTMLElement {
    return h('button.ship-hit', {
      title: `${s.id}: open terminal`,
      style: { left: pctX(s.x - 10), top: pctY(s.feet - SPRITE_H - 2), width: pctX(20), height: pctY(SPRITE_H + 4) },
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
    return h('div.ship-bubble', { style: { left: pctX(cap.x), top: pctY(cap.feet - SPRITE_H - 8) } },
      h('div.row', null, h('span.pill', null, 'CAPTAIN ASKS'), h('span.grow'), h('span.mono', null, `${n.id} · ${ageShort(n.createdAt)}`)),
      h('div.q', null, text.length > 180 ? `${text.slice(0, 179)}…` : text),
      h('div.actions', null,
        q?.options.map((o, i) => h('button', { class: i === 0 ? 'primary' : 'outline', title: o.description ?? '', onclick: () => answer(o.label) }, o.label)),
        h('button.ghost', { onclick: () => { location.hash = `#/board?note=${n.id}`; } }, 'Answer…')),
      h('div.tail'));
  }

  function chestCallout(v: ShipView): HTMLElement | null {
    if (!v.chest.length) return null;
    return h('div.ship-callout.crew', { style: { left: pctX(SHIP_X + 154), top: pctY(SHIP_Y + 234) } },
      h('div.txt', null, h('b', null, `${v.chest.length} ready to approve`), h('span', null, `${v.chest.map((t) => t.id).join(' · ')} · reviewed by the Captain`)),
      h('button.go.crew', { onclick: () => void approveAllMerges(v.chest) }, icon('ticks', 14, 2.4), v.chest.length > 1 ? 'Approve all' : 'Approve'));
  }

  function fireCallout(v: ShipView): HTMLElement | null {
    if (!v.fire) return null;
    const first = v.fire.text.split('\n')[0];
    return h('div.ship-callout.warm', { style: { left: pctX(SHIP_X + 270), top: pctY(SHIP_Y + 236) } },
      h('div.txt', null, h('b', null, 'Merge blocked · fire on deck'), h('span', null, first.length > 70 ? `${first.slice(0, 69)}…` : first)),
      h('button.go.warm', { onclick: () => void commitCheckout() }, 'Commit & merge'),
      h('button.ghost', { onclick: () => void stashCheckout() }, 'Stash'));
  }

  function stuckCallout(e: ShipView['stuck'][number]): HTMLElement {
    const s = e.sailor;
    const said = e.note?.text.replace(/\s+/g, ' ');
    const right = s.x > SHIP_X + 110;
    return h('button.ship-chip.stuck', {
      class: right ? 'right' : 'left',
      title: said ? `${s.id}: “${said}”
Click to open their terminal` : `Open ${s.id}'s terminal`,
      style: { left: pctX(right ? s.x + 9 : s.x - 9), top: pctY(s.feet - SPRITE_H + 4) },
      onclick: () => openTerminal(s.id),
    }, h('span.bang', null, '!'), h('b', null, `${s.id} is stuck`), h('span.faint', null, ageShort(e.note?.createdAt)), h('span.go', null, 'Open →'));
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
      v.below > 0 && h('div.ship-tag.quiet', { style: { left: pctX(SHIP_X + 154), top: pctY(SHIP_Y + 262) } }, h('b', null, `+${v.below}`), h('span', null, 'below deck')),
      v.anchored && h('div.ship-tag.quiet', { style: { left: pctX(SHIP_X + 317), top: pctY(SHIP_Y + 262) } }, h('b', null, 'Anchored'), h('span', null, 'paused until the 5-hour reset')),
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
      shownAt = performance.now() / 1000;
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
