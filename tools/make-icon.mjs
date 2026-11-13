// Icon generator: draws the xMonkey mark and writes a .icns for the macOS app.
//
// Pure Node with zlib — no image libraries, no ffmpeg filters, no canvas. The
// mark is a geometric monkey: rounded dark tile, orange head, muzzle, ears and
// eyes. Deterministic, so rebuilding the app always produces the same icon.
//
// Usage: node tools/make-icon.mjs [outDir]

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const OUT = process.argv[2] || 'app/assets';
const SIZE = 1024;

// ---------------------------------------------------------------- drawing

class Canvas {
  constructor(size) {
    this.size = size;
    this.px = new Uint8Array(size * size * 4);   // RGBA
  }

  blend(x, y, [r, g, b], a = 1) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size || a <= 0) return;
    const i = (y * this.size + x) * 4;
    const dstA = this.px[i + 3] / 255;
    const outA = a + dstA * (1 - a);
    if (outA === 0) return;
    this.px[i] = Math.round((r * a + this.px[i] * dstA * (1 - a)) / outA);
    this.px[i + 1] = Math.round((g * a + this.px[i + 1] * dstA * (1 - a)) / outA);
    this.px[i + 2] = Math.round((b * a + this.px[i + 2] * dstA * (1 - a)) / outA);
    this.px[i + 3] = Math.round(outA * 255);
  }

  /** Rounded rectangle with 4x4 supersampling for a clean edge. */
  roundRect(x0, y0, w, h, r, color, alpha = 1) {
    const S = 4;
    for (let y = Math.floor(y0); y < Math.ceil(y0 + h); y++) {
      for (let x = Math.floor(x0); x < Math.ceil(x0 + w); x++) {
        let hits = 0;
        for (let sy = 0; sy < S; sy++) {
          for (let sx = 0; sx < S; sx++) {
            const px = x + (sx + 0.5) / S;
            const py = y + (sy + 0.5) / S;
            if (px < x0 || py < y0 || px > x0 + w || py > y0 + h) continue;
            const cx = Math.min(Math.max(px, x0 + r), x0 + w - r);
            const cy = Math.min(Math.max(py, y0 + r), y0 + h - r);
            const dx = px - cx, dy = py - cy;
            if (dx * dx + dy * dy <= r * r) hits++;
          }
        }
        if (hits) this.blend(x, y, color, (hits / (S * S)) * alpha);
      }
    }
  }

  /** Filled ellipse with supersampling. */
  ellipse(cx, cy, rx, ry, color, alpha = 1) {
    const S = 4;
    for (let y = Math.floor(cy - ry) - 1; y <= Math.ceil(cy + ry) + 1; y++) {
      for (let x = Math.floor(cx - rx) - 1; x <= Math.ceil(cx + rx) + 1; x++) {
        let hits = 0;
        for (let sy = 0; sy < S; sy++) {
          for (let sx = 0; sx < S; sx++) {
            const px = x + (sx + 0.5) / S;
            const py = y + (sy + 0.5) / S;
            const nx = (px - cx) / rx;
            const ny = (py - cy) / ry;
            if (nx * nx + ny * ny <= 1) hits++;
          }
        }
        if (hits) this.blend(x, y, color, (hits / (S * S)) * alpha);
      }
    }
  }

  toPNG() {
    const { size } = this;
    const raw = Buffer.alloc((size * 4 + 1) * size);
    for (let y = 0; y < size; y++) {
      raw[y * (size * 4 + 1)] = 0;   // filter: none
      this.px.subarray(y * size * 4, (y + 1) * size * 4)
        .forEach((v, i) => { raw[y * (size * 4 + 1) + 1 + i] = v; });
    }
    const idat = zlib.deflateSync(raw, { level: 9 });
    const chunk = (type, data) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(body) >>> 0);
      return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;    // bit depth
    ihdr[9] = 6;    // colour type RGBA
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', idat),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- the mark

const C = {
  tile: [0x1b, 0x1e, 0x24],
  tileEdge: [0x24, 0x28, 0x30],
  fur: [0xf2, 0xa3, 0x3c],      // xMonkey orange
  furDark: [0xc9, 0x7a, 0x12],
  face: [0xff, 0xd9, 0xa8],     // muzzle
  ink: [0x1b, 0x1e, 0x24],
};

function drawMark(c) {
  const S = c.size;
  const u = S / 1024;              // design unit
  // App tile (macOS icons leave breathing room inside the canvas).
  c.roundRect(84 * u, 84 * u, 856 * u, 856 * u, 190 * u, C.tile);

  const cx = 512 * u, cy = 520 * u;

  // Ears
  c.ellipse(cx - 235 * u, cy - 40 * u, 105 * u, 118 * u, C.furDark);
  c.ellipse(cx + 235 * u, cy - 40 * u, 105 * u, 118 * u, C.furDark);
  c.ellipse(cx - 235 * u, cy - 40 * u, 62 * u, 70 * u, C.face);
  c.ellipse(cx + 235 * u, cy - 40 * u, 62 * u, 70 * u, C.face);

  // Head
  c.ellipse(cx, cy - 60 * u, 250 * u, 232 * u, C.fur);
  // Muzzle lobes + chin
  c.ellipse(cx - 88 * u, cy + 62 * u, 118 * u, 104 * u, C.face);
  c.ellipse(cx + 88 * u, cy + 62 * u, 118 * u, 104 * u, C.face);
  c.ellipse(cx, cy + 130 * u, 150 * u, 96 * u, C.face);

  // Brow ridge
  c.ellipse(cx, cy - 128 * u, 196 * u, 88 * u, C.fur);

  // Eyes
  c.ellipse(cx - 96 * u, cy - 40 * u, 38 * u, 44 * u, C.ink);
  c.ellipse(cx + 96 * u, cy - 40 * u, 38 * u, 44 * u, C.ink);
  c.ellipse(cx - 84 * u, cy - 54 * u, 13 * u, 15 * u, [255, 255, 255]);
  c.ellipse(cx + 108 * u, cy - 54 * u, 13 * u, 15 * u, [255, 255, 255]);

  // Nose + mouth
  c.ellipse(cx, cy + 76 * u, 30 * u, 22 * u, C.ink);
  c.roundRect(cx - 62 * u, cy + 132 * u, 124 * u, 12 * u, 6 * u, C.ink);
}

// ---------------------------------------------------------------- icns

function writeIcns(png1024, outFile) {
  // Build the iconset and let iconutil package it: it produces a valid .icns
  // with every size macOS asks for, including @2x.
  const iconset = path.join(OUT, 'xmonkey.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });
  const src = path.join(OUT, 'icon-1024.png');
  fs.writeFileSync(src, png1024);

  const sizes = [
    ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
  ];
  for (const [name, px] of sizes) {
    execFileSync('sips', ['-z', String(px), String(px), src, '--out', path.join(iconset, name)], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', outFile]);
  fs.rmSync(iconset, { recursive: true, force: true });
  return outFile;
}

fs.mkdirSync(OUT, { recursive: true });
const canvas = new Canvas(SIZE);
drawMark(canvas);
const png = canvas.toPNG();
fs.writeFileSync(path.join(OUT, 'icon-1024.png'), png);
const icns = writeIcns(png, path.join(OUT, 'icon.icns'));
console.log(JSON.stringify({
  png: path.join(OUT, 'icon-1024.png'),
  icns,
  pngBytes: png.length,
  icnsBytes: fs.statSync(icns).size,
}));
