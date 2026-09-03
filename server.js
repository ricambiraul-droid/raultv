'use strict';

const http = require('http');
const { CATALOG, CATEGORY_ORDER } = require('./channels');
const { buildPoster, buildBackground, buildLogo, ImageCache } = require('./lib/poster');

const PORT = Number(process.env.PORT || 7000);
const VERSION = '3.0.0';
const PAGE_SIZE = 100;
const POSTER_SIZE = Number(process.env.RAULTV_POSTER_SIZE || 512);

// ---------------------------------------------------------------------------
// Canale
// ---------------------------------------------------------------------------

function envKey(slug) {
  return `RAULTV_${slug.toUpperCase().replace(/-/g, '_')}_URL`;
}

// Fluxuri implicite, suprascriptibile din variabile de mediu.
const DEFAULT_STREAMS = {
  'prima-tv': 'https://stream1.1616.ro:1945/prima/livestream/playlist.m3u8',
  'look-sport': 'https://stream1.1616.ro:1945/look/livestream/playlist.m3u8',
  'tvr-1': 'https://mn-nl.mncdn.com/tvr1_test/smil:tvr1_test.smil/playlist.m3u8',
  'tvr-2': 'https://mn-nl.mncdn.com/tvr2_test/smil:tvr2_test.smil/playlist.m3u8'
};

// Nume istorice de variabile pentru canalele DIGI, pastrate din versiunile anterioare.
const LEGACY_ENV = {
  'digi-24': 'DIGI_24_URL',
  'digi-sport-1': 'DIGI_SPORT_1_URL',
  'digi-sport-2': 'DIGI_SPORT_2_URL',
  'digi-sport-3': 'DIGI_SPORT_3_URL',
  'digi-sport-4': 'DIGI_SPORT_4_URL',
  'digi-world': 'DIGI_WORLD_URL',
  'digi-life': 'DIGI_LIFE_URL',
  'digi-animal-world': 'DIGI_ANIMAL_WORLD_URL'
};

function resolveUrl(slug) {
  const legacy = LEGACY_ENV[slug];
  return process.env[envKey(slug)] || (legacy && process.env[legacy]) || DEFAULT_STREAMS[slug] || '';
}

const channels = CATALOG.map(([slug, name, category, officialPage]) => ({
  id: `raultv-${slug}`,
  slug,
  name,
  category,
  officialPage,
  url: resolveUrl(slug),
  envKey: LEGACY_ENV[slug] || envKey(slug)
}));

const byId = new Map(channels.map(channel => [channel.id, channel]));

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

const allSorted = sortChannels(channels);

const genreCatalogs = categories.map(category => ({
  type: 'tv',
  id: `raultv-${slugify(category)}`,
  name: `RaulTV • ${category}`,
  category,
  channels: sortChannels(channels.filter(channel => channel.category === category))
}));

const catalogById = new Map(genreCatalogs.map(catalog => [catalog.id, catalog]));

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

function streamsFor(channel) {
  if (channel.url) {
    return [{
      name: 'RaulTV',
      title: `${channel.name}\n${channel.category} • LIVE`,
      url: channel.url,
      behaviorHints: { notWebReady: false }
    }];
  }
  return [{
    name: 'RaulTV',
    title: `${channel.name}\nDeschide pagina oficială`,
    externalUrl: channel.officialPage
  }];
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

const posterCache = new ImageCache(260);
const backgroundCache = new ImageCache(60);
let logoBuffer = null;

function handle(req, res) {
  let pathname;
  try {
    pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  } catch {
    return json(req, res, 400, { error: 'Bad request' });
  }
  const path = safeDecode(pathname).replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1') || '/';

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
    return json(req, res, 200, { streams: streamsFor(channel) });
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

  if (path === '/health') {
    return json(req, res, 200, {
      status: 'ok',
      version: VERSION,
      channels: channels.length,
      withStream: channels.filter(channel => channel.url).length,
      categories: categories.length,
      postersCached: posterCache.size
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
<p style="margin-top:22px"><a href="/manifest.json">manifest.json</a> · <a href="/catalog/tv/${MAIN_CATALOG_ID}.json">toate canalele</a> · <a href="/health">health</a></p>
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
    warmPosters();
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = {
  server, channels, categories, genreCatalogs, allSorted,
  buildManifest, slugify, searchKey, parseExtra, selectChannels, streamsFor, metaFor,
  MAIN_CATALOG_ID, PAGE_SIZE
};
