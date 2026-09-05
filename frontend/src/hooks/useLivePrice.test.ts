import { describe, expect, it } from 'vitest'
import { calculateLiveStats, type PriceableItem } from './useLivePrice'

const item = (o: Partial<PriceableItem>): PriceableItem => ({
  symbol: 'RELIANCE',
  exchange: 'NSE',
  quantity: 10,
  average_price: 1000,
  ltp: 1050,
  pnl: 500,
  pnlpercent: 5,
  ...o,
})

const baseStats = {
  totalholdingvalue: 0,
  totalinvvalue: 0,
  totalprofitandloss: 0,
  totalpnlpercentage: 0,
}

describe('calculateLiveStats', () => {
  it('returns null when there are no original stats to merge onto', () => {
    expect(calculateLiveStats([item({})], undefined)).toBeNull()
  })

  it('computes day P&L and day P&L% from per-item day_change, weighted by prevClose value', () => {
    // Two holdings, both up on the day:
    // RELIANCE: qty=10, ltp=1050, day_change=+20  -> prevClose=1030, dayPnl=+200
    // TCS:      qty=5,  ltp=3600, day_change=-40  -> prevClose=3640, dayPnl=-200
    const items = [
      item({ symbol: 'RELIANCE', quantity: 10, ltp: 1050, day_change: 20 }),
      item({ symbol: 'TCS', quantity: 5, ltp: 3600, day_change: -40 }),
    ]

    const result = calculateLiveStats(items, baseStats)

    expect(result?.totaldaypnl).toBeCloseTo(200 + -200)
    // totalPrevCloseValue = 10*1030 + 5*3640 = 10300 + 18200 = 28500
    // totalDayPnl = 200 - 200 = 0
    expect(result?.totaldaypnlpercentage).toBeCloseTo(0)
  })

  it('ignores items with no day_change (e.g. broker/quote data not yet loaded)', () => {
    const items = [
      item({ symbol: 'RELIANCE', quantity: 10, ltp: 1050, day_change: undefined }),
    ]

    const result = calculateLiveStats(items, baseStats)

    expect(result?.totaldaypnl).toBe(0)
    expect(result?.totaldaypnlpercentage).toBe(0)
  })

  it('does not divide by zero when total previous-close value is zero', () => {
    const items = [item({ quantity: 0, ltp: 1050, day_change: 20 })]

    const result = calculateLiveStats(items, baseStats)

    expect(result?.totaldaypnlpercentage).toBe(0)
  })

  it('still computes the existing total P&L fields alongside the new day P&L fields', () => {
    const items = [item({ quantity: 10, average_price: 1000, ltp: 1050, pnl: 500 })]

    const result = calculateLiveStats(items, baseStats)

    expect(result?.totalprofitandloss).toBe(500)
    expect(result?.totalpnlpercentage).toBeCloseTo(5)
  })
})
