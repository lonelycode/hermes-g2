// PCM helpers for the G2 microphone stream: 16 kHz, mono, signed 16-bit little-endian.

export const SAMPLE_RATE = 16000

export function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

export interface AudioStats {
  seconds: number
  rms: number
  peak: number
}

/** Loudness stats over s16le PCM; used for the "do nothing if no audio" rule. */
export function pcmStats(pcm: Uint8Array, sampleRate = SAMPLE_RATE): AudioStats {
  const samples = Math.floor(pcm.byteLength / 2)
  if (!samples) return { seconds: 0, rms: 0, peak: 0 }
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2)
  let sumSq = 0
  let peak = 0
  for (let i = 0; i < samples; i++) {
    const s = view.getInt16(i * 2, true)
    const a = Math.abs(s)
    if (a > peak) peak = a
    sumSq += s * s
  }
  return { seconds: samples / sampleRate, rms: Math.sqrt(sumSq / samples), peak }
}

/** Wrap raw s16le mono PCM in a RIFF/WAVE header. */
export function pcmToWav(pcm: Uint8Array, sampleRate = SAMPLE_RATE, channels = 1): Uint8Array<ArrayBuffer> {
  const bytesPerSample = 2
  const blockAlign = channels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = pcm.byteLength
  const buf = new ArrayBuffer(44 + dataSize)
  const v = new DataView(buf)
  const w = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  w(0, 'RIFF')
  v.setUint32(4, 36 + dataSize, true)
  w(8, 'WAVE')
  w(12, 'fmt ')
  v.setUint32(16, 16, true) // PCM chunk size
  v.setUint16(20, 1, true) // PCM format
  v.setUint16(22, channels, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, byteRate, true)
  v.setUint16(32, blockAlign, true)
  v.setUint16(34, 16, true) // bits per sample
  w(36, 'data')
  v.setUint32(40, dataSize, true)
  new Uint8Array(buf, 44).set(pcm)
  return new Uint8Array(buf)
}
