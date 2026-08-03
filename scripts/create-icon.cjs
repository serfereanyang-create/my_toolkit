const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const size = 256;
const radius = 52;
const pixels = Buffer.alloc(size * size * 4);

function roundedRectAlpha(x, y) {
  const left = radius;
  const right = size - radius - 1;
  const top = radius;
  const bottom = size - radius - 1;
  const cornerX = x < left ? left : x > right ? right : x;
  const cornerY = y < top ? top : y > bottom ? bottom : y;
  const dx = x - cornerX;
  const dy = y - cornerY;
  return dx * dx + dy * dy <= radius * radius ? 255 : 0;
}

function insideP(x, y) {
  const stem = x >= 78 && x <= 112 && y >= 58 && y <= 198;
  const bowlOuter = x >= 104 && x <= 184 && y >= 58 && y <= 134;
  const dx = x - 142;
  const dy = y - 96;
  const roundedBowl = (dx * dx) / (46 * 46) + (dy * dy) / (42 * 42) <= 1;
  const cutout = x >= 126 && x <= 154 && y >= 84 && y <= 108;
  return stem || ((bowlOuter || roundedBowl) && !cutout);
}

for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const index = (y * size + x) * 4;
    const alpha = roundedRectAlpha(x, y);
    const gradient = y / size;
    pixels[index] = Math.round(24 + 14 * gradient);
    pixels[index + 1] = Math.round(70 + 20 * gradient);
    pixels[index + 2] = Math.round(160 + 40 * gradient);
    pixels[index + 3] = alpha;

    if (alpha && insideP(x, y)) {
      pixels[index] = 255;
      pixels[index + 1] = 255;
      pixels[index + 2] = 255;
      pixels[index + 3] = 255;
    }
  }
}

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

const scanlines = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y += 1) {
  const row = y * (size * 4 + 1);
  scanlines[row] = 0;
  pixels.copy(scanlines, row + 1, y * size * 4, (y + 1) * size * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0);
ihdr.writeUInt32BE(size, 4);
ihdr[8] = 8;
ihdr[9] = 6;
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(scanlines)),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), png);
