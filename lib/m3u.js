'use strict';

const { fetchUpstream } = require('./live');

// ---------------------------------------------------------------------------
// Import de playlist M3U.
//
// Format acceptat, inclusiv cel folosit de iptv-org:
//
//   #EXTINF:-1 tvg-id="TVR1.ro@SD" tvg-logo="..." group-title="General",TVR 1
//   https://tvr-1.lg.mncdn.com/tvr1/smil:tvr1.smil/playlist.m3u8
//
// Atenție la două capcane:
//   - numele e după ULTIMA virgulă, nu prima: atributul http-user-agent conține
//     el însuși virgule ("(KHTML, like Gecko)") și taie numele în două;
//   - unele fluxuri cer antete http-referrer / http-user-agent, date fie ca
//     atribute pe linia #EXTINF, fie pe linii #EXTVLCOPT dedesubt.
// ---------------------------------------------------------------------------

function normalize(name) {
  return String(name)
    .toLowerCase()
    .replace(/ș|ş/g, 's').replace(/ț|ţ/g, 't')
    .replace(/ă|â/g, 'a').replace(/î/g, 'i')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(ro|rom|romania|hd|fhd|uhd|sd|4k|1080p?|1080i|720p?|576p?|576i|540p?|480p?|360p?|h265|hevc|backup|alt)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Cheie fără spații, pentru cazuri ca „A7 TV" vs „A7TV".
function compact(name) {
  return normalize(name).replace(/ /g, '');
}

// tvg-id-ul iptv-org e CamelCase: TVR1.ro@SD, AtomicTV.ro, RealitateaPlus.ro.
// Îl desfacem în cuvinte ca să-l putem compara cu numele din catalog.
function dinTvgId(id) {
  let text = String(id || '').split('@')[0].replace(/\.[a-z]{2,3}$/i, '');
  if (!text) return '';
  text = text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2');
  return text;
}

function atribut(linie, nume) {
  const m = new RegExp(`${nume}="([^"]*)"`, 'i').exec(linie);
  return m ? m[1] : null;
}

// Calitatea, dacă e scrisă în nume: „Atomic TV (360p)" -> „360p".
function calitateaDin(nume) {
  const m = /\((\d{3,4}[pi]|4K|UHD|FHD|HD|SD)\)/i.exec(String(nume));
  return m ? m[1].toUpperCase() : null;
}

// Unele playlisturi trec și legături către pagini video, nu către fluxuri:
// un link YouTube sau Facebook nu poate fi redat de player ca stream, deci
// nu-l adăugăm ca sursă — ar apărea în listă și ar da eroare la play.
const GAZDE_RESPINSE = /(^|\.)(youtube\.com|youtu\.be|facebook\.com|fb\.watch|twitch\.tv|dailymotion\.com|vimeo\.com)$/i;

function esteFlux(url) {
  let gazda;
  try { gazda = new URL(url).hostname; } catch { return false; }
  return !GAZDE_RESPINSE.test(gazda);
}

function parseM3U(text) {
  const linii = String(text).split(/\r?\n/);
  const intrari = [];
  let pending = null;

  for (const raw of linii) {
    const linie = raw.trim();
    if (!linie) continue;

    if (linie.startsWith('#EXTINF')) {
      // numele e după ultima virgulă
      const taietura = linie.lastIndexOf(',');
      const nume = taietura === -1 ? '' : linie.slice(taietura + 1).trim();
      pending = {
        nume,
        tvgId: atribut(linie, 'tvg-id'),
        tvgName: atribut(linie, 'tvg-name'),
        grup: atribut(linie, 'group-title'),
        logo: atribut(linie, 'tvg-logo'),
        referer: atribut(linie, 'http-referrer'),
        userAgent: atribut(linie, 'http-user-agent'),
        calitate: calitateaDin(nume),
        non24: /\[Not 24\/7\]/i.test(nume),
        geo: /\[Geo-blocked\]/i.test(nume)
      };
      continue;
    }

    // opțiuni de player, scrise pe linii separate sub #EXTINF
    if (linie.startsWith('#EXTVLCOPT') && pending) {
      const ref = /http-referrer=(.+)$/i.exec(linie);
      const ua = /http-user-agent=(.+)$/i.exec(linie);
      if (ref && !pending.referer) pending.referer = ref[1].trim();
      if (ua && !pending.userAgent) pending.userAgent = ua[1].trim();
      continue;
    }

    if (linie.startsWith('#')) continue;

    if (pending && /^https?:\/\//i.test(linie)) {
      if (esteFlux(linie)) intrari.push({ ...pending, url: linie });
      pending = null;
    }
  }
  return intrari;
}

// Potrivește intrările cu posturile din catalog.
// Ordinea încercărilor: tvg-id, apoi numele, apoi variantele fără spații.
function matchChannels(intrari, channels) {
  const dupaNume = new Map();
  const dupaCompact = new Map();
  for (const channel of channels) {
    const cheie = normalize(channel.name);
    const strans = compact(channel.name);
    if (cheie && !dupaNume.has(cheie)) dupaNume.set(cheie, channel.slug);
    if (strans.length >= 4 && !dupaCompact.has(strans)) dupaCompact.set(strans, channel.slug);
  }

  const rezultat = {};
  const adauga = (slug, intrare) => {
    if (!rezultat[slug]) rezultat[slug] = [];
    if (rezultat[slug].some(sursa => sursa.url === intrare.url)) return;
    rezultat[slug].push({
      url: intrare.url,
      logo: intrare.logo || null,
      calitate: intrare.calitate,
      referer: intrare.referer || null,
      userAgent: intrare.userAgent || null,
      non24: intrare.non24,
      geo: intrare.geo,
      dinPlaylist: true
    });
  };

  for (const intrare of intrari) {
    const variante = [dinTvgId(intrare.tvgId), intrare.nume, intrare.tvgName].filter(Boolean);
    let slug = null;

    for (const varianta of variante) {
      const cheie = normalize(varianta);
      if (cheie && dupaNume.has(cheie)) { slug = dupaNume.get(cheie); break; }
    }
    if (!slug) {
      for (const varianta of variante) {
        const strans = compact(varianta);
        if (strans.length >= 4 && dupaCompact.has(strans)) { slug = dupaCompact.get(strans); break; }
      }
    }
    // ultimul resort: numele din catalog e exact începutul numelui din playlist
    if (!slug) {
      for (const varianta of variante) {
        const cheie = normalize(varianta);
        if (!cheie) continue;
        let cel_mai_lung = null;
        for (const [nume, candidat] of dupaNume) {
          if (cheie === nume || cheie.startsWith(nume + ' ')) {
            if (!cel_mai_lung || nume.length > cel_mai_lung.nume.length) cel_mai_lung = { nume, slug: candidat };
          }
        }
        if (cel_mai_lung) { slug = cel_mai_lung.slug; break; }
      }
    }

    if (slug) adauga(slug, intrare);
  }
  return rezultat;
}

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
      if (body.length > 12 * 1024 * 1024) { response.destroy(); reject(new Error('playlist prea mare')); }
    });
    response.on('end', () => resolve(body));
    response.on('error', reject);
  });
}

module.exports = { parseM3U, matchChannels, normalize, compact, dinTvgId, calitateaDin, fetchM3U, esteFlux };
