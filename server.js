'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { CATALOG, CATEGORY_ORDER } = require('./channels');
const { SURSE } = require('./surse');
const { buildPoster, buildBackground, buildLogo, ImageCache } = require('./lib/poster');
const live = require('./lib/live');
const m3u = require('./lib/m3u');
const resolver = require('./lib/resolver');

const PORT = Number(process.env.PORT || 7000);
const VERSION = '3.3.0';
const PAGE_SIZE = 100;
const POSTER_SIZE = Number(process.env.RAULTV_POSTER_SIZE || 512);

// Cum ajunge fluxul la player:
//   direct  — adresa reală a sursei, fără niciun hop prin addon (implicit)
//   server  — adresa trece prin /live/<id>.m3u8, care redirectează spre sursă
// „direct" e mai robust cu playerele de pe televizor, care nu tratează toate
// redirectul la fel. „server" e util când vrei să schimbi o sursă fără să
// redeschizi lista în Stremio.
const MOD_FLUX = process.env.RAULTV_MOD_FLUX === 'server' ? 'server' : 'direct';

// Pentru canalele fără sursă configurată, serverul încearcă să găsească fluxul
// public chiar pe pagina oficială a postului, în momentul în care apeși play.
// Se oprește cu RAULTV_AUTO=off.
const AUTO = process.env.RAULTV_AUTO !== 'off';

// ---------------------------------------------------------------------------
// Canale
// ---------------------------------------------------------------------------

const channels = CATALOG.map(([slug, name, category, officialPage]) => {
  const surse = live.sourcesFor(slug, SURSE);
  return {
    id: `raultv-${slug}`,
    slug,
    name,
    category,
    officialPage,
    surse,
    url: surse.length ? surse[0].url : '',
    envKey: live.LEGACY_ENV[slug] || live.envKey(slug)
  };
});

const byId = new Map(channels.map(channel => [channel.id, channel]));

// ---------------------------------------------------------------------------
// Playlist propriu (opțional)
//
// RAULTV_M3U_URL sau un fișier canale.m3u lângă server.js. Canalele din
// playlist sunt potrivite după nume cu cele din catalog și devin surse
// suplimentare, alături de cele din surse.js.
// ---------------------------------------------------------------------------

const playlistState = { stare: 'neconfigurat', intrari: 0, potrivite: 0, la: null, eroare: null };

function applyPlaylist(text, origine) {
  const intrari = m3u.parseM3U(text);
  const potriviri = m3u.matchChannels(intrari, channels);

  let potrivite = 0;
  for (const channel of channels) {
    // scoatem sursele adăugate la o încărcare anterioară
    channel.surse = channel.surse.filter(source => !source.dinPlaylist);
    for (const source of (potriviri[channel.slug] || [])) {
      channel.surse.push({
        url: source.url,
        referer: null,
        eticheta: `Server ${channel.surse.length + 1}`,
        calitate: source.eticheta || null,
        dinMediu: false,
        dinPlaylist: true
      });
      potrivite++;
    }
    channel.url = channel.surse.length ? channel.surse[0].url : '';
  }

  resortCatalogs();

  playlistState.stare = 'încărcat';
  playlistState.origine = origine;
  playlistState.intrari = intrari.length;
  playlistState.potrivite = potrivite;
  playlistState.la = new Date().toISOString();
  playlistState.eroare = null;
  console.log(`RaulTV: playlist ${origine} — ${intrari.length} intrări, ${potrivite} potrivite`);
}

async function loadPlaylist() {
  const url = process.env.RAULTV_M3U_URL;
  const file = path.join(__dirname, 'canale.m3u');

  try {
    if (url) {
      applyPlaylist(await m3u.fetchM3U(url), 'din RAULTV_M3U_URL');
      return;
    }
    if (fs.existsSync(file)) {
      applyPlaylist(fs.readFileSync(file, 'utf8'), 'din canale.m3u');
      return;
    }
  } catch (error) {
    playlistState.stare = 'eroare';
    playlistState.eroare = error.message;
    console.error('RaulTV: playlistul nu a putut fi încărcat —', error.message);
  }
}

// Categoriile efectiv prezente, in ordinea definita.
const categories = CATEGORY_ORDER.filter(category =>
  channels.some(channel => channel.category === category));

// ---------------------------------------------------------------------------
// Text: slug, cautare fara diacritice
// ---------------------------------------------------------------------------

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/ș|ş/g, 's').replace(/ț|ţ/g, 't')
    .replace(/ă|â/g, 'a').replace(/î/g, 'i')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function searchKey(value) {
  return slugify(value).replace(/-/g, ' ');
}

for (const channel of channels) channel.searchKey = searchKey(channel.name);

// ---------------------------------------------------------------------------
// Rubrici pe genuri
// ---------------------------------------------------------------------------

// Canalele cu flux configurat apar primele, apoi alfabetic (cu diacritice ignorate).
const collator = new Intl.Collator('ro', { sensitivity: 'base', numeric: true });

function sortChannels(list) {
  return [...list].sort((a, b) => {
    if (Boolean(b.url) !== Boolean(a.url)) return b.url ? 1 : -1;
    return collator.compare(a.name, b.name);
  });
}

let allSorted = sortChannels(channels);

const genreCatalogs = categories.map(category => ({
  type: 'tv',
  id: `raultv-${slugify(category)}`,
  name: `RaulTV • ${category}`,
  category,
  channels: sortChannels(channels.filter(channel => channel.category === category))
}));

const catalogById = new Map(genreCatalogs.map(catalog => [catalog.id, catalog]));

// Sortarea depinde de ce canale au surse, iar playlistul se încarcă după
// pornire. Fără resortare, un post căruia playlistul tocmai i-a dat trei
// servere ar rămâne unde era, în coada listei alfabetice.
function resortCatalogs() {
  allSorted = sortChannels(channels);
  for (const catalog of genreCatalogs) {
    catalog.channels = sortChannels(channels.filter(channel => channel.category === catalog.category));
  }
}

const MAIN_CATALOG_ID = 'raultv-toate';

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function buildManifest(base) {
  const mainExtra = [
    { name: 'genre', options: categories, isRequired: false },
    { name: 'search', isRequired: false },
    { name: 'skip', isRequired: false }
  ];
  const genreExtra = [
    { name: 'search', isRequired: false },
    { name: 'skip', isRequired: false }
  ];

  return {
    id: 'ro.raultv.live',
    version: VERSION,
    name: 'RaulTV România',
    description: `${channels.length} televiziuni românești live, grupate în ${categories.length} rubrici: ${categories.join(', ')}.`,
    logo: `${base}/logo.png`,
    background: `${base}/logo.png`,
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    catalogs: [
      {
        type: 'tv',
        id: MAIN_CATALOG_ID,
        name: 'RaulTV • Toate canalele',
        genres: categories,
        extra: mainExtra,
        extraSupported: ['genre', 'search', 'skip']
      },
      ...genreCatalogs.map(catalog => ({
        type: 'tv',
        id: catalog.id,
        name: catalog.name,
        extra: genreExtra,
        extraSupported: ['search', 'skip']
      }))
    ],
    idPrefixes: ['raultv-'],
    behaviorHints: { configurable: false, configurationRequired: false }
  };
}

// ---------------------------------------------------------------------------
// Meta si stream
// ---------------------------------------------------------------------------

function publicBase(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = /^https?$/.test(forwarded)
    ? forwarded
    : (req.socket && req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers.host || `localhost:${PORT}`}`;
}

function metaFor(channel, base) {
  return {
    id: channel.id,
    type: 'tv',
    name: channel.name,
    poster: `${base}/poster/${channel.id}.png`,
    posterShape: 'square',
    logo: `${base}/poster/${channel.id}.png`,
    background: `${base}/background/${channel.id}.png`,
    genres: [channel.category],
    description: channel.url
      ? `${channel.name} — transmisiune live, categoria ${channel.category}.`
      : `${channel.name} — categoria ${channel.category}. Nu are flux public configurat: se deschide pagina oficială. Pentru redare directă, setează variabila ${channel.envKey} cu un URL HLS autorizat.`,
    releaseInfo: 'Live',
    website: channel.officialPage
  };
}

// Lista de fluxuri pentru un canal. Fiecare sursă apare ca „Server 1",
// „Server 2" etc., cu câte o intrare per rezoluție oferită de sursă.
// Ultima opțiune e întotdeauna linkul live către pagina oficială.
async function streamsFor(channel, base) {
  const streams = [];

  const push = (source, index, eticheta, target, rezIndex) => {
    const hints = { notWebReady: true };
    if (source.referer) {
      hints.proxyHeaders = { request: { Referer: source.referer, 'User-Agent': live.UA } };
    }
    streams.push({
      name: 'RaulTV',
      title: `${channel.name}\n${eticheta}`,
      url: MOD_FLUX === 'server'
        ? `${base}/live/${channel.id}.m3u8?sursa=${index}${rezIndex === null ? '' : `&rez=${rezIndex}`}`
        : target,
      behaviorHints: hints
    });
  };

  for (let index = 0; index < channel.surse.length; index++) {
    const source = channel.surse[index];
    const server = source.eticheta;
    const calitate = source.calitate ? ` ${source.calitate}` : '';

    push(source, index, `${server}${calitate} • Auto`, source.url, null);

    let variante = [];
    try { variante = await live.variantsFor(source); } catch { variante = []; }
    if (variante.length > 1) {
      variante.forEach((variant, position) => {
        push(source, index, `${server} • ${live.labelFor(variant)}`, variant.url, position);
      });
    }
  }

  // Canalele fără sursă: serverul caută fluxul pe pagina oficială la play.
  // Nu rezolvăm aici, ca lista să apară instant — căutarea se face la cerere.
  if (AUTO && !channel.surse.length) {
    streams.push({
      name: 'RaulTV',
      title: `${channel.name}\nCaută fluxul pe server`,
      url: `${base}/live/${channel.id}.m3u8`,
      behaviorHints: { notWebReady: true }
    });
  }

  streams.push({
    name: 'RaulTV',
    title: `${channel.name}\nDeschide pagina oficială`,
    externalUrl: channel.officialPage
  });

  return streams;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*'
};

function json(req, res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'public, max-age=60',
    ...CORS
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

function sendPng(req, res, buffer) {
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': buffer.length,
    'Cache-Control': 'public, max-age=604800, immutable',
    ...CORS
  });
  res.end(req.method === 'HEAD' ? undefined : buffer);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]
  ));
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

// Stremio trimite optiunile ca segment de cale: /catalog/tv/<id>/genre=Sport&skip=100.json
function parseExtra(raw) {
  const result = {};
  if (!raw) return result;
  for (const pair of safeDecode(raw).split('&')) {
    const index = pair.indexOf('=');
    if (index > 0) result[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  }
  return result;
}

function selectChannels(catalogId, extra) {
  let list;
  if (catalogId === MAIN_CATALOG_ID) {
    list = allSorted;
  } else {
    const catalog = catalogById.get(catalogId);
    if (!catalog) return null;
    list = catalog.channels;
  }

  if (extra.genre) {
    const wanted = slugify(extra.genre);
    const match = categories.find(category => slugify(category) === wanted);
    if (!match) return [];
    list = list.filter(channel => channel.category === match);
  }

  if (extra.search) {
    const query = searchKey(extra.search);
    if (query) list = list.filter(channel => channel.searchKey.includes(query));
  }

  const skip = Number.parseInt(extra.skip, 10);
  const offset = Number.isFinite(skip) && skip > 0 ? skip : 0;
  return list.slice(offset, offset + PAGE_SIZE);
}

function sameHost(a, b) {
  try { return new URL(a).host === new URL(b).host; } catch { return false; }
}

function clampIndex(raw, length) {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 && value < length ? value : 0;
}

// Adresa finala pentru o cerere de flux: playlistul master, sau varianta ceruta.
async function resolveTarget(source, rez) {
  if (rez === null || rez === undefined || rez === '') return source.url;
  const variante = await live.variantsFor(source);
  const index = Number.parseInt(rez, 10);
  if (Number.isFinite(index) && variante[index]) return variante[index].url;
  return source.url;
}

const posterCache = new ImageCache(260);
const backgroundCache = new ImageCache(60);
let logoBuffer = null;

function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return json(req, res, 400, { error: 'Bad request' });
  }
  const path = safeDecode(url.pathname).replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(req, res, 405, { error: 'Method not allowed' });
  }

  const base = publicBase(req);

  if (path === '/manifest.json') return json(req, res, 200, buildManifest(base));

  const catalogMatch = path.match(/^\/catalog\/tv\/([^/]+?)(?:\/(.*))?\.json$/);
  if (catalogMatch) {
    const list = selectChannels(catalogMatch[1], parseExtra(catalogMatch[2]));
    if (list === null) return json(req, res, 404, { metas: [], error: 'Catalog inexistent' });
    return json(req, res, 200, { metas: list.map(channel => metaFor(channel, base)) });
  }

  const metaMatch = path.match(/^\/meta\/tv\/([^/]+?)(?:\/.*)?\.json$/);
  if (metaMatch) {
    const channel = byId.get(metaMatch[1]);
    if (!channel) return json(req, res, 404, { error: 'Canal inexistent' });
    return json(req, res, 200, { meta: metaFor(channel, base) });
  }

  const streamMatch = path.match(/^\/stream\/tv\/([^/]+?)(?:\/.*)?\.json$/);
  if (streamMatch) {
    const channel = byId.get(streamMatch[1]);
    if (!channel) return json(req, res, 404, { streams: [], error: 'Canal inexistent' });
    return streamsFor(channel, base)
      .then(streams => json(req, res, 200, { streams }))
      .catch(error => {
        console.error('Eroare la fluxuri:', error);
        json(req, res, 200, { streams: [{
          name: 'RaulTV',
          title: `${channel.name}\nLive pe pagina oficială`,
          externalUrl: channel.officialPage
        }] });
      });
  }

  // ---- fluxul propriu-zis --------------------------------------------------
  // Redirectăm către sursă în loc să retransmitem: traficul video merge direct
  // de la CDN la tine, deci nu consumă banda serverului și nu pleacă din
  // Frankfurt, ceea ce ar strica posturile restricționate geografic.
  if (path === '/live/proxy') {
    const target = url.searchParams.get('catre');
    if (!target) return json(req, res, 400, { error: 'Lipsește parametrul catre' });
    const owner = channels.find(channel =>
      channel.surse.some(source => source.referer && sameHost(source.url, target)));
    const source = owner
      ? owner.surse.find(item => sameHost(item.url, target))
      : { referer: null };
    return live.proxyStream(req, res, target, source, `${base}/live/proxy`);
  }

  const liveMatch = path.match(/^\/live\/([^/]+)\.m3u8$/);
  if (liveMatch) {
    const channel = byId.get(liveMatch[1]);
    if (!channel) return json(req, res, 404, { error: 'Canal inexistent' });
    if (!channel.surse.length) {
      if (!AUTO) {
        return json(req, res, 404, {
          error: 'Canalul nu are flux configurat',
          paginaOficiala: channel.officialPage,
          variabila: channel.envKey
        });
      }
      return resolver.rezolva(channel)
        .then(gasit => {
          if (!gasit) {
            return json(req, res, 404, {
              error: 'Nu am găsit un flux public pe pagina oficială',
              paginaOficiala: channel.officialPage,
              variabila: channel.envKey
            });
          }
          res.writeHead(302, { Location: gasit, 'Cache-Control': 'no-store', ...CORS });
          res.end();
        })
        .catch(() => json(req, res, 502, {
          error: 'Rezolvarea a eșuat',
          paginaOficiala: channel.officialPage
        }));
    }

    const sourceIndex = clampIndex(url.searchParams.get('sursa'), channel.surse.length);
    const source = channel.surse[sourceIndex];

    return resolveTarget(source, url.searchParams.get('rez'))
      .then(target => {
        // sursele care cer antetul Referer trec prin server, restul se redirectează
        if (source.referer) return live.proxyStream(req, res, target, source, `${base}/live/proxy`);
        res.writeHead(302, {
          Location: target,
          'Cache-Control': 'no-store',
          ...CORS
        });
        res.end();
      })
      .catch(error => {
        console.error('Eroare la rezolvarea fluxului:', error);
        res.writeHead(302, { Location: source.url, 'Cache-Control': 'no-store', ...CORS });
        res.end();
      });
  }

  if (path === '/logo.png') {
    if (!logoBuffer) logoBuffer = buildLogo(POSTER_SIZE);
    return sendPng(req, res, logoBuffer);
  }

  const posterMatch = path.match(/^\/poster\/([^/]+)\.png$/);
  if (posterMatch) {
    const channel = byId.get(posterMatch[1]);
    if (!channel) return json(req, res, 404, { error: 'Canal inexistent' });
    return sendPng(req, res, posterCache.get(channel.id, () => buildPoster(channel, POSTER_SIZE)));
  }

  const backgroundMatch = path.match(/^\/background\/([^/]+)\.png$/);
  if (backgroundMatch) {
    const channel = byId.get(backgroundMatch[1]);
    if (!channel) return json(req, res, 404, { error: 'Canal inexistent' });
    return sendPng(req, res, backgroundCache.get(channel.id, () => buildBackground(channel)));
  }

  // Lista surselor, pentru pagina de verificare.
  if (path === '/surse.json') {
    return json(req, res, 200, {
      canale: channels
        .filter(channel => channel.surse.length)
        .map(channel => ({
          id: channel.id,
          nume: channel.name,
          rubrica: channel.category,
          surse: channel.surse.map(source => ({ eticheta: source.eticheta, url: source.url }))
        })),
      faraFlux: channels.filter(channel => !channel.surse.length).length
    });
  }

  // Pagina de verificare. Testele rulează în browserul tău, nu pe server:
  // serverul e în Frankfurt, iar posturile românești sunt adesea restricționate
  // geografic, deci un test făcut de server ar minți.
  if (path === '/verifica') {
    const body = `<!doctype html><html lang="ro"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verificare fluxuri — RaulTV</title><style>
body{background:#07111f;color:#e8eef7;font-family:system-ui,Arial,sans-serif;max-width:860px;margin:0 auto;padding:36px 20px 80px;line-height:1.6}
h1{color:#f5c451;font-size:1.6rem;margin:0 0 6px}
.sub{color:#8aa4c4;margin:0 0 22px;font-size:.95rem}
button{background:#f5c451;color:#07111f;border:0;border-radius:8px;padding:11px 20px;font-weight:700;font-size:.95rem;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
.sumar{margin:18px 0 14px;font-size:.95rem;color:#a7bcd7}
table{width:100%;border-collapse:collapse;font-size:.92rem;margin-top:8px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid #1c2f47;vertical-align:top}
th{color:#8aa4c4;font-size:.72rem;letter-spacing:.08em;text-transform:uppercase}
.st{font-weight:700;white-space:nowrap}
.ok{color:#63d6a0}.rau{color:#ff8f8f}.astept{color:#f2bb55}
.rez{color:#8aa4c4;font-size:.85rem}
code{font-family:ui-monospace,Menlo,monospace;font-size:.8rem;color:#7b91af;word-break:break-all}
.nota{border-left:3px solid #22395a;padding-left:14px;color:#a7bcd7;font-size:.9rem;margin:22px 0 0}
</style>
<h1>Verificare fluxuri</h1>
<p class="sub">Testele rulează aici, în browserul tău. Serverul e în Frankfurt, iar multe posturi românești sunt restricționate geografic — un test făcut de server ar da alt rezultat decât realitatea de la tine.</p>\n<p class="sub">Galben nu înseamnă stricat: multe CDN-uri nu trimit antete CORS, deci browserul nu poate citi playlistul chiar dacă fluxul merge. Confirmarea finală o dă tot Stremio.</p>
<button id="start">Pornește verificarea</button>
<p class="sumar" id="sumar"></p>
<table id="t"><thead><tr><th>Canal</th><th>Stare</th><th>Rezoluții</th><th>Sursă</th></tr></thead><tbody></tbody></table>
<p class="nota" id="nota"></p>
<script>
var buton = document.getElementById('start');
var corp = document.querySelector('#t tbody');
var sumar = document.getElementById('sumar');

function rand(canal, sursa) {
  var tr = document.createElement('tr');
  tr.innerHTML = '<td>' + canal.nume + '</td>' +
    '<td class="st astept">se testează…</td>' +
    '<td class="rez">—</td>' +
    '<td><code>' + sursa.url.replace(/[&<>]/g, '') + '</code></td>';
  corp.appendChild(tr);
  return tr;
}

function numaraRezolutii(text) {
  var potriviri = text.match(/#EXT-X-STREAM-INF/g);
  if (!potriviri) return text.indexOf('#EXTINF') !== -1 ? 'flux simplu' : '—';
  var rez = [];
  var re = /RESOLUTION=\d+x(\d+)/g, m;
  while ((m = re.exec(text)) !== null) rez.push(m[1] + 'p');
  return rez.length ? rez.join(', ') : potriviri.length + ' variante';
}

// Multe CDN-uri nu trimit antete CORS, deci browserul nu poate citi răspunsul
// chiar dacă fluxul e viu. De aceea încercăm de două ori: întâi normal, ca să
// vedem status și rezoluții, apoi în mod no-cors, care nu ne lasă să citim
// nimic, dar ne spune dacă gazda răspunde. Fără al doilea pas, un flux perfect
// funcțional ar apărea ca mort.
async function testeaza(tr, sursa) {
  var stare = tr.querySelector('.st');
  var rez = tr.querySelector('.rez');

  function cuTimp(optiuni) {
    var control = new AbortController();
    var timer = setTimeout(function () { control.abort(); }, 12000);
    optiuni.signal = control.signal;
    optiuni.cache = 'no-store';
    return fetch(sursa.url, optiuni).finally(function () { clearTimeout(timer); });
  }

  try {
    var raspuns = await cuTimp({});
    if (!raspuns.ok) {
      stare.className = 'st rau';
      stare.textContent = 'HTTP ' + raspuns.status;
      rez.textContent = raspuns.status === 403 ? 'refuzat — poate cere Referer' :
                        raspuns.status === 404 ? 'adresa nu mai există' : '—';
      return 'rau';
    }
    var text = await raspuns.text();
    if (text.indexOf('#EXTM3U') !== 0) {
      stare.className = 'st rau';
      stare.textContent = 'nu e playlist';
      return 'rau';
    }
    stare.className = 'st ok';
    stare.textContent = 'merge';
    rez.textContent = numaraRezolutii(text);
    return 'ok';
  } catch (eroare) {
    if (eroare.name === 'AbortError') {
      stare.className = 'st rau';
      stare.textContent = 'expirat';
      return 'rau';
    }

    // pagina e pe https, deci browserul refuză din start orice sursă http://
    if (sursa.url.indexOf('http://') === 0) {
      stare.className = 'st astept';
      stare.textContent = 'http, netestabil';
      rez.textContent = 'browserul blochează; în Stremio poate merge';
      return 'incert';
    }

    try {
      await cuTimp({ mode: 'no-cors' });
      stare.className = 'st astept';
      stare.textContent = 'răspunde';
      rez.textContent = 'CORS nu lasă citirea — probabil viu';
      return 'incert';
    } catch (alta) {
      stare.className = 'st rau';
      stare.textContent = 'nu răspunde';
      return 'rau';
    }
  }
}

buton.addEventListener('click', async function () {
  buton.disabled = true;
  corp.innerHTML = '';
  sumar.textContent = 'Se încarcă lista…';

  var date = await (await fetch('/surse.json')).json();
  var randuri = [];
  date.canale.forEach(function (canal) {
    canal.surse.forEach(function (sursa) { randuri.push({ tr: rand(canal, sursa), sursa: sursa }); });
  });

  sumar.textContent = 'Se testează ' + randuri.length + ' surse…';
  var bune = 0, incerte = 0, rele = 0;
  for (var i = 0; i < randuri.length; i++) {
    var stare = await testeaza(randuri[i].tr, randuri[i].sursa);
    if (stare === 'ok') bune++; else if (stare === 'incert') incerte++; else rele++;
    sumar.textContent = (i + 1) + ' din ' + randuri.length + ' testate';
  }

  sumar.textContent = 'Gata: ' + bune + ' confirmate, ' + incerte +
    ' probabil bune, ' + rele + ' moarte.';
  document.getElementById('nota').textContent =
    'Restul de ' + date.faraFlux + ' canale nu au flux configurat și deschid pagina oficială. ' +
    'Ca să adaugi unul, pune-l în surse.js sau într-o variabilă RAULTV_<SLUG>_URL în Render.';
  buton.disabled = false;
  buton.textContent = 'Testează din nou';
});
</script></html>`;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      ...CORS
    });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  if (path === '/health') {
    return json(req, res, 200, {
      status: 'ok',
      version: VERSION,
      modFlux: MOD_FLUX,
      channels: channels.length,
      withStream: channels.filter(channel => channel.surse.length).length,
      sources: channels.reduce((total, channel) => total + channel.surse.length, 0),
      categories: categories.length,
      postersCached: posterCache.size,
      playlist: playlistState,
      auto: AUTO ? resolver.stare() : 'oprit'
    });
  }

  if (path === '/') {
    const manifestUrl = `${base}/manifest.json`;
    const withStream = channels.filter(channel => channel.url).length;
    const rows = categories.map(category => {
      const catalog = genreCatalogs.find(item => item.category === category);
      return `<tr><td>${escapeHtml(category)}</td><td>${catalog.channels.length}</td><td><a href="/catalog/tv/${catalog.id}.json">${catalog.id}</a></td></tr>`;
    }).join('');

    const body = `<!doctype html><html lang="ro"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RaulTV România</title><style>
body{background:#07111f;color:#e8eef7;font-family:system-ui,Arial,sans-serif;max-width:820px;margin:0 auto;padding:40px 24px;line-height:1.6}
main{border:1px solid #2b4564;border-radius:20px;padding:32px;background:#0c1a2c}
h1{color:#f5c451;margin:0 0 4px;font-size:1.9rem}
.sub{color:#8aa4c4;margin:0 0 24px}
code{display:block;padding:14px;background:#020811;border-radius:10px;overflow:auto;word-break:break-all;font-size:.9rem}
a{color:#5fd4ff}
.btn{display:inline-block;margin:18px 0;padding:12px 22px;background:#f5c451;color:#07111f;border-radius:10px;font-weight:700;text-decoration:none}
table{width:100%;border-collapse:collapse;margin-top:10px;font-size:.92rem}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #1c2f47}
th{color:#8aa4c4;font-weight:600}
img{border-radius:14px;margin-right:10px;vertical-align:middle}
</style><main>
<h1>RaulTV România</h1>
<p class="sub"><strong>${channels.length}</strong> canale · <strong>${categories.length}</strong> rubrici · <strong>${withStream}</strong> cu flux configurat</p>
<p><img src="/poster/raultv-pro-tv.png" width="86" height="86" alt=""><img src="/poster/raultv-digi-sport-1.png" width="86" height="86" alt=""><img src="/poster/raultv-mooz-dance.png" width="86" height="86" alt=""><img src="/poster/raultv-trinitas-tv.png" width="86" height="86" alt=""></p>
<p>URL manifest:</p>
<code>${escapeHtml(manifestUrl)}</code>
<a class="btn" href="stremio://${escapeHtml(manifestUrl.replace(/^https?:\/\//, ''))}">Instalează în Stremio</a>
<table><tr><th>Rubrică</th><th>Canale</th><th>Catalog</th></tr>${rows}</table>
<p style="margin-top:22px"><a href="/manifest.json">manifest.json</a> · <a href="/catalog/tv/${MAIN_CATALOG_ID}.json">toate canalele</a> · <a href="/verifica">verifică fluxurile</a> · <a href="/health">health</a></p>
</main></html>`;

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      ...CORS
    });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  return json(req, res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (error) {
    console.error('Eroare la cerere:', error);
    if (!res.headersSent) json(req, res, 500, { error: 'Internal error' });
    else res.end();
  }
});

server.on('clientError', (error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

// Pregateste posterele in fundal, in pasi mici, ca prima deschidere pe TV sa fie rapida.
function warmPosters() {
  let index = 0;
  const step = () => {
    const deadline = Date.now() + 40;
    while (index < allSorted.length && Date.now() < deadline) {
      const channel = allSorted[index++];
      posterCache.get(channel.id, () => buildPoster(channel, POSTER_SIZE));
    }
    if (index < allSorted.length) setTimeout(step, 60).unref();
    else console.log(`RaulTV: ${posterCache.size} postere pregătite`);
  };
  setTimeout(step, 1500).unref();
}

if (require.main === module) {
  process.on('uncaughtException', error => console.error('uncaughtException:', error));
  process.on('unhandledRejection', error => console.error('unhandledRejection:', error));
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`RaulTV v${VERSION}: http://localhost:${PORT}/manifest.json`);
    console.log(`${channels.length} canale în ${categories.length} rubrici`);
    loadPlaylist().finally(warmPosters);
    setInterval(() => { loadPlaylist(); }, 60 * 60 * 1000).unref();
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = {
  server, channels, categories, genreCatalogs, resortCatalogs,
  buildManifest, slugify, searchKey, parseExtra, selectChannels, streamsFor, metaFor,
  resolveTarget, live, m3u, loadPlaylist, playlistState,
  MAIN_CATALOG_ID, PAGE_SIZE
};

// allSorted se reconstruiește după încărcarea playlistului, deci îl expunem
// ca proprietate calculată, nu ca valoare copiată la încărcarea modulului.
Object.defineProperty(module.exports, 'allSorted', { get: () => allSorted });
