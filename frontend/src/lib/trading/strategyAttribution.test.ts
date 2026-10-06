import { describe, expect, it } from 'vitest'
import type { AttributedRow, StrategyAttribution } from '@/api/trading'
import type { Holding, Position } from '@/types/trading'
import { groupByStrategy, narrowHoldingsToStrategy } from './strategyAttribution'

const pos = (over: Partial<Position> = {}): Position => ({
  symbol: 'NIFTYX',
  exchange: 'NFO',
  product: 'NRML',
  quantity: -150,
  average_price: 100,
  ltp: 90,
  pnl: 1500,
  pnlpercent: 10,
  ...over,
})

const attribution = (rows: Partial<AttributedRow>[]): StrategyAttribution => ({
  kind: 'positions',
  strategies: [],
  rows: rows.map((r) => ({
    symbol: 'NIFTYX',
    exchange: 'NFO',
    product: 'NRML',
    quantity: 0,
    average_price: 0,
    slices: [],
    mismatch: false,
    mismatch_reason: null,
    leftover_owner: null,
    ...r,
  })),
})

const slice = (strategy: string, quantity: number, average_price: number, today = 0) => ({
  strategy,
  quantity,
  average_price,
  today_realized_pnl: today,
  attributed: strategy !== 'Unattributed',
})

const total = (groups: Record<string, { pnl: number }[]>) =>
  Object.values(groups)
    .flat()
    .reduce((sum, r) => sum + r.pnl, 0)

describe('groupByStrategy', () => {
  it('splits one broker row across strategies and keeps the broker P&L total', () => {
    const groups = groupByStrategy(
      [pos()],
      attribution([{ slices: [slice('A', -100, 100), slice('B', -50, 100)] }])
    )
    expect(Object.keys(groups).sort()).toEqual(['A', 'B'])
    expect(groups.A[0].quantity).toBe(-100)
    expect(groups.A[0].pnl).toBeCloseTo(1000)
    expect(groups.B[0].pnl).toBeCloseTo(500)
    expect(total(groups)).toBeCloseTo(1500)
  })

  it('shows every row as Unattributed when there is no attribution', () => {
    const groups = groupByStrategy([pos()], null)
    expect(Object.keys(groups)).toEqual(['Unattributed'])
    expect(groups.Unattributed[0].pnl).toBe(1500)
  })

  it('keeps a flat strategy leg realized P&L and puts the rest on Unattributed', () => {
    const groups = groupByStrategy(
      [pos({ quantity: 0, ltp: 0, pnl: 1800 })],
      attribution([{ slices: [slice('IC', 0, 0, 1250)] }])
    )
    expect(groups.IC[0].pnl).toBe(1250)
    expect(groups.Unattributed[0].pnl).toBeCloseTo(550)
    expect(total(groups)).toBeCloseTo(1800)
  })

  it('folds the unexplained P&L into an existing Unattributed remainder slice', () => {
    const groups = groupByStrategy(
      [pos({ quantity: -150, pnl: 1700 })],
      attribution([{ slices: [slice('A', -100, 100), slice('Unattributed', -50, 100)] }])
    )
    expect(groups.Unattributed).toHaveLength(1)
    expect(groups.Unattributed[0].quantity).toBe(-50)
    expect(total(groups)).toBeCloseTo(1700)
  })

  it('does not mark slices without a live price, only realized P&L', () => {
    const groups = groupByStrategy(
      [pos({ ltp: undefined, pnl: 400 })],
      attribution([{ slices: [slice('A', -150, 100, 100)] }])
    )
    expect(groups.A[0].pnl).toBe(100)
    expect(total(groups)).toBeCloseTo(400)
  })
})

describe('flat position closed outside the book', () => {
  it('gives the realized P&L to the one strategy the book still shows holding it', () => {
    const groups = groupByStrategy(
      [pos({ quantity: 0, ltp: 0.4, pnl: 1088.75 })],
      attribution([{ slices: [], leftover_owner: 'IronCondor' }])
    )
    expect(Object.keys(groups)).toEqual(['IronCondor'])
    expect(groups.IronCondor[0].pnl).toBeCloseTo(1088.75)
    expect(groups.IronCondor[0].quantity).toBe(0)
  })

  it('keeps it Unattributed when no single strategy owns it', () => {
    const groups = groupByStrategy(
      [pos({ quantity: 0, ltp: 0.4, pnl: 1088.75 })],
      attribution([{ slices: [], leftover_owner: null }])
    )
    expect(Object.keys(groups)).toEqual(['Unattributed'])
  })

  it('adds to the owner row when that strategy also realized P&L today', () => {
    const groups = groupByStrategy(
      [pos({ quantity: 0, ltp: 0, pnl: 1500 })],
      attribution([{ slices: [slice('IC', 0, 0, 1000)], leftover_owner: 'IC' }])
    )
    expect(groups.IC).toHaveLength(1)
    expect(groups.IC[0].pnl).toBeCloseTo(1500)
  })
})

describe('narrowHoldingsToStrategy', () => {
  const holding: Holding = {
    symbol: 'INFY',
    exchange: 'NSE',
    product: 'CNC',
    quantity: 60,
    t1_quantity: 10,
    pledged_quantity: 30,
    average_price: 1500,
    ltp: 1600,
    pnl: 10000,
    pnlpercent: 6.67,
  }
  const attr = (slices: ReturnType<typeof slice>[]): StrategyAttribution => ({
    kind: 'holdings',
    strategies: [],
    rows: [
      {
        symbol: 'INFY',
        exchange: 'NSE',
        product: 'CNC',
        quantity: 100,
        average_price: 1500,
        slices,
        mismatch: false,
        mismatch_reason: null,
        leftover_owner: null,
      },
    ],
  })

  it('keeps only the strategy share at its own cost, marked to the live price', () => {
    const [row] = narrowHoldingsToStrategy(
      [holding],
      attr([slice('EBP', 40, 1550), slice('Unattributed', 60, 1466.67)]),
      'EBP'
    )
    expect(row.quantity).toBe(40)
    expect(row.t1_quantity).toBe(0)
    expect(row.pledged_quantity).toBe(0)
    expect(row.average_price).toBe(1550)
    expect(row.pnl).toBeCloseTo(2000)
    expect(row.pnlpercent).toBeCloseTo((2000 / (40 * 1550)) * 100)
  })

  it('drops holdings the strategy does not own', () => {
    expect(narrowHoldingsToStrategy([holding], attr([slice('Other', 100, 1500)]), 'EBP')).toEqual(
      []
    )
  })

  it('returns nothing without an attribution', () => {
    expect(narrowHoldingsToStrategy([holding], null, 'EBP')).toEqual([])
  })
})
