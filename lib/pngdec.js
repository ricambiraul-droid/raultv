'use strict';

const zlib = require('zlib');

// ---------------------------------------------------------------------------
// Decodor PNG minimal, fără dependențe. Întoarce pixeli RGBA.
//
// Acoperă ce apare în practică la siglele de televiziune: 8 și 16 biți,
// grayscale, RGB, paletă și variantele cu canal alfa. Imaginile întrețesute
// (Adam7) sunt rare și le refuzăm — apelantul rămâne fără siglă, nu crapă.
// ---------------------------------------------------------------------------

const MAX_LATURA = 2000;

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Reface scanliniile filtrate. bpp = octeți per pixel, rotunjit în sus.
function unfilter(date, latime, inaltime, canale, adancime) {
  const bitiPePixel = canale * adancime;
  const bpp = Math.max(1, Math.ceil(bitiPePixel / 8));
  const octetiPeRand = Math.ceil((latime * bitiPePixel) / 8);
  const iesire = Buffer.alloc(octetiPeRand * inaltime);

  let pozitie = 0;
  for (let y = 0; y < inaltime; y++) {
    const filtru = date[pozitie++];
    const rand = y * octetiPeRand;
    const anterior = rand - octetiPeRand;

    for (let i = 0; i < octetiPeRand; i++) {
      const brut = date[pozitie + i];
      const stanga = i >= bpp ? iesire[rand + i - bpp] : 0;
      const sus = y > 0 ? iesire[anterior + i] : 0;
      const susStanga = y > 0 && i >= bpp ? iesire[anterior + i - bpp] : 0;

      let valoare;
      if (filtru === 0) valoare = brut;
      else if (filtru === 1) valoare = brut + stanga;
      else if (filtru === 2) valoare = brut + sus;
      else if (filtru === 3) valoare = brut + ((stanga + sus) >> 1);
      else if (filtru === 4) valoare = brut + paeth(stanga, sus, susStanga);
      else throw new Error(`filtru PNG necunoscut: ${filtru}`);

      iesire[rand + i] = valoare & 0xff;
    }
    pozitie += octetiPeRand;
  }
  return { pixeli: iesire, octetiPeRand };
}

// Citește o valoare de `adancime` biți de la indexul dat dintr-un rand.
function citesteBiti(rand, offsetRand, index, adancime) {
  if (adancime === 8) return rand[offsetRand + index];
  if (adancime === 16) return rand[offsetRand + index * 2]; // păstrăm octetul mare
  const pePozitie = 8 / adancime;
  const octet = rand[offsetRand + Math.floor(index / pePozitie)];
  const deplasare = 8 - adancime * ((index % pePozitie) + 1);
  return (octet >> deplasare) & ((1 << adancime) - 1);
}

function decodePng(buffer) {
  if (buffer.length < 8 || buffer[0] !== 0x89 || buffer[1] !== 0x50) return null;

  let pozitie = 8;
  let latime = 0;
  let inaltime = 0;
  let adancime = 8;
  let tipCuloare = 6;
  let intretesut = 0;
  const bucatiIdat = [];
  let paleta = null;
  let transparenta = null;

  while (pozitie + 8 <= buffer.length) {
    const lungime = buffer.readUInt32BE(pozitie);
    const tip = buffer.toString('latin1', pozitie + 4, pozitie + 8);
    const start = pozitie + 8;
    if (start + lungime > buffer.length) break;

    if (tip === 'IHDR') {
      latime = buffer.readUInt32BE(start);
      inaltime = buffer.readUInt32BE(start + 4);
      adancime = buffer[start + 8];
      tipCuloare = buffer[start + 9];
      intretesut = buffer[start + 12];
    } else if (tip === 'PLTE') {
      paleta = buffer.subarray(start, start + lungime);
    } else if (tip === 'tRNS') {
      transparenta = buffer.subarray(start, start + lungime);
    } else if (tip === 'IDAT') {
      bucatiIdat.push(buffer.subarray(start, start + lungime));
    } else if (tip === 'IEND') {
      break;
    }
    pozitie = start + lungime + 4;
  }

  if (!latime || !inaltime || !bucatiIdat.length) return null;
  if (intretesut) return null;                       // Adam7, rar la sigle
  if (latime > MAX_LATURA || inaltime > MAX_LATURA) return null;
  if (![1, 2, 4, 8, 16].includes(adancime)) return null;

  const canalePeTip = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const canale = canalePeTip[tipCuloare];
  if (!canale) return null;

  let brut;
  try {
    brut = zlib.inflateSync(Buffer.concat(bucatiIdat));
  } catch {
    return null;
  }

  const { pixeli, octetiPeRand } = unfilter(brut, latime, inaltime, canale, adancime);
  const maxim = adancime === 16 ? 255 : (1 << adancime) - 1;
  const scara = 255 / maxim;
  const rgba = Buffer.alloc(latime * inaltime * 4);

  for (let y = 0; y < inaltime; y++) {
    const offsetRand = y * octetiPeRand;
    for (let x = 0; x < latime; x++) {
      const tinta = (y * latime + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;

      if (tipCuloare === 3) {
        const index = citesteBiti(pixeli, offsetRand, x, adancime);
        if (paleta && index * 3 + 2 < paleta.length) {
          r = paleta[index * 3];
          g = paleta[index * 3 + 1];
          b = paleta[index * 3 + 2];
        }
        if (transparenta && index < transparenta.length) a = transparenta[index];
      } else if (tipCuloare === 0 || tipCuloare === 4) {
        const gri = citesteBiti(pixeli, offsetRand, x * canale, adancime);
        r = g = b = adancime === 16 ? gri : Math.round(gri * scara);
        if (tipCuloare === 4) a = citesteBiti(pixeli, offsetRand, x * canale + 1, adancime);
      } else {
        const baza = x * canale;
        r = citesteBiti(pixeli, offsetRand, baza, adancime);
        g = citesteBiti(pixeli, offsetRand, baza + 1, adancime);
        b = citesteBiti(pixeli, offsetRand, baza + 2, adancime);
        if (adancime !== 16 && adancime !== 8) {
          r = Math.round(r * scara); g = Math.round(g * scara); b = Math.round(b * scara);
        }
        if (tipCuloare === 6) a = citesteBiti(pixeli, offsetRand, baza + 3, adancime);
      }

      rgba[tinta] = r;
      rgba[tinta + 1] = g;
      rgba[tinta + 2] = b;
      rgba[tinta + 3] = a;
    }
  }

  return { latime, inaltime, rgba };
}

module.exports = { decodePng };
