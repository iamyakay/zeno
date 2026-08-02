const zlib = require("zlib");
const fs = require("fs");

const SIZE = 256;
const px = Buffer.alloc(SIZE * SIZE * 4);

function set(x, y, r, g, b, a) {
  const i = (y * SIZE + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

const cx = SIZE / 2, cy = SIZE / 2, R = SIZE * 0.42;

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = x - cx, dy = y - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > R + 6) continue;
    if (d > R) {
      const t = 1 - (d - R) / 6;
      set(x, y, 0, 255, 140, Math.round(90 * t));
      continue;
    }
    const t = d / R;
    const hl = Math.max(0, 1 - Math.sqrt((dx + R * 0.3) ** 2 + (dy + R * 0.35) ** 2) / (R * 0.9));
    let r = Math.round(4 + 40 * (1 - t) + 150 * hl * hl);
    let g = Math.round(60 + 195 * (1 - t * 0.55) * (0.55 + 0.45 * hl));
    let b = Math.round(40 + 100 * (1 - t) * 0.9 + 60 * hl);
    const ring = Math.abs(d - R * 0.82) < 3 ? 40 : 0;
    set(x, y, Math.min(255, r + ring), Math.min(255, g + ring), Math.min(255, b + ring), 255);
  }
}

const zw = SIZE * 0.34, zh = SIZE * 0.36, zt = SIZE * 0.055;
const zx0 = cx - zw / 2, zy0 = cy - zh / 2;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const lx = x - zx0, ly = y - zy0;
    if (lx < 0 || lx > zw || ly < 0 || ly > zh) continue;
    const top = ly < zt;
    const bottom = ly > zh - zt;
    const diagY = zh - ly;
    const diagX = (diagY / zh) * (zw - zt * 1.2);
    const onDiag = lx > diagX - zt * 0.75 && lx < diagX + zt * 0.75;
    if (top || bottom || onDiag) set(x, y, 2, 12, 8, 255);
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, crcBuf]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0))
]);

fs.writeFileSync("assets/zeno.png", png);

const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(0, 0);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry[0] = 0; entry[1] = 0; entry[2] = 0; entry[3] = 0;
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(22, 12);
fs.writeFileSync("assets/zeno.ico", Buffer.concat([icoHeader, entry, png]));

console.log("png bytes:", png.length);
