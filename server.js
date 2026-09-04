'use strict';

// ---------------------------------------------------------------------------
// Serverul RaulTV: rutare per dispozitiv, chenare, panou de administrare si
// endpointuri de stare. Nu proxaza video — playerul primeste adresa sursei.
//
// Reguli stricte:
//   * credentialele Xtream nu apar in manifest, in UI si in loguri;
//   * token-ul unui dispozitiv nu se scrie niciodata intreg in log;
//   * nu se fac probe video automate.
// ---------------------------------------------------------------------------

const http = require('http');
const addon = require('./addon');
const src = require('./lib/source');
const devices = require('./lib/devices');
const tile = require('./lib/tile');
const { RateLimiter, dedupeStats } = require('./lib/guard');

const PORT = Number(process.env.PORT || 7000);
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '').trim();
const rate = new RateLimiter(Number(process.env.RATE_LIMIT || 240), Number(process.env.RATE_WINDOW_MS || 60000));

const pornit = Date.now();
let cereri = 0, respinse = 0, erori = 0;

// --- ajutoare -------------------------------------------------------------

function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
  res.setHeader('access-control-allow-headers', '*');
}

function json(res, body, { status = 200, cache = 'no-store' } = {}) {
  cors(res);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', cache);
  res.end(JSON.stringify(body));
}

function text(res, body, status = 200, type = 'text/plain; charset=utf-8') {
  cors(res);
  res.statusCode = status;
  res.setHeader('content-type', type);
  res.end(body);
}

// In log intra doar id-ul dispozitivului, niciodata token-ul si niciodata
// adresa cu user/parola.
const curat = p => p.replace(/\/d\/[^/]+/, '/d/•').replace(/(username|password)=[^&]*/gi, '$1=•');

function baseUrl(req) {
  const env = String(process.env.PUBLIC_URL || '').trim();
  if (/^https?:\/\//.test(env)) return env.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'raultv.onrender.com').split(',')[0].trim();
  return `${proto}://${host}`;
}

const ip = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'necunoscut';

// Stremio cere /catalog/tv/all/genre=RO&skip=100.json
function parseExtra(raw) {
  const out = {};
  if (!raw) return out;
  for (const part of decodeURIComponent(raw).split('&')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

// --- panoul de administrare ----------------------------------------------

function adminOk(url) {
  return ADMIN_TOKEN && url.searchParams.get('key') === ADMIN_TOKEN;
}

function panelHtml(base) {
  return `<!doctype html><html lang="ro"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RaulTV · dispozitive</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#0b0f1c;color:#e8ecf8;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{padding:20px 22px;border-bottom:1px solid #232c4b}
h1{margin:0;font-size:19px}
.sub{color:#8b96b8;font-size:13px;margin-top:4px}
main{padding:18px 22px;max-width:1100px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:9px 8px;border-bottom:1px solid #1c2440;vertical-align:middle}
th{color:#8b96b8;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
tr.off td{opacity:.5}
input,select{background:#141b32;border:1px solid #2a3556;color:#e8ecf8;border-radius:7px;padding:6px 8px;font:inherit;font-size:13px}
input[type=text]{width:160px}
button{background:#3b5bdb;border:0;color:#fff;border-radius:7px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer}
button.ghost{background:#1d2540}
code{background:#141b32;padding:2px 6px;border-radius:5px;font-size:12px;word-break:break-all}
.link{color:#7aa2ff;text-decoration:none}
.bar{display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap}
.pill{background:#141b32;border:1px solid #2a3556;border-radius:999px;padding:4px 11px;font-size:12px;color:#a9b4d4}
</style></head><body>
<header><h1>RaulTV · dispozitive</h1><div class="sub" id="rez">se incarca…</div></header>
<main>
<div class="bar">
  <button class="ghost" onclick="load()">Reimprospateaza</button>
  <span class="pill" id="p1">—</span><span class="pill" id="p2">—</span><span class="pill" id="p3">—</span>
</div>
<table><thead><tr><th>Slot</th><th>Nume</th><th>Cont</th><th>Activ</th><th>Adresa de instalare</th><th>Ultima cerere</th><th></th></tr></thead>
<tbody id="t"></tbody></table>
</main>
<script>
const KEY = new URLSearchParams(location.search).get('key');
const BASE = ${JSON.stringify(base)};
async function load(){
  const r = await fetch('/admin/api/devices?key='+encodeURIComponent(KEY));
  if(!r.ok){ document.getElementById('rez').textContent = 'cheie de administrare gresita'; return; }
  const d = await r.json();
  document.getElementById('rez').textContent = d.stats.active+' active din '+d.stats.sloturi+' sloturi · '+d.stats.cereriTotale+' cereri';
  document.getElementById('p1').textContent = 'active 24h: '+d.stats.activeUltimele24h;
  document.getElementById('p2').textContent = 'conturi: '+d.conturi.map(c=>c.id+(c.configurat?'':' (neconfigurat)')).join(', ');
  document.getElementById('p3').textContent = 'sloturi libere: '+d.stats.inactive;
  const optiuni = d.conturi.map(c=>c.id).map(id=>'<option value="'+id+'">'+id+'</option>').join('');
  document.getElementById('t').innerHTML = d.dispozitive.map(x=>{
    const url = BASE+'/d/'+x.token+'/manifest.json';
    return '<tr class="'+(x.activ?'':'off')+'">'
      +'<td>'+x.id+'</td>'
      +'<td><input type="text" value="'+x.nume.replace(/"/g,'&quot;')+'" onchange="save(\\''+x.id+'\\',{nume:this.value})"></td>'
      +'<td><select onchange="save(\\''+x.id+'\\',{cont:this.value})">'+optiuni.replace('value="'+x.cont+'"','value="'+x.cont+'" selected')+'</select></td>'
      +'<td><input type="checkbox" '+(x.activ?'checked':'')+' onchange="save(\\''+x.id+'\\',{activ:this.checked})"></td>'
      +'<td>'+(x.activ?'<code>'+url+'</code> <a class="link" href="stremio://'+url.replace(/^https?:\\/\\//,'')+'">instaleaza</a>':'<span class="sub">—</span>')+'</td>'
      +'<td>'+(x.ultimaCerere?new Date(x.ultimaCerere).toLocaleString('ro-RO'):'—')+'</td>'
      +'<td>'+x.cereri+'</td></tr>';
  }).join('');
}
async function save(id, patch){
  await fetch('/admin/api/devices?key='+encodeURIComponent(KEY), {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,patch})});
  load();
}
load();
</script></body></html>`;
}

// --- serverul -------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  cereri++;
  let url;
  try { url = new URL(req.url, 'http://local'); } catch (e) { return text(res, 'cerere invalida', 400); }
  const path = url.pathname;

  if (req.method === 'OPTIONS') { cors(res); res.statusCode = 204; return res.end(); }
  if (req.method !== 'GET' && req.method !== 'POST') return text(res, 'metoda nepermisa', 405);

  try {
    // ---- chenare (fara token: sunt doar imagini) ----
    if (path === '/poster.png' || path.startsWith('/poster')) {
      const png = await tile.build(url.searchParams.get('n') || '', url.searchParams.get('u') || '');
      cors(res);
      res.setHeader('content-type', 'image/png');
      res.setHeader('cache-control', 'public, max-age=604800');
      return res.end(png);
    }

    // ---- stare publica, fara nimic sensibil ----
    if (path === '/health') {
      return json(res, {
        stare: 'ok', versiune: addon.VERSION,
        uptimeSec: Math.round((Date.now() - pornit) / 1000),
        dispozitive: devices.stats(),
        conturi: devices.listAccounts(),
        date: src.health(),
        memorieMB: Math.round(process.memoryUsage().rss / 1048576),
        panouActiv: Boolean(ADMIN_TOKEN)
      });
    }

    if (path === '/stats') {
      return json(res, {
        versiune: addon.VERSION,
        uptimeSec: Math.round((Date.now() - pornit) / 1000),
        cereri, respinse, erori,
        dispozitive: devices.stats(),
        imdb: addon.imdbStats(),
        deduplicare: dedupeStats(),
        rate: rate.stare(),
        date: src.health(),
        memorieMB: Math.round(process.memoryUsage().rss / 1048576)
      });
    }

    // ---- diagnostic cont (fara credentiale) ----
    if (path === '/tivione-status') {
      const acc = devices.getAccount(url.searchParams.get('cont') || 'main');
      if (!src.configured(acc)) return json(res, { versiune: addon.VERSION, configurat: false, cont: acc.id }, { status: 503 });
      try {
        const info = await src.api(acc, '');
        const u = (info && info.user_info) || {};
        return json(res, {
          versiune: addon.VERSION, cont: acc.id, configurat: true,
          auth: String(u.auth) === '1', status: u.status || null,
          expira: u.exp_date || null,
          conexiuniActive: u.active_cons || null, conexiuniMaxime: u.max_connections || null,
          nota: 'Doar metadate; niciun flux video nu este deschis.'
        });
      } catch (e) {
        return json(res, { versiune: addon.VERSION, cont: acc.id, configurat: true, eroare: e.message }, { status: 503 });
      }
    }

    // ---- panou ----
    if (path === '/admin') {
      if (!ADMIN_TOKEN) return text(res, 'Panoul este oprit. Adauga ADMIN_TOKEN in Render → Environment si redeployeaza.', 503);
      if (!adminOk(url)) return text(res, 'cheie de administrare lipsa sau gresita', 401);
      return text(res, panelHtml(baseUrl(req)), 200, 'text/html; charset=utf-8');
    }

    if (path === '/admin/api/devices') {
      if (!adminOk(url)) return json(res, { eroare: 'neautorizat' }, { status: 401 });
      if (req.method === 'POST') {
        const body = await new Promise((resolve, reject) => {
          let b = ''; let n = 0;
          req.on('data', d => { n += d.length; if (n > 8192) { req.destroy(); reject(new Error('prea mare')); } b += d; });
          req.on('end', () => resolve(b)); req.on('error', reject);
        });
        let payload;
        try { payload = JSON.parse(body || '{}'); } catch (e) { return json(res, { eroare: 'json invalid' }, { status: 400 }); }
        const d = devices.update(String(payload.id || ''), payload.patch || {});
        if (!d) return json(res, { eroare: 'slot inexistent' }, { status: 404 });
        console.log(`[RaulTV] panou: ${d.id} → activ=${d.activ} cont=${d.cont}`);
        return json(res, { ok: true });
      }
      return json(res, { dispozitive: devices.list({ includeToken: true }), stats: devices.stats(), conturi: devices.listAccounts() });
    }

    // ---- addon: /d/<token>/... sau rutele vechi (compatibilitate) ----
    let token = null;
    let rest = path;
    const m = path.match(/^\/d\/([A-Za-z0-9_-]{8,40})(\/.*)?$/);
    if (m) { token = m[1]; rest = m[2] || '/'; }

    let device = null, account = null;
    if (token) {
      const r = devices.resolve(token);
      if (!r || r.eroare === 'necunoscut') return json(res, { eroare: 'dispozitiv necunoscut' }, { status: 404 });
      if (r.eroare === 'dezactivat') return json(res, { eroare: 'dispozitiv dezactivat din panou' }, { status: 403 });
      device = r.dispozitiv; account = r.cont;
    } else if (/^\/(manifest\.json|catalog|meta|stream)/.test(rest)) {
      // Instalarile facute inainte de v17 continua sa mearga pe slotul d1.
      const r = devices.resolve(devices.tokenFor('d1'));
      if (!r || r.eroare) return json(res, { eroare: 'slotul d1 este dezactivat' }, { status: 403 });
      device = r.dispozitiv; account = r.cont;
    }

    if (device) {
      const limita = rate.check(device.id + '|' + ip(req));
      if (!limita.ok) {
        respinse++;
        cors(res);
        res.setHeader('retry-after', String(limita.retryAfter));
        return json(res, { eroare: 'prea multe cereri' }, { status: 429 });
      }
      devices.touch(device);
      const ctx = { account, device, base: baseUrl(req) };

      if (rest === '/manifest.json') return json(res, addon.manifest(ctx), { cache: 'public, max-age=300' });

      let mm = rest.match(/^\/catalog\/([^/]+)\/([^/]+?)(?:\/(.+))?\.json$/);
      if (mm) return json(res, await addon.catalog(ctx, { type: mm[1], id: mm[2], extra: parseExtra(mm[3]) }), { cache: 'public, max-age=120' });

      mm = rest.match(/^\/meta\/([^/]+)\/(.+)\.json$/);
      if (mm) return json(res, await addon.meta(ctx, { type: mm[1], id: decodeURIComponent(mm[2]) }), { cache: 'public, max-age=300' });

      mm = rest.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
      if (mm) return json(res, await addon.stream(ctx, { type: mm[1], id: decodeURIComponent(mm[2]) }), { cache: 'no-store' });

      if (rest === '/' || rest === '') {
        return text(res, `RaulTV v${addon.VERSION} · ${device.nume}\nManifest: ${baseUrl(req)}/d/${token || devices.tokenFor('d1')}/manifest.json\n`);
      }
    }

    if (path === '/') return text(res, `RaulTV v${addon.VERSION}\n/health · /stats · /admin?key=…\n`);
    return json(res, { eroare: 'ruta inexistenta' }, { status: 404 });

  } catch (e) {
    erori++;
    console.error('[RaulTV] eroare la', curat(path) + ':', e.message);
    return json(res, { eroare: 'eroare interna' }, { status: 500 });
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

server.listen(PORT, () => {
  console.log(`[RaulTV] v${addon.VERSION} pornit pe portul ${PORT}`);
  console.log(`[RaulTV] sloturi dispozitiv: ${devices.SLOTS} · conturi: ${devices.accountIds().join(', ')}`);
  console.log(`[RaulTV] panou: ${ADMIN_TOKEN ? 'activ (/admin?key=…)' : 'oprit (lipseste ADMIN_TOKEN)'}`);
});
