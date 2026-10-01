// Builds the app icon from the Ember logo: desktop/icon.svg (the tile), icon.png (256) and icon.ico.
// Run with Electron (it renders the SVG): node_modules/electron/dist/electron.exe scripts/build-icon.cjs
//
// The .ico holds 16–256 px. Sizes below 256 are stored as classic 32-bit bitmaps (DIB), not PNG:
// the taskbar and Explorer often fail to draw PNG-compressed small entries, which leaves a blank
// icon on pinned apps.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const desk = path.join(__dirname, '..', 'desktop');
const full = fs.readFileSync(path.join(desk, 'logo-colours', 'ember.svg'), 'utf8');
const small = fs.readFileSync(path.join(desk, 'logo-ember-small.svg'), 'utf8');

// Tile: graphite rounded square with a warm glow; the mark sits slightly below centre.
function tile(mark, size) {
  const inner = mark.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  const viewBox = mark.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
  const tiny = size <= 32; // small icons: fill the square and enlarge the mark so it still reads
  const inset = tiny ? 0 : 8;
  const markW = tiny ? 236 : 196; // of 256
  const markH = (markW * viewBox[3]) / viewBox[2];
  const x = (256 - markW) / 2;
  const y = (256 - markH) / 2 + 6;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
  <defs>
    <radialGradient id="tile-bg" cx="0.72" cy="0.18" r="0.95"><stop offset="0" stop-color="#3A2418"/><stop offset="0.55" stop-color="#1A1716"/><stop offset="1" stop-color="#111113"/></radialGradient>
    <radialGradient id="tile-glow" cx="0.5" cy="0.56" r="0.5"><stop offset="0" stop-color="#FF7A1A" stop-opacity="0.22"/><stop offset="1" stop-color="#FF7A1A" stop-opacity="0"/></radialGradient>
  </defs>
  <rect x="${inset}" y="${inset}" width="${256 - 2 * inset}" height="${256 - 2 * inset}" rx="${tiny ? 48 : 56}" fill="url(#tile-bg)"/>
  <rect x="${inset}" y="${inset}" width="${256 - 2 * inset}" height="${256 - 2 * inset}" rx="${tiny ? 48 : 56}" fill="url(#tile-glow)"/>
  ${tiny ? '' : '<rect x="8.5" y="8.5" width="239" height="239" rx="55.5" fill="none" stroke="#2D2D32"/>'}
  <svg x="${x}" y="${y}" width="${markW}" height="${markH}" viewBox="${viewBox.join(' ')}">${inner}</svg>
</svg>`;
}

async function render(win, svg, size) {
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`));
  await new Promise((r) => setTimeout(r, 250));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  return img.getSize().width === size ? img : img.resize({ width: size, height: size, quality: 'best' });
}

// 32-bit BGRA DIB with an all-zero AND mask (alpha carries transparency).
function dib(img, size) {
  const bgra = img.toBitmap(); // BGRA, top-down
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND masks
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4, 20);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) bgra.copy(pixels, (size - 1 - y) * size * 4, y * size * 4, (y + 1) * size * 4); // bottom-up
  const maskRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 256, height: 256, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  const sizes = [256, 64, 48, 40, 32, 24, 20, 16];
  const entries = [];
  for (const size of sizes) {
    const svg = tile(size >= 128 ? full : small, size);
    const img = await render(win, svg, size);
    if (size === 256) {
      fs.writeFileSync(path.join(desk, 'icon.svg'), tile(full, 256));
      fs.writeFileSync(path.join(desk, 'icon.png'), img.toPNG());
    }
    entries.push({ size, data: size === 256 ? img.toPNG() : dib(img, size) });
  }
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach(({ size, data }, i) => {
    const o = 6 + 16 * i;
    head.writeUInt8(size === 256 ? 0 : size, o);
    head.writeUInt8(size === 256 ? 0 : size, o + 1);
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(data.length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  fs.writeFileSync(path.join(desk, 'icon.ico'), Buffer.concat([head, ...entries.map((e) => e.data)]));
  console.log('icon.ico:', entries.map((e) => `${e.size}${e.size === 256 ? 'png' : 'bmp'}`).join(' '));
  app.quit();
});
