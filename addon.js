'use strict';

// ---------------------------------------------------------------------------
// Logica addonului Stremio: manifest, cataloage, metadate, fluxuri.
//
// Fiecare cerere primeste un context { account, base } — contul Xtream al
// dispozitivului si adresa publica a serverului. Nicio credentiala nu ajunge
// in manifest sau in raspunsurile de catalog; adresele de flux se construiesc
// abia in momentul in care playerul cere efectiv un stream.
// ---------------------------------------------------------------------------

const net = require('./lib/net');
const src = require('./lib/source');
const { dedupe } = require('./lib/guard');

const VERSION = '17.0.0';
const PAGE = 100;

// --- manifest -------------------------------------------------------------

function manifest(ctx = {}) {
  // Lista de tari vine din canalele incarcate efectiv, nu dintr-o lista fixa.
  const tari = src.tvGenres(ctx.account);
  const eticheta = ctx.device ? ` · ${ctx.device.nume}` : '';
  return {
    id: 'ro.raultv.live' + (ctx.device ? '.' + ctx.device.id : ''),
    version: VERSION,
    name: 'RaulTV FULL TiviOne' + eticheta,
    description: 'RaulTV v17 • Live TV din toate tarile + Filme/VOD + Seriale • multi-device, potrivire IMDB pentru subtitrari',
    logo: (ctx.base || '') + '/poster.png?n=RaulTV',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv', 'movie', 'series'],
    idPrefixes: ['raultv:', 'tivione:movie:', 'tivione:series:', 'tivione:episode:', 'tt'],
    behaviorHints: { configurable: false, configurationRequired: false },
    catalogs: [
      { type: 'tv', id: 'all', name: '📺 RaulTV • Toate tarile', genres: tari, extra: [{ name: 'genre', isRequired: false, options: tari }, { name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
      { type: 'tv', id: 'ro', name: '🇷🇴 RaulTV • Romania', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
      { type: 'tv', id: 'it', name: '🇮🇹 RaulTV • Italia', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
      { type: 'movie', id: 'tivione-movies', name: '🎬 TiviOne • Filme', genres: src.VOD_GENRES, extra: [{ name: 'genre', isRequired: false, options: src.VOD_GENRES }, { name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
      { type: 'series', id: 'tivione-series', name: '📺 TiviOne • Seriale', genres: src.VOD_GENRES, extra: [{ name: 'genre', isRequired: false, options: src.VOD_GENRES }, { name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] }
    ]
  };
}

// --- chenare --------------------------------------------------------------

const posterFor = (base, name, logo) => (base || '') + '/poster.png?n=' +
  encodeURIComponent(String(name || '').slice(0, 60)) + (logo ? '&u=' + encodeURIComponent(logo) : '');

// --- potrivirea cu IMDB (comuna tuturor conturilor si dispozitivelor) -----

const CINEMETA = 'https://v3-cinemeta.strem.io';
const IMDB_TIMEOUT = Number(process.env.IMDB_TIMEOUT || 5000);
const IMDB_CONCURRENCY = Number(process.env.IMDB_CONCURRENCY || 6);
const imdbCache = new Map();
const imdbToVod = new Map();
const imdbToSeries = new Map();

function titleYear(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/\((19|20)\d{2}\)\s*$/);
  const year = m ? Number(m[0].replace(/[()\s]/g, '')) : 0;
  let title = (m ? s.slice(0, m.index) : s).trim();
  title = title.replace(/\b(4K|UHD|FHD|HD|SD|1080p?|720p?|2160p?|MULTI|VOSTFR|DUB|SUB)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ').replace(/[-–—:|]+\s*$/, '').trim();
  return { title, year };
}

async function findImdb(type, rawName) {
  const { title, year } = titleYear(rawName);
  if (!title || title.length < 2) return null;
  const key = type + '|' + src.canonical(title) + '|' + (year || '');
  if (imdbCache.has(key)) return imdbCache.get(key);
  let hit = null;
  try {
    hit = await dedupe('imdb|' + key, async () => {
      const url = `${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(title)}.json`;
      const data = await net.getJson(url, { timeout: IMDB_TIMEOUT });
      const metas = (data && data.metas) || [];
      const want = src.canonical(title);
      let exact = null, loose = null;
      for (const m of metas) {
        if (!m || !m.id || !String(m.id).startsWith('tt')) continue;
        const got = src.canonical(m.name);
        const my = Number(String(m.releaseInfo || '').slice(0, 4)) || 0;
        const yearOk = !year || !my || Math.abs(my - year) <= 1;
        if (got === want && yearOk) { exact = m.id; break; }
        if (!loose && got === want) loose = m.id;
      }
      return exact || loose || null;
    });
  } catch (e) { hit = null; }
  if (imdbCache.size > 8000) imdbCache.clear();
  imdbCache.set(key, hit);
  return hit;
}

// Rezolva un lot cu paralelism limitat; ce nu se potriveste pastreaza id-ul intern.
async function attachImdb(rows, type, accId) {
  const out = new Array(rows.length);
  let i = 0;
  async function worker() {
    while (i < rows.length) {
      const k = i++;
      const id = await findImdb(type, rows[k].name);
      if (id) {
        const map = type === 'movie' ? imdbToVod : imdbToSeries;
        map.set(accId + '|' + id, rows[k]);
      }
      out[k] = id;
    }
  }
  await Promise.all(Array.from({ length: Math.min(IMDB_CONCURRENCY, rows.length) }, worker));
  return out;
}

// --- paginare / filtrare --------------------------------------------------

function page(rows, extra) {
  const g = String(extra.genre || '').trim().toUpperCase();
  if (g) rows = rows.filter(x => x.tag === g);
  const q = String(extra.search || '').toLowerCase().trim();
  if (q) rows = rows.filter(x => x.name.toLowerCase().includes(q));
  const skip = Math.max(0, Number(extra.skip || 0));
  return rows.slice(skip, skip + PAGE);
}

// --- cataloage ------------------------------------------------------------

async function catalog(ctx, { type, id, extra = {} }) {
  const acc = ctx.account;
  const base = ctx.base;

  if (type === 'movie' && id === 'tivione-movies') {
    const rows = page(await src.loadVod(acc), extra);
    const ids = await attachImdb(rows, 'movie', acc.id);
    return {
      metas: rows.map((x, k) => ({
        id: ids[k] || ('tivione:movie:' + x.id), type: 'movie', name: x.name,
        poster: x.poster || undefined,
        description: [x.tag, x.year, x.rating && ('⭐ ' + x.rating)].filter(Boolean).join(' • ')
      }))
    };
  }

  if (type === 'series' && id === 'tivione-series') {
    const rows = page(await src.loadSeries(acc), extra);
    const ids = await attachImdb(rows, 'series', acc.id);
    return {
      metas: rows.map((x, k) => ({
        id: ids[k] || ('tivione:series:' + x.id), type: 'series', name: x.name,
        poster: x.poster || undefined,
        description: x.plot || [x.tag, x.year, x.rating].filter(Boolean).join(' • ')
      }))
    };
  }

  if (type !== 'tv') return { metas: [] };

  const tv = await src.loadTV(acc);
  let rows = tv.rows;
  if (id === 'ro') rows = rows.filter(x => x.tag === 'RO');
  else if (id === 'it') rows = rows.filter(x => x.tag === 'IT');
  const showTag = id === 'all';
  return {
    metas: page(rows, extra).map(x => ({
      id: x.id, type: 'tv',
      name: showTag && x.tag ? `[${x.tag}] ${x.name}` : x.name,
      poster: posterFor(base, x.name, x.logo), posterShape: 'square',
      description: `${x.tag} • ${x.servers.length} server(e)`
    }))
  };
}

// --- metadate -------------------------------------------------------------

async function meta(ctx, { type, id }) {
  const acc = ctx.account;
  if (String(id).startsWith('tt')) return { meta: null };   // metadatele vin de la Cinemeta

  if (type === 'movie' && id.startsWith('tivione:movie:')) {
    const sid = id.split(':').pop();
    const x = (await src.loadVod(acc)).find(v => v.id === sid);
    return { meta: x ? { id, type: 'movie', name: x.name, poster: x.poster || undefined, description: [x.tag, x.year, x.rating && ('⭐ ' + x.rating)].filter(Boolean).join(' • ') } : null };
  }

  if (type === 'series' && id.startsWith('tivione:series:')) {
    const sid = id.split(':').pop();
    let d;
    try { d = await src.seriesInfo(acc, sid); } catch (e) { return { meta: null }; }
    const base = (await src.loadSeries(acc)).find(x => x.id === sid) || {};
    const videos = [];
    for (const [season, arr] of Object.entries((d && d.episodes) || {})) {
      for (const e of (Array.isArray(arr) ? arr : [])) {
        videos.push({
          id: `tivione:episode:${e.id}:${(e.container_extension || 'mp4').replace(/[^a-z0-9]/gi, '')}`,
          title: e.title || `Episod ${e.episode_num || ''}`,
          season: Number(season) || 1, episode: Number(e.episode_num) || 1,
          released: e.info && e.info.releasedate ? new Date(e.info.releasedate) : undefined
        });
      }
    }
    const info = (d && d.info) || {};
    return { meta: { id, type: 'series', name: info.name || base.name || 'Serial', poster: info.cover || base.poster || undefined, background: (info.backdrop_path && info.backdrop_path[0]) || undefined, description: info.plot || base.plot || '', videos } };
  }

  if (type === 'tv') {
    const x = (await src.loadTV(acc)).byId.get(id);
    return { meta: x ? { id, type: 'tv', name: x.name, poster: posterFor(ctx.base, x.name, x.logo), posterShape: 'square', description: `${x.tag} • ${x.servers.length} server(e)` } : null };
  }
  return { meta: null };
}

// --- fluxuri --------------------------------------------------------------

async function stream(ctx, { type, id }) {
  const acc = ctx.account;
  if (!src.configured(acc)) return { streams: [] };

  // „tt0084787" (film) sau „tt0903747:1:2" (episod) — vin de la Cinemeta.
  if (String(id).startsWith('tt')) {
    const p = String(id).split(':');
    if (p.length === 1) {
      const x = imdbToVod.get(acc.id + '|' + p[0]);
      return { streams: x ? [{ name: 'TiviOne • Film', title: x.name, url: src.movieUrl(acc, x), behaviorHints: { notWebReady: false } }] : [] };
    }
    const baseRow = imdbToSeries.get(acc.id + '|' + p[0]);
    if (!baseRow) return { streams: [] };
    const season = Number(p[1]) || 1, episode = Number(p[2]) || 1;
    try {
      const d = await src.seriesInfo(acc, baseRow.id);
      for (const [sn, arr] of Object.entries((d && d.episodes) || {})) {
        if ((Number(sn) || 1) !== season) continue;
        for (const e of (Array.isArray(arr) ? arr : [])) {
          if ((Number(e.episode_num) || 1) === episode) {
            return { streams: [{ name: 'TiviOne • Episod', title: baseRow.name, url: src.episodeUrl(acc, e.id, e.container_extension), behaviorHints: { notWebReady: false } }] };
          }
        }
      }
    } catch (e) { /* fara flux */ }
    return { streams: [] };
  }

  if (type === 'movie' && id.startsWith('tivione:movie:')) {
    const sid = id.split(':').pop();
    const x = (await src.loadVod(acc)).find(v => v.id === sid);
    return { streams: x ? [{ name: 'TiviOne • Film', title: x.name, url: src.movieUrl(acc, x), behaviorHints: { notWebReady: false } }] : [] };
  }

  if (type === 'series' && id.startsWith('tivione:episode:')) {
    const p = id.split(':');
    return { streams: [{ name: 'TiviOne • Episod', url: src.episodeUrl(acc, p[2], p[3]), behaviorHints: { notWebReady: false } }] };
  }

  if (type === 'tv') {
    const x = (await src.loadTV(acc)).byId.get(id);
    if (!x) return { streams: [] };
    // Pentru sursele TiviOne dam HLS si TS: televizoarele digera de obicei doar
    // HLS, iar PC-ul merge cu ambele, deci exista mereu o alternativa.
    const out = [];
    let n = 0;
    for (const s of [...x.servers].sort((a, b) => b.priority - a.priority)) {
      n++;
      if (s.provider === 'TiviOne') {
        const stem = src.liveStem(s.url);
        out.push({ name: `RaulTV • Server ${n} • TiviOne HLS`, title: x.name, url: stem + '.m3u8', behaviorHints: { notWebReady: false } });
        out.push({ name: `RaulTV • Server ${n} • TiviOne TS`, title: x.name, url: stem + '.ts', behaviorHints: { notWebReady: false } });
      } else {
        out.push({ name: `RaulTV • Server ${n} • ${s.source || 'Public'}`, title: x.name, url: s.url, behaviorHints: { notWebReady: false } });
      }
    }
    return { streams: out };
  }

  return { streams: [] };
}

const imdbStats = () => ({ titluriPotrivite: imdbCache.size, filmeMapate: imdbToVod.size, serialeMapate: imdbToSeries.size });

module.exports = { VERSION, manifest, catalog, meta, stream, posterFor, imdbStats };
