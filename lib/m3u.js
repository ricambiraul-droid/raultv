'use strict';

const { fetchUpstream } = require('./live');

// ---------------------------------------------------------------------------
// Import de playlist M3U.
//
// Dacă ai un abonament IPTV legal, furnizorul îți dă o adresă M3U. Pui adresa
// aia în RAULTV_M3U_URL și serverul potrivește singur canalele din playlist cu
// cele 201 posturi din catalog, după nume. Nu trebuie să scrii nicio adresă
// de flux manual.
//
// Funcționează la fel cu un fișier canale.m3u pus lângă server.js.
// ---------------------------------------------------------------------------

// Normalizeaza un nume de canal ca sa poata fi comparat:
// fara diacritice, fara sufixe de calitate, fara prefixe de tara.
function normalize(name) {
  return String(name)
    .toLowerCase()
    .replace(/ș|ş/g, 's').replace(/ț|ţ/g, 't')
    .replace(/ă|â/g, 'a').replace(/î/g, 'i')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(ro|rom|romania|hd|fhd|uhd|sd|4k|1080p?|720p?|h265|hevc|backup|alt)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Citeste un playlist M3U si intoarce intrarile cu nume si adresa.
function parseM3U(text) {
  const lines = String(text).split(/\r?\n/);
  const entries = [];
  let pending = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const comma = line.indexOf(',');
      const name = comma === -1 ? '' : line.slice(comma + 1).trim();
      const group = /group-title="([^"]*)"/i.exec(line);
      const tvgName = /tvg-name="([^"]*)"/i.exec(line);
      pending = {
        name: name || (tvgName ? tvgName[1] : ''),
        tvgName: tvgName ? tvgName[1] : '',
        group: group ? group[1] : ''
      };
      continue;
    }

    if (line.startsWith('#')) continue;

    if (pending && /^https?:\/\//i.test(line)) {
      entries.push({ ...pending, url: line });
      pending = null;
    }
  }
  return entries;
}

// Potriveste intrarile din playlist cu posturile din catalog.
// Intai potrivire exacta pe numele normalizat, apoi potrivire pe inceput de nume.
// Nu potrivim pe "contine" in ambele sensuri, ca sa nu ajunga "Digi Sport 1" la
// "Digi Sport 11" sau "TV" la orice.
function matchChannels(entries, channels) {
  const byName = new Map();
  for (const channel of channels) {
    const key = normalize(channel.name);
    if (key && !byName.has(key)) byName.set(key, channel.slug);
  }

  const result = {};
  const add = (slug, entry, eticheta) => {
    if (!result[slug]) result[slug] = [];
    if (result[slug].some(source => source.url === entry.url)) return;
    result[slug].push({ url: entry.url, eticheta, dinPlaylist: true });
  };

  for (const entry of entries) {
    for (const candidate of [entry.name, entry.tvgName]) {
      const key = normalize(candidate);
      if (!key) continue;

      if (byName.has(key)) {
        add(byName.get(key), entry, etichetaPentru(entry));
        break;
      }

      // potrivire pe cuvinte: numele din catalog trebuie sa fie identic
      // cu primele cuvinte din intrarea de playlist
      let gasit = null;
      for (const [name, slug] of byName) {
        if (key === name || key.startsWith(name + ' ')) {
          if (!gasit || name.length > normalize(gasit.name).length) gasit = { slug, name };
        }
      }
      if (gasit) { add(gasit.slug, entry, etichetaPentru(entry)); break; }
    }
  }
  return result;
}

// Scoate calitatea din numele intrarii, daca e mentionata: "PRO TV FHD" -> "FHD".
function etichetaPentru(entry) {
  const calitate = /\b(4K|UHD|FHD|1080p?|HD|720p?|SD)\b/i.exec(entry.name || '');
  return calitate ? calitate[1].toUpperCase() : null;
}

// Descarca un playlist de la o adresa.
async function fetchM3U(url) {
  const { response } = await fetchUpstream(url, { referer: null });
  if ((response.statusCode || 0) >= 400) {
    response.resume();
    throw new Error(`playlistul a răspuns cu ${response.statusCode}`);
  }
  return new Promise((resolve, reject) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', chunk => {
      body += chunk;
      if (body.length > 8 * 1024 * 1024) { response.destroy(); reject(new Error('playlist prea mare')); }
    });
    response.on('end', () => resolve(body));
    response.on('error', reject);
  });
}

module.exports = { parseM3U, matchChannels, normalize, fetchM3U, etichetaPentru };
