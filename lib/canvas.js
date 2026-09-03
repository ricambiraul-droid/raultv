'use strict';

const { encodePng } = require('./png');

// Canvas RGB simplu, cu anti-aliasing prin acoperire, fara dependente externe.

function hexToRgb(hex) {
  const value = String(hex).replace('#', '');
  const full = value.length === 3 ? value.split('').map(c => c + c).join('') : value;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16)
  ];
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 3);
  }

  blend(x, y, rgb, alpha) {
    if (alpha <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const a = alpha >= 1 ? 1 : alpha;
    const index = (y * this.width + x) * 3;
    this.data[index] = this.data[index] + (rgb[0] - this.data[index]) * a;
    this.data[index + 1] = this.data[index + 1] + (rgb[1] - this.data[index + 1]) * a;
    this.data[index + 2] = this.data[index + 2] + (rgb[2] - this.data[index + 2]) * a;
  }

  // Degrade liniar pe diagonala, cu o usoara vignetare spre colturi.
  gradient(fromHex, toHex, vignette = 0.28) {
    const from = hexToRgb(fromHex);
    const to = hexToRgb(toHex);
    const cx = this.width / 2;
    const cy = this.height / 2;
    const maxDistance = Math.hypot(cx, cy);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const t = clamp((x / this.width) * 0.42 + (y / this.height) * 0.58, 0, 1);
        const eased = t * t * (3 - 2 * t);
        const distance = Math.hypot(x - cx, y - cy) / maxDistance;
        const shade = 1 - vignette * distance * distance;
        const index = (y * this.width + x) * 3;
        this.data[index] = (from[0] + (to[0] - from[0]) * eased) * shade;
        this.data[index + 1] = (from[1] + (to[1] - from[1]) * eased) * shade;
        this.data[index + 2] = (from[2] + (to[2] - from[2]) * eased) * shade;
      }
    }
  }

  // Dreptunghi cu colturi rotunjite; mode 'fill' sau 'stroke'.
  roundRect(x, y, w, h, radius, hex, mode = 'fill', thickness = 2, alpha = 1) {
    const rgb = hexToRgb(hex);
    const r = Math.min(radius, w / 2, h / 2);
    const x0 = Math.max(0, Math.floor(x - thickness - 1));
    const y0 = Math.max(0, Math.floor(y - thickness - 1));
    const x1 = Math.min(this.width - 1, Math.ceil(x + w + thickness + 1));
    const y1 = Math.min(this.height - 1, Math.ceil(y + h + thickness + 1));

    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const cx = px + 0.5;
        const cy = py + 0.5;
        // distanta cu semn fata de dreptunghiul rotunjit
        const dx = Math.max(x + r - cx, 0, cx - (x + w - r));
        const dy = Math.max(y + r - cy, 0, cy - (y + h - r));
        const distance = Math.hypot(dx, dy) - r;
        let coverage;
        if (mode === 'fill') {
          coverage = clamp(0.5 - distance, 0, 1);
        } else {
          coverage = clamp(thickness / 2 + 0.5 - Math.abs(distance), 0, 1);
        }
        if (coverage > 0) this.blend(px, py, rgb, coverage * alpha);
      }
    }
  }

  circle(cx, cy, radius, hex, alpha = 1) {
    const rgb = hexToRgb(hex);
    const x0 = Math.max(0, Math.floor(cx - radius - 1));
    const y0 = Math.max(0, Math.floor(cy - radius - 1));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + radius + 1));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + radius + 1));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const coverage = clamp(radius + 0.5 - Math.hypot(px + 0.5 - cx, py + 0.5 - cy), 0, 1);
        if (coverage > 0) this.blend(px, py, rgb, coverage * alpha);
      }
    }
  }

  // Segment gros cu capete rotunde, anti-aliasing pe distanta.
  segment(ax, ay, bx, by, thickness, rgb, alpha = 1) {
    const radius = thickness / 2;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - radius - 1));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - radius - 1));
    const x1 = Math.min(this.width - 1, Math.ceil(Math.max(ax, bx) + radius + 1));
    const y1 = Math.min(this.height - 1, Math.ceil(Math.max(ay, by) + radius + 1));
    const vx = bx - ax;
    const vy = by - ay;
    const lengthSquared = vx * vx + vy * vy;

    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const cx = px + 0.5;
        const cy = py + 0.5;
        let t = lengthSquared === 0 ? 0 : ((cx - ax) * vx + (cy - ay) * vy) / lengthSquared;
        t = clamp(t, 0, 1);
        const distance = Math.hypot(cx - (ax + t * vx), cy - (ay + t * vy));
        const coverage = clamp(radius + 0.5 - distance, 0, 1);
        if (coverage > 0) this.blend(px, py, rgb, coverage * alpha);
      }
    }
  }

  polylines(strokes, thickness, hex, alpha = 1) {
    const rgb = hexToRgb(hex);
    for (const stroke of strokes) {
      for (let i = 1; i < stroke.length; i++) {
        this.segment(stroke[i - 1][0], stroke[i - 1][1], stroke[i][0], stroke[i][1], thickness, rgb, alpha);
      }
    }
  }

  // Desenează o imagine RGBA în dreptunghiul dat, păstrând transparența.
  // La micșorare mediem toți pixelii sursă care cad într-un pixel destinație —
  // altfel siglele ies zimțate, fiindcă vin la 500px și intră într-o casetă
  // de 180px. La mărire folosim interpolare biliniară.
  drawImage(imagine, dx, dy, dw, dh) {
    const { latime: sw, inaltime: sh, rgba } = imagine;
    if (!sw || !sh || dw <= 0 || dh <= 0) return;

    const micsorare = sw > dw || sh > dh;
    const x0 = Math.max(0, Math.floor(dx));
    const y0 = Math.max(0, Math.floor(dy));
    const x1 = Math.min(this.width - 1, Math.ceil(dx + dw));
    const y1 = Math.min(this.height - 1, Math.ceil(dy + dh));

    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;

        if (micsorare) {
          // media zonei sursă corespunzătoare
          const sx0 = Math.max(0, Math.floor((px - dx) / dw * sw));
          const sx1 = Math.min(sw, Math.ceil((px + 1 - dx) / dw * sw));
          const sy0 = Math.max(0, Math.floor((py - dy) / dh * sh));
          const sy1 = Math.min(sh, Math.ceil((py + 1 - dy) / dh * sh));
          if (sx1 <= sx0 || sy1 <= sy0) continue;

          let sumaAlfa = 0;
          let numar = 0;
          for (let sy = sy0; sy < sy1; sy++) {
            for (let sx = sx0; sx < sx1; sx++) {
              const i = (sy * sw + sx) * 4;
              const alfa = rgba[i + 3] / 255;
              // premultiplicat, ca marginile transparente să nu tragă culoarea spre negru
              r += rgba[i] * alfa;
              g += rgba[i + 1] * alfa;
              b += rgba[i + 2] * alfa;
              sumaAlfa += alfa;
              numar++;
            }
          }
          if (!numar || sumaAlfa <= 0) continue;
          r /= sumaAlfa; g /= sumaAlfa; b /= sumaAlfa;
          a = sumaAlfa / numar;
        } else {
          const fx = Math.min(sw - 1, Math.max(0, (px + 0.5 - dx) / dw * sw - 0.5));
          const fy = Math.min(sh - 1, Math.max(0, (py + 0.5 - dy) / dh * sh - 0.5));
          const ix = Math.floor(fx);
          const iy = Math.floor(fy);
          const tx = fx - ix;
          const ty = fy - iy;
          const ix2 = Math.min(sw - 1, ix + 1);
          const iy2 = Math.min(sh - 1, iy + 1);

          let sumaAlfa = 0;
          for (const [qx, qy, pondere] of [
            [ix, iy, (1 - tx) * (1 - ty)], [ix2, iy, tx * (1 - ty)],
            [ix, iy2, (1 - tx) * ty], [ix2, iy2, tx * ty]
          ]) {
            const i = (qy * sw + qx) * 4;
            const alfa = (rgba[i + 3] / 255) * pondere;
            r += rgba[i] * alfa;
            g += rgba[i + 1] * alfa;
            b += rgba[i + 2] * alfa;
            sumaAlfa += alfa;
            a += pondere * (rgba[i + 3] / 255);
          }
          if (sumaAlfa <= 0) continue;
          r /= sumaAlfa; g /= sumaAlfa; b /= sumaAlfa;
        }

        if (a > 0) this.blend(px, py, [r, g, b], a);
      }
    }
  }

  toPng() {
    return encodePng(this.data, this.width, this.height);
  }
}

// Taie marginile complet transparente din jurul unei sigle. Multe sigle vin cu
// jumatate din imagine goala, iar fara taiere apar mici si pierdute in chenar.
function trimAlpha(imagine, prag = 8) {
  const { latime, inaltime, rgba } = imagine;
  let sus = inaltime;
  let jos = -1;
  let stanga = latime;
  let dreapta = -1;

  for (let y = 0; y < inaltime; y++) {
    for (let x = 0; x < latime; x++) {
      if (rgba[(y * latime + x) * 4 + 3] > prag) {
        if (y < sus) sus = y;
        if (y > jos) jos = y;
        if (x < stanga) stanga = x;
        if (x > dreapta) dreapta = x;
      }
    }
  }
  if (jos < 0 || dreapta < 0) return imagine;
  if (sus === 0 && stanga === 0 && jos === inaltime - 1 && dreapta === latime - 1) return imagine;

  const noulLat = dreapta - stanga + 1;
  const noulInalt = jos - sus + 1;
  const iesire = Buffer.alloc(noulLat * noulInalt * 4);
  for (let y = 0; y < noulInalt; y++) {
    rgba.copy(iesire, y * noulLat * 4, ((sus + y) * latime + stanga) * 4,
      ((sus + y) * latime + stanga + noulLat) * 4);
  }
  return { latime: noulLat, inaltime: noulInalt, rgba: iesire };
}

// Luminozitatea medie a pixelilor vizibili, 0 = negru, 1 = alb.
// Ne spune daca sigla are nevoie de un fundal deschis ca sa se vada.
function luminozitate(imagine) {
  const { latime, inaltime, rgba } = imagine;
  let suma = 0;
  let greutate = 0;
  const pas = Math.max(1, Math.floor(Math.sqrt((latime * inaltime) / 4000)));
  for (let y = 0; y < inaltime; y += pas) {
    for (let x = 0; x < latime; x += pas) {
      const i = (y * latime + x) * 4;
      const alfa = rgba[i + 3] / 255;
      if (alfa < 0.15) continue;
      suma += (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) / 255 * alfa;
      greutate += alfa;
    }
  }
  return greutate ? suma / greutate : 1;
}

module.exports = { Canvas, hexToRgb, trimAlpha, luminozitate };
