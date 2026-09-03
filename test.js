'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const {
  server, channels, categories, genreCatalogs, MAIN_CATALOG_ID, PAGE_SIZE, searchKey
} = require('./server');
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
    assert.equal(stream.body.streams.length, 1);
    const first = stream.body.streams[0];
    assert.equal(first.name, 'RaulTV');
    assert.equal(first.url || first.externalUrl, channel.url || channel.officialPage);
  }
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
