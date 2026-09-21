// Generates public/icon.png: a 24x24 greyscale "H" built from 2x2 pixel blocks (store rules).
import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const SIZE = 24
const rows = [
  '......................',
  '.####............####.',
  '.####............####.',
  '.####............####.',
  '.####............####.',
  '.####............####.',
  '.####............####.',
  '.####............####.',
  '.####............####.',
  '.####################.',
  '.####################.',
  '.####################.',
  '.####################.',
  '.####............####.',
  '.####............####.',
  '.####............####.',
  '.####............####.',
  '.####............####.',
  '.####............####.',
  '.####............####.',
  '.####............####.',
  '......................',
].map(r => '.' + r + '.')
rows.unshift('.'.repeat(SIZE))
rows.push('.'.repeat(SIZE))

const raw = Buffer.alloc((SIZE + 1) * SIZE)
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE + 1)] = 0 // filter: none
  for (let x = 0; x < SIZE; x++) raw[y * (SIZE + 1) + 1 + x] = rows[y]?.[x] === '#' ? 255 : 0
}

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
const crc32 = buf => {
  let c = -1
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 0 // greyscale
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
])
mkdirSync('public', { recursive: true })
writeFileSync('public/icon.png', png)
console.log(`wrote public/icon.png (${png.length} bytes)`)
