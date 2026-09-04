'use strict';

// ---------------------------------------------------------------------------
// Stratul de date: playlisturi publice + Xtream, pe cont, cu memorie comuna.
//
// Toate dispozitivele care folosesc acelasi cont impart aceleasi liste, deci 30
// de televizoare inseamna acelasi numar de cereri catre furnizor ca unul singur.
// Cererile identice pornite in acelasi moment se unifica, iar numarul de cereri
// simultane nu depaseste niciodata max_connections al contului.
// ---------------------------------------------------------------------------

const net = require('./net');
const { Semaphore, dedupe } = require('./guard');

const CACHE_MS = Number(process.env.CACHE_MS || 30 * 60 * 1000);
const TIMEOUT = Number(process.env.FETCH_TIMEOUT || 15000);
const BIG_TIMEOUT = Number(process.env.FETCH_TIMEOUT_BIG || 60000);
const MAX_ROWS = Number(process.env.MAX_ROWS || 60000);
// Listele mari (canale, filme, seriale) pot depasi zeci de MB; plafonul obisnuit
// ar taia raspunsul, asa ca pentru ele folosim unul separat.
const BIG_BYTES = Number(process.env.HTTP_MAX_BYTES_BIG || 96 * 1024 * 1024);

const PUBLIC = [
  { name: 'HMLendea RO', url: 'https://raw.githubusercontent.com/hmlendea/iptv-playlist/master/ro.m3u', priority: 20, provider: 'Public', tag: 'RO' },
  { name: 'IPTV-org RO', url: 'https://iptv-org.github.io/iptv/countries/ro.m3u', priority: 10, provider: 'Public', tag: 'RO' }
];

const TV_GENRES = ['RO', 'IT', 'UK', 'USA', 'DE', 'FR', 'ES', 'PT', 'NL', 'BE', 'IE', 'AT', 'CH', 'PL', 'CZ', 'HU', 'BG', 'GR', 'CY', 'TR', 'AL', 'EXYU', 'RS', 'HR', 'BA', 'ME', 'MK', 'SI', 'RU', 'UKR', 'SE', 'NO', 'DK', 'FI', 'LT', 'LV', 'CA EN', 'CA FR', 'LAT', 'MX', 'ARG', 'BR', 'COL', 'CHL', 'AR', 'IL', 'IR', 'KURD', 'PK', 'HINDI', 'ASIA', 'AFR', 'AU', 'NZ', 'PPV', 'UCL', 'WORLD'];
const VOD_GENRES = ['IT', 'EN', 'FR', 'DE', 'ES', 'PT', 'NL', 'PL', 'GR', 'TR', 'AL', 'EXYU', 'AR', 'IR', 'ASIA', 'MULTI'];

// --- text -----------------------------------------------------------------

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
const tidy = s => String(s || '').replace(/[([][^)\]]*[)\]]/g, ' ').replace(/\s+/g, ' ').trim();
const mergeKey = s => canonical(tidy(s)).replace(/\s+/g, '');
function attrs(s) { const o = {}; for (const m of s.matchAll(/([\w-]+)="([^"]*)"/g)) o[m[1]] = m[2]; return o; }

// --- Xtream, pe cont ------------------------------------------------------

const stores = new Map();
function store(acc) {
  let s = stores.get(acc.id);
  if (!s) {
    s = {
      tv: { at: 0, rows: [], byId: new Map() },
      vod: { at: 0, rows: [] },
      series: { at: 0, rows: [] },
      seriesInfo: new Map(),
      // Furnizorul permite max_connections fluxuri; pastram unul liber pentru
      // redarea propriu-zisa, deci nu cerem niciodata mai mult decat atat.
      sem: new Semaphore(Math.max(1, (Number(acc.maxConnections) || 1) - 0)),
      apeluri: 0, erori: 0
    };
    stores.set(acc.id, s);
  }
  s.sem.setMax(Math.max(1, Number(acc.maxConnections) || 1));
  return s;
}

const configured = acc => Boolean(acc && acc.server && acc.username && acc.password);

function apiUrl(acc, action, extra) {
  const q = new URLSearchParams({ username: acc.username, password: acc.password, ...(action ? { action } : {}), ...extra });
  return acc.server + '/player_api.php?' + q.toString();
}

async function api(acc, action, extra = {}, timeout = TIMEOUT, maxBytes) {
  if (!configured(acc)) throw new Error('cont neconfigurat');
  const s = store(acc);
  // Cheia de deduplicare nu contine credentiale.
  const key = `api|${acc.id}|${action || 'account'}|${JSON.stringify(extra)}`;
  return dedupe(key, () => s.sem.run(async () => {
    s.apeluri++;
    try { return await net.getJson(apiUrl(acc, action, extra), { timeout, maxBytes }); }
    catch (e) { s.erori++; throw e; }
  }));
}

// --- playlisturi publice (comune tuturor conturilor) ----------------------

let publicCache = { at: 0, rows: [] };

function parseM3U(text, src) {
  let info = null; const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const l = raw.trim();
    if (l.startsWith('#EXTINF')) {
      const a = attrs(l);
      const i = l.lastIndexOf(',');   // numele e dupa ULTIMA virgula
      const { name } = splitTag(i >= 0 ? l.slice(i + 1) : (a['tvg-name'] || 'Canal'));
      info = { name: name || a['tvg-name'] || 'Canal', logo: a['tvg-logo'] || '' };
      continue;
    }
    if (info && /^https?:\/\//i.test(l)) {
      out.push({ tag: src.tag, name: info.name, logo: info.logo, url: l, provider: src.provider, source: src.name, priority: src.priority });
      info = null;
    }
  }
  return out;
}

async function loadPublic() {
  if (publicCache.rows.length && Date.now() - publicCache.at < CACHE_MS) return publicCache.rows;
  return dedupe('public-playlists', async () => {
    if (publicCache.rows.length && Date.now() - publicCache.at < CACHE_MS) return publicCache.rows;
    const rows = [];
    for (const s of PUBLIC) {
      try { rows.push(...parseM3U(await net.getText(s.url, { timeout: TIMEOUT }), s)); }
      catch (e) { console.error('[RaulTV] playlist public indisponibil:', s.name, e.message); }
    }
    publicCache = { at: Date.now(), rows };
    return rows;
  });
}

// --- Live TV --------------------------------------------------------------

async function loadTV(acc) {
  const s = store(acc);
  if (s.tv.rows.length && Date.now() - s.tv.at < CACHE_MS) return s.tv;
  return dedupe('tv|' + acc.id, async () => {
    if (s.tv.rows.length && Date.now() - s.tv.at < CACHE_MS) return s.tv;
    const rows = [...(await loadPublic())];

    if (configured(acc)) {
      try {
        const cats = await api(acc, 'get_live_categories');
        const catTag = new Map();
        for (const c of (Array.isArray(cats) ? cats : [])) catTag.set(String(c.category_id), splitTag(c.category_name).tag);
        // Un singur apel pentru toate canalele; per categorie ar insemna sute.
        const streams = await api(acc, 'get_live_streams', {}, BIG_TIMEOUT, BIG_BYTES);
        for (const x of (Array.isArray(streams) ? streams : [])) {
          if (rows.length >= MAX_ROWS) break;
          const sp = splitTag(x.name || 'Canal');
          const ext = (x.container_extension || 'ts').replace(/[^a-z0-9]/gi, '') || 'ts';
          rows.push({
            tag: catTag.get(String(x.category_id)) || sp.tag || '',
            name: sp.name || 'Canal', logo: x.stream_icon || '',
            url: `${acc.server}/live/${encodeURIComponent(acc.username)}/${encodeURIComponent(acc.password)}/${x.stream_id}.${ext}`,
            provider: 'TiviOne', source: 'TiviOne Xtream', priority: 120
          });
        }
      } catch (e) { console.error('[RaulTV] canale live indisponibile pentru contul', acc.id + ':', e.message); }
    }

    const m = new Map();
    for (const x of rows) {
      const key = mergeKey(x.name);
      if (!key) continue;
      const tag = x.tag || 'RO';
      const id = 'raultv:' + tag.toLowerCase().replace(/\s+/g, '-') + ':' + key;
      const nice = tidy(x.name) || x.name;
      if (!m.has(id)) m.set(id, { id, tag, name: nice, logo: x.logo, servers: [] });
      const z = m.get(id);
      if (nice && nice.length < z.name.length) z.name = nice;
      if (!z.logo && x.logo) z.logo = x.logo;
      if (!z.servers.some(v => v.url === x.url)) z.servers.push(x);
    }
    const order = new Map(TV_GENRES.map((g, i) => [g, i]));
    const list = [...m.values()].sort((a, b) => {
      const d = (order.has(a.tag) ? order.get(a.tag) : 999) - (order.has(b.tag) ? order.get(b.tag) : 999);
      return d || a.name.localeCompare(b.name);
    });
    s.tv = { at: Date.now(), rows: list, byId: new Map(list.map(x => [x.id, x])) };
    console.log(`[RaulTV] cont ${acc.id}: ${list.length} canale live in ${new Set(list.map(x => x.tag)).size} grupuri`);
    return s.tv;
  });
}

// --- VOD / Seriale --------------------------------------------------------

async function loadVod(acc) {
  const s = store(acc);
  if (s.vod.rows.length && Date.now() - s.vod.at < CACHE_MS) return s.vod.rows;
  return dedupe('vod|' + acc.id, async () => {
    if (s.vod.rows.length && Date.now() - s.vod.at < CACHE_MS) return s.vod.rows;
    let rows = [];
    try {
      const cats = await api(acc, 'get_vod_categories');
      const catTag = new Map();
      for (const c of (Array.isArray(cats) ? cats : [])) catTag.set(String(c.category_id), splitTag(c.category_name).tag);
      const data = await api(acc, 'get_vod_streams', {}, BIG_TIMEOUT, BIG_BYTES);
      rows = (Array.isArray(data) ? data : []).slice(0, MAX_ROWS).map(x => {
        const sp = splitTag(x.name || 'Film');
        return {
          id: String(x.stream_id), name: sp.name || 'Film',
          tag: catTag.get(String(x.category_id)) || sp.tag || '',
          poster: x.stream_icon || '', rating: x.rating || '', year: x.year || '',
          ext: (x.container_extension || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4'
        };
      });
    } catch (e) { console.error('[RaulTV] filme indisponibile pentru contul', acc.id + ':', e.message); }
    s.vod = { at: Date.now(), rows };
    return rows;
  });
}

async function loadSeries(acc) {
  const s = store(acc);
  if (s.series.rows.length && Date.now() - s.series.at < CACHE_MS) return s.series.rows;
  return dedupe('series|' + acc.id, async () => {
    if (s.series.rows.length && Date.now() - s.series.at < CACHE_MS) return s.series.rows;
    let rows = [];
    try {
      const cats = await api(acc, 'get_series_categories');
      const catTag = new Map();
      for (const c of (Array.isArray(cats) ? cats : [])) catTag.set(String(c.category_id), splitTag(c.category_name).tag);
      const data = await api(acc, 'get_series', {}, BIG_TIMEOUT, BIG_BYTES);
      rows = (Array.isArray(data) ? data : []).slice(0, MAX_ROWS).map(x => {
        const sp = splitTag(x.name || 'Serial');
        return {
          id: String(x.series_id), name: sp.name || 'Serial',
          tag: catTag.get(String(x.category_id)) || sp.tag || '',
          poster: x.cover || '', rating: x.rating || '', year: x.releaseDate || x.year || '', plot: x.plot || ''
        };
      });
    } catch (e) { console.error('[RaulTV] seriale indisponibile pentru contul', acc.id + ':', e.message); }
    s.series = { at: Date.now(), rows };
    return rows;
  });
}

async function seriesInfo(acc, sid) {
  const s = store(acc);
  const hit = s.seriesInfo.get(sid);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  return dedupe(`seriesinfo|${acc.id}|${sid}`, async () => {
    const data = await api(acc, 'get_series_info', { series_id: sid });
    if (s.seriesInfo.size > 400) s.seriesInfo.clear();
    s.seriesInfo.set(sid, { at: Date.now(), data: data || {} });
    return data || {};
  });
}

// --- adresele de flux (construite doar aici, niciodata in manifest) -------

const liveStem = url => url.replace(/\.[a-z0-9]+$/i, '');
const movieUrl = (acc, x) => `${acc.server}/movie/${encodeURIComponent(acc.username)}/${encodeURIComponent(acc.password)}/${x.id}.${x.ext}`;
const episodeUrl = (acc, eid, ext) => `${acc.server}/series/${encodeURIComponent(acc.username)}/${encodeURIComponent(acc.password)}/${eid}.${(ext || 'mp4').replace(/[^a-z0-9]/gi, '')}`;

function health() {
  const out = {};
  for (const [id, s] of stores) {
    out[id] = {
      canale: s.tv.rows.length, filme: s.vod.rows.length, seriale: s.series.rows.length,
      varstaCacheMin: s.tv.at ? Math.round((Date.now() - s.tv.at) / 60000) : null,
      apeluriUpstream: s.apeluri, eroriUpstream: s.erori, conexiuni: s.sem.stare()
    };
  }
  return { conturi: out, playlisturiPublice: publicCache.rows.length };
}

module.exports = {
  TV_GENRES, VOD_GENRES, CACHE_MS,
  splitTag, canonical, tidy, mergeKey,
  configured, api, loadTV, loadVod, loadSeries, seriesInfo,
  liveStem, movieUrl, episodeUrl, health
};
