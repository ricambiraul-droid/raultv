'use strict';

// ---------------------------------------------------------------------------
// Cereri HTTP fara dependinte externe. Inlocuieste axios: pornire mai rapida pe
// Render, memorie mai putina si un singur loc in care controlam timeout-urile,
// limita de marime si redirectarile.
// ---------------------------------------------------------------------------

const http = require('http');
const https = require('https');

const MAX_BYTES = Number(process.env.HTTP_MAX_BYTES || 24 * 1024 * 1024);
const UA = 'RaulTV/17';

// Agenti cu keep-alive: 30 de dispozitive care cer acelasi upstream refolosesc
// conexiunile in loc sa deschida una noua de fiecare data.
const agents = {
  http: new http.Agent({ keepAlive: true, maxSockets: 8, timeout: 30000 }),
  https: new https.Agent({ keepAlive: true, maxSockets: 8, timeout: 30000 })
};

function getBuffer(url, { timeout = 15000, redirects = 3, maxBytes = MAX_BYTES, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = e => { if (!settled) { settled = true; reject(e); } };
    const ok = v => { if (!settled) { settled = true; resolve(v); } };

    let req;
    try {
      const secure = url.startsWith('https:');
      const client = secure ? https : http;
      req = client.get(url, {
        timeout,
        agent: secure ? agents.https : agents.http,
        headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity', ...headers }
      }, res => {
        const loc = res.headers.location;
        if (res.statusCode >= 300 && res.statusCode < 400 && loc && redirects > 0) {
          res.resume();
          return getBuffer(new URL(loc, url).toString(), { timeout, redirects: redirects - 1, maxBytes, headers })
            .then(ok, fail);
        }
        if (res.statusCode !== 200) { res.resume(); return fail(new Error('HTTP ' + res.statusCode)); }
        const parts = [];
        let size = 0;
        res.on('data', d => {
          size += d.length;
          if (size > maxBytes) { req.destroy(); return fail(new Error('raspuns prea mare')); }
          parts.push(d);
        });
        res.on('end', () => ok(Buffer.concat(parts)));
        res.on('error', fail);
      });
    } catch (e) { return fail(e); }

    req.on('timeout', () => { req.destroy(); fail(new Error('timeout')); });
    req.on('error', fail);
  });
}

async function getText(url, opts) {
  return (await getBuffer(url, opts)).toString('utf8');
}

async function getJson(url, opts) {
  const text = await getText(url, opts);
  try { return JSON.parse(text); }
  catch (e) { throw new Error('raspuns care nu e JSON'); }
}

module.exports = { getBuffer, getText, getJson };
