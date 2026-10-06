// Pixel art for the Ship view, drawn on a 1220×720 canvas in 4px "pixels". The ship and props are sprites
// (assets/ship/*.png); sky, sea, weather, fire, the chest and the crew are drawn here.
import type { Pose, Weather } from './shipmodel';
import type { Role } from '../../src/types';

type RGB = [number, number, number];
const css = (c: RGB, a = 1) => (a === 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`);

/** Small deterministic PRNG so the stars and glints stay put between frames. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export const HORIZON = 500;

// ---------------------------------------------------------------- sky and sea

export function drawSky(g: CanvasRenderingContext2D, w: number, weather: Weather, t: number): void {
  const storm = weather !== 'clear';
  const top: RGB = storm ? [22, 24, 34] : [28, 32, 58];
  const bottom: RGB = storm ? [58, 60, 74] : [92, 74, 98];
  for (let y = 0; y < HORIZON; y += 4) {
    const k = y / HORIZON;
    g.fillStyle = css([0, 1, 2].map((i) => Math.round(top[i] + (bottom[i] - top[i]) * k)) as RGB);
    g.fillRect(0, y, w, 4);
  }
  if (!storm) {
    const r = rng(4);
    for (let i = 0; i < 60; i++) {
      const x = Math.floor((r() * w) / 4) * 4;
      const y = Math.floor((r() * HORIZON * 0.6) / 4) * 4;
      const s = r() < 0.33 ? 8 : 4;
      const tw = 0.35 + 0.65 * Math.abs(Math.sin(t * 0.7 + i * 1.7)); // twinkle
      g.fillStyle = `rgba(230,226,255,${(0.35 + r() * 0.5) * tw})`;
      g.fillRect(x, y, s, s);
    }
    for (let i = 0; i < 14; i++) {
      g.fillStyle = `rgba(255,120,32,${Math.max(0, 64 - i * 5) / 255})`;
      g.fillRect(0, HORIZON - 4 * (i + 1), w, 4);
    }
  }
  // far island
  g.fillStyle = storm ? 'rgb(30,30,40)' : 'rgb(34,30,52)';
  for (let x = 840; x < 1120; x += 4) {
    const hgt = Math.floor(18 + 14 * Math.sin((x - 840) / 40) + 8 * Math.sin((x - 840) / 13));
    g.fillRect(x, HORIZON - hgt, 4, hgt);
  }
}

export function drawSea(g: CanvasRenderingContext2D, w: number, h: number, weather: Weather, t: number): void {
  const storm = weather !== 'clear';
  const deep: RGB[] = storm ? [[30, 40, 58], [26, 34, 50], [22, 29, 44], [18, 24, 38]] : [[30, 52, 92], [26, 46, 84], [22, 40, 74], [19, 34, 64]];
  for (let y = HORIZON; y < h; y += 4) {
    g.fillStyle = css(deep[Math.min(3, Math.floor(((y - HORIZON) / (h - HORIZON)) * 4))]);
    g.fillRect(0, y, w, 4);
  }
  const r = rng(9);
  const drift = Math.floor(t * 6) * 4; // glints slide slowly to the left
  for (let i = 0; i < 170; i++) {
    const y = Math.floor((HORIZON + 8 + r() * (h - HORIZON - 8)) / 4) * 4;
    const L = [8, 12, 16, 24][Math.floor(r() * 4)];
    const ember = r() < 0.25 && !storm;
    const x = (((Math.floor((r() * w) / 4) * 4 - drift * (0.5 + (y - HORIZON) / (h - HORIZON))) % (w + 40)) + w + 40) % (w + 40) - 20;
    g.fillStyle = storm ? 'rgb(70,84,104)' : ember ? 'rgb(232,140,80)' : 'rgb(92,128,176)';
    g.fillRect(Math.floor(x / 4) * 4, y, L, 4);
  }
}

// ---------------------------------------------------------------- weather

export function drawClouds(g: CanvasRenderingContext2D, dark = 'rgb(48,50,66)'): void {
  for (const [x, y, w] of [[40, 70, 300], [380, 40, 420], [860, 80, 330]]) {
    const r = rng(x);
    g.fillStyle = dark;
    for (let i = 0; i < w - 40; i += 28) {
      const rad = 22 + Math.floor(r() * 18);
      const cx = x + 20 + i;
      const cy = y - Math.floor(r() * 18);
      for (let yy = -rad; yy < rad; yy += 4) {
        const half = Math.floor(Math.sqrt(rad * rad - yy * yy) / 4) * 4;
        g.fillRect(cx - half, cy + yy, half * 2, 4);
      }
    }
    g.fillRect(x, y + 8, w, 20);
    g.fillStyle = 'rgb(36,38,50)';
    g.fillRect(x + 8, y + 24, w - 16, 8);
  }
}

export function drawRain(g: CanvasRenderingContext2D, w: number, h: number, t: number): void {
  const r = rng(3);
  const fall = Math.floor(t * 60) * 4;
  g.fillStyle = 'rgb(120,140,176)';
  for (let i = 0; i < 260; i++) {
    const x0 = Math.floor((r() * w) / 4) * 4;
    const y0 = Math.floor((120 + r() * (h - 120)) / 4) * 4;
    const y = ((y0 - 120 + fall) % (h - 120)) + 120;
    const x = (((x0 - Math.floor((fall % (h - 120)) / 4) * 4) % w) + w) % w;
    for (let k = 0; k < 3; k++) g.fillRect(x - k * 4, y + k * 4, 4, 4);
  }
}

export function drawBolt(g: CanvasRenderingContext2D, x: number, y: number): void {
  const path = [[0, 0], [-24, 56], [-4, 56], [-32, 124], [-12, 124], [-44, 200]];
  g.fillStyle = 'rgb(255,240,170)';
  for (let p = 0; p < path.length - 1; p++) {
    const [x0, y0] = path[p];
    const [x1, y1] = path[p + 1];
    const steps = Math.max(1, Math.floor(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / 4));
    for (let i = 0; i <= steps; i++) {
      const px = x + x0 + Math.floor(((x1 - x0) * i) / steps);
      const py = y + y0 + Math.floor(((y1 - y0) * i) / steps);
      g.fillRect(Math.floor(px / 4) * 4, Math.floor(py / 4) * 4, 8, 4);
    }
  }
}

// ---------------------------------------------------------------- grid sprites

function gridCanvas(text: string, pal: Record<string, string | undefined>, px = 4, flip = false): HTMLCanvasElement {
  const rows = text.replace(/^\n+|\n+$/g, '').split('\n');
  const w = Math.max(...rows.map((r) => r.length));
  const c = document.createElement('canvas');
  c.width = w * px;
  c.height = rows.length * px;
  const g = c.getContext('2d')!;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const col = pal[row[x]];
      if (!col) continue;
      g.fillStyle = col;
      g.fillRect((flip ? w - 1 - x : x) * px, y * px, px, px);
    }
  });
  return c;
}

const BASE_PAL: Record<string, string> = {
  k: 'rgb(24,20,26)', s: 'rgb(236,186,144)', S: 'rgb(198,142,106)', w: 'rgb(236,236,242)', g: 'rgb(120,122,134)',
  p: 'rgb(52,62,100)', b: 'rgb(44,32,30)', h: 'rgb(156,110,70)', m: 'rgb(170,172,184)', r: 'rgb(242,85,90)',
  c: 'rgb(34,30,40)', a: 'rgb(245,165,36)', o: 'rgb(178,92,34)', O: 'rgb(140,70,28)', e: 'rgb(60,44,34)',
};
const ROLE_PAL: Record<string, { x: string; y: string }> = {
  crew: { x: 'rgb(45,212,191)', y: 'rgb(32,150,136)' },
  qa: { x: 'rgb(79,123,255)', y: 'rgb(56,92,200)' },
  design: { x: 'rgb(167,139,250)', y: 'rgb(118,96,196)' },
  captain: { x: 'rgb(245,165,36)', y: 'rgb(196,120,30)' },
};

const GRIDS: Record<string, string> = {
  stand: `
...xxxx....
..xxxxxx...
..xsssss...
...sksks...
...sssss...
....SSS....
..wyywyyw..
.swwywwyws.
.s.yywyy.s.
...wwywww..
...ppppp...
...pp.pp...
...pp.pp...
..bbb.bbb..`,
  hammer: `
.........mm
...xxxx..mm
..xxxxxx.h.
..xsssssh..
...sksksh..
...sssssh..
....SSSs...
..wyywyw...
.swwywwy...
.s.yywyy...
...wwywww..
...ppppp...
...pp.pp...
..bbb.bbb..`,
  hammer2: `
...........
...xxxx....
..xxxxxx...
..xsssss...
...sksks...
...sssss...
....SSS....
..wyywyyw..
.swwywwyws.
.s.yywyy.sh
...wwywww.h
...ppppp.mm
...pp.pp.mm
..bbb.bbb..`,
  haul: `
...........
...xxxx....
..xxxxxx...
..xsssss...
...sksks...
...sssss...
....SSS..s.
..wyywyyws.
.swwywwyw..
ss.yywyy...
...wwywww..
...ppppp...
..pp...pp..
.bbb...bbb.`,
  haul2: `
...........
...xxxx....
..xxxxxx...
..xsssss...
...sksks...
...sssss...
....SSS....
..wyywyyss.
.swwywwyw..
.ssyywyy...
...wwywww..
...ppppp...
...pp.pp...
..bbb.bbb..`,
  sit: `
...xxxx....
..xxxxxx...
..xsssss...
...skkks...
...sssss...
....SSS....
..wyywyyw..
.swwywwyws.
.s.yywyy.s.
...wwywww..
..ppppppp..
..pp...pp..
..bb...bb..`,
  stuck: `
.s.......s.
.s.xxxx..s.
.sxxxxxx.s.
..xsssss.s.
..ssksks.s.
...sssssss.
....SSS....
...wyywy...
...wwyww...
...yywyy...
...wwywww..
...ppppp...
...pp.pp...
..bbb.bbb..`,
  captain: `
..cccccccc.
.caccccccac
...cccccc..
...sssss...
...sksks...
...eeeee...
...eesee...
..oooaooo..
.ooOoaoOoo.
.sooooaoo..
mmmmmooooo.
..ooooooo..
...ppppp...
...pp.pp...
..bbb.bbb..`,
  captain_wave: `
.........s.
..ccccccccs
.caccccccas
...cccccc.s
...sssss..o
...sksks.oo
...eeeee.o.
...eesee.o.
..oooaooo..
.ooOoaoOo..
.sooooaoo..
.sooooooo..
...ppppp...
...pp.pp...
..bbb.bbb..`,
  captain_wave2: `
...........
..cccccccc.
.caccccccac
...cccccc..
...sssss.ss
...sksks.so
...eeeee.o.
...eesee.o.
..oooaooo..
.ooOoaoOo..
.sooooaoo..
.sooooooo..
...ppppp...
...pp.pp...
..bbb.bbb..`,
};

/** The second animation frame of each pose (static poses repeat). */
const FRAME2: Partial<Record<Pose, string>> = { hammer: 'hammer2', haul: 'haul2', captain_wave: 'captain_wave2' };

const spriteCache = new Map<string, HTMLCanvasElement>();
export function sailorSprite(pose: Pose, role: Role, frame: number, flip = false): HTMLCanvasElement {
  const name = frame % 2 && FRAME2[pose] ? FRAME2[pose]! : pose;
  const pal = ROLE_PAL[role] ?? ROLE_PAL.crew;
  const key = `${name}|${role}|${flip}`;
  let c = spriteCache.get(key);
  if (!c) {
    c = gridCanvas(GRIDS[name], { ...BASE_PAL, ...pal }, 4, flip);
    spriteCache.set(key, c);
  }
  return c;
}

let chest: HTMLCanvasElement | null = null;
export function chestSprite(): HTMLCanvasElement {
  return (chest ??= gridCanvas(`
..bbbbbbbbbb..
.bhhhhhhhhhhb.
bhhhhhhhhhhhhb
bggggggaggggggb
bhhhhhaaahhhhb
bhhhhhhahhhhhb
bhhhhhhhhhhhhb
bggggggggggggb
.bbbbbbbbbbbb.`, { b: 'rgb(60,34,22)', h: 'rgb(150,90,44)', g: 'rgb(245,165,36)', a: 'rgb(255,226,120)' }, 5));
}

const FIRE_PAL = { r: 'rgb(226,58,34)', o: 'rgb(255,128,32)', y: 'rgb(255,214,92)', w: 'rgb(255,246,210)' };
const FIRE = [`
.....r......
....rr...r..
...rorr..rr.
..rooor.ror.
..roooorroor
.rooyyoooyor
.royywyoyyor
rooywwyyywor
rooyywwywyor
.rooyyyyyoor`, `
......r.....
..r..rr.....
..rr.ror..r.
.ror.roor.rr
.roorooor.or
rooyoooyoror
royywoyyyoor
rooywwywyoor
.rooywwyyor.
..rooyyyoor.`];
const fireCache: HTMLCanvasElement[] = [];
export function fireSprite(frame: number): HTMLCanvasElement {
  const i = frame % 2;
  return (fireCache[i] ??= gridCanvas(FIRE[i], FIRE_PAL));
}

export function drawSmoke(g: CanvasRenderingContext2D, x: number, y: number, t: number): void {
  const r = rng(1);
  const rise = (t * 18) % 22;
  for (let i = 0; i < 7; i++) {
    const s = 8 + i * 3;
    const cx = Math.floor((x + Math.floor(r() * 24) - 10 + i * 6) / 4) * 4;
    const cy = Math.floor((y - i * 22 - rise) / 4) * 4;
    const v = 70 + i * 6;
    g.fillStyle = `rgba(${v},${v},${v + 8},${1 - i * 0.1})`;
    g.fillRect(cx, cy, s, s);
  }
}

export function drawHalo(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, pulse: number): void {
  for (let i = r; i > 0; i -= 4) {
    g.fillStyle = `rgba(245,165,36,${(0.28 * (1 - i / r)) * (0.75 + 0.25 * pulse)})`;
    g.beginPath();
    g.ellipse(cx, cy, i, i * 0.6, 0, 0, Math.PI * 2);
    g.fill();
  }
}

/** Draws a sprite with its feet on `feet`, centred on `x`. */
export function foot(g: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, x: number, feet: number): void {
  g.drawImage(img, Math.round(x - img.width / 2), Math.round(feet - img.height));
}
