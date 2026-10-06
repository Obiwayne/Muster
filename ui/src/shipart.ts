// Pixel art for the Ship view. The scene is drawn at its true pixel size (SCENE_W × SCENE_H, one unit = one art pixel)
// and the canvas is scaled up with image-rendering: pixelated, so every pixel is the same size. The ship and props are
// sprites (assets/ship/*.png, rebuilt on the sprite sheet's own pixel grid); sky, sea, weather, fire, the chest and
// the crew are drawn here.
import type { Pose, Weather } from './shipmodel';
import type { Role } from '../../src/types';

type RGB = [number, number, number];
const css = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;
/** Blend two colours, k = 0 → a … 1 → b. */
const mix = (a: RGB, b: RGB, k: number): RGB => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * k)) as RGB;
/** How stormy the scene looks: a storm warning is full gloom; otherwise the Kraken's visit sets it (0..1). */
const gloomOf = (weather: Weather, gloom: number) => (weather === 'clear' ? gloom : 1);

/** Small deterministic PRNG so the stars and glints stay put between frames. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export const HORIZON = 186;

// ---------------------------------------------------------------- sky and sea

export function drawSky(g: CanvasRenderingContext2D, w: number, weather: Weather, t: number, gloom = 0): void {
  const k0 = gloomOf(weather, gloom);
  const top = mix([28, 32, 58], [22, 24, 34], k0);
  const bottom = mix([92, 74, 98], [58, 60, 74], k0);
  for (let y = 0; y < HORIZON; y++) {
    g.fillStyle = css(mix(top, bottom, y / HORIZON));
    g.fillRect(0, y, w, 1);
  }
  if (k0 < 1) {
    const fade = 1 - k0;
    const r = rng(4);
    for (let i = 0; i < 56; i++) {
      const x = Math.floor(r() * w);
      const y = Math.floor(r() * HORIZON * 0.62);
      const big = r() < 0.18;
      const tw = 0.35 + 0.65 * Math.abs(Math.sin(t * 0.7 + i * 1.7)); // twinkle
      g.fillStyle = `rgba(230,226,255,${(0.35 + r() * 0.5) * tw * fade})`;
      if (big) {
        g.fillRect(x, y - 1, 1, 3); // a little cross for the bright ones
        g.fillRect(x - 1, y, 3, 1);
      } else {
        g.fillRect(x, y, 1, 1);
      }
    }
    for (let i = 0; i < 18; i++) {
      g.fillStyle = `rgba(255,120,32,${Math.max(0, 0.26 - i * 0.015) * fade})`;
      g.fillRect(0, HORIZON - 1 - i, w, 1);
    }
  }
  // far island
  g.fillStyle = css(mix([34, 30, 52], [30, 30, 40], k0));
  for (let x = 352; x < 459; x++) {
    const hgt = Math.max(0, Math.floor(7 + 5 * Math.sin((x - 352) / 15) + 2 * Math.sin((x - 352) / 5)));
    g.fillRect(x, HORIZON - hgt, 1, hgt);
  }
}

const SEA_CALM: RGB[] = [[30, 52, 92], [26, 46, 84], [22, 40, 74], [19, 34, 64]];
const SEA_STORM: RGB[] = [[30, 40, 58], [26, 34, 50], [22, 29, 44], [18, 24, 38]];

export function drawSea(g: CanvasRenderingContext2D, w: number, h: number, weather: Weather, t: number, gloom = 0): void {
  const k0 = gloomOf(weather, gloom);
  for (let y = HORIZON; y < h; y++) {
    const band = Math.min(3, Math.floor(((y - HORIZON) / (h - HORIZON)) * 4));
    g.fillStyle = css(mix(SEA_CALM[band], SEA_STORM[band], k0));
    g.fillRect(0, y, w, 1);
  }
  const r = rng(9);
  for (let i = 0; i < 130; i++) {
    const y = Math.floor(HORIZON + 3 + r() * (h - HORIZON - 3));
    const depth = (y - HORIZON) / (h - HORIZON);
    const L = 2 + Math.floor(r() * 3 + depth * 4); // nearer waves are longer
    const ember = r() < 0.25; // the sunset glints fade to grey as the storm comes in
    const x0 = r() * w;
    const x = Math.floor(((((x0 - t * (2 + depth * 5)) % (w + 20)) + w + 20) % (w + 20)) - 10); // drift left, faster up close
    g.fillStyle = css(mix(ember ? [232, 140, 80] : [92, 128, 176], [70, 84, 104], k0));
    g.fillRect(x, y, L, 1);
  }
}

/** The sea in front of the hull from `from` down, so the ship floats instead of standing on its keel. */
export function drawWater(g: CanvasRenderingContext2D, w: number, h: number, from: number, weather: Weather, t: number, gloom = 0): void {
  const k0 = gloomOf(weather, gloom);
  for (let y = from; y < h; y++) {
    const band = 1 + Math.min(2, Math.floor(((y - from) / Math.max(1, h - from)) * 3));
    g.fillStyle = css(mix(SEA_CALM[band], SEA_STORM[band], k0));
    g.fillRect(0, y, w, 1);
  }
  g.fillStyle = css(mix([120, 156, 200], [70, 84, 104], k0)); // foam along the waterline, rocking with the swell
  for (let x = 0; x < w; x += 9) if ((x + Math.floor(t * 3)) % 4 !== 0) g.fillRect(x, from, 4, 1);
}

// ---------------------------------------------------------------- weather

let clouds: HTMLCanvasElement | null = null;
/** The storm clouds; drawn once to their own canvas so they can fade in without the overlaps showing. */
export function drawClouds(g: CanvasRenderingContext2D, alpha = 1): void {
  if (alpha <= 0) return;
  if (!clouds) {
    clouds = document.createElement('canvas');
    clouds.width = 470;
    clouds.height = 60;
    const c = clouds.getContext('2d')!;
    for (const [x, y, w] of [[15, 27, 115], [146, 16, 162], [331, 31, 127]]) {
      const r = rng(x);
      c.fillStyle = 'rgb(48,50,66)';
      for (let i = 0; i < w - 16; i += 12) {
        const rad = 9 + Math.floor(r() * 8);
        const cx = x + 8 + i;
        const cy = y - Math.floor(r() * 7);
        for (let yy = -rad; yy < rad; yy++) {
          const half = Math.floor(Math.sqrt(rad * rad - yy * yy));
          c.fillRect(cx - half, cy + yy, half * 2, 1);
        }
      }
      c.fillRect(x, y + 3, w, 9);
      c.fillStyle = 'rgb(36,38,50)';
      c.fillRect(x + 3, y + 10, w - 6, 3);
    }
  }
  g.save();
  g.globalAlpha = alpha;
  g.drawImage(clouds, 0, 0);
  g.restore();
}

export function drawRain(g: CanvasRenderingContext2D, w: number, h: number, t: number): void {
  const r = rng(3);
  const fall = Math.floor(t * 110);
  g.fillStyle = 'rgba(120,140,176,0.85)';
  for (let i = 0; i < 190; i++) {
    const x0 = Math.floor(r() * w);
    const y0 = Math.floor(45 + r() * (h - 45));
    const y = ((y0 - 45 + fall) % (h - 45)) + 45;
    const x = (((x0 - Math.floor((fall % (h - 45)) / 2)) % w) + w) % w;
    for (let k = 0; k < 3; k++) g.fillRect(x - k, y + k, 1, 1);
  }
}

/** A lightning bolt from (x, y) down; `seed` 0 is the usual one, other seeds zigzag differently and run `len` down. */
export function drawBolt(g: CanvasRenderingContext2D, x: number, y: number, seed = 0, len = 88): void {
  let path = [[0, 0], [-11, 25], [-2, 25], [-14, 55], [-5, 55], [-19, 88]];
  if (seed) {
    const r = rng(seed * 7919);
    path = [[0, 0]];
    let px = 0;
    for (let py = 0; py < len;) {
      py = Math.min(len, py + 12 + Math.floor(r() * 14));
      px += Math.floor(r() * 17) - 10;
      path.push([px, py]);
      if (py < len) path.push([px + 6 + Math.floor(r() * 4), py]); // the flat step that makes it read as lightning
      px = path[path.length - 1][0];
    }
  }
  g.fillStyle = 'rgb(255,240,170)';
  for (let p = 0; p < path.length - 1; p++) {
    const [x0, y0] = path[p];
    const [x1, y1] = path[p + 1];
    const steps = Math.max(1, Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)));
    for (let i = 0; i <= steps; i++) g.fillRect(x + x0 + Math.round(((x1 - x0) * i) / steps), y + y0 + Math.round(((y1 - y0) * i) / steps), 2, 1);
  }
}

// ---------------------------------------------------------------- grid sprites

function gridCanvas(text: string, pal: Record<string, string | undefined>, flip = false): HTMLCanvasElement {
  const rows = text.replace(/^\n+|\n+$/g, '').split('\n');
  const w = Math.max(...rows.map((r) => r.length));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = rows.length;
  const g = c.getContext('2d')!;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const col = pal[row[x]];
      if (!col) continue;
      g.fillStyle = col;
      g.fillRect(flip ? w - 1 - x : x, y, 1, 1);
    }
  });
  return c;
}

// Crew: original sprites, 14 px wide. x/X = the role colour (bandana, shirt stripes).
const BASE_PAL: Record<string, string> = {
  k: 'rgb(24,20,26)',
  s: 'rgb(236,186,144)',
  S: 'rgb(198,142,106)',
  h: 'rgb(74,46,34)',
  w: 'rgb(238,236,242)',
  W: 'rgb(196,196,210)',
  p: 'rgb(52,62,100)',
  P: 'rgb(38,44,74)',
  b: 'rgb(44,32,30)',
  L: 'rgb(110,70,40)',
  m: 'rgb(176,178,190)',
  M: 'rgb(120,122,134)',
  H: 'rgb(150,100,56)',
  c: 'rgb(34,30,40)',
  a: 'rgb(245,165,36)',
  o: 'rgb(170,56,44)',
  O: 'rgb(126,38,34)',
  e: 'rgb(60,40,30)',
};
const ROLE_PAL: Record<string, { x: string; X: string }> = {
  crew: { x: 'rgb(45,212,191)', X: 'rgb(24,150,136)' },
  qa: { x: 'rgb(100,140,255)', X: 'rgb(60,96,210)' },
  design: { x: 'rgb(167,139,250)', X: 'rgb(118,96,196)' },
  captain: { x: 'rgb(245,165,36)', X: 'rgb(196,120,30)' },
};
const GRIDS: Record<string, string> = {
  stand: `
.....xxxx.....
....xxxxxxX...
...xxxxxxxXX..
...hsssssshX..
...hsksskss...
...hsssssss...
....sSSSs.....
.....ssss.....
...wwwwwwww...
..sxxxxxxxxs..
..swwwwwwwws..
..sxxxxxxxxs..
..s.wwwwww.s..
.....LLLL.....
....pppppp....
....pppPpp....
....pp..pp....
....pp..pp....
....PP..PP....
...bbb..bbb...`,
  hammer: `
..........mm..
..........mm..
.....xxxx..H..
....xxxxxxXH..
...xxxxxxxXH..
...hssssssH...
...hsksskssH..
...hsssssss...
....sSSSs.....
.....ssss.....
...wwwwwwwws..
..sxxxxxxxx...
..swwwwwwww...
..sxxxxxxxx...
..s.wwwwww....
.....LLLL.....
....pppppp....
....pppPpp....
....pp..pp....
....pp..pp....
....PP..PP....
...bbb..bbb...`,
  hammer2: `
.....xxxx.....
....xxxxxxX...
...xxxxxxxXX..
...hsssssshX..
...hsksskss...
...hsssssss...
....sSSSs.....
.....ssss.....
...wwwwwwww...
..sxxxxxxxxs..
..swwwwwwwws..
..sxxxxxxxxsH.
..s.wwwwww..H.
............H.
...........mmm
.....LLLL.....
....pppppp....
....pppPpp....
....pp..pp....
....pp..pp....
....PP..PP....
...bbb..bbb...`,
  haul: `
.....xxxx.....
....xxxxxxX...
...xxxxxxxXX..
...hsssssshX..
...hsksskss...
...hsssssss...
....sSSSs.....
.....ssss.....
...wwwwwwww...
..sxxxxxxxxsss
..swwwwwwww..H
..sxxxxxxxx..H
..sswwwwww...H
.....LLLL.....
....pppppp....
....pppPpp....
....pp..pp....
....pp..pp....
....PP..PP....
...bbb..bbb...`,
  haul2: `
.....xxxx.....
....xxxxxxX...
...xxxxxxxXX..
...hsssssshX..
...hsksskss...
...hsssssss...
....sSSSs.....
.....ssss.....
...wwwwwwwwsss
..sxxxxxxxxs.H
..swwwwwwww..H
..sxxxxxxxx..H
..s.wwwwww...H
.....LLLL.....
....pppppp....
....pppPpp....
....pp..pp....
....pp..pp....
....PP..PP....
...bbb..bbb...`,
  sit: `
.....xxxx.....
....xxxxxxX...
...xxxxxxxXX..
...hsssssshX..
...hsksskss...
...hsssssss...
....sSSSs.....
.....ssss.....
...wwwwwwww...
..sxxxxxxxxs..
..swwwwwwwws..
..sxxxxxxxxs..
..s.wwwwww.s..
.....LLLL.....
...pppppppp...
...pppPpppp...
...pp....pp...
...bb....bb...`,
  stuck: `
..s........s..
..s..xxxx..s..
..s.xxxxxxXs..
..sxxxxxxxXs..
..shsssssshs..
..shsksskss.s.
...hsssssss...
...ssSkkSs....
.....ssss.....
...wwwwwwww...
...xxxxxxxx...
...wwwwwwww...
...xxxxxxxx...
....wwwwww....
.....LLLL.....
....pppppp....
....pppPpp....
....pp..pp....
....pp..pp....
....PP..PP....
...bbb..bbb...`,
  captain: `
....cccccc....
...cccccccc...
..caccccccac..
.cccccccccccc.
...hsssssh....
...hsksskss...
...hsssssss...
...eeSSSee....
...eeeeeeee...
....eeeeee....
..oooaaaaooo..
.ooooOaaOoooo.
.so.ooaaoo.os.
.so.oOaaOo.os.
.mmmmmaaoo..s.
....LLaaLL....
...oooppooo...
...oo.pp.oo...
....pp..pp....
....PP..PP....
...bbb..bbb...`,
  captain_wave: `
............s.
....cccccc..s.
...cccccccc.s.
..caccccccacs.
.ccccccccccco.
...hsssssh..o.
...hsksskss.o.
...hsssssss.o.
...eeSSSee..o.
...eeeeeeeeo..
....eeeeeeo...
..oooaaaaoo...
.ooooOaaOoo...
.so.ooaaoo....
.so.oOaaOo....
.s..ooaaoo....
....LLaaLL....
...oooppooo...
...oo.pp.oo...
....pp..pp....
....PP..PP....
...bbb..bbb...`,
  captain_wave2: `
..............
....cccccc....
...cccccccc.ss
..caccccccacso
.ccccccccccco.
...hsssssh..o.
...hsksskss.o.
...hsssssss.o.
...eeSSSee..o.
...eeeeeeeeo..
....eeeeeeo...
..oooaaaaoo...
.ooooOaaOoo...
.so.ooaaoo....
.so.oOaaOo....
.s..ooaaoo....
....LLaaLL....
...oooppooo...
...oo.pp.oo...
....pp..pp....
....PP..PP....
...bbb..bbb...`,
  push: `
.....xxxx.....
....xxxxxxX...
...xxxxxxxXX..
...hsssssshX..
...hsksskss...
...hsssssss...
....sSSSs.....
.....ssss.....
...wwwwwwwwsss
..wxxxxxxxx.ss
..wwwwwwwww...
..wxxxxxxxx...
...wwwwwww....
....LLLL......
...pppppp.....
...ppPpppp....
..pp...ppp....
..pp....pp....
.PP.....PP....
bbb.....bbb...`,
  push2: `
.....xxxx.....
....xxxxxxX...
...xxxxxxxXX..
...hsssssshX..
...hsksskss...
...hsssssss...
....sSSSs.....
.....ssss.....
...wwwwwwwwsss
..wxxxxxxxx.ss
..wwwwwwwww...
..wxxxxxxxx...
...wwwwwww....
....LLLL......
...pppppp.....
...pppPpp.....
...pp.ppp.....
...pp..pp.....
...pp..PP.....
..bbb.bbb.....`,
};
/** The second animation frame of each pose (static poses repeat). */
const FRAME2: Partial<Record<Pose, string>> = { hammer: 'hammer2', haul: 'haul2', captain_wave: 'captain_wave2', push: 'push2' };

const spriteCache = new Map<string, HTMLCanvasElement>();
export function sailorSprite(pose: Exclude<Pose, 'barrel'>, role: Role, frame: number, flip = false): HTMLCanvasElement {
  const name = frame % 2 && FRAME2[pose] ? FRAME2[pose]! : pose;
  const key = `${name}|${role}|${flip}`;
  let c = spriteCache.get(key);
  if (!c) {
    c = gridCanvas(GRIDS[name], { ...BASE_PAL, ...(ROLE_PAL[role] ?? ROLE_PAL.crew) }, flip);
    spriteCache.set(key, c);
  }
  return c;
}

let chest: HTMLCanvasElement | null = null;
export function chestSprite(): HTMLCanvasElement {
  return (chest ??= gridCanvas(`
...bbbbbbbbbb...
..bhhhhhhhhhhb..
.bhHhhhhhhhhHhb.
.bhhhhhhhhhhhhb.
bggggggaaggggggb
bhhhhhhaaahhhhhb
bhhhhhhhahhhhhhb
bhHhhhhhhhhhhHhb
bggggggggggggggb
.bbbbbbbbbbbbbb.`, { b: 'rgb(60,34,22)', h: 'rgb(150,90,44)', H: 'rgb(118,68,32)', g: 'rgb(245,165,36)', a: 'rgb(255,226,120)' }));
}

const FIRE_PAL = { r: 'rgb(226,58,34)', o: 'rgb(255,128,32)', y: 'rgb(255,214,92)', w: 'rgb(255,246,210)' };
const FIRE = [`
....r.....
...rr..r..
..rorr.rr.
..rooorror
.roooyoor.
.royywyyor
royywwyyor
rooywwyyor
.rooyyyoor`, `
.....r....
..r..rr...
..rr.ror.r
.roo.roorr
.rooooyoor
roooyyoyor
royywwyyor
rooywwwyor
.rooyyyor.`];
const fireCache: HTMLCanvasElement[] = [];
export function fireSprite(frame: number): HTMLCanvasElement {
  const i = frame % 2;
  return (fireCache[i] ??= gridCanvas(FIRE[i], FIRE_PAL));
}

export function drawSmoke(g: CanvasRenderingContext2D, x: number, y: number, t: number): void {
  const r = rng(1);
  const rise = (t * 8) % 10;
  for (let i = 0; i < 7; i++) {
    const s = 3 + Math.floor(i * 1.3);
    const cx = Math.floor(x + r() * 10 - 4 + i * 2.5);
    const cy = Math.floor(y - i * 9 - rise);
    const v = 70 + i * 6;
    g.fillStyle = `rgba(${v},${v},${v + 8},${1 - i * 0.11})`;
    g.fillRect(cx, cy, s, s);
  }
}

export function drawHalo(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, pulse: number): void {
  for (let i = r; i > 0; i -= 2) {
    g.fillStyle = `rgba(245,165,36,${0.12 * (1 - i / r) * (0.75 + 0.25 * pulse)})`;
    g.beginPath();
    g.ellipse(cx, cy, i, i * 0.6, 0, 0, Math.PI * 2);
    g.fill();
  }
}

/** Draws a sprite with its feet on `feet`, centred on `x`. */
export function foot(g: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, x: number, feet: number): void {
  g.drawImage(img, Math.round(x - img.width / 2), Math.round(feet - img.height));
}

// ---------------------------------------------------------------- the barrel game

const BARREL_W = 24;
const BARREL_H = 13;
/** A barrel on its side with a sailor inside: boots out of one end, head out of the other. `roll` is how far it has
 *  rolled in art pixels, so the staves turn with the distance travelled. The pushers stand behind it. */
export function barrelSprite(roll: number, role: Role): HTMLCanvasElement {
  const turn = ((Math.floor(roll / 2) % 4) + 4) % 4;
  const key = `barrel|${turn}|${role}`;
  let c = spriteCache.get(key);
  if (c) return c;
  const head = gridCanvas(`
..xxxx.
.xxxxxX
.hssssX
.skssk.
.sssss.
..sSs..`, { ...BASE_PAL, ...(ROLE_PAL[role] ?? ROLE_PAL.crew) });
  c = document.createElement('canvas');
  c.width = BARREL_W + 8;
  c.height = BARREL_H + 3;
  const g = c.getContext('2d')!;
  const px = (col: string, x: number, y: number, w = 1, h = 1) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  // boots sticking out of the near end
  px(BASE_PAL.b, 0, 7, 3, 2);
  px(BASE_PAL.b, 0, 11, 3, 2);
  const X0 = 3;
  const Y0 = 3;
  for (let y = 0; y < BARREL_H; y++) {
    for (let x = 0; x < BARREL_W; x++) {
      const edge = y === 0 || y === BARREL_H - 1;
      if (edge && (x < 2 || x > BARREL_W - 3)) continue;
      let col: string;
      if (edge || x === 0 || x === BARREL_W - 1) col = 'rgb(60,34,22)';
      else if (x <= 2) col = y === 1 || y === BARREL_H - 2 ? 'rgb(74,42,24)' : 'rgb(96,56,30)'; // the lid end
      else if (x === 6 || x === BARREL_W - 5) col = (y + turn) % 4 === 0 ? 'rgb(176,178,190)' : 'rgb(120,122,134)'; // hoops
      else col = (y + turn) % 4 < 2 ? 'rgb(150,90,44)' : 'rgb(118,68,32)';
      px(col, X0 + x, Y0 + y);
    }
  }
  g.drawImage(head, X0 + BARREL_W - 2, 4); // head poking out of the open end
  spriteCache.set(key, c);
  return c;
}

// ---------------------------------------------------------------- the Kraken

export interface Tentacle {
  x: number; // where it comes out of the sea
  sea: number; // the sea's surface there
  len: number; // length in art pixels when fully out
  thick: number; // radius at the base
  lean: number; // starting angle (radians from upright)
  bend: number; // steady bend along its length
  curl: number; // how hard the tip curls
  dir: 1 | -1; // -1 leans and curls toward the ship (left)
  phase: number; // so two tentacles don't sway in step
}

export interface SpinePoint { x: number; y: number; nx: number; ny: number; r: number }

const T_OUT: RGB = [74, 16, 38];
const T_BODY: RGB = [182, 58, 88];
const T_TOP: RGB = [214, 92, 116];
const T_BELLY: RGB = [236, 150, 160];
const T_SUCK: RGB = [138, 104, 186];
const T_SUCK_IN: RGB = [86, 58, 128];

/** A filled pixel circle (whole pixels only, so it stays on the art grid). */
function disc(g: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  const x0 = Math.round(cx);
  const y0 = Math.round(cy);
  const ri = Math.floor(r);
  for (let dy = -ri; dy <= ri; dy++) {
    const half = Math.floor(Math.sqrt(r * r - dy * dy) + 0.3);
    g.fillRect(x0 - half, y0 + dy, half * 2 + 1, 1);
  }
}

/** Points along a tentacle's spine from the base to the tip; (nx, ny) points to the inner side of the curl. */
export function tentacleSpine(T: Tentacle, rise: number, t: number, flinch: number): SpinePoint[] {
  const ds = 0.5;
  const n = Math.round(T.len / ds);
  let x = T.x;
  let y = T.sea + T.len * (1 - rise) + 2; // the rest is still under water: the tip comes up first
  const pts: SpinePoint[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const sway = 0.2 * Math.sin(t * 1.5 + T.phase + u * 2.6) * u;
    const jolt = flinch * 0.45 * Math.sin(t * 24 + u * 4) * u;
    const a = T.lean + T.bend * u + T.curl * u * u * u + sway + jolt;
    pts.push({ x, y, nx: T.dir * Math.cos(a), ny: T.dir * Math.sin(a), r: T.thick * Math.pow(1 - u, 0.85) + 0.5 });
    x += T.dir * Math.sin(a) * ds;
    y -= Math.cos(a) * ds;
  }
  return pts;
}

/** Draws one tentacle (only the part above the sea) and returns its spine so the cannon can aim at it. */
export function drawTentacle(g: CanvasRenderingContext2D, T: Tentacle, rise: number, t: number, flinch: number): SpinePoint[] {
  const pts = tentacleSpine(T, rise, t, flinch);
  if (rise <= 0) return pts;
  g.save();
  g.beginPath();
  g.rect(0, 0, 9999, T.sea);
  g.clip();
  const hurt = flinch > 0.6; // it flashes pale for a moment when a ball hits
  g.fillStyle = css(T_OUT);
  for (const p of pts) disc(g, p.x, p.y, p.r + 1);
  g.fillStyle = css(hurt ? T_BELLY : T_BODY);
  for (const p of pts) disc(g, p.x, p.y, p.r);
  g.fillStyle = css(hurt ? [250, 210, 214] : T_TOP);
  for (const p of pts) if (p.r > 1.6) disc(g, p.x - p.nx * p.r * 0.45, p.y - p.ny * p.r * 0.45, p.r * 0.35);
  g.fillStyle = css(T_BELLY);
  for (const p of pts) if (p.r > 1.2) disc(g, p.x + p.nx * p.r * 0.5, p.y + p.ny * p.r * 0.5, p.r * 0.45);
  // suckers along the belly, smaller toward the tip
  for (let i = 6; i < pts.length * 0.86; i += 9) {
    const p = pts[i];
    const sx = Math.round(p.x + p.nx * p.r * 0.55);
    const sy = Math.round(p.y + p.ny * p.r * 0.55);
    const big = p.r > 3.4;
    g.fillStyle = css(T_SUCK);
    g.fillRect(sx - 1, sy - 1, big ? 3 : 2, big ? 3 : 2);
    g.fillStyle = css(T_SUCK_IN);
    g.fillRect(sx, sy, 1, 1);
  }
  g.restore();
  return pts;
}

/** Foam churning round a tentacle where it breaks the surface. */
export function drawSplash(g: CanvasRenderingContext2D, x: number, sea: number, width: number, rise: number, t: number): void {
  if (rise <= 0.02) return;
  const r = rng(Math.round(x));
  const spread = width + 4 + Math.round(rise * 4);
  for (let i = 0; i < 26; i++) {
    const dx = Math.round((r() * 2 - 1) * spread);
    const hop = Math.max(0, Math.round(Math.sin(t * 6 + i * 1.9) * 2 * rise));
    g.fillStyle = i % 3 ? 'rgb(196,214,232)' : 'rgb(240,246,252)';
    g.fillRect(x + dx, sea - hop - (Math.abs(dx) < width ? 1 : 0), 1 + (i % 2), 1);
  }
  g.fillStyle = 'rgba(220,232,244,0.75)';
  g.fillRect(x - spread, sea + 1, spread * 2, 1);
}

/** The flash and smoke at the cannon's mouth, `since` seconds after it fired. */
export function drawMuzzle(g: CanvasRenderingContext2D, x: number, y: number, since: number): void {
  const px = (col: string, dx: number, dy: number, w: number, h: number) => { g.fillStyle = col; g.fillRect(x + dx, y + dy, w, h); };
  if (since < 0.15) {
    px('rgb(255,128,32)', 1, -4, 9, 9);
    px('rgb(255,214,92)', 0, -3, 9, 7);
    px('rgb(255,214,92)', 3, -5, 3, 11);
    px('rgb(255,246,210)', 0, -2, 6, 5);
    px('rgb(255,128,32)', 10, -1, 3, 3);
  }
  // puffs of smoke drifting up and away, clear of the deck
  for (let i = 0; i < 5; i++) {
    const k = since * 1.1 - i * 0.1;
    if (k <= 0 || k > 1.4) continue;
    const sz = 3 + Math.floor(k * 5) + (i % 2);
    const v = Math.round(226 - k * 70);
    g.fillStyle = `rgba(${v},${v},${v + 6},${Math.max(0, 0.9 - k * 0.6)})`;
    g.fillRect(Math.round(x + 3 + i * 3 + k * 10 - sz / 2), Math.round(y - 4 - k * 20 - i * 2 - sz / 2), sz, sz);
  }
}

/** A cannonball at (x, y), with a short smoky trail back toward (px, py) where it was a moment ago. */
export function drawCannonball(g: CanvasRenderingContext2D, x: number, y: number, px: number, py: number): void {
  for (let i = 1; i <= 4; i++) {
    const k = i / 5;
    g.fillStyle = `rgba(200,200,214,${0.5 - k * 0.4})`;
    g.fillRect(Math.round(x + (px - x) * k), Math.round(y + (py - y) * k), 2, 2);
  }
  const bx = Math.round(x) - 2;
  const by = Math.round(y) - 2;
  g.fillStyle = 'rgb(16,14,18)';
  g.fillRect(bx, by + 1, 4, 2);
  g.fillRect(bx + 1, by, 2, 4);
  g.fillStyle = 'rgb(150,150,166)';
  g.fillRect(bx + 1, by + 1, 1, 1);
}

/** Sparks where a ball strikes, `k` 0..1 through the burst. */
export function drawHit(g: CanvasRenderingContext2D, x: number, y: number, k: number): void {
  const r = rng(Math.round(x * 31 + y));
  for (let i = 0; i < 12; i++) {
    const a = r() * Math.PI * 2;
    const d = 2 + k * (6 + r() * 6);
    g.fillStyle = i % 3 === 0 ? 'rgb(255,246,210)' : i % 3 === 1 ? 'rgb(255,214,92)' : 'rgb(255,128,32)';
    g.fillRect(Math.round(x + Math.cos(a) * d), Math.round(y + Math.sin(a) * d), 1, 1);
  }
  if (k < 0.35) {
    g.fillStyle = 'rgb(255,246,210)';
    g.fillRect(Math.round(x) - 2, Math.round(y) - 1, 5, 3);
    g.fillRect(Math.round(x) - 1, Math.round(y) - 2, 3, 5);
  }
}
