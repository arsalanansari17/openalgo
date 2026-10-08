// frontend/src/lib/pnlCurve.ts
/**
 * Pure maths for the P&L Curve page (fork-only, see SKYSHIELD_PATCHES.md):
 * daily and cumulative realized P&L, drawdown, summary statistics and the
 * monthly table, from the closed lots GET /api/v1/pnl/history returns. No I/O
 * and no React, so every figure on the page is covered by tests.
 *
 * Everything is by the day a lot was closed out (its exit date), the same
 * basis as the P&L History day-wise table. A lot's strategy is the strategy
 * of the fill that opened it; a lot with none is "Untagged".
 */

export const UNTAGGED = 'Untagged'

export interface CurveLot {
  exit_timestamp: string
  realized_pnl: number
  strategy: string | null
}

export interface DailySeries {
  /** Ascending YYYY-MM-DD dates on which at least one lot closed. */
  dates: string[]
  /** Daily P&L over all lots, aligned to `dates`. */
  total: number[]
  /** Daily P&L per strategy, each aligned to `dates` (zero on idle days). */
  byStrategy: Map<string, number[]>
}

export function strategyOf(lot: CurveLot): string {
  return lot.strategy || UNTAGGED
}

export function dailySeries(lots: CurveLot[]): DailySeries {
  const perDay = new Map<string, Map<string, number>>()
  for (const lot of lots) {
    const date = lot.exit_timestamp.slice(0, 10)
    const strategy = strategyOf(lot)
    const day = perDay.get(date) ?? new Map<string, number>()
    day.set(strategy, (day.get(strategy) ?? 0) + lot.realized_pnl)
    perDay.set(date, day)
  }

  const dates = Array.from(perDay.keys()).sort()
  const names = new Set<string>()
  for (const day of perDay.values()) for (const name of day.keys()) names.add(name)

  const byStrategy = new Map<string, number[]>()
  for (const name of names) {
    byStrategy.set(
      name,
      dates.map((date) => perDay.get(date)?.get(name) ?? 0)
    )
  }
  const total = dates.map((date) => {
    let sum = 0
    for (const value of perDay.get(date)?.values() ?? []) sum += value
    return sum
  })
  return { dates, total, byStrategy }
}

export function cumulative(daily: number[]): number[] {
  let running = 0
  return daily.map((value) => {
    running += value
    return running
  })
}

export interface MaxDrawdown {
  /** Negative or zero: the deepest fall from a running peak. */
  depth: number
  /** Date of the peak the fall started from; null when it started from the first day's start (zero). */
  peakDate: string | null
  troughDate: string | null
  /** First date the curve got back to the peak; null while still under water. */
  recoveryDate: string | null
  /** Calendar days from the peak (or the first date) to recovery, or to the last date if not recovered. */
  days: number
}

export interface DrawdownResult {
  /** Drawdown from the running peak at every date, zero or negative. */
  series: number[]
  max: MaxDrawdown
}

function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/** The curve starts at zero before the first date, so the first peak is zero. */
export function drawdown(dates: string[], cum: number[]): DrawdownResult {
  const series: number[] = []
  let peak = 0
  let peakDate: string | null = null
  let worst = 0
  let worstPeakDate: string | null = null
  let worstPeakValue = 0
  let worstTroughIdx = -1

  cum.forEach((value, i) => {
    if (value > peak) {
      peak = value
      peakDate = dates[i]
    }
    const depth = value - peak
    series.push(depth)
    if (depth < worst) {
      worst = depth
      worstPeakDate = peakDate
      worstPeakValue = peak
      worstTroughIdx = i
    }
  })

  if (worstTroughIdx < 0) {
    return {
      series,
      max: { depth: 0, peakDate: null, troughDate: null, recoveryDate: null, days: 0 },
    }
  }

  let recoveryDate: string | null = null
  for (let i = worstTroughIdx + 1; i < cum.length; i++) {
    if (cum[i] >= worstPeakValue) {
      recoveryDate = dates[i]
      break
    }
  }
  const startDate = worstPeakDate ?? dates[0]
  const endDate = recoveryDate ?? dates[dates.length - 1]
  return {
    series,
    max: {
      depth: worst,
      peakDate: worstPeakDate,
      troughDate: dates[worstTroughIdx],
      recoveryDate,
      days: dayDiff(startDate, endDate),
    },
  }
}

export interface DayExtreme {
  date: string
  value: number
}

export interface CurveStats {
  netPnl: number
  /** Days on which at least one lot closed. */
  activeDays: number
  winDays: number
  lossDays: number
  /** Win days over win plus loss days; null with no decided day. */
  winRate: number | null
  avgWinDay: number | null
  avgLossDay: number | null
  /** Sum of winning days over the absolute sum of losing days; null with no losing day. */
  profitFactor: number | null
  bestDay: DayExtreme | null
  worstDay: DayExtreme | null
  longestWinStreak: number
  longestLossStreak: number
}

export function stats(dates: string[], daily: number[]): CurveStats {
  let netPnl = 0
  let winSum = 0
  let lossSum = 0
  let winDays = 0
  let lossDays = 0
  let best: DayExtreme | null = null
  let worst: DayExtreme | null = null
  let winStreak = 0
  let lossStreak = 0
  let longestWin = 0
  let longestLoss = 0

  daily.forEach((value, i) => {
    netPnl += value
    if (best === null || value > best.value) best = { date: dates[i], value }
    if (worst === null || value < worst.value) worst = { date: dates[i], value }
    if (value > 0) {
      winDays += 1
      winSum += value
      winStreak += 1
      lossStreak = 0
    } else if (value < 0) {
      lossDays += 1
      lossSum += value
      lossStreak += 1
      winStreak = 0
    } else {
      winStreak = 0
      lossStreak = 0
    }
    longestWin = Math.max(longestWin, winStreak)
    longestLoss = Math.max(longestLoss, lossStreak)
  })

  const decided = winDays + lossDays
  return {
    netPnl,
    activeDays: daily.length,
    winDays,
    lossDays,
    winRate: decided > 0 ? winDays / decided : null,
    avgWinDay: winDays > 0 ? winSum / winDays : null,
    avgLossDay: lossDays > 0 ? lossSum / lossDays : null,
    profitFactor: lossDays > 0 ? winSum / Math.abs(lossSum) : null,
    bestDay: best,
    worstDay: worst,
    longestWinStreak: longestWin,
    longestLossStreak: longestLoss,
  }
}

export interface MonthlyRow {
  year: number
  /** January to December; null for a month with no closed lot. */
  months: (number | null)[]
  total: number
}

export function monthly(dates: string[], daily: number[]): MonthlyRow[] {
  const byYear = new Map<number, (number | null)[]>()
  dates.forEach((date, i) => {
    const year = Number(date.slice(0, 4))
    const month = Number(date.slice(5, 7)) - 1
    const row = byYear.get(year) ?? new Array<number | null>(12).fill(null)
    row[month] = (row[month] ?? 0) + daily[i]
    byYear.set(year, row)
  })
  return Array.from(byYear.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([year, months]) => ({
      year,
      months,
      total: months.reduce<number>((sum, value) => sum + (value ?? 0), 0),
    }))
}

export interface StrategySummary {
  strategy: string
  netPnl: number
  maxDrawdown: number
  winRate: number | null
  profitFactor: number | null
  activeDays: number
}

/** One row per strategy, each judged on its own days. */
export function strategySummaries(series: DailySeries): StrategySummary[] {
  const rows: StrategySummary[] = []
  for (const [strategy, daily] of series.byStrategy) {
    // Only the days this strategy closed something: an idle zero is not a day.
    const dates: string[] = []
    const active: number[] = []
    daily.forEach((value, i) => {
      if (value !== 0) {
        dates.push(series.dates[i])
        active.push(value)
      }
    })
    const summary = stats(dates, active)
    rows.push({
      strategy,
      netPnl: summary.netPnl,
      maxDrawdown: drawdown(dates, cumulative(active)).max.depth,
      winRate: summary.winRate,
      profitFactor: summary.profitFactor,
      activeDays: summary.activeDays,
    })
  }
  return rows.sort((a, b) => b.netPnl - a.netPnl)
}
