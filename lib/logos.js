'use strict';

const { fetchUpstream } = require('./live');
const { decodePng } = require('./pngdec');
const { trimAlpha, luminozitate } = require('./canvas');

// ---------------------------------------------------------------------------
// Siglele posturilor.
//
// Playlisturile publice dau, pe lângă flux, și adresa siglei oficiale a
// postului (tvg-logo). O descărcăm o singură dată, o decodăm și o ținem în
// memorie gata pregătită, ca generatorul de postere să o poată folosi
// sincron. Formatul dominant e PNG; ce nu e PNG se ignoră, iar posterul
// rămâne cel cu numele scris mare.
// ---------------------------------------------------------------------------

const MAX_OCTETI = 3 * 1024 * 1024;
const LIMITA_CACHE = 260;
const TTL_ESEC = 6 * 60 * 60 * 1000;

const cache = new Map();     // url -> { imagine, luminozitate } sau { esuat, la }
const inCurs = new Map();    // url -> Promise, ca să nu cerem de două ori
let descarcate = 0;
let esuate = 0;

function taie() {
  while (cache.size > LIMITA_CACHE) cache.delete(cache.keys().next().value);
}

function descarca(url) {
  return fetchUpstream(url, { referer: null }).then(({ response }) => {
    if ((response.statusCode || 0) >= 400) {
      response.resume();
      throw new Error(`HTTP ${response.statusCode}`);
    }
    return new Promise((resolve, reject) => {
      const bucati = [];
      let total = 0;
      response.on('data', bucata => {
        total += bucata.length;
        if (total > MAX_OCTETI) { response.destroy(); reject(new Error('siglă prea mare')); return; }
        bucati.push(bucata);
      });
      response.on('end', () => resolve(Buffer.concat(bucati)));
      response.on('error', reject);
    });
  });
}

// Aduce sigla în fundal. Nu întoarce imaginea — o pune în cache pentru `get`.
function incarca(url, laGata) {
  if (!url || cache.has(url) || inCurs.has(url)) return;

  const promisiune = descarca(url)
    .then(buffer => {
      const brut = decodePng(buffer);
      if (!brut) throw new Error('nu e PNG decodabil');
      const imagine = trimAlpha(brut);
      if (imagine.latime < 8 || imagine.inaltime < 8) throw new Error('siglă prea mică');
      cache.set(url, { imagine, lumina: luminozitate(imagine) });
      taie();
      descarcate++;
      if (laGata) laGata(url);
    })
    .catch(() => {
      cache.set(url, { esuat: true, la: Date.now() });
      taie();
      esuate++;
    })
    .finally(() => inCurs.delete(url));

  inCurs.set(url, promisiune);
}

// Sigla pregătită, sau null. Nu blochează niciodată.
function get(url) {
  if (!url) return null;
  const item = cache.get(url);
  if (!item) return null;
  if (item.esuat) {
    if (Date.now() - item.la > TTL_ESEC) cache.delete(url);
    return null;
  }
  return item;
}

// Aduce o listă de sigle în pași mici, ca să nu blocheze serverul la pornire.
function incalzeste(urls, laGata, pasuri = 6) {
  const lista = [...new Set(urls.filter(Boolean))];
  let index = 0;
  const pas = () => {
    const felie = lista.slice(index, index + pasuri);
    index += pasuri;
    for (const url of felie) incarca(url, laGata);
    if (index < lista.length) setTimeout(pas, 900).unref();
    else console.log(`RaulTV: sigle — ${descarcate} descărcate, ${esuate} eșuate`);
  };
  if (lista.length) setTimeout(pas, 2500).unref();
}

function stare() {
  return { descarcate, esuate, inCache: cache.size };
}

module.exports = { get, incarca, incalzeste, stare };
