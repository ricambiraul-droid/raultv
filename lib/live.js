'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const UA = 'Mozilla/5.0 (SmartTV; Linux) AppleWebKit/537.36 Stremio/RaulTV';
const TIMEOUT = 12000;

// ---------------------------------------------------------------------------
// Rezolvarea surselor
// ---------------------------------------------------------------------------

function envKey(slug) {
  return `RAULTV_${slug.toUpperCase().replace(/-/g, '_')}_URL`;
}

// Numele istorice de variabile pentru canalele DIGI, pastrate din v2.
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

function isHttp(value) {
  return /^https?:\/\/\S+$/i.test(String(value || '').trim());
}

// Sursele unui canal: intai cele din variabilele de mediu, apoi cele din surse.js.
// Variabila poate contine mai multe adrese separate prin virgula sau spatiu.
function sourcesFor(slug, table) {
  const list = [];

  const fromEnv = process.env[envKey(slug)] || (LEGACY_ENV[slug] && process.env[LEGACY_ENV[slug]]) || '';
  for (const piece of String(fromEnv).split(/[,\s]+/)) {
    if (isHttp(piece)) list.push({ url: piece.trim(), eticheta: 'Prin server', dinMediu: true });
  }

  for (const source of (table[slug] || [])) {
    if (isHttp(source.url)) list.push({ ...source, url: source.url.trim() });
  }

  return list.map((source, index) => ({
    url: source.url,
    referer: source.referer || null,
    eticheta: source.eticheta || `Server ${index + 1}`,
    dinMediu: Boolean(source.dinMediu)
  }));
}

// ---------------------------------------------------------------------------
// Retransmisie HLS, folosita doar cand sursa cere un antet Referer.
// Un redirect nu poate impune antete, deci pentru sursele astea trecem
// continutul prin server. Pentru restul redirectam si nu consumam banda.
// ---------------------------------------------------------------------------

function headersFor(source) {
  const headers = { 'User-Agent': UA, 'Accept': '*/*' };
  if (source.referer) {
    headers.Referer = source.referer;
    try { headers.Origin = new URL(source.referer).origin; } catch { /* referer invalid */ }
  }
  return headers;
}

// Rescrie adresele relative dintr-un playlist HLS ca sa treaca tot prin proxy.
function rewritePlaylist(body, sourceUrl, proxyBase) {
  const wrap = target => {
    let absolute;
    try { absolute = new URL(target, sourceUrl).toString(); } catch { return target; }
    return `${proxyBase}?catre=${encodeURIComponent(absolute)}`;
  };

  return body.split('\n').map(rawLine => {
    const line = rawLine.trim();
    if (!line) return rawLine;

    // adrese din atribute, de exemplu URI="chei.key"
    if (line.startsWith('#')) {
      return rawLine.replace(/URI="([^"]+)"/g, (match, target) => `URI="${wrap(target)}"`);
    }
    return wrap(line);
  }).join('\n');
}

function fetchUpstream(target, source, redirectsLeft = 4) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(target); } catch { return reject(new Error('Adresă invalidă')); }
    const client = parsed.protocol === 'http:' ? http : https;

    const request = client.get(target, { headers: headersFor(source), timeout: TIMEOUT }, response => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location && redirectsLeft > 0) {
        response.resume();
        let next;
        try { next = new URL(response.headers.location, target).toString(); } catch { return reject(new Error('Redirect invalid')); }
        return resolve(fetchUpstream(next, source, redirectsLeft - 1));
      }
      resolve({ response, finalUrl: target });
    });

    request.on('timeout', () => request.destroy(new Error('Sursa nu răspunde')));
    request.on('error', reject);
  });
}

// Retransmite o adresa prin server. `catre` e adresa reala ceruta de player.
async function proxyStream(req, res, target, source, proxyBase) {
  let upstream;
  try {
    upstream = await fetchUpstream(target, source);
  } catch (error) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    return res.end(`Sursa nu răspunde: ${error.message}`);
  }

  const { response, finalUrl } = upstream;
  const status = response.statusCode || 502;
  const type = String(response.headers['content-type'] || '');
  const isPlaylist = /mpegurl/i.test(type) || /\.m3u8(\?|$)/i.test(finalUrl);

  if (status >= 400) {
    response.resume();
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    return res.end(`Sursa a răspuns cu ${status}`);
  }

  if (isPlaylist) {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => {
      const rewritten = rewritePlaylist(body, finalUrl, proxyBase);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'Content-Length': Buffer.byteLength(rewritten),
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(req.method === 'HEAD' ? undefined : rewritten);
    });
    response.on('error', () => res.end());
    return;
  }

  // segmente video, chei de criptare: le trecem mai departe neatinse
  const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    if (response.headers[name]) headers[name] = response.headers[name];
  }
  res.writeHead(status, headers);
  if (req.method === 'HEAD') { response.resume(); return res.end(); }
  response.pipe(res);
  response.on('error', () => res.end());
}


// ---------------------------------------------------------------------------
// Rezolutii: un playlist master HLS contine cate o variantă per calitate.
// Le citim si le oferim ca optiuni separate in lista din Stremio.
// ---------------------------------------------------------------------------

// Extrage variantele dintr-un playlist master.
function parseMaster(body, sourceUrl) {
  const lines = String(body).split('\n');
  const variants = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;

    const resolution = /RESOLUTION=(\d+)x(\d+)/i.exec(line);
    const bandwidth = /[^-]BANDWIDTH=(\d+)/i.exec(' ' + line);

    // adresa variantei e pe prima linie care nu e comentariu
    let target = '';
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j].trim();
      if (!candidate) continue;
      if (candidate.startsWith('#')) continue;
      target = candidate;
      break;
    }
    if (!target) continue;

    let absolute;
    try { absolute = new URL(target, sourceUrl).toString(); } catch { continue; }

    variants.push({
      inaltime: resolution ? Number(resolution[2]) : null,
      latime: resolution ? Number(resolution[1]) : null,
      banda: bandwidth ? Number(bandwidth[1]) : null,
      url: absolute
    });
  }

  // cea mai mare calitate prima, fara duplicate de inaltime
  const seen = new Set();
  return variants
    .sort((a, b) => (b.inaltime || 0) - (a.inaltime || 0) || (b.banda || 0) - (a.banda || 0))
    .filter(variant => {
      const key = variant.inaltime || variant.banda || variant.url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// Eticheta prietenoasa pentru o varianta: "1080p", "720p" sau debitul.
function labelFor(variant) {
  if (variant.inaltime) {
    const suffix = variant.inaltime >= 2160 ? ' 4K' : variant.inaltime >= 1080 ? ' HD' : '';
    return `${variant.inaltime}p${suffix}`;
  }
  if (variant.banda) return `${Math.round(variant.banda / 1000)} kbps`;
  return 'Variantă';
}

// Cache scurt: playlisturile master se schimbă rar, dar nu vrem să le cerem
// la fiecare deschidere de canal.
const variantCache = new Map();
const VARIANT_TTL = 5 * 60 * 1000;

async function variantsFor(source, timeout = 3500) {
  const cached = variantCache.get(source.url);
  if (cached && Date.now() - cached.la < VARIANT_TTL) return cached.variante;

  let variante = [];
  try {
    variante = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), timeout);
      fetchUpstream(source.url, source).then(({ response, finalUrl }) => {
        if ((response.statusCode || 0) >= 400) { response.resume(); clearTimeout(timer); return resolve([]); }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          body += chunk;
          if (body.length > 262144) response.destroy();
        });
        response.on('end', () => { clearTimeout(timer); resolve(parseMaster(body, finalUrl)); });
        response.on('error', () => { clearTimeout(timer); resolve([]); });
      }).catch(error => { clearTimeout(timer); reject(error); });
    });
  } catch {
    variante = [];
  }

  variantCache.set(source.url, { la: Date.now(), variante });
  return variante;
}

module.exports = {
  sourcesFor, proxyStream, rewritePlaylist, parseMaster, labelFor, variantsFor,
  fetchUpstream, envKey, LEGACY_ENV, UA
};
