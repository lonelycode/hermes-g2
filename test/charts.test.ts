import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHART_INVALID, MAX_BARS, extractCharts, parseChart } from '../src/app/charts.ts'

const BLOCK = '```g2chart\n{"type":"bar","title":"Steps","labels":["Mon","Tue"],"values":[8200,9100],"unit":"steps"}\n```'

test('a complete block becomes a marker line and a spec', () => {
  const { text, charts } = extractCharts(`Tuesday was best.\n\n${BLOCK}\n`)
  assert.equal(text, 'Tuesday was best.\n\n[chart] Steps\n')
  assert.equal(charts.length, 1)
  assert.deepEqual(charts[0].values, [8200, 9100])
  assert.deepEqual(charts[0].labels, ['Mon', 'Tue'])
  assert.equal(charts[0].unit, 'steps')
})

test('a block that is still streaming is hidden', () => {
  const full = `Tuesday was best.\n\n${BLOCK}`
  for (let cut = 'Tuesday was best.\n\n'.length + 1; cut < full.length; cut++) {
    const { text, charts } = extractCharts(full.slice(0, cut))
    assert.equal(charts.length, 0)
    assert.doesNotMatch(text, /[`{]/, `leaked at ${cut}: ${JSON.stringify(text)}`)
  }
})

test('invalid JSON leaves an unavailable marker', () => {
  const { text, charts, invalid } = extractCharts('Here.\n```g2chart\n{"type":"bar",\n```')
  assert.equal(text, `Here.\n${CHART_INVALID}`)
  assert.equal(charts.length, 0)
  assert.equal(invalid, 1)
})

test('other code blocks are left alone', () => {
  const { text } = extractCharts('Run:\n```sh\nls\n```')
  assert.equal(text, 'Run:\n```sh\nls\n```')
})

test('values are clamped and cleaned', () => {
  const spec = parseChart({ type: 'bar', title: 't', values: [...Array(20).keys(), 'x', null], labels: ['a very long label'] })
  assert.ok(spec)
  assert.equal(spec.values.length, MAX_BARS)
  assert.equal(spec.labels[0], 'a very…')
  assert.equal(parseChart({ type: 'pie', title: 't', values: [1] }), null)
  assert.equal(parseChart({ type: 'bar', values: [1] }), null)
  assert.equal(parseChart({ type: 'line', title: 't', values: [] }), null)
})

test('only valid blocks count, in order', () => {
  const two = `${BLOCK}\n${BLOCK.replace('Steps', 'Sleep')}`
  const { charts } = extractCharts(two)
  assert.deepEqual(charts.map(c => c.title), ['Steps', 'Sleep'])
})

test('gauge ranges default sensibly', () => {
  assert.deepEqual([parseChart({ type: 'gauge', title: 'g', values: [72] })?.min, parseChart({ type: 'gauge', title: 'g', values: [72] })?.max], [0, 100])
  const big = parseChart({ type: 'gauge', title: 'g', value: 450 })
  assert.equal(big?.max, 450)
  const ranged = parseChart({ type: 'gauge', title: 'g', values: [3], min: 0, max: 5 })
  assert.equal(ranged?.max, 5)
})
