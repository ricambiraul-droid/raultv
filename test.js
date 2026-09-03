'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const {
  server, channels, categories, genreCatalogs, MAIN_CATALOG_ID, PAGE_SIZE, searchKey
} = require('./server');
const { parseMaster, labelFor, rewritePlaylist, sourcesFor } = require('./lib/live');
const { parseM3U, matchChannels, normalize, dinTvgId, calitateaDin } = require('./lib/m3u');
const font = require('./lib/font');
const { wrapToWidth } = require('./lib/poster');

let base;
const get = async path => {
  const response = await fetch(base + path);
  return { status: response.status, body: await response.json() };
};

test.before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

// --------------------------------------------------------------------------

test('catalogul contine toate posturile, fara duplicate', () => {
  assert.ok(channels.length >= 200, `doar ${channels.length} canale`);
  const ids = channels.map(channel => channel.id);
  const names = channels.map(channel => channel.name);
  assert.equal(new Set(ids).size, ids.length, 'id duplicat');
  assert.equal(new Set(names).size, names.length, 'nume duplicat');
  for (const channel of channels) {
    assert.match(channel.id, /^raultv-[a-z0-9-]+$/, channel.id);
    assert.ok(channel.officialPage.startsWith('https://'), channel.id);
    assert.ok(categories.includes(channel.category), `categorie necunoscuta: ${channel.category}`);
  }
});

test('cele 12 posturi cerute initial sunt pastrate', () => {
  for (const required of ['Prima TV', 'Look Sport', 'TVR 1', 'TVR 2', 'Digi 24',
    'Digi Sport 1', 'Digi Sport 2', 'Digi Sport 3', 'Digi Sport 4',
    'Digi World', 'Digi Life', 'Digi Animal World']) {
    assert.ok(channels.some(channel => channel.name === required), `lipseste ${required}`);
  }
});

test('manifestul declara rubricile pe genuri', async () => {
  const { status, body } = await get('/manifest.json');
  assert.equal(status, 200);
  assert.equal(body.id, 'ro.raultv.live');
  assert.deepEqual(body.types, ['tv']);
  assert.ok(body.logo.endsWith('/logo.png'), 'sigla trebuie sa fie PNG');
  assert.equal(body.catalogs.length, categories.length + 1);

  const main = body.catalogs[0];
  assert.equal(main.id, MAIN_CATALOG_ID);
  assert.deepEqual(main.genres, categories, 'rubricile trebuie expuse ca genuri');
  assert.ok(main.extra.some(item => item.name === 'genre' && item.options.length === categories.length));
  assert.ok(main.extraSupported.includes('genre'));

  for (const catalog of body.catalogs.slice(1)) {
    assert.match(catalog.id, /^raultv-[a-z0-9-]+$/);
    assert.ok(catalog.extraSupported.includes('skip'));
  }
});

test('fiecare rubrica raspunde si contine doar canalele ei', async () => {
  for (const catalog of genreCatalogs) {
    const { status, body } = await get(`/catalog/tv/${catalog.id}.json`);
    assert.equal(status, 200, catalog.id);
    assert.ok(body.metas.length > 0, `rubrica goala: ${catalog.id}`);
    assert.equal(body.metas.length, Math.min(catalog.channels.length, PAGE_SIZE));
    for (const meta of body.metas) {
      assert.deepEqual(meta.genres, [catalog.category], `${catalog.id}: ${meta.name}`);
    }
  }
});

test('filtrul pe gen din catalogul principal', async () => {
  for (const category of categories) {
    const { status, body } = await get(
      `/catalog/tv/${MAIN_CATALOG_ID}/${encodeURIComponent(`genre=${category}`)}.json`);
    assert.equal(status, 200, category);
    assert.ok(body.metas.length > 0, `niciun canal pentru ${category}`);
    assert.ok(body.metas.every(meta => meta.genres[0] === category), category);
  }
  const unknown = await get(`/catalog/tv/${MAIN_CATALOG_ID}/genre=Inexistent.json`);
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body.metas, []);
});

test('paginare si cautare', async () => {
  const page1 = await get(`/catalog/tv/${MAIN_CATALOG_ID}.json`);
  assert.equal(page1.body.metas.length, PAGE_SIZE);
  const page2 = await get(`/catalog/tv/${MAIN_CATALOG_ID}/skip=100.json`);
  assert.equal(page2.body.metas.length, Math.min(PAGE_SIZE, channels.length - 100));
  assert.notEqual(page1.body.metas[0].id, page2.body.metas[0].id);

  const beyond = await get(`/catalog/tv/${MAIN_CATALOG_ID}/skip=9999.json`);
  assert.deepEqual(beyond.body.metas, []);

  const search = await get(`/catalog/tv/${MAIN_CATALOG_ID}/search=digi.json`);
  assert.ok(search.body.metas.length >= 8);
  assert.ok(search.body.metas.every(meta => meta.name.toLowerCase().includes('digi')));

  // cautarea ignora diacriticele in ambele sensuri
  assert.equal(searchKey('România TV'), 'romania tv');
  assert.equal(searchKey('Brașov'), 'brasov');
  const noDiacritics = await get(`/catalog/tv/${MAIN_CATALOG_ID}/search=brasov.json`);
  assert.ok(noDiacritics.body.metas.some(meta => meta.name === 'Brașov TV'));

  const combined = await get(
    `/catalog/tv/${MAIN_CATALOG_ID}/${encodeURIComponent('genre=Sport&skip=0')}.json`);
  assert.ok(combined.body.metas.length > 0);
  assert.ok(combined.body.metas.every(meta => meta.genres[0] === 'Sport'));
});

test('canalele cu flux apar primele', async () => {
  const { body } = await get(`/catalog/tv/${MAIN_CATALOG_ID}.json`);
  const withStream = channels.filter(channel => channel.url).length;
  const firstIds = body.metas.slice(0, withStream).map(meta => meta.id);
  for (const id of firstIds) {
    assert.ok(channels.find(channel => channel.id === id).url, `${id} nu are flux dar e in fata`);
  }
});

test('meta si stream pentru fiecare canal', async () => {
  for (const channel of channels) {
    const meta = await get(`/meta/tv/${channel.id}.json`);
    assert.equal(meta.status, 200, channel.id);
    assert.equal(meta.body.meta.id, channel.id);
    assert.ok(meta.body.meta.poster.endsWith('.png'), 'posterul trebuie sa fie PNG');
    assert.ok(meta.body.meta.background.endsWith('.png'));
    assert.deepEqual(meta.body.meta.genres, [channel.category]);
    assert.ok(meta.body.meta.description.includes(channel.category));

    const stream = await get(`/stream/tv/${channel.id}.json`);
    assert.equal(stream.status, 200, channel.id);
    assert.ok(stream.body.streams.length >= 1, channel.id);

    const last = stream.body.streams[stream.body.streams.length - 1];
    assert.equal(last.externalUrl, channel.officialPage,
      `${channel.id}: ultima opțiune trebuie să fie pagina oficială`);

    if (channel.surse.length) {
      const prim = stream.body.streams[0];
      // modul implicit e „direct": adresa reală a sursei, fără hop prin addon
      assert.equal(prim.url, channel.surse[0].url, `${channel.id}: link direct`);
      // pe https curat, Stremio primește adresa direct — fără notWebReady
      assert.ok(!prim.behaviorHints || prim.behaviorHints.notWebReady !== true,
        `${channel.id}: https curat nu trebuie marcat notWebReady`);
      assert.match(prim.title, /Server 1/, `${channel.id}: serverele sunt numerotate`);
    } else {
      // fără sursă: căutarea pe server, apoi linkul către pagina oficială
      assert.equal(stream.body.streams.length, 2, channel.id);
      assert.ok(stream.body.streams[0].url.includes(`/live/${channel.id}.m3u8`),
        `${channel.id}: trebuie oferită căutarea pe server`);
      assert.match(stream.body.streams[0].title, /Caută fluxul pe server/);
    }
    for (const item of stream.body.streams) assert.equal(item.name, 'RaulTV');
  }
});

test('modul server rutează prin addon, modul direct nu', async () => {
  const { streamsFor } = require('./server');
  const cu = channels.find(channel => channel.surse.length);

  const direct = await streamsFor(cu, 'https://exemplu.ro');
  assert.equal(direct[0].url, cu.surse[0].url, 'implicit: adresa reală a sursei');

  // modul se schimbă dintr-o variabilă de mediu, verificată la pornire
  assert.ok(['direct', 'server'].includes((await get('/health')).body.modFlux));
});

test('fiecare sursă apare ca server numerotat', async () => {
  const cu = channels.filter(channel => channel.surse.length > 1);
  for (const channel of cu) {
    const { body } = await get(`/stream/tv/${channel.id}.json`);
    channel.surse.forEach((source, index) => {
      assert.ok(body.streams.some(item => item.title.includes(`Server ${index + 1}`)),
        `${channel.id}: lipsește Server ${index + 1}`);
    });
  }
});

test('ruta /live redirectează către sursă, nu retransmite', async () => {
  const cu = channels.find(channel => channel.surse.length && !channel.surse[0].referer);
  const response = await fetch(`${base}/live/${cu.id}.m3u8`, { redirect: 'manual' });
  assert.equal(response.status, 302, 'trebuie redirect, nu retransmisie');
  assert.equal(response.headers.get('location'), cu.surse[0].url);

  const fara = channels.find(channel => !channel.surse.length);
  const lipsa = await fetch(`${base}/live/${fara.id}.m3u8`);
  assert.equal(lipsa.status, 404);
  const corp = await lipsa.json();
  assert.equal(corp.paginaOficiala, fara.officialPage);
  assert.ok(corp.variabila.startsWith('RAULTV_') || corp.variabila.startsWith('DIGI_'));

  assert.equal((await fetch(`${base}/live/raultv-inexistent.m3u8`)).status, 404);
});

test('sursele se citesc din surse.js și din variabile de mediu', () => {
  const tabel = { 'test-canal': [{ url: 'https://a.ro/1.m3u8' }] };
  assert.equal(sourcesFor('test-canal', tabel).length, 1);
  assert.equal(sourcesFor('fara-surse', tabel).length, 0);

  process.env.RAULTV_TEST_CANAL_URL = 'https://b.ro/x.m3u8, https://b.ro/y.m3u8';
  const cuMediu = sourcesFor('test-canal', tabel);
  assert.equal(cuMediu.length, 3, 'mediul se adaugă înaintea celor din fișier');
  assert.equal(cuMediu[0].url, 'https://b.ro/x.m3u8');
  assert.ok(cuMediu[0].dinMediu);
  delete process.env.RAULTV_TEST_CANAL_URL;

  // adrese invalide sunt ignorate
  assert.equal(sourcesFor('x', { x: [{ url: 'nu-e-adresa' }, { url: 'ftp://a/b' }] }).length, 0);
});

test('rezoluțiile se citesc din playlistul master', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    'low.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
    'https://alt.ro/high.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720',
    'mid.m3u8'
  ].join('\n');

  const variante = parseMaster(master, 'https://cdn.ro/live/master.m3u8');
  assert.equal(variante.length, 3);
  assert.deepEqual(variante.map(v => v.inaltime), [1080, 720, 360], 'cea mai bună prima');
  assert.equal(variante[0].url, 'https://alt.ro/high.m3u8', 'adresă absolută păstrată');
  assert.equal(variante[1].url, 'https://cdn.ro/live/mid.m3u8', 'adresă relativă rezolvată');
  assert.deepEqual(variante.map(labelFor), ['1080p HD', '720p', '360p']);

  // un playlist fara variante nu produce rezolutii
  assert.deepEqual(parseMaster('#EXTM3U\n#EXTINF:6,\nseg.ts', 'https://cdn.ro/a.m3u8'), []);
});

test('retransmisia rescrie adresele din playlist', () => {
  const rescris = rewritePlaylist(
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.key"\nseg1.ts\nhttps://alt.ro/seg2.ts',
    'https://cdn.ro/live/index.m3u8',
    '/live/proxy'
  );
  assert.ok(rescris.includes('URI="/live/proxy?catre=https%3A%2F%2Fcdn.ro%2Flive%2Fk.key"'));
  assert.ok(rescris.includes('/live/proxy?catre=https%3A%2F%2Fcdn.ro%2Flive%2Fseg1.ts'));
  assert.ok(rescris.includes('/live/proxy?catre=https%3A%2F%2Falt.ro%2Fseg2.ts'));
  assert.ok(rescris.startsWith('#EXTM3U'));
});

test('playlistul M3U se potrivește cu posturile din catalog', () => {
  const intrari = parseM3U([
    '#EXTM3U',
    '#EXTINF:-1 tvg-name="PRO TV" group-title="RO",PRO TV FHD',
    'https://ex.ro/protv.m3u8',
    '#EXTINF:-1,Digi Sport 1 HD',
    'https://ex.ro/ds1.m3u8',
    '#EXTINF:-1,Digi Sport 1 SD',
    'https://ex.ro/ds1sd.m3u8',
    '#EXTINF:-1,Brasov TV',
    'https://ex.ro/bv.m3u8',
    '#EXTINF:-1,Canal Inexistent XYZ',
    'https://ex.ro/nope.m3u8'
  ].join('\n'));

  assert.equal(intrari.length, 5);
  const potriviri = matchChannels(intrari, channels);
  assert.ok(potriviri['pro-tv'], 'PRO TV FHD trebuie potrivit');
  assert.equal(potriviri['digi-sport-1'].length, 2, 'două calități pentru același post');
  assert.ok(potriviri['brasov-tv'], 'diacriticele trebuie ignorate la potrivire');
  assert.ok(!potriviri['canal-inexistent-xyz']);

  // normalizarea nu trebuie sa confunde posturi diferite
  assert.notEqual(normalize('Digi Sport 1'), normalize('Digi Sport 11'));
  assert.equal(normalize('Brașov TV'), normalize('Brasov TV'));
});

test('extragerea fluxului din pagina oficială', () => {
  const { extrageM3u8, scripturiCandidate } = require('./lib/resolver');

  // adresă simplă în atribut HTML
  assert.deepEqual(
    extrageM3u8('<video src="https://cdn.ro/live/index.m3u8">', 'https://post.ro/'),
    ['https://cdn.ro/live/index.m3u8']);

  // adresă relativă, rezolvată față de pagină
  assert.deepEqual(
    extrageM3u8('"/hls/live.m3u8"', 'https://post.ro/live/pagina'),
    ['https://post.ro/hls/live.m3u8']);

  // adresă scăpată în JSON, cum apare în configurația playerelor
  assert.deepEqual(
    extrageM3u8('{"file":"https:\\/\\/edge.ro\\/a.m3u8?t=1"}', 'https://post.ro/'),
    ['https://edge.ro/a.m3u8?t=1']);

  // fără duplicate
  assert.equal(extrageM3u8(
    '"https://a.ro/x.m3u8" "https://a.ro/x.m3u8"', 'https://post.ro/').length, 1);

  // o pagină fără flux nu produce nimic
  assert.deepEqual(extrageM3u8('<p>fără video aici</p>', 'https://post.ro/'), []);

  // doar scripturile care par legate de player
  assert.deepEqual(
    scripturiCandidate('<script src="/js/analytics.js"></script><script src="/js/hls-player.js"></script>',
      'https://post.ro/'),
    ['https://post.ro/js/hls-player.js']);
});

test('playlistul iptv-org se citește corect', () => {
  // atributul http-user-agent conține virgule: "(KHTML, like Gecko)".
  // Numele trebuie luat după ULTIMA virgulă, altfel iese tăiat.
  const linie = '#EXTINF:-1 tvg-id="AMCEurope.uk@Romania" http-referrer="https://cool-tv.net/" ' +
    'http-user-agent="Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130" ' +
    'group-title="Movies",AMC Europe Romania';
  const [intrare] = parseM3U(linie + '\nhttps://cdn.ro/amc.m3u8');
  assert.equal(intrare.nume, 'AMC Europe Romania', 'numele nu trebuie tăiat de virgula din user-agent');
  assert.equal(intrare.referer, 'https://cool-tv.net/');
  assert.match(intrare.userAgent, /^Mozilla\/5\.0/);
  assert.match(intrare.userAgent, /KHTML, like Gecko/);

  // opțiunile pot veni și pe linii #EXTVLCOPT, sub #EXTINF
  const [vlc] = parseM3U([
    '#EXTINF:-1 tvg-id="X.ro",Post X',
    '#EXTVLCOPT:http-referrer=https://x.ro/',
    '#EXTVLCOPT:http-user-agent=VLC/3.0.18 (KHTML, like Gecko)',
    'https://x.ro/live.m3u8'
  ].join('\n'));
  assert.equal(vlc.referer, 'https://x.ro/');
  assert.equal(vlc.userAgent, 'VLC/3.0.18 (KHTML, like Gecko)');

  // calitatea se ia din paranteze
  assert.equal(calitateaDin('Atomic TV (360p)'), '360P');
  assert.equal(calitateaDin('Kanal D2 (1080i)'), '1080I');
  assert.equal(calitateaDin('Columna TV'), null);

  // marcajele din nume
  const [n24] = parseM3U('#EXTINF:-1,Nasul TV (720p) [Not 24/7]\nhttps://a.ro/b.m3u8');
  assert.equal(n24.non24, true);
});

test('tvg-id-ul iptv-org se potrivește cu posturile', () => {
  assert.equal(normalize(dinTvgId('TVR1.ro@SD')), 'tvr 1');
  assert.equal(normalize(dinTvgId('AtomicTV.ro')), 'atomic tv');
  assert.equal(normalize(dinTvgId('RealitateaPlus.ro')), 'realitatea plus');

  const intrari = parseM3U([
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="TVR1.ro@SD" group-title="General",TVR 1',
    'https://tvr-1.lg.mncdn.com/tvr1/smil:tvr1.smil/playlist.m3u8',
    '#EXTINF:-1 tvg-id="A7TV.ro@SD",A7TV (1080p)',
    'https://a7.ro/live.m3u8',
    '#EXTINF:-1 tvg-id="KanalD2.ro",Kanal D2 (1080i)',
    'https://kd2.ro/live.m3u8',
    '#EXTINF:-1 tvg-id="AXNBlack.ro",AXN Black Romania',
    'https://axn.ro/live.m3u8'
  ].join('\n'));

  const potriviri = matchChannels(intrari, channels);
  assert.ok(potriviri['tvr-1'], 'TVR 1 prin tvg-id');
  assert.ok(potriviri['a7-tv'], 'A7TV trebuie potrivit cu A7 TV');
  assert.ok(potriviri['kanal-d2'], 'Kanal D2 prin tvg-id');
  assert.ok(!potriviri['axn-black'], 'posturile care nu sunt în catalog rămân afară');
  assert.equal(potriviri['a7-tv'][0].calitate, '1080P');
});

test('pagina de verificare și lista surselor', async () => {
  const surse = await get('/surse.json');
  assert.equal(surse.status, 200);
  assert.equal(surse.body.canale.length, channels.filter(c => c.surse.length).length);
  assert.equal(surse.body.faraFlux, channels.filter(c => !c.surse.length).length);

  const pagina = await fetch(base + '/verifica');
  assert.equal(pagina.status, 200);
  const html = await pagina.text();
  assert.match(html, /Verificare fluxuri/);
  assert.ok(html.includes('/surse.json'), 'pagina trebuie să ceară lista surselor');
});

// --------------------------------------------------------------------------

test('fontul acopera toate caracterele din numele canalelor', () => {
  const supported = new Set([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -.,+/&!"\'():•ĂÂÎȘȚ']);
  const missing = new Set();
  for (const channel of [...channels, { name: 'RAUL TV ROMÂNIA' }]) {
    for (const character of channel.name.toUpperCase()) {
      if (!supported.has(character)) missing.add(character);
    }
  }
  assert.deepEqual([...missing], [], `caractere fara glifa: ${[...missing].join(' ')}`);
});

test('numele incap pe cel mult 3 randuri', () => {
  for (const channel of channels) {
    const lines = wrapToWidth(channel.name, 6.8, 3);
    assert.ok(lines.length <= 3, `${channel.name} -> ${lines.length} randuri`);
    assert.ok(lines.every(line => line.length > 0), channel.name);
    assert.equal(lines.join(' '), channel.name.toUpperCase().replace(/\s+/g, ' '),
      `text pierdut la impartire: ${channel.name}`);
    for (const line of lines) assert.ok(font.measure(line) > 0, channel.name);
  }
});

test('posterele sunt PNG valid si de dimensiunea corecta', async () => {
  const sample = [channels[0], channels[40], channels[120], channels[channels.length - 1]];
  for (const channel of sample) {
    const response = await fetch(`${base}/poster/${channel.id}.png`);
    assert.equal(response.status, 200, channel.id);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'semnatura PNG');
    assert.equal(buffer.subarray(12, 16).toString('latin1'), 'IHDR');
    assert.equal(buffer.readUInt32BE(16), 512, 'latime');
    assert.equal(buffer.readUInt32BE(20), 512, 'inaltime');
    assert.equal(buffer.subarray(buffer.length - 8, buffer.length - 4).toString('latin1'), 'IEND');
    assert.ok(buffer.length > 5000, 'poster suspect de mic');
  }

  const background = await fetch(`${base}/background/${channels[0].id}.png`);
  assert.equal(background.status, 200);
  const backgroundBuffer = Buffer.from(await background.arrayBuffer());
  assert.equal(backgroundBuffer.readUInt32BE(16), 1024);
  assert.equal(backgroundBuffer.readUInt32BE(20), 576);

  const logo = await fetch(`${base}/logo.png`);
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get('content-type'), 'image/png');
});

test('sumele de control PNG sunt corecte', async () => {
  const { crc32 } = require('./lib/png');
  const response = await fetch(`${base}/poster/${channels[3].id}.png`);
  const buffer = Buffer.from(await response.arrayBuffer());
  let offset = 8;
  let chunks = 0;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const body = buffer.subarray(offset + 4, offset + 8 + length);
    const stored = buffer.readUInt32BE(offset + 8 + length);
    assert.equal(crc32(body), stored, `CRC gresit la chunk ${chunks}`);
    offset += 12 + length;
    chunks++;
  }
  assert.equal(offset, buffer.length, 'structura PNG incompleta');
  assert.equal(chunks, 3, 'asteptam IHDR, IDAT, IEND');
});

test('posterele sunt servite din cache la a doua cerere', async () => {
  const id = channels[7].id;
  await fetch(`${base}/poster/${id}.png`);
  const started = Date.now();
  const response = await fetch(`${base}/poster/${id}.png`);
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.ok(Date.now() - started < 120, 'a doua cerere ar trebui servita din cache');
});

// --------------------------------------------------------------------------

test('id-uri inexistente returneaza 404', async () => {
  assert.equal((await get('/catalog/tv/nimic.json')).status, 404);
  assert.equal((await get('/meta/tv/raultv-nu-exista.json')).status, 404);
  assert.equal((await get('/stream/tv/raultv-nu-exista.json')).status, 404);
  assert.equal((await fetch(base + '/poster/raultv-nu-exista.png')).status, 404);
  assert.equal((await fetch(base + '/background/raultv-nu-exista.png')).status, 404);
});

test('health si pagina de start', async () => {
  const health = await get('/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.channels, channels.length);
  assert.equal(health.body.categories, categories.length);
  assert.equal(health.body.withStream, channels.filter(c => c.surse.length).length);
  assert.ok(health.body.playlist, 'health trebuie să raporteze starea playlistului');

  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /RaulTV Rom/);
  for (const catalog of genreCatalogs) assert.ok(html.includes(catalog.id), catalog.id);
});

test('CORS si preflight', async () => {
  const response = await fetch(base + '/manifest.json');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal((await fetch(base + '/manifest.json', { method: 'OPTIONS' })).status, 204);
  assert.equal((await fetch(base + '/manifest.json', { method: 'POST' })).status, 405);
});

test('un URL malformat nu opreste serverul', async () => {
  const raw = await new Promise((resolve, reject) => {
    const socket = net.connect(server.address().port, '127.0.0.1', () => {
      socket.write('GET /%E0%A4%A HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n');
    });
    let data = '';
    socket.on('data', chunk => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
  assert.match(raw.split('\r\n')[0], /HTTP\/1\.1 (200|400|404)/);
  assert.equal((await get('/health')).status, 200, 'serverul a murit dupa URL malformat');
});
