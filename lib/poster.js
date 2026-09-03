'use strict';

const { Canvas } = require('./canvas');
const logos = require('./logos');
const font = require('./font');
const { CATEGORY_STYLE } = require('../channels');

const DEFAULT_STYLE = { from: '#1b4a8f', to: '#0a1f3d', accent: '#f5c451' };

function styleFor(category) {
  return CATEGORY_STYLE[category] || DEFAULT_STYLE;
}

function greedyWrap(words, maxEm) {
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current || font.measure(candidate) <= maxEm) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Imparte numele pe randuri echilibrate, fara sa depaseasca maxLines.
function wrapToWidth(name, maxEm, maxLines) {
  const words = String(name).toUpperCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [''];

  let lines = greedyWrap(words, maxEm);

  // Prea multe randuri: le comprimam pe ultimele intr-unul singur.
  if (lines.length > maxLines) {
    lines = greedyWrap(words, font.measure(name.toUpperCase()) / maxLines * 1.35);
    if (lines.length > maxLines) {
      const head = lines.slice(0, maxLines - 1);
      head.push(lines.slice(maxLines - 1).join(' '));
      lines = head;
    }
  }

  // Echilibram randurile: cautam cea mai mica latime care pastreaza acelasi numar de randuri.
  const target = lines.length;
  if (target > 1) {
    const widest = Math.max(...words.map(word => font.measure(word)));
    let low = widest;
    let high = Math.max(...lines.map(line => font.measure(line)));
    for (let i = 0; i < 24 && high - low > 0.01; i++) {
      const mid = (low + high) / 2;
      if (greedyWrap(words, mid).length <= target) high = mid;
      else low = mid;
    }
    const balanced = greedyWrap(words, high);
    if (balanced.length === target) lines = balanced;
  }

  return lines;
}

function drawText(canvas, lines, box, color, weight) {
  const { x, y, width, height } = box;
  const gap = 0.33;
  const longest = Math.max(...lines.map(line => font.measure(line)), 0.001);
  const sizeByWidth = width / longest;
  const sizeByHeight = height / (lines.length + (lines.length - 1) * gap);
  const size = Math.min(sizeByWidth, sizeByHeight);
  const lineHeight = size * (1 + gap);
  const totalHeight = lines.length * size + (lines.length - 1) * size * gap;
  const startY = y + (height - totalHeight) / 2;

  lines.forEach((line, index) => {
    const lineWidth = font.measure(line) * size;
    const strokes = font.layout(line, x + (width - lineWidth) / 2, startY + index * lineHeight, size);
    canvas.polylines(strokes, Math.max(2, size * weight), color);
  });
  return size;
}

// Fundalul posterului depinde doar de categorie si de dimensiune, nu de canal.
// Il desenam o singura data per categorie si apoi doar copiem bufferul.
const baseCache = new Map();

function posterBase(category, size) {
  const key = `${category}@${size}`;
  const cached = baseCache.get(key);
  if (cached) return cached;

  const style = styleFor(category);
  const canvas = new Canvas(size, size);
  const unit = size / 512;

  canvas.gradient(style.from, style.to);

  // Benzi diagonale discrete, pentru textura.
  for (let i = -6; i < 16; i++) {
    const offset = i * 64 * unit;
    canvas.segment(offset, 0, offset + size, size, 18 * unit, [255, 255, 255], 0.022);
  }

  // Rama de accent.
  const inset = 22 * unit;
  canvas.roundRect(inset, inset, size - inset * 2, size - inset * 2, 34 * unit,
    style.accent, 'stroke', 3 * unit, 0.85);

  // Insigna LIVE, stanga sus.
  const badgeX = 46 * unit;
  const badgeY = 46 * unit;
  const badgeH = 40 * unit;
  const badgeW = 118 * unit;
  canvas.roundRect(badgeX, badgeY, badgeW, badgeH, badgeH / 2, '#e12d2d', 'fill', 1, 0.92);
  canvas.circle(badgeX + 21 * unit, badgeY + badgeH / 2, 7 * unit, '#ffffff', 0.95);
  drawText(canvas, ['LIVE'], {
    x: badgeX + 36 * unit, y: badgeY + 12 * unit,
    width: badgeW - 50 * unit, height: badgeH - 24 * unit
  }, '#ffffff', 0.19);

  // Linie de accent si eticheta categoriei, jos.
  const ruleY = 392 * unit;
  canvas.roundRect(size / 2 - 54 * unit, ruleY, 108 * unit, 4 * unit, 2 * unit, style.accent, 'fill', 1, 0.9);
  drawText(canvas, [category.toUpperCase()], {
    x: 60 * unit, y: ruleY + 26 * unit,
    width: size - 120 * unit, height: 30 * unit
  }, style.accent, 0.17);

  baseCache.set(key, canvas.data);
  return canvas.data;
}

// Asaza sigla in caseta data, pastrand proportiile si centrand-o.
// Siglele intunecate primesc o placa deschisa dedesubt, altfel dispar in
// fundalul inchis al posterului.
function drawLogo(canvas, sigla, caseta, unit) {
  const { imagine, lumina } = sigla;
  const scara = Math.min(caseta.width / imagine.latime, caseta.height / imagine.inaltime);
  const w = imagine.latime * scara;
  const h = imagine.inaltime * scara;
  const x = caseta.x + (caseta.width - w) / 2;
  const y = caseta.y + (caseta.height - h) / 2;

  if (lumina < 0.42) {
    const margine = 16 * unit;
    canvas.roundRect(
      x - margine, y - margine, w + margine * 2, h + margine * 2,
      14 * unit, '#ffffff', 'fill', 1, 0.93
    );
  }

  canvas.drawImage(imagine, x, y, w, h);
  return { x, y, w, h };
}

// Poster patrat, folosit in grila Stremio pe Smart TV.
function renderPoster(channel, size = 512) {
  const canvas = new Canvas(size, size);
  posterBase(channel.category, size).copy(canvas.data);
  const unit = size / 512;

  const sigla = channel.logo ? logos.get(channel.logo) : null;

  if (sigla) {
    // sigla sus, centrata; numele dedesubt, mai mic
    drawLogo(canvas, sigla, {
      x: 76 * unit, y: 128 * unit,
      width: size - 152 * unit, height: 168 * unit
    }, unit);

    const lines = wrapToWidth(channel.name, 9, 2);
    drawText(canvas, lines, {
      x: 44 * unit, y: 316 * unit,
      width: size - 88 * unit, height: 58 * unit
    }, '#ffffff', 0.16);
  } else {
    const lines = wrapToWidth(channel.name, 6.8, 3);
    drawText(canvas, lines, {
      x: 58 * unit, y: 150 * unit,
      width: size - 116 * unit, height: 210 * unit
    }, '#ffffff', 0.155);
  }

  return canvas;
}

function buildPoster(channel, size = 512) {
  return renderPoster(channel, size).toPng();
}

// Imagine 16:9 pentru fundalul paginii de detaliu.
const backgroundCache = new Map();

function backgroundBase(category, width, height) {
  const key = `${category}@${width}x${height}`;
  const cached = backgroundCache.get(key);
  if (cached) return cached;

  const style = styleFor(category);
  const canvas = new Canvas(width, height);
  const unit = width / 1024;

  canvas.gradient(style.from, style.to, 0.42);
  for (let i = -8; i < 22; i++) {
    const offset = i * 96 * unit;
    canvas.segment(offset, 0, offset + height, height, 26 * unit, [255, 255, 255], 0.018);
  }

  backgroundCache.set(key, canvas.data);
  return canvas.data;
}

function buildBackground(channel, width = 1024, height = 576) {
  const style = styleFor(channel.category);
  const canvas = new Canvas(width, height);
  backgroundBase(channel.category, width, height).copy(canvas.data);
  const unit = width / 1024;

  const sigla = channel.logo ? logos.get(channel.logo) : null;
  if (sigla) {
    drawLogo(canvas, sigla, {
      x: width / 2 - 190 * unit, y: 150 * unit,
      width: 380 * unit, height: 150 * unit
    }, unit);
  } else {
    const lines = wrapToWidth(channel.name, 9, 2);
    drawText(canvas, lines, {
      x: 90 * unit, y: 170 * unit,
      width: width - 180 * unit, height: 180 * unit
    }, '#ffffff', 0.15);
  }

  drawText(canvas, [`${channel.category.toUpperCase()}  •  LIVE`], {
    x: 90 * unit, y: 400 * unit,
    width: width - 180 * unit, height: 34 * unit
  }, style.accent, 0.17);

  return canvas.toPng();
}

// Sigla addonului.
function buildLogo(size = 512) {
  const canvas = new Canvas(size, size);
  const unit = size / 512;
  canvas.gradient('#123b91', '#050d1c');
  canvas.roundRect(20 * unit, 20 * unit, size - 40 * unit, size - 40 * unit, 40 * unit,
    '#f5c451', 'stroke', 4 * unit, 0.9);
  drawText(canvas, ['RAUL', 'TV'], {
    x: 70 * unit, y: 130 * unit, width: size - 140 * unit, height: 200 * unit
  }, '#ffffff', 0.15);
  drawText(canvas, ['ROMÂNIA'], {
    x: 70 * unit, y: 372 * unit, width: size - 140 * unit, height: 34 * unit
  }, '#f5c451', 0.17);
  return canvas.toPng();
}

// Cache LRU simplu, ca sa nu regeneram acelasi poster la fiecare cerere.
class ImageCache {
  constructor(limit = 240) {
    this.limit = limit;
    this.map = new Map();
  }

  get(key, factory) {
    if (this.map.has(key)) {
      const value = this.map.get(key);
      this.map.delete(key);
      this.map.set(key, value);
      return value;
    }
    const value = factory();
    this.map.set(key, value);
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
    return value;
  }

  delete(key) {
    return this.map.delete(key);
  }

  get size() {
    return this.map.size;
  }
}

module.exports = { buildPoster, renderPoster, buildBackground, buildLogo, ImageCache, wrapToWidth, styleFor };
