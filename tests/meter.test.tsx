import { describe, expect, test } from 'claude-code/testing'

import { fmtDuration, fmtTokens, forecast, limitsCard, moveTo, niceTicks, positionOf } from '../hooks/register'

const PLUGIN = 'token-almanac'
const MIN = 60_000
const T0 = Date.parse('2026-10-10T08:00:00Z')

const band = {
  plugin: PLUGIN,
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 140, scroll: { offset: 0, bodyRows: 6 }, view: {} },
}
const pane = {
  plugin: PLUGIN,
  component: 'Pane' as const,
  requestId: 'token-almanac',
  props: { title: 'Token 用量', isFocused: false, bodyColumns: 70, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} },
}

// A find that names what it was looking for when nothing matches.
async function must(ui: { find: (q: never) => Promise<unknown> }, query: object): Promise<void> {
  if ((await ui.find(query as never)) === undefined) {
    throw new Error(`nothing drawn matches ${String(JSON.stringify(query, (k, v) => (v instanceof RegExp ? String(v) : v)))}`)
  }
}

describe('forecast', () => {
  const reset = new Date(T0 + 5 * 60 * MIN).toISOString()

  test('needs ten minutes of readings', () => {
    expect(forecast([[T0, 10]], 12, T0 + 5 * MIN, reset).state).toBe('unknown')
  })

  test('projects the fill time from the last 90 minutes', () => {
    // 20% -> 40% over one hour: 20%/h, 60% left, 3h, inside the 4h to reset.
    const f = forecast([[T0, 20]], 40, T0 + 60 * MIN, reset)
    expect(f.ratePerHour).toBe(20)
    expect(f.etaMs).toBe(3 * 60 * MIN)
    expect(f.state).toBe('eta')
  })

  test('says it will not fill before the reset', () => {
    const f = forecast([[T0, 20]], 25, T0 + 60 * MIN, reset)
    expect(f.etaMs).toBeNull()
    expect(f.state).toBe('safe')
  })

  test('flat or full windows', () => {
    expect(forecast([[T0, 30]], 30, T0 + 30 * MIN, reset).state).toBe('flat')
    expect(forecast([[T0, 30]], 100, T0 + 30 * MIN, reset).state).toBe('full')
  })

  test('old readings cannot predict a new burst, and expired windows have no ETA', () => {
    expect(forecast([[T0, 10]], 90, T0 + 120 * MIN, reset).state).toBe('unknown')
    expect(forecast([[T0, 90]], 100, Date.parse(reset), reset).state).toBe('unknown')
  })

  test('formats', () => {
    expect(fmtTokens(950)).toBe('950')
    expect(fmtTokens(1234)).toBe('1.2k')
    expect(fmtTokens(2_345_678)).toBe('2.35M')
    expect(fmtDuration(26 * 60 * MIN)).toBe('1d2h')
    expect(fmtDuration(135 * MIN)).toBe('2h15m')
  })
})

test('turns, models, limits and context reach the band and the pane', { options: { language: 'zh' } }, async ($, on) => {
  let now = T0
  const store: Record<string, unknown> = {}
  on('clock.now', () => ({ value: now }))
  on('clock.every', () => ({ value: { cancel: () => undefined } }) as never)
  on('store.get', ($: unknown, e: { key: string }) => ({ value: store[e.key] }) as never)
  on('store.set', ($: unknown, e: { key: string; value: unknown }) => ((store[e.key] = e.value), { value: undefined }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('session.measure', ($: unknown, e: { changed: string[] }) => ({ changed: e.changed }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  const measure = (five: number, week: number) =>
    $.session.measure({
      context: { tokens: 50_000, window: 200_000, percent: 25 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: five, resetsAt: new Date(T0 + 5 * 60 * MIN).toISOString() },
        { kind: 'seven_day', percentUsed: week, resetsAt: new Date(T0 + 3 * 1440 * MIN).toISOString() },
      ],
      cost: { usd: 1.5 },
      changed: ['context', 'rateLimits', 'cost'],
    } as never)

  await measure(20, 10)
  now = T0 + 60 * MIN
  await measure(40, 11)

  const usage = (model: string, input: number, output: number, cacheRead: number, cacheWrite: number) => ({
    model,
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  })
  // A subagent turn on another model, then the main turn it belongs to, then a second main turn.
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 's1', agentId: 'a1', reason: 'answer', usage: usage('claude-haiku-5-5', 100, 50, 0, 0) } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: usage('claude-opus-5-5', 1000, 500, 8000, 2000) } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer', usage: usage('claude-opus-5-5', 200, 300, 9000, 0) } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const b = await $.ui.mount({ ...band, surface })
    // The band keeps to the cost, the context, each limit and how soon one fills before its reset.
    await must(b, { type: 'Text', text: /\$1\.50 · 上下文 25%/ })
    await must(b, { text: /5 小时 40% 3h0m 后满/ })
    await must(b, { text: /每周 11%/ })
    expect(await b.find({ text: /重置|tok/ })).toBeUndefined()
    await b.unmount()

    const p = await $.ui.mount({ ...pane, surface })
    // The desktop sets its figures in drawn cards, the terminal writes them as text; on both the
    // makeup and models are behind the breakdown.
    expect(await p.find({ text: /haiku-5-5/ })).toBeUndefined()
    await p.press({ key: 'details' })
    const drawn = surface === 'desktop' ? JSON.stringify(await p.findAll({ type: 'Svg' })) : ''
    const shows = async (text: string | RegExp) => (surface === 'desktop' ? expect(drawn).toMatch(text) : must(p, { text }))
    // The limits lead: when each resets and how it goes at the current pace, in one line (with no
    // scan there is no usual pace to tell).
    await shows(/4h0m后重置 · 当前速度约 3h0m 后用满/)
    await shows(/当前速度 → 约 \d+%/)
    await shows('$1.50')
    await shows('25%')
    await shows('上下文 200k')
    await shows('opus-5-5')
    await shows('haiku-5-5')
    await shows(/cache 读 (\$[\d.]+ )?\d+%/)
    if (surface === 'desktop') {
      // The first main turn carries its subagent's turn.
      const charts = await p.findAll({ type: 'Svg' })
      expect(JSON.stringify(charts)).toMatch(/第 1 轮 {2}12k tokens.{1,2}output 550 · cache 写 2\.0k · cache 读 8\.0k.{1,2}含子代理 1 个/)
    } else {
      await must(p, { text: /^[▁▂▃▄▅▆▇█]{2}$/ })
    }
    // The breakdown is folded again for the next surface.
    await p.press({ key: 'details' })
    await p.unmount()
  }
  // Readings were kept for a restart within the same window.
  expect(Object.keys(store.samples as object).sort()).toEqual(['five_hour', 'seven_day'])
})

describe('motion', () => {
  test('a figure rises from zero once, keeps its move while the value stays, and sets off from where it is', () => {
    const first = moveTo('test:a', 40, T0)
    expect([first.from, first.to]).toEqual([0, 40])
    // Drawn again with the same value: the same move, so a vector drawing does not play again.
    expect(moveTo('test:a', 40, T0 + 5_000)).toBe(first)
    expect(positionOf(first, T0)).toBe(0)
    expect(positionOf(first, T0 + 10_000)).toBe(40)
    // Halfway through a move to 60, a move to 20 sets off from where the figure is drawn.
    const up = moveTo('test:b', 60, T0, 60)
    expect(up.from).toBe(60)
    const back = moveTo('test:b', 20, T0)
    expect(back.from).toBe(60)
    const mid = positionOf(back, T0 + 200)
    expect(mid < 60 && mid > 20).toBe(true)
    expect(moveTo('test:b', 30, T0 + 200).from).toBe(mid)
  })

  test('a new value glides; once the move is over the bar is drawn still, so a fresh image does not play it again', () => {
    const row = (percent: number, at: number) => ({ label: '5h', percent, move: moveTo('test:meter', percent, at), projected: null, paceProjected: null, elapsed: null, parts: [] })
    // The bar runs 288 wide from x 112: 40% fills 115.2 of it.
    const a = limitsCard([row(40, T0)], T0)
    expect(a).toContain('<animate attributeName="width" from="10.0" to="115.2"')
    // Drawn again after the move: the still bar, the same as one drawn without a move.
    expect(limitsCard([row(40, T0 + 30_000)], T0 + 30_000)).toBe(limitsCard([{ ...row(40, T0 + 30_000), move: null }], T0 + 30_000))
    const b = limitsCard([row(55, T0 + 60_000)], T0 + 60_000)
    expect(b).toContain('from="115.2" to="158.4"')
  })

  test('a limit shows where it is headed each way and how far through its window the clock is, each part of its line led by its mark', () => {
    const parts = [
      { text: '4d21h后重置', mark: 'elapsed' as const },
      { text: '当前速度约 1d18h 后用满', mark: 'pace' as const },
      { text: '历史节奏 → 约 80%', mark: 'usual' as const },
      { text: '剩余 ≈ $159', mark: null },
    ]
    const svg = limitsCard([{ label: '每周', percent: 46, move: null, projected: 80, paceProjected: 100, elapsed: 0.3, parts }], T0)
    // The usual pace's stretch reaches 80% of the bar, the current pace's, paler, all of it; the tick
    // sits three tenths of the way along.
    expect(svg).toContain('width="230.4" height="10" fill="#D97757" fill-opacity="0.4"')
    expect(svg).toContain('width="288.0" height="10" fill="#D97757" fill-opacity="0.18"')
    expect(svg).toContain('<line x1="198.4" x2="198.4"')
    for (const text of ['46%', '每周', ...parts.map(p => p.text)]) expect(svg).toContain(text)
    // Each mark before its text: the tick's, then a swatch as pale as each stretch.
    expect(svg.match(/fill-opacity="0\.18"/g)?.length).toBe(2)
    expect(svg.match(/fill-opacity="0\.4"/g)?.length).toBe(2)
    // The line runs on to a second line where it is wider than the card.
    const y = (text: string) => Number(/y="([\d.]+)"[^<]*$/.exec(svg.slice(0, svg.indexOf(`>${text}<`)))![1])
    expect(y('剩余 ≈ $159') > y('4d21h后重置')).toBe(true)
    // Where a window is not headed past what it has used, no stretch is drawn.
    const still = limitsCard([{ label: '5h', percent: 30, move: null, projected: 20, paceProjected: null, elapsed: null, parts: [] }], T0)
    expect(still).not.toContain('fill-opacity')
  })

  test('gridlines fall on clean values just past the top', () => {
    expect(niceTicks(764)).toEqual([0, 200, 400, 600, 800])
    expect(niceTicks(12_000)).toEqual([0, 5000, 10000, 15000])
    expect(niceTicks(0)).toEqual([0])
  })
})
