'use strict';

const { fetchUpstream, UA } = require('./live');
const { URL } = require('url');

// ---------------------------------------------------------------------------
// Rezolvare automată din pagina oficială.
//
// Multe posturi românești își pun fluxul liber în playerul de pe site. Când un
// canal nu are sursă configurată, serverul deschide pagina oficială, caută
// adresa de flux pe care o folosește chiar playerul lor și o servește mai
// departe. E același lucru pe care îl face browserul când intri pe site.
//
// Nu funcționează pentru posturile cu DRM sau cu token de sesiune — acolo
// rămâne linkul către pagina oficială. Și nu încearcă niciodată să ocolească
// o autentificare: dacă pagina cere cont, rezolvarea eșuează și gata.
// ---------------------------------------------------------------------------

const TTL_REUSITA = 30 * 60 * 1000;   // o adresă găsită se refolosește 30 de minute
const TTL_ESEC = 10 * 60 * 1000;      // un eșec nu se reîncearcă imediat
const MAX_HTML = 3 * 1024 * 1024;
const MAX_SCRIPTS = 4;
const MAX_CANDIDATI = 8;

const cache = new Map();

function descarca(url, limita = MAX_HTML) {
  return fetchUpstream(url, { referer: null }).then(({ response, finalUrl }) => {
    if ((response.statusCode || 0) >= 400) {
      response.resume();
      throw new Error(`HTTP ${response.statusCode}`);
    }
    return new Promise((resolve, reject) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > limita) { response.destroy(); resolve({ body, finalUrl }); }
      });
      response.on('end', () => resolve({ body, finalUrl }));
      response.on('error', reject);
    });
  });
}

// Scoate adresele .m3u8 dintr-un text, fie el HTML sau JavaScript.
function extrageM3u8(text, baseUrl) {
  const gasite = [];
  const vazute = new Set();

  const adauga = brut => {
    let curat = String(brut)
      .replace(/\\\//g, '/')          // adrese scăpate în JSON: https:\/\/...
      .replace(/&amp;/g, '&')
      .replace(/^['"]|['"]$/g, '')
      .trim();
    if (!curat || curat.length > 600) return;
    let absolut;
    try { absolut = new URL(curat, baseUrl).toString(); } catch { return; }
    if (!/^https?:/i.test(absolut)) return;
    if (vazute.has(absolut)) return;
    vazute.add(absolut);
    gasite.push(absolut);
  };

  // adrese absolute sau relative care se termină în .m3u8, cu parametri opționali
  const re = /["'(]([^"'()\s]*?\.m3u8(?:\?[^"'()\s]*)?)["')]/gi;
  let m;
  while ((m = re.exec(text)) !== null) adauga(m[1]);

  // varianta fără ghilimele, de exemplu în atribute HTML
  const re2 = /(https?:\/\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?)/gi;
  while ((m = re2.exec(text)) !== null) adauga(m[1]);

  return gasite;
}

// Scripturile care au șanse să conțină configurația playerului.
function scripturiCandidate(html, baseUrl) {
  const surse = [];
  const re = /<script[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const src = m[1];
    if (!/player|live|stream|hls|video|config|embed/i.test(src)) continue;
    try { surse.push(new URL(src, baseUrl).toString()); } catch { /* adresă invalidă */ }
  }
  return surse.slice(0, MAX_SCRIPTS);
}

// Confirmă că adresa chiar întoarce un playlist HLS.
async function esteplaylist(url) {
  try {
    const { body } = await descarca(url, 65536);
    return body.trimStart().startsWith('#EXTM3U');
  } catch {
    return false;
  }
}

// Caută fluxuri publice pe pagina oficială a unui canal.
// Întoarce TOATE adresele care răspund cu un playlist valid, nu doar prima —
// o pagină poate expune mai multe servere sau mai multe calități, iar în
// Stremio le vrem pe toate, chiar și pe cele mici.
async function rezolva(channel) {
  const cheie = channel.id;
  const memorat = cache.get(cheie);
  if (memorat && Date.now() - memorat.la < (memorat.urls.length ? TTL_REUSITA : TTL_ESEC)) {
    return memorat.urls;
  }

  const bune = [];
  try {
    const { body, finalUrl } = await descarca(channel.officialPage);
    let candidati = extrageM3u8(body, finalUrl);

    // dacă pagina nu conține adresa direct, ne uităm în scripturile playerului
    for (const script of scripturiCandidate(body, finalUrl)) {
      if (candidati.length >= MAX_CANDIDATI) break;
      try {
        const rezultat = await descarca(script, 1024 * 1024);
        candidati = candidati.concat(extrageM3u8(rezultat.body, rezultat.finalUrl));
      } catch { /* scriptul nu se poate citi, trecem mai departe */ }
    }

    // fără duplicate, în ordinea în care apar în pagină
    const vazute = new Set();
    const unice = candidati.filter(url => !vazute.has(url) && vazute.add(url));

    // verificăm în paralel, câte trei odată, ca să nu ținem canalul blocat
    for (let i = 0; i < unice.length && i < MAX_CANDIDATI; i += 3) {
      const felie = unice.slice(i, i + 3);
      const rezultate = await Promise.all(felie.map(async url => (await esteplaylist(url)) ? url : null));
      for (const url of rezultate) if (url) bune.push(url);
    }
  } catch { /* pagina nu răspunde sau ne blochează */ }

  cache.set(cheie, { la: Date.now(), urls: bune });
  return bune;
}

// Ce a găsit deja, fără să mai caute o dată.
function dinCache(channelId) {
  const memorat = cache.get(channelId);
  if (!memorat) return null;
  if (Date.now() - memorat.la > (memorat.urls.length ? TTL_REUSITA : TTL_ESEC)) return null;
  return memorat.urls;
}

function stare() {
  let reusite = 0;
  let esecuri = 0;
  let adrese = 0;
  for (const item of cache.values()) {
    if (item.urls.length) { reusite++; adrese += item.urls.length; } else esecuri++;
  }
  return { incercate: cache.size, reusite, esecuri, adrese };
}

module.exports = { rezolva, dinCache, extrageM3u8, scripturiCandidate, stare, UA };
