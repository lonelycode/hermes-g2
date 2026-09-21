// Reports which candidate UI glyphs exist in the G2 firmware fonts (via @evenrealities/pretext).
import { getAdvW } from '@evenrealities/pretext'
const candidates = '▶▷►▲▼●○■□★☆✓✔✗✘✕×⚙⚡…·•»«→←↳↲↑↓⇅━─│╭╮╯╰?!◌◉◎▮▯┃┆♪🎤🔊⏺⏹⏳⌛✱*+-=~^'
for (const ch of candidates) {
  const w = getAdvW(ch.codePointAt(0))
  console.log(`${ch}\tU+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}\t${w ? 'ok ' + (w / 16).toFixed(1) + 'px' : 'MISSING'}`)
}
