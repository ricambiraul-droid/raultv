'use strict';

const zlib = require('zlib');

// Encoder PNG minimal (RGB, 8 biti pe canal), fara dependente externe.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

// Filtrul "Sub" (tip 1): scade pixelul din stanga. Pentru degradeuri si forme netede
// da practic aceeasi compresie ca filtrarea adaptiva, dar de ~20x mai rapid, ceea ce
// conteaza pentru ca posterele se genereaza la cerere.
function filterRows(pixels, width, height, bpp) {
  const stride = width * bpp;
  const output = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const out = y * (stride + 1);
    output[out] = 1;
    for (let i = 0; i < bpp; i++) output[out + 1 + i] = pixels[row + i];
    for (let i = bpp; i < stride; i++) {
      output[out + 1 + i] = (pixels[row + i] - pixels[row + i - bpp]) & 0xff;
    }
  }
  return output;
}

function encodePng(pixels, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type: truecolor RGB
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  const filtered = filterRows(pixels, width, height, 3);
  const compressed = zlib.deflateSync(filtered, { level: 6 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

module.exports = { encodePng, crc32 };
