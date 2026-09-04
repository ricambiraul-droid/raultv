const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');

const CACHE_MS = Number(process.env.CACHE_MS || 30 * 60 * 1000);
const TIMEOUT = Number(process.env.FETCH_TIMEOUT || 15000);
const BIG_TIMEOUT = Number(process.env.FETCH_TIMEOUT_BIG || 60000);
const PAGE = 100;

const PUBLIC = [
  { name: 'HMLendea RO', url: 'https://raw.githubusercontent.com/hmlendea/iptv-playlist/master/ro.m3u', priority: 20, provider: 'Public', tag: 'RO' },
  { name: 'IPTV-org RO', url: 'https://iptv-org.github.io/iptv/countries/ro.m3u', priority: 10, provider: 'Public', tag: 'RO' }
];

// Lista de tari/grupuri, in ordinea in care apar in selectorul din Stremio.
const TV_GENRES = ['RO', 'IT', 'UK', 'USA', 'DE', 'FR', 'ES', 'PT', 'NL', 'BE', 'IE', 'AT', 'CH', 'PL', 'CZ', 'HU', 'BG', 'GR', 'CY', 'TR', 'AL', 'EXYU', 'RS', 'HR', 'BA', 'ME', 'MK', 'SI', 'RU', 'UKR', 'SE', 'NO', 'DK', 'FI', 'LT', 'LV', 'CA EN', 'CA FR', 'LAT', 'MX', 'ARG', 'BR', 'COL', 'CHL', 'AR', 'IL', 'IR', 'KURD', 'PK', 'HINDI', 'ASIA', 'AFR', 'AU', 'NZ', 'PPV', 'UCL', 'WORLD'];
const VOD_GENRES = ['IT', 'EN', 'FR', 'DE', 'ES', 'PT', 'NL', 'PL', 'GR', 'TR', 'AL', 'EXYU', 'AR', 'IR', 'ASIA', 'MULTI'];

const manifest = {
  id: 'ro.raultv.live',
  version: '15.8.0',
  name: 'RaulTV FULL TiviOne',
  description: 'RaulTV v15.8 • Live TV din toate tarile + TiviOne Filme/VOD + Seriale • potrivire IMDB pentru subtitrari',
  resources: ['catalog', 'meta', 'stream'],
  types: ['tv', 'movie', 'series'],
  idPrefixes: ['raultv:', 'tivione:movie:', 'tivione:series:', 'tivione:episode:', 'tt'],
  catalogs: [
    { type: 'tv', id: 'all', name: '📺 RaulTV • Toate tarile', genres: TV_GENRES, extra: [{ name: 'genre', isRequired: false, options: TV_GENRES }, { name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { type: 'tv', id: 'ro', name: '🇷🇴 RaulTV • Romania', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { type: 'tv', id: 'it', name: '🇮🇹 RaulTV • Italia', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { type: 'movie', id: 'tivione-movies', name: '🎬 TiviOne • Filme', genres: VOD_GENRES, extra: [{ name: 'genre', isRequired: false, options: VOD_GENRES }, { name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { type: 'series', id: 'tivione-series', name: '📺 TiviOne • Seriale', genres: VOD_GENRES, extra: [{ name: 'genre', isRequired: false, options: VOD_GENRES }, { name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] }
  ]
};

const builder = new addonBuilder(manifest);
let tvCache = { at: 0, rows: [], byId: new Map() };
let vodCache = { at: 0, rows: [] };
let seriesCache = { at: 0, rows: [] };
const seriesInfo = new Map();

// „┃RO┃ CANALE SPORT" -> { tag:'RO', name:'CANALE SPORT' }; „Digi Sport 1" -> { tag:'', name:'Digi Sport 1' }
const TAG_RE = /^[\s|[({\-–—:•┃‖│]*([A-Za-z][A-Za-z0-9 +&]{0,12}?)\s*[|\])}┃‖│:]+\s*/;
function splitTag(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  const m = s.match(TAG_RE);
  if (m && s.length > m[0].length) return { tag: m[1].trim().toUpperCase(), name: s.slice(m[0].length).trim() };
  return { tag: '', name: s };
}
const canonical = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(uhd|fhd|hd|sd|4k|8k|2160p?|1080p?|720p?)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const slug = s => canonical(s).replace(/\s+/g, '-') || 'item';

function attrs(s) { const o = {}; for (const m of s.matchAll(/([\w-]+)="([^"]*)"/g)) o[m[1]] = m[2]; return o; }

function cfg() {
  return {
    base: (process.env.TIVIONE_XTREAM_SERVER || '').replace(/\/+$/, ''),
    username: process.env.TIVIONE_XTREAM_USERNAME || '',
    password: process.env.TIVIONE_XTREAM_PASSWORD || ''
  };
}
async function api(action, extra = {}, timeout = TIMEOUT) {
  const c = cfg();
  if (!c.base || !c.username || !c.password) throw new Error('TiviOne not configured');
  return (await axios.get(c.base + '/player_api.php', {
    params: { username: c.username, password: c.password, ...(action ? { action } : {}), ...extra },
    timeout, headers: { 'User-Agent': 'RaulTV/15.7' }
  })).data;
}

function parseM3U(text, src) {
  let info = null; const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const l = raw.trim();
    if (l.startsWith('#EXTINF')) {
      const a = attrs(l);
      // Numele este dupa ULTIMA virgula: atributele contin virgule („(KHTML, like Gecko)").
      const i = l.lastIndexOf(',');
      const { name } = splitTag(i >= 0 ? l.slice(i + 1) : (a['tvg-name'] || 'Canal'));
      info = { name: name || a['tvg-name'] || 'Canal', logo: a['tvg-logo'] || '', group: a['group-title'] || '' };
      continue;
    }
    if (info && /^https?:\/\//i.test(l)) {
      out.push({ tag: src.tag, name: info.name, logo: info.logo, url: l, provider: src.provider, source: src.name, priority: src.priority });
      info = null;
    }
  }
  return out;
}

async function loadTV() {
  if (tvCache.rows.length && Date.now() - tvCache.at < CACHE_MS) return tvCache;
  const rows = [];

  for (const s of PUBLIC) {
    try { rows.push(...parseM3U((await axios.get(s.url, { timeout: TIMEOUT })).data, s)); }
    catch (e) { console.error('[RaulTV]', s.name, e.message); }
  }

  const c = cfg();
  if (c.base && c.username && c.password) {
    try {
      const cats = await api('get_live_categories');
      const catTag = new Map();
      for (const cat of (Array.isArray(cats) ? cats : [])) catTag.set(String(cat.category_id), splitTag(cat.category_name).tag);
      // Un singur apel pentru toate canalele; per categorie ar insemna sute de cereri.
      const streams = await api('get_live_streams', {}, BIG_TIMEOUT);
      for (const x of (Array.isArray(streams) ? streams : [])) {
        const sp = splitTag(x.name || 'Canal');
        const tag = catTag.get(String(x.category_id)) || sp.tag || '';
        const ext = (x.container_extension || 'ts').replace(/[^a-z0-9]/gi, '') || 'ts';
        rows.push({
          tag, name: sp.name || 'Canal', logo: x.stream_icon || '',
          url: `${c.base}/live/${encodeURIComponent(c.username)}/${encodeURIComponent(c.password)}/${x.stream_id}.${ext}`,
          provider: 'TiviOne', source: 'TiviOne Xtream', priority: 120
        });
      }
    } catch (e) { console.error('[RaulTV] Xtream live', e.message); }
  }

  const m = new Map();
  for (const x of rows) {
    const key = canonical(x.name);
    if (!key) continue;
    const tag = x.tag || 'RO';
    const id = 'raultv:' + tag.toLowerCase().replace(/\s+/g, '-') + ':' + slug(x.name);
    if (!m.has(id)) m.set(id, { id, tag, name: x.name, logo: x.logo, servers: [] });
    const z = m.get(id);
    if (!z.logo && x.logo) z.logo = x.logo;
    if (!z.servers.some(s => s.url === x.url)) z.servers.push(x);
  }
  const order = new Map(TV_GENRES.map((g, i) => [g, i]));
  const list = [...m.values()].sort((a, b) => {
    const d = (order.has(a.tag) ? order.get(a.tag) : 999) - (order.has(b.tag) ? order.get(b.tag) : 999);
    return d || a.name.localeCompare(b.name);
  });
  tvCache = { at: Date.now(), rows: list, byId: new Map(list.map(x => [x.id, x])) };
  console.log(`[RaulTV] ${list.length} canale live in ${new Set(list.map(x => x.tag)).size} grupuri`);
  return tvCache;
}

async function loadVod() {
  if (vodCache.rows.length && Date.now() - vodCache.at < CACHE_MS) return vodCache.rows;
  let rows = [];
  try {
    const cats = await api('get_vod_categories');
    const catTag = new Map();
    for (const cat of (Array.isArray(cats) ? cats : [])) catTag.set(String(cat.category_id), splitTag(cat.category_name).tag);
    const data = await api('get_vod_streams', {}, BIG_TIMEOUT);
    rows = (Array.isArray(data) ? data : []).map(x => {
      const sp = splitTag(x.name || 'Film');
      return {
        id: String(x.stream_id), name: sp.name || 'Film', tag: catTag.get(String(x.category_id)) || sp.tag || '',
        poster: x.stream_icon || '', rating: x.rating || '', year: x.year || '',
        ext: (x.container_extension || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4'
      };
    });
  } catch (e) { console.error('[RaulTV] Xtream VOD', e.message); }
  vodCache = { at: Date.now(), rows };
  return rows;
}

async function loadSeries() {
  if (seriesCache.rows.length && Date.now() - seriesCache.at < CACHE_MS) return seriesCache.rows;
  let rows = [];
  try {
    const cats = await api('get_series_categories');
    const catTag = new Map();
    for (const cat of (Array.isArray(cats) ? cats : [])) catTag.set(String(cat.category_id), splitTag(cat.category_name).tag);
    const data = await api('get_series', {}, BIG_TIMEOUT);
    rows = (Array.isArray(data) ? data : []).map(x => {
      const sp = splitTag(x.name || 'Serial');
      return {
        id: String(x.series_id), name: sp.name || 'Serial', tag: catTag.get(String(x.category_id)) || sp.tag || '',
        poster: x.cover || '', rating: x.rating || '', year: x.releaseDate || x.year || '', plot: x.plot || ''
      };
    });
  } catch (e) { console.error('[RaulTV] Xtream series', e.message); }
  seriesCache = { at: Date.now(), rows };
  return rows;
}


// ---------------------------------------------------------------------------
// Potrivirea cu IMDB. Serverul Xtream da doar tmdb_id, iar addon-urile de
// subtitrari din Stremio (OpenSubtitles etc.) cauta exclusiv dupa id-ul IMDB.
// Cautam titlul in catalogul public Cinemeta al Stremio si, cand gasim, dam
// elementului id-ul „tt…" — asa Stremio ii pune metadatele lui si addon-urile
// de subtitrari il recunosc.
// ---------------------------------------------------------------------------
const CINEMETA = 'https://v3-cinemeta.strem.io';
const IMDB_TIMEOUT = Number(process.env.IMDB_TIMEOUT || 5000);
const IMDB_CONCURRENCY = Number(process.env.IMDB_CONCURRENCY || 8);
const imdbCache = new Map();   // "movie|the thing|1982" -> 'tt0084787' | null
const imdbToVod = new Map();   // 'tt0084787' -> randul din loadVod()
const imdbToSeries = new Map();

function titleYear(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/\((19|20)\d{2}\)\s*$/);
  const year = m ? Number(m[0].replace(/[()\s]/g, '')) : 0;
  let title = (m ? s.slice(0, m.index) : s).trim();
  title = title.replace(/\b(4K|UHD|FHD|HD|SD|1080p?|720p?|2160p?|MULTI|VOSTFR|DUB|SUB)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ').replace(/[\-–—:|]+\s*$/, '').trim();
  return { title, year };
}

async function findImdb(type, rawName) {
  const { title, year } = titleYear(rawName);
  if (!title || title.length < 2) return null;
  const key = type + '|' + canonical(title) + '|' + (year || '');
  if (imdbCache.has(key)) return imdbCache.get(key);
  let hit = null;
  try {
    const url = `${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(title)}.json`;
    const data = (await axios.get(url, { timeout: IMDB_TIMEOUT })).data;
    const metas = (data && data.metas) || [];
    const want = canonical(title);
    let exact = null, loose = null;
    for (const m of metas) {
      if (!m || !m.id || !String(m.id).startsWith('tt')) continue;
      const got = canonical(m.name);
      const my = Number(String(m.releaseInfo || '').slice(0, 4)) || 0;
      const yearOk = !year || !my || Math.abs(my - year) <= 1;
      if (got === want && yearOk) { exact = m.id; break; }
      if (!loose && got === want) loose = m.id;
    }
    hit = exact || loose || null;
  } catch (e) { hit = null; }
  imdbCache.set(key, hit);
  return hit;
}

// Rezolva un lot de randuri cu paralelism limitat; ce nu se potriveste ramane
// cu id-ul intern, deci nu se pierde nimic din catalog.
async function attachImdb(rows, type) {
  const out = new Array(rows.length);
  let i = 0;
  async function worker() {
    while (i < rows.length) {
      const k = i++;
      const row = rows[k];
      const id = await findImdb(type, row.name);
      if (id) {
        if (type === 'movie') imdbToVod.set(id, row); else imdbToSeries.set(id, row);
      }
      out[k] = id;
    }
  }
  await Promise.all(Array.from({ length: Math.min(IMDB_CONCURRENCY, rows.length) }, worker));
  return out;
}

async function seriesInfoOf(sid) {
  let info = seriesInfo.get(sid);
  if (!info || Date.now() - info.at > CACHE_MS) {
    info = { at: Date.now(), data: await api('get_series_info', { series_id: sid }) };
    seriesInfo.set(sid, info);
  }
  return info.data || {};
}

function page(rows, args) {
  const g = (args.extra && args.extra.genre || '').trim().toUpperCase();
  if (g) rows = rows.filter(x => x.tag === g);
  const q = (args.extra && args.extra.search || '').toLowerCase().trim();
  if (q) rows = rows.filter(x => x.name.toLowerCase().includes(q));
  const skip = Math.max(0, Number(args.extra && args.extra.skip || 0));
  return rows.slice(skip, skip + PAGE);
}

builder.defineCatalogHandler(async args => {
  if (args.type === 'movie' && args.id === 'tivione-movies') {
    const rows = page(await loadVod(), args);
    const ids = await attachImdb(rows, 'movie');
    return {
      metas: rows.map((x, k) => ({
        id: ids[k] || ('tivione:movie:' + x.id), type: 'movie', name: x.name, poster: x.poster || undefined,
        description: [x.tag, x.year, x.rating && ('⭐ ' + x.rating)].filter(Boolean).join(' • ')
      }))
    };
  }
  if (args.type === 'series' && args.id === 'tivione-series') {
    const rows = page(await loadSeries(), args);
    const ids = await attachImdb(rows, 'series');
    return {
      metas: rows.map((x, k) => ({
        id: ids[k] || ('tivione:series:' + x.id), type: 'series', name: x.name, poster: x.poster || undefined,
        description: x.plot || [x.tag, x.year, x.rating].filter(Boolean).join(' • ')
      }))
    };
  }
  const tv = await loadTV();
  let rows = tv.rows;
  if (args.id === 'ro') rows = rows.filter(x => x.tag === 'RO');
  else if (args.id === 'it') rows = rows.filter(x => x.tag === 'IT');
  // In randul „Toate tarile" numele poarta eticheta de tara, ca sa se vada dintr-o privire.
  const showTag = args.id === 'all';
  return {
    metas: page(rows, args).map(x => ({
      id: x.id, type: 'tv', name: showTag && x.tag ? `[${x.tag}] ${x.name}` : x.name,
      poster: x.logo || undefined, posterShape: 'square',
      description: `${x.tag} • ${x.servers.length} server(e)`
    }))
  };
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (String(id).startsWith('tt')) return { meta: null }; // metadatele vin de la Cinemeta
  if (type === 'movie' && id.startsWith('tivione:movie:')) {
    const x = (await loadVod()).find(v => id === 'tivione:movie:' + v.id);
    return { meta: x ? { id, type: 'movie', name: x.name, poster: x.poster || undefined, description: [x.tag, x.year, x.rating && ('⭐ ' + x.rating)].filter(Boolean).join(' • ') } : null };
  }
  if (type === 'series' && id.startsWith('tivione:series:')) {
    const sid = id.split(':').pop();
    let info = seriesInfo.get(sid);
    if (!info || Date.now() - info.at > CACHE_MS) {
      try { info = { at: Date.now(), data: await api('get_series_info', { series_id: sid }) }; seriesInfo.set(sid, info); }
      catch (e) { return { meta: null }; }
    }
    const d = info.data || {};
    const base = (await loadSeries()).find(x => x.id === sid) || {};
    const videos = [];
    for (const [season, arr] of Object.entries(d.episodes || {})) {
      for (const e of (Array.isArray(arr) ? arr : [])) {
        videos.push({
          id: `tivione:episode:${e.id}:${(e.container_extension || 'mp4').replace(/[^a-z0-9]/gi, '')}`,
          title: e.title || `Episod ${e.episode_num || ''}`,
          season: Number(season) || 1, episode: Number(e.episode_num) || 1,
          released: e.info && e.info.releasedate ? new Date(e.info.releasedate) : undefined
        });
      }
    }
    return { meta: { id, type: 'series', name: (d.info && d.info.name) || base.name || 'Serial', poster: (d.info && d.info.cover) || base.poster || undefined, background: (d.info && d.info.backdrop_path && d.info.backdrop_path[0]) || undefined, description: (d.info && d.info.plot) || base.plot || '', videos } };
  }
  if (type === 'tv') {
    const x = (await loadTV()).byId.get(id);
    return { meta: x ? { id, type: 'tv', name: x.name, poster: x.logo || undefined, posterShape: 'square', description: `${x.tag} • ${x.servers.length} server(e)` } : null };
  }
  return { meta: null };
});

function vodStream(c, x) {
  return { name: 'TiviOne • Film', title: x.name, url: `${c.base}/movie/${encodeURIComponent(c.username)}/${encodeURIComponent(c.password)}/${x.id}.${x.ext}`, behaviorHints: { notWebReady: false } };
}
function epStream(c, eid, ext, title) {
  return { name: 'TiviOne • Episod', title, url: `${c.base}/series/${encodeURIComponent(c.username)}/${encodeURIComponent(c.password)}/${eid}.${(ext || 'mp4').replace(/[^a-z0-9]/gi, '')}`, behaviorHints: { notWebReady: false } };
}

builder.defineStreamHandler(async ({ type, id }) => {
  const c = cfg();
  if (!c.base) return { streams: [] };
  // „tt0084787" (film) sau „tt0903747:1:2" (episod) — vin de la Cinemeta.
  if (String(id).startsWith('tt')) {
    const p = String(id).split(':');
    if (p.length === 1) {
      const x = imdbToVod.get(p[0]);
      return { streams: x ? [vodStream(c, x)] : [] };
    }
    const base = imdbToSeries.get(p[0]);
    if (!base) return { streams: [] };
    const season = Number(p[1]) || 1, episode = Number(p[2]) || 1;
    try {
      const d = await seriesInfoOf(base.id);
      for (const [sn, arr] of Object.entries(d.episodes || {})) {
        if ((Number(sn) || 1) !== season) continue;
        for (const e of (Array.isArray(arr) ? arr : [])) {
          if ((Number(e.episode_num) || 1) === episode) return { streams: [epStream(c, e.id, e.container_extension, base.name)] };
        }
      }
    } catch (e) { console.error('[RaulTV] series info', e.message); }
    return { streams: [] };
  }
  if (type === 'movie' && id.startsWith('tivione:movie:')) {
    const sid = id.split(':').pop();
    const x = (await loadVod()).find(v => v.id === sid);
    if (!x || !c.base) return { streams: [] };
    return { streams: [{ name: 'TiviOne • Film', title: x.name, url: `${c.base}/movie/${encodeURIComponent(c.username)}/${encodeURIComponent(c.password)}/${x.id}.${x.ext}`, behaviorHints: { notWebReady: false } }] };
  }
  if (type === 'series' && id.startsWith('tivione:episode:')) {
    const p = id.split(':'); const eid = p[2]; const ext = (p[3] || 'mp4').replace(/[^a-z0-9]/gi, '');
    if (!c.base) return { streams: [] };
    return { streams: [{ name: 'TiviOne • Episod', url: `${c.base}/series/${encodeURIComponent(c.username)}/${encodeURIComponent(c.password)}/${eid}.${ext}`, behaviorHints: { notWebReady: false } }] };
  }
  if (type === 'tv') {
    const x = (await loadTV()).byId.get(id);
    if (!x) return { streams: [] };
    return {
      streams: [...x.servers].sort((a, b) => b.priority - a.priority).map((s, i) => ({
        name: `RaulTV • Server ${i + 1}${s.provider === 'TiviOne' ? ' • TiviOne' : ''}`,
        title: x.name, url: s.url, behaviorHints: { notWebReady: false }
      }))
    };
  }
  return { streams: [] };
});

module.exports = builder.getInterface();
