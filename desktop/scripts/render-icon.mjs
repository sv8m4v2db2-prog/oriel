#!/usr/bin/env node
// Renders desktop/build/icon.svg into icon.png (1024×1024, transparent) and icon.icns.
//
// macOS only, no dependency: QuickLook (qlmanage) rasterises the SVG with WebKit but always on an
// opaque white background, so the SVG is rendered twice — on white and on black — and the alpha
// channel is recovered from the difference (difference matting). `sips` and `iconutil` then build
// the .icns iconset.
//
// Usage: node desktop/scripts/render-icon.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(here, '../build');
const svgPath = path.join(buildDir, 'icon.svg');
const SIZE = 1024;

if (process.platform !== 'darwin') {
  console.error('render-icon: macOS requis (qlmanage, sips, iconutil).');
  process.exit(1);
}

const work = mkdtempSync(path.join(tmpdir(), 'oriel-icon-'));
try {
  const svg = readFileSync(svgPath, 'utf8');
  const onWhite = path.join(work, 'white.svg');
  const onBlack = path.join(work, 'black.svg');
  writeFileSync(onWhite, svg);
  // Same artwork with an opaque black backdrop inserted right after the opening <svg …> tag.
  writeFileSync(onBlack, svg.replace(/<svg\b[^>]*>/, (m) => `${m}<rect width="${SIZE}" height="${SIZE}" fill="#000000"/>`));

  for (const file of [onWhite, onBlack]) {
    execFileSync('qlmanage', ['-t', '-s', String(SIZE), '-o', work, file], { stdio: 'ignore' });
  }
  const white = decodePng(readFileSync(`${onWhite}.png`));
  const black = decodePng(readFileSync(`${onBlack}.png`));
  if (white.width !== SIZE || black.width !== SIZE) throw new Error('Rendu QuickLook inattendu.');

  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const w = [white.data[i * 4], white.data[i * 4 + 1], white.data[i * 4 + 2]];
    const b = [black.data[i * 4], black.data[i * 4 + 1], black.data[i * 4 + 2]];
    // white = a·F + (1 − a)·255 ; black = a·F  ⇒  a = 1 − (white − black)/255
    const diff = (w[0] - b[0] + (w[1] - b[1]) + (w[2] - b[2])) / 3;
    const alpha = Math.max(0, Math.min(255, Math.round(255 - diff)));
    for (let c = 0; c < 3; c++) {
      rgba[i * 4 + c] = alpha === 0 ? 0 : Math.max(0, Math.min(255, Math.round((b[c] * 255) / alpha)));
    }
    rgba[i * 4 + 3] = alpha;
  }
  const pngPath = path.join(buildDir, 'icon.png');
  writeFileSync(pngPath, encodePng(SIZE, SIZE, rgba));
  console.log(`✓ ${path.relative(process.cwd(), pngPath)}`);

  // .icns via an iconset (16 → 1024 px, @1x and @2x).
  const iconset = path.join(work, 'icon.iconset');
  mkdirSync(iconset);
  for (const base of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = base * scale;
      const name = `icon_${base}x${base}${scale === 2 ? '@2x' : ''}.png`;
      const out = path.join(iconset, name);
      if (px === SIZE) copyFileSync(pngPath, out);
      else execFileSync('sips', ['-z', String(px), String(px), pngPath, '--out', out], { stdio: 'ignore' });
    }
  }
  const icnsPath = path.join(buildDir, 'icon.icns');
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icnsPath]);
  console.log(`✓ ${path.relative(process.cwd(), icnsPath)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

// --- Minimal PNG codec (8-bit RGB/RGBA, non-interlaced) -------------------------------------------

function decodePng(buf) {
  let off = 8;
  let width = 0, height = 0, colorType = 0, bitDepth = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('PNG entrelacé non pris en charge');
    } else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) throw new Error(`PNG non pris en charge (type ${colorType}, ${bitDepth} bits)`);
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    prev = cur;
  }
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = px[i * bpp];
    data[i * 4 + 1] = px[i * bpp + 1];
    data[i * 4 + 2] = px[i * bpp + 2];
    data[i * 4 + 3] = bpp === 4 ? px[i * bpp + 3] : 255;
  }
  return { width, height, data };
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c ^ 0xffffffff;
}
