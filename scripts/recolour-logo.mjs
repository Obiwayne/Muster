// Recolours desktop/logo.svg into named colourways (desktop/logo-colours/<name>.svg).
// The mark's particles use ~20 colour steps in order along the wave, plus a gradient on the solid
// tail; each step is re-mapped to the same position on the new palette, blended in OKLab.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export const COLOURWAYS = {
  twilight: { label: 'Twilight', note: 'Original', stops: ['#AFBFFF', '#4F7BFF', '#8B5CF6', '#E04FD3', '#F0558A'] },
  ember: { label: 'Ember', note: 'Gold to fire red', stops: ['#FFE2A6', '#FFB01F', '#FF7A1A', '#F2441B', '#D91E2A'] },
  sunrise: { label: 'Sunrise', note: 'Yellow to rich orange', stops: ['#FFF6B8', '#FFE03B', '#FFB21A', '#FF8A12', '#FF6A0D'] },
  molten: { label: 'Molten gold', note: 'Gold to deep amber', stops: ['#FFF0C2', '#FFD15C', '#F5A524', '#E07B12', '#B9520B'] },
  citrus: { label: 'Citrus', note: 'Lime to orange', stops: ['#F6FFB8', '#D8F23C', '#FFD21A', '#FFA51F', '#FF7F1F'] },
  sunset: { label: 'Sunset', note: 'Orange to pink to violet', stops: ['#FFD3A1', '#FF9A3D', '#FF5F6D', '#E04FA8', '#9B4BE0'] },
  lagoon: { label: 'Lagoon', note: 'Teal to blue', stops: ['#C2FFF4', '#2DD4BF', '#1CB2D9', '#2F8CF0', '#4F6BFF'] },
  aurora: { label: 'Aurora', note: 'Green to teal to violet', stops: ['#CBFFE4', '#34C77B', '#2DD4BF', '#5A8CF2', '#8B5CF6'] },
  rose: { label: 'Rose gold', note: 'Peach to raspberry', stops: ['#FFE4D4', '#F9B49A', '#F07C82', '#D9487A', '#A82E62'] },
};

// ---- OKLab interpolation
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const toHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function toLab([r, g, b]) {
  [r, g, b] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromLab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(gam);
}
export function sample(stops, t) {
  const labs = stops.map((s) => toLab(hex(s)));
  const x = Math.min(1, Math.max(0, t)) * (labs.length - 1);
  const i = Math.min(labs.length - 2, Math.floor(x));
  const f = x - i;
  return toHex(fromLab(labs[i].map((v, k) => v + (labs[i + 1][k] - v) * f)));
}

export function recolour(svg, name, stops) {
  // Particle colours in order of appearance along the wave → t in [0, 0.85]; the solid tail gets the last 15%.
  const order = [];
  for (const m of svg.matchAll(/fill="(#[0-9A-Fa-f]{6})"/g)) if (!order.includes(m[1].toUpperCase())) order.push(m[1].toUpperCase());
  const map = new Map(order.map((c, i) => [c, sample(stops, (i / Math.max(1, order.length - 1)) * 0.85)]));
  let out = svg.replace(/#[0-9A-Fa-f]{6}/g, (c) => map.get(c.toUpperCase()) ?? c);
  const stopsOut = [sample(stops, 0.82), sample(stops, 1)];
  let k = 0;
  out = out.replace(/stop-color="#[0-9A-Fa-f]{6}"/g, () => `stop-color="${stopsOut[Math.min(k++, 1)]}"`);
  // Ids must be unique per colourway when several sit in one document.
  return out.replace(/id="([^"]+)"/g, `id="$1-${name}"`).replace(/url\(#([^)]+)\)/g, `url(#$1-${name})`);
}

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const base = new URL('../desktop/', import.meta.url);
  const svg = readFileSync(new URL('logo.svg', base), 'utf8');
  mkdirSync(new URL('logo-colours/', base), { recursive: true });
  for (const [name, cw] of Object.entries(COLOURWAYS)) {
    writeFileSync(new URL(`logo-colours/${name}.svg`, base), recolour(svg, name, cw.stops));
    console.log(name, cw.stops.join(' '));
  }
}
