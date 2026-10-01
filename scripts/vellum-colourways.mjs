// Lays out the logo colourways on the "Logo — colourways" artboard in the Vellum file "Muster",
// through Vellum's MCP CLI (F:/Vellum/mcp/test/call.mjs). Usage: node scripts/vellum-colourways.mjs <artboardId>
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COLOURWAYS, recolour, sample } from './recolour-logo.mjs';

const FILE = '28BUsqILtGqq';
const artboard = process.argv[2];
const base = readFileSync(new URL('../desktop/logo.svg', import.meta.url), 'utf8');
const small = readFileSync(new URL('../desktop/logo-small.svg', import.meta.url), 'utf8');

function call(tool, args) {
  const f = join(tmpdir(), `vellum-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify({ fileId: FILE, ...args }));
  const out = execFileSync(process.execPath, ['F:/Vellum/mcp/test/call.mjs', tool, '@' + f], { cwd: 'F:/Vellum', encoding: 'utf8', maxBuffer: 1 << 26 });
  const json = out.slice(out.search(/\}\s*\{/) + 1).trim(); // the result follows the {file,contentHash} header
  return JSON.parse(json);
}
const write = (target, html) => call('write_html', { targetNodeId: target, mode: 'insert-children', html }).createdNodeIds;
const sized = (svg, name, w, h) => recolour(svg, name, COLOURWAYS[name].stops).replace('<svg ', `<svg width="${w}" height="${h}" `);

// Header
write(artboard, `<div data-name="Header" style="display:flex;flex-direction:column;gap:12px">
  <div style="font-size:12px;font-weight:600;letter-spacing:0.1em;color:var(--color-faint)">07 · LOGO · COLOURWAYS</div>
  <div style="font-size:44px;font-weight:650;letter-spacing:-0.02em;line-height:50px">Nine colourways for the mark</div>
  <div style="font-size:15px;line-height:23px;color:var(--color-muted);width:720px">Same particle swoosh, recoloured along the wave in OKLab so the gradients stay rich. Warm options first: Ember, Sunrise, Molten gold and Citrus. Twilight is the original.</div>
</div>`);

const [grid] = write(artboard, `<div data-name="Colourways" style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:20px"></div>`);
const order = ['ember', 'sunrise', 'molten', 'citrus', 'sunset', 'rose', 'twilight', 'aurora', 'lagoon'];
for (const name of order) {
  const cw = COLOURWAYS[name];
  const glow = sample(cw.stops, 0.55);
  const dots = cw.stops.map((c) => `<div style="width:14px;height:14px;border-radius:7px;background:${c};flex-shrink:0"></div>`).join('');
  write(grid, `<div data-name="Colourway — ${cw.label}" style="display:flex;flex-direction:column;border-radius:16px;background:var(--color-surface);border:1px solid var(--color-line);overflow:hidden">
  <div data-name="Stage" style="height:270px;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden;background:radial-gradient(60% 70% at 50% 55%, color-mix(in oklab, ${glow} 18%, transparent), transparent 70%), #0C0C0E">${sized(base, name, 340, 170)}</div>
  <div data-name="Meta" style="display:flex;align-items:center;gap:12px;padding:16px 18px;border-top:1px solid var(--color-line)">
    <div style="display:flex;flex-direction:column;gap:3px;flex:1"><div style="font-size:15px;font-weight:600">${cw.label}</div><div style="font-size:12px;color:var(--color-muted)">${cw.note}</div></div>
    <div style="display:flex;gap:4px">${dots}</div>
  </div>
</div>`);
}

// Warm picks as app icons and on light
const [warm] = write(artboard, `<div data-name="Warm picks" style="display:flex;flex-direction:column;gap:16px">
  <div style="font-size:12px;font-weight:600;letter-spacing:0.1em;color:var(--color-faint)">07 · LOGO · WARM PICKS AS APP ICONS AND ON LIGHT</div>
</div>`);
const [row] = write(warm, `<div data-name="Icons" style="display:flex;gap:20px;align-items:flex-end"></div>`);
for (const name of ['ember', 'sunrise', 'molten', 'citrus']) {
  write(row, `<div data-name="Icon — ${COLOURWAYS[name].label}" style="display:flex;flex-direction:column;align-items:center;gap:10px">
  <div style="width:150px;height:150px;border-radius:34px;display:flex;align-items:center;justify-content:center;background:radial-gradient(90% 90% at 75% 15%, #2A2230, #17171B 60%, #111113);border:1px solid var(--color-line)">${sized(small, name, 112, 56)}</div>
  <div style="font-size:12px;color:var(--color-muted)">${COLOURWAYS[name].label}</div>
</div>`);
}
write(row, `<div style="width:12px"></div>`);
for (const name of ['ember', 'sunrise']) {
  write(row, `<div data-name="On light — ${COLOURWAYS[name].label}" style="display:flex;flex-direction:column;align-items:center;gap:10px">
  <div style="width:280px;height:150px;border-radius:16px;display:flex;align-items:center;justify-content:center;background:#F4F4F5">${sized(base, name, 220, 110)}</div>
  <div style="font-size:12px;color:var(--color-muted)">${COLOURWAYS[name].label} on light</div>
</div>`);
}
call('update_styles', { updates: [{ nodeIds: [artboard], styles: { height: 'fit-content' } }] });
console.log('done');
