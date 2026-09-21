// Refuses to package a bundle that contains any secret from the local env files.
// Run after `vite build`, before `evenhub pack`.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const secrets = new Map()
for (const file of ['.env', '.env.local', '.env.development.local', '.env.production.local']) {
  if (!existsSync(file)) continue
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]*(KEY|TOKEN|SECRET)[A-Z0-9_]*)\s*=\s*(.+?)\s*$/.exec(line)
    if (m && m[3].length >= 8) secrets.set(m[3].replace(/^(['"])(.*)\1$/, '$2'), `${m[1]} (${file})`)
  }
}
const dir = 'dist/assets'
if (!existsSync(dir)) {
  console.error('[check-bundle] dist/assets missing — run vite build first')
  process.exit(1)
}
let hits = 0
for (const f of readdirSync(dir)) {
  const text = readFileSync(join(dir, f), 'utf8')
  for (const [value, where] of secrets) {
    if (text.includes(value)) {
      console.error(`[check-bundle] ✘ ${where} is embedded in dist/assets/${f}`)
      hits++
    }
  }
  for (const m of text.matchAll(/VITE_[A-Z_]*(KEY|TOKEN)/g)) void m
}
if (hits) {
  console.error('[check-bundle] refusing to package: secrets must live on the proxy or be typed into the phone settings')
  process.exit(1)
}
console.log(`[check-bundle] ✔ no env secrets in the bundle (${secrets.size} value${secrets.size === 1 ? '' : 's'} checked)`)
