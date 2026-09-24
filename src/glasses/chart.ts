// Draws a ChartSpec on the phone and cuts it into PNG tiles for the glasses' image containers
// (each at most 288x144). Light marks on black: black is "off" (transparent) on the waveguide,
// and the host converts the PNG to the display's 16 grey levels.

import type { ChartSpec } from '../app/charts.ts'

export const TILE_W = 288
export const TILE_H = 144
/** Tiles side by side; 1 = a single centred 288x144 image if the firmware rejects the wide page. */
export const CHART_TILES = 2
export const CHART_W = TILE_W * CHART_TILES
export const CHART_H = TILE_H

const FG = '#ffffff'
const MID = '#a0a0a0'
const DIM = '#606060'
const FONT = 'bold 16px system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif'
const BIG_FONT = 'bold 40px system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif'

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas

export interface RenderedChart {
  /** PNG bytes per image container, left to right. */
  tiles: Uint8Array[]
  /** The whole chart as one PNG (for the companion page). */
  preview: Uint8Array
}

export async function renderChart(spec: ChartSpec): Promise<RenderedChart> {
  const canvas = makeCanvas(CHART_W, CHART_H)
  const ctx = canvas.getContext('2d') as Ctx | null
  if (!ctx) throw new Error('2D canvas unavailable')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, CHART_W, CHART_H)
  ctx.font = FONT
  ctx.textBaseline = 'middle'
  if (spec.type === 'bar') drawBars(ctx, spec)
  else if (spec.type === 'line') drawLine(ctx, spec)
  else drawGauge(ctx, spec)

  const tiles: Uint8Array[] = []
  for (let i = 0; i < CHART_TILES; i++) {
    const tile = makeCanvas(TILE_W, TILE_H)
    const tctx = tile.getContext('2d') as Ctx | null
    if (!tctx) throw new Error('2D canvas unavailable')
    tctx.drawImage(canvas, -i * TILE_W, 0)
    tiles.push(await toPng(tile))
  }
  return { tiles, preview: await toPng(canvas) }
}

// ---- chart types ----------------------------------------------------------------------------

function drawBars(ctx: Ctx, spec: ChartSpec): void {
  const { values, labels } = spec
  const hasLabels = labels.some(Boolean)
  const top = 22
  const bottom = CHART_H - (hasLabels ? 22 : 4)
  const lo = Math.min(0, spec.min ?? Math.min(...values))
  const hi = Math.max(spec.max ?? Math.max(...values), lo + 1e-9)
  const y = (v: number) => bottom - ((v - lo) / (hi - lo)) * (bottom - top)
  const slot = (CHART_W - 8) / values.length
  const barW = Math.max(6, Math.min(56, slot * 0.62))
  const base = y(0)
  ctx.fillStyle = DIM
  ctx.fillRect(4, Math.round(base), CHART_W - 8, 2)
  values.forEach((v, i) => {
    const cx = 4 + slot * (i + 0.5)
    const yv = y(v)
    ctx.fillStyle = FG
    ctx.fillRect(Math.round(cx - barW / 2), Math.round(Math.min(yv, base)), Math.round(barW), Math.max(2, Math.round(Math.abs(base - yv))))
    ctx.textAlign = 'center'
    ctx.fillStyle = MID
    ctx.fillText(fmt(v), cx, Math.max(10, Math.min(yv, base) - 10), slot - 2)
    if (hasLabels && labels[i]) {
      ctx.fillStyle = FG
      ctx.fillText(labels[i], cx, CHART_H - 11, slot - 2)
    }
  })
}

function drawLine(ctx: Ctx, spec: ChartSpec): void {
  const { values, labels } = spec
  const gutter = 56
  const top = 24
  const axis = CHART_H - 24
  const bottom = axis - 8
  const lo = spec.min ?? Math.min(...values)
  const hi = spec.max ?? Math.max(...values)
  const span = hi - lo || 1
  const left = gutter
  const right = CHART_W - 24
  const x = (i: number) => (values.length === 1 ? (left + right) / 2 : left + (i / (values.length - 1)) * (right - left))
  const y = (v: number) => bottom - ((v - lo) / span) * (bottom - top)

  ctx.fillStyle = DIM
  ctx.fillRect(left, axis, right - left, 2)
  ctx.textAlign = 'right'
  ctx.fillStyle = MID
  ctx.fillText(fmt(hi), gutter - 8, top, gutter - 10)
  ctx.fillText(fmt(lo), gutter - 8, bottom, gutter - 10)

  ctx.strokeStyle = FG
  ctx.lineWidth = 3
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.beginPath()
  values.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))))
  ctx.stroke()
  const last = values.length - 1
  ctx.fillStyle = FG
  ctx.beginPath()
  ctx.arc(x(last), y(values[last]), 5, 0, Math.PI * 2)
  ctx.fill()
  // Latest value above its dot, kept inside the canvas.
  ctx.textAlign = 'center'
  ctx.fillText(fmt(values[last]), Math.min(x(last), CHART_W - 22), y(values[last]) - 15, 44)

  if (labels.some(Boolean)) {
    ctx.fillStyle = FG
    ctx.textAlign = 'left'
    if (labels[0]) ctx.fillText(labels[0], left, CHART_H - 11, 120)
    ctx.textAlign = 'right'
    if (last > 0 && labels[last]) ctx.fillText(labels[last], right, CHART_H - 11, 120)
  }
}

function drawGauge(ctx: Ctx, spec: ChartSpec): void {
  const v = spec.values[0]
  const lo = spec.min ?? 0
  const hi = spec.max ?? 100
  const frac = Math.max(0, Math.min(1, (v - lo) / (hi - lo)))
  const left = 24
  const right = CHART_W - 24
  const barY = 88
  const barH = 26
  ctx.textAlign = 'center'
  ctx.fillStyle = FG
  ctx.font = BIG_FONT
  const unit = !spec.unit ? '' : spec.unit === '%' ? '%' : ` ${spec.unit}`
  ctx.fillText(`${fmt(v)}${unit}`, CHART_W / 2, 42, CHART_W - 40)
  ctx.font = FONT
  ctx.strokeStyle = MID
  ctx.lineWidth = 2
  ctx.strokeRect(left, barY, right - left, barH)
  ctx.fillStyle = FG
  ctx.fillRect(left + 4, barY + 4, Math.round((right - left - 8) * frac), barH - 8)
  ctx.fillStyle = MID
  ctx.textAlign = 'left'
  ctx.fillText(fmt(lo), left, barY + barH + 16)
  ctx.textAlign = 'right'
  ctx.fillText(fmt(hi), right, barY + barH + 16)
}

// ---- helpers --------------------------------------------------------------------------------

/** 8200 -> "8.2k", 0.456 -> "0.46", 12 -> "12". */
export function fmt(n: number): string {
  const a = Math.abs(n)
  if (a >= 1e9) return `${trim(n / 1e9)}B`
  if (a >= 1e6) return `${trim(n / 1e6)}M`
  if (a >= 1e4) return `${Math.round(n / 1e3)}k`
  if (a >= 1e3) return `${trim(n / 1e3)}k`
  if (a >= 100 || Number.isInteger(n)) return String(Math.round(n))
  return String(Number(n.toPrecision(2)))
}

function trim(n: number): string {
  return String(Number(n.toFixed(1)))
}

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

async function toPng(canvas: AnyCanvas): Promise<Uint8Array> {
  const blob =
    'convertToBlob' in canvas
      ? await canvas.convertToBlob({ type: 'image/png' })
      : await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png'))
  return new Uint8Array(await blob.arrayBuffer())
}
