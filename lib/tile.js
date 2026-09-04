'use strict';

// ---------------------------------------------------------------------------
// Chenarul patrat al unui canal: fundal inchis, sigla micsorata si centrata.
// Cand postul nu are sigla, scriem numele lui cu fontul vectorial din lib/font.
// Fara dependinte externe: PNG-ul e decodat, compus si reencodat aici.
// ---------------------------------------------------------------------------

const http = require('http');
const https = require('https');
const { Canvas, trimAlpha, luminozitate } = require('./canvas');
const { decodePng } = require('./pngdec');
const font = require('./font');
const { wrapToWidth } = require('./poster');

const SIZE = Number(process.env.RAULTV_POSTER_SIZE || 512);
const TIMEOUT = Number(process.env.LOGO_TIMEOUT || 6000);
const MAX_CACHE = Number(process.env.POSTER_CACHE || 400);
const cache = new Map();

function drawText(canvas, lines, box, hex, weight) {
  const { x, y, width, height } = box;
  const gap = 0.33;
  const longest = Math.max(...lines.map(l => font.measure(l)), 0.001);
  const size = Math.min(width / longest, height / (lines.length + (lines.length - 1) * gap));
  const lineHeight = size * (1 + gap);
  const total = lines.length * size + (lines.length - 1) * size * gap;
  const startY = y + (height - total) / 2;
  lines.forEach((line, i) => {
    const w = font.measure(line) * size;
    canvas.polylines(font.layout(line, x + (width - w) / 2, startY + i * lineHeight, size),
      Math.max(2, size * weight), hex);
  });
}


// Descarcare simpla, fara dependinte, cu limita de marime si de redirectari.
function fetchBuffer(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = e => { if (!done) { done = true; reject(e); } };
    let req;
    try {
      const client = url.startsWith('https:') ? https : http;
      req = client.get(url, { timeout: TIMEOUT, headers: { 'User-Agent': 'Mozilla/5.0 RaulTV' } }, res => {
        const loc = res.headers.location;
        if (res.statusCode >= 300 && res.statusCode < 400 && loc && redirects > 0) {
          res.resume();
          return resolve(fetchBuffer(new URL(loc, url).toString(), redirects - 1));
        }
        if (res.statusCode !== 200) { res.resume(); return fail(new Error('HTTP ' + res.statusCode)); }
        const parts = [];
        let size = 0;
        res.on('data', d => {
          size += d.length;
          if (size > 4 * 1024 * 1024) { req.destroy(); return fail(new Error('prea mare')); }
          parts.push(d);
        });
        res.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(parts)); } });
        res.on('error', fail);
      });
    } catch (e) { return fail(e); }
    req.on('timeout', () => { req.destroy(); fail(new Error('timeout')); });
    req.on('error', fail);
  });
}

function isPng(buf) {
  return buf && buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

async function build(name, logoUrl) {
  const key = `${SIZE}|${logoUrl || ''}|${name || ''}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const canvas = new Canvas(SIZE, SIZE);
  canvas.gradient('#161c33', '#0a0e1b', 0.32);
  canvas.roundRect(9, 9, SIZE - 18, SIZE - 18, Math.round(SIZE * 0.055), '#2c3760', 'stroke', 3, 0.8);

  let drawn = false;
  if (logoUrl) {
    try {
      const raw = await fetchBuffer(logoUrl);
      if (isPng(raw)) {
        const img = trimAlpha(decodePng(raw));
        // Sigla ocupa cel mult 72% din latura, ca sa se vada de la distanta,
        // dar sa ramana aer in jurul ei si sa nu fie taiata de chenar.
        const box = SIZE * 0.72;
        const scale = Math.min(box / img.latime, box / img.inaltime);
        const w = Math.max(1, Math.round(img.latime * scale));
        const h = Math.max(1, Math.round(img.inaltime * scale));
        const x = Math.round((SIZE - w) / 2);
        const y = Math.round((SIZE - h) / 2);
        // Sigla intunecata pe fundal transparent ar disparea in degradeul inchis.
        if (luminozitate(img) < 0.42) {
          const pad = Math.round(SIZE * 0.045);
          canvas.roundRect(x - pad, y - pad, w + 2 * pad, h + 2 * pad,
            Math.round(SIZE * 0.035), '#f2f5fc', 'fill', 2, 0.95);
        }
        canvas.drawImage(img, x, y, w, h);
        drawn = true;
      }
    } catch (e) { /* ramane varianta scrisa */ }
  }

  if (!drawn) {
    const text = String(name || 'TV').toUpperCase();
    const lines = wrapToWidth(text, 6.2, 3);
    drawText(canvas, lines, { x: SIZE * 0.08, y: SIZE * 0.24, width: SIZE * 0.84, height: SIZE * 0.52 },
      '#f2f6ff', 0.21);
  }

  const png = canvas.toPng();
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(key, png);
  return png;
}

module.exports = { build, SIZE };
