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
const MAX_SCRIPTS = 3;

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

// Caută un flux public pe pagina oficială a unui canal.
async function rezolva(channel) {
  const cheie = channel.id;
  const memorat = cache.get(cheie);
  if (memorat && Date.now() - memorat.la < (memorat.url ? TTL_REUSITA : TTL_ESEC)) {
    return memorat.url;
  }

  let gasit = null;
  try {
    const { body, finalUrl } = await descarca(channel.officialPage);
    let candidati = extrageM3u8(body, finalUrl);

    // dacă pagina nu conține adresa direct, ne uităm în scripturile playerului
    if (!candidati.length) {
      for (const script of scripturiCandidate(body, finalUrl)) {
        try {
          const rezultat = await descarca(script, 1024 * 1024);
          candidati = candidati.concat(extrageM3u8(rezultat.body, rezultat.finalUrl));
        } catch { /* scriptul nu se poate citi, trecem mai departe */ }
        if (candidati.length) break;
      }
    }

    for (const candidat of candidati.slice(0, 6)) {
      if (await esteplaylist(candidat)) { gasit = candidat; break; }
    }
  } catch { /* pagina nu răspunde sau ne blochează */ }

  cache.set(cheie, { la: Date.now(), url: gasit });
  return gasit;
}

function stare() {
  let reusite = 0;
  let esecuri = 0;
  for (const item of cache.values()) item.url ? reusite++ : esecuri++;
  return { incercate: cache.size, reusite, esecuri };
}

module.exports = { rezolva, extrageM3u8, scripturiCandidate, stare, UA };
