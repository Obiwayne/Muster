// Pixel art for the Ship view. The scene is drawn at its true pixel size (SCENE_W × SCENE_H, one unit = one art pixel)
// and the canvas is scaled up with image-rendering: pixelated, so every pixel is the same size. The ship and props are
// sprites (assets/ship/*.png, rebuilt on the sprite sheet's own pixel grid); sky, sea, weather, fire, the chest and
// the crew are drawn here.
import type { Pose, Weather } from './shipmodel';
import type { Role } from '../../src/types';

type RGB = [number, number, number];
const css = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** Small deterministic PRNG so the stars and glints stay put between frames. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export const HORIZON = 186;

// ---------------------------------------------------------------- sky and sea

export function drawSky(g: CanvasRenderingContext2D, w: number, weather: Weather, t: number): void {
  const storm = weather !== 'clear';
  const top: RGB = storm ? [22, 24, 34] : [28, 32, 58];
  const bottom: RGB = storm ? [58, 60, 74] : [92, 74, 98];
  for (let y = 0; y < HORIZON; y++) {
    const k = y / HORIZON;
    g.fillStyle = css([0, 1, 2].map((i) => Math.round(top[i] + (bottom[i] - top[i]) * k)) as RGB);
    g.fillRect(0, y, w, 1);
  }
  if (!storm) {
    const r = rng(4);
    for (let i = 0; i < 56; i++) {
      const x = Math.floor(r() * w);
      const y = Math.floor(r() * HORIZON * 0.62);
      const big = r() < 0.18;
      const tw = 0.35 + 0.65 * Math.abs(Math.sin(t * 0.7 + i * 1.7)); // twinkle
      g.fillStyle = `rgba(230,226,255,${(0.35 + r() * 0.5) * tw})`;
      if (big) {
        g.fillRect(x, y - 1, 1, 3); // a little cross for the bright ones
        g.fillRect(x - 1, y, 3, 1);
      } else {
        g.fillRect(x, y, 1, 1);
      }
    }
    for (let i = 0; i < 18; i++) {
      g.fillStyle = `rgba(255,120,32,${Math.max(0, 0.26 - i * 0.015)})`;
      g.fillRect(0, HORIZON - 1 - i, w, 1);
    }
  }
  // far island
  g.fillStyle = storm ? 'rgb(30,30,40)' : 'rgb(34,30,52)';
  for (let x = 352; x < 459; x++) {
    const hgt = Math.max(0, Math.floor(7 + 5 * Math.sin((x - 352) / 15) + 2 * Math.sin((x - 352) / 5)));
    g.fillRect(x, HORIZON - hgt, 1, hgt);
  }
}

export function drawSea(g: CanvasRenderingContext2D, w: number, h: number, weather: Weather, t: number): void {
  const storm = weather !== 'clear';
  const deep: RGB[] = storm ? [[30, 40, 58], [26, 34, 50], [22, 29, 44], [18, 24, 38]] : [[30, 52, 92], [26, 46, 84], [22, 40, 74], [19, 34, 64]];
  for (let y = HORIZON; y < h; y++) {
    g.fillStyle = css(deep[Math.min(3, Math.floor(((y - HORIZON) / (h - HORIZON)) * 4))]);
    g.fillRect(0, y, w, 1);
  }
  const r = rng(9);
  for (let i = 0; i < 130; i++) {
    const y = Math.floor(HORIZON + 3 + r() * (h - HORIZON - 3));
    const depth = (y - HORIZON) / (h - HORIZON);
    const L = 2 + Math.floor(r() * 3 + depth * 4); // nearer waves are longer
    const ember = r() < 0.25 && !storm;
    const x0 = r() * w;
    const x = Math.floor(((((x0 - t * (2 + depth * 5)) % (w + 20)) + w + 20) % (w + 20)) - 10); // drift left, faster up close
    g.fillStyle = storm ? 'rgb(70,84,104)' : ember ? 'rgb(232,140,80)' : 'rgb(92,128,176)';
    g.fillRect(x, y, L, 1);
  }
}

/** The sea in front of the hull from `from` down, so the ship floats instead of standing on its keel. */
export function drawWater(g: CanvasRenderingContext2D, w: number, h: number, from: number, weather: Weather, t: number): void {
  const storm = weather !== 'clear';
  const deep: RGB[] = storm ? [[26, 34, 50], [22, 29, 44], [18, 24, 38]] : [[26, 46, 84], [22, 40, 74], [19, 34, 64]];
  for (let y = from; y < h; y++) {
    g.fillStyle = css(deep[Math.min(2, Math.floor(((y - from) / Math.max(1, h - from)) * 3))]);
    g.fillRect(0, y, w, 1);
  }
  g.fillStyle = storm ? 'rgb(70,84,104)' : 'rgb(120,156,200)'; // foam along the waterline, rocking with the swell
  for (let x = 0; x < w; x += 9) if ((x + Math.floor(t * 3)) % 4 !== 0) g.fillRect(x, from, 4, 1);
}

// ---------------------------------------------------------------- weather

export function drawClouds(g: CanvasRenderingContext2D): void {
  for (const [x, y, w] of [[15, 27, 115], [146, 16, 162], [331, 31, 127]]) {
    const r = rng(x);
    g.fillStyle = 'rgb(48,50,66)';
    for (let i = 0; i < w - 16; i += 12) {
      const rad = 9 + Math.floor(r() * 8);
      const cx = x + 8 + i;
      const cy = y - Math.floor(r() * 7);
      for (let yy = -rad; yy < rad; yy++) {
        const half = Math.floor(Math.sqrt(rad * rad - yy * yy));
        g.fillRect(cx - half, cy + yy, half * 2, 1);
      }
    }
    g.fillRect(x, y + 3, w, 9);
    g.fillStyle = 'rgb(36,38,50)';
    g.fillRect(x + 3, y + 10, w - 6, 3);
  }
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

export function drawBolt(g: CanvasRenderingContext2D, x: number, y: number): void {
  const path = [[0, 0], [-11, 25], [-2, 25], [-14, 55], [-5, 55], [-19, 88]];
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
};
/** The second animation frame of each pose (static poses repeat). */
const FRAME2: Partial<Record<Pose, string>> = { hammer: 'hammer2', haul: 'haul2', captain_wave: 'captain_wave2' };

const spriteCache = new Map<string, HTMLCanvasElement>();
export function sailorSprite(pose: Pose, role: Role, frame: number, flip = false): HTMLCanvasElement {
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
