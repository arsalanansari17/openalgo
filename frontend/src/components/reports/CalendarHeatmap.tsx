// frontend/src/components/reports/CalendarHeatmap.tsx
/**
 * Shared calendar heat map (fork-only, see openalgo's SKYSHIELD_PATCHES.md
 * and docs/design/56-pnl-history). Modeled on Zerodha Console's own two
 * report heat maps: the P&L report's green/red-by-realized-P&L map and the
 * Tradebook report's blue-by-trade-count map. Both are the same continuous
 * week-column layout with a different value + color function, so the
 * layout lives here once and each page supplies its own `days` and
 * `colorFor`.
 *
 * Layout is a continuous strip - weeks as columns, Sun-Sat as rows, month
 * labels placed under whichever column that month first appears in - a
 * GitHub-contributions-graph style, matching Zerodha's own reference
 * exactly (confirmed against a real Zerodha Console screenshot). An
 * earlier version rendered separate bordered per-month calendar blocks
 * instead; replaced because it doesn't match the reference and needs far
 * more space (12 month-blocks wrap into several tall rows, where this
 * layout fits a full year in ~740px of width and 7 cells of height).
 *
 * Always a trailing 12-month frame ending at endDate's own month,
 * regardless of how narrow the actual searched/filtered range is (another
 * confirmed Zerodha behavior) - days outside the real fetched range still
 * render, just very faint, so the frame's size never jumps around between
 * a 7-day and a 90-day search.
 */
import { useMemo } from 'react'

export interface CalendarHeatmapDay {
  date: string // YYYY-MM-DD
  value: number
  tooltip: string
}

interface CalendarHeatmapProps {
  days: CalendarHeatmapDay[]
  startDate: string
  endDate: string
  colorFor: (value: number, maxAbs: number) => string
}

function toUTCDateStr(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month, day)).toISOString().split('T')[0]
}

function addUTCDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + delta)
  return dt.toISOString().split('T')[0]
}

function monthShortLabel(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 1)).toLocaleString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  })
}

interface MonthLabel {
  col: number
  label: string
}

/** Continuous week-column grid for the trailing 12 months ending at
 * endDate's month. Weeks start on Sunday; the first/last columns are
 * padded with `null` cells outside the actual frame so every column has
 * exactly 7 entries. A month label is emitted for the first column in
 * which that month's days appear. */
function buildColumns(endDate: string): { weeks: (string | null)[][]; monthLabels: MonthLabel[] } {
  const [ey, em] = endDate.split('-').map(Number)
  const frameEnd = new Date(Date.UTC(ey, em, 0)).toISOString().split('T')[0] // last day of endDate's month

  const frameStartIdx = ey * 12 + (em - 1) - 11
  const frameStartYear = Math.floor(frameStartIdx / 12)
  const frameStartMonth = ((frameStartIdx % 12) + 12) % 12
  const frameStart = toUTCDateStr(frameStartYear, frameStartMonth, 1)

  const frameStartWeekday = new Date(`${frameStart}T00:00:00Z`).getUTCDay()
  const gridStart = addUTCDays(frameStart, -frameStartWeekday)

  const weeks: (string | null)[][] = []
  const monthLabels: MonthLabel[] = []
  let lastLabeledMonth = ''
  let cursor = gridStart
  let col = 0

  while (cursor <= frameEnd) {
    const week: (string | null)[] = []
    let monthOfLastRealDay = ''
    for (let row = 0; row < 7; row++) {
      if (cursor < frameStart || cursor > frameEnd) {
        week.push(null)
      } else {
        week.push(cursor)
        monthOfLastRealDay = cursor.slice(0, 7) // YYYY-MM
      }
      cursor = addUTCDays(cursor, 1)
    }
    if (monthOfLastRealDay && monthOfLastRealDay !== lastLabeledMonth) {
      const [ly, lm] = monthOfLastRealDay.split('-').map(Number)
      monthLabels.push({ col, label: monthShortLabel(ly, lm - 1) })
      lastLabeledMonth = monthOfLastRealDay
    }
    weeks.push(week)
    col += 1
  }

  return { weeks, monthLabels }
}

const CELL = 11
const GAP = 3
const STEP = CELL + GAP

export function CalendarHeatmap({ days, startDate, endDate, colorFor }: CalendarHeatmapProps) {
  const dayMap = useMemo(() => new Map(days.map((d) => [d.date, d])), [days])
  const maxAbs = useMemo(() => Math.max(1, ...days.map((d) => Math.abs(d.value))), [days])
  const { weeks, monthLabels } = useMemo(() => buildColumns(endDate), [endDate])

  return (
    <div className="inline-flex flex-col gap-1">
      <div className="flex" style={{ gap: GAP }}>
        {weeks.map((week, colIdx) => (
          <div key={colIdx} className="flex flex-col" style={{ gap: GAP }}>
            {week.map((dateStr, rowIdx) => {
              if (!dateStr) {
                return <div key={rowIdx} style={{ width: CELL, height: CELL }} />
              }
              const inRange = dateStr >= startDate && dateStr <= endDate
              const entry = inRange ? dayMap.get(dateStr) : undefined
              const bg = !inRange
                ? 'rgba(148, 163, 184, 0.08)'
                : entry
                  ? colorFor(entry.value, maxAbs)
                  : 'rgba(148, 163, 184, 0.15)'
              return (
                <div
                  key={dateStr}
                  title={inRange ? (entry?.tooltip ?? `${dateStr}: no data`) : undefined}
                  className="rounded-sm"
                  style={{ width: CELL, height: CELL, backgroundColor: bg }}
                />
              )
            })}
          </div>
        ))}
      </div>
      <div className="relative h-4" style={{ width: weeks.length * STEP }}>
        {monthLabels.map(({ col, label }) => (
          <span
            key={col}
            className="absolute text-[9px] text-muted-foreground"
            style={{ left: col * STEP }}
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}
