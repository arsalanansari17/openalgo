// frontend/src/components/reports/CalendarHeatmap.tsx
/**
 * Shared calendar-grid heatmap (fork-only, see openalgo's
 * SKYSHIELD_PATCHES.md and docs/design/56-pnl-history). Modeled on Zerodha
 * Console's own two report heatmaps: the P&L report's green/red-by-realized-
 * P&L map and the Tradebook report's blue-by-trade-count map. Both are the
 * same calendar layout with a different value + color function, so the
 * layout lives here once and each page supplies its own `days` and
 * `colorFor`.
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

function enumerateMonths(startDate: string, endDate: string): { year: number; month: number }[] {
  const [sy, sm] = startDate.split('-').map(Number)
  const [ey, em] = endDate.split('-').map(Number)
  const months: { year: number; month: number }[] = []
  let y = sy
  let m = sm - 1
  const endIdx = ey * 12 + (em - 1)
  while (y * 12 + m <= endIdx) {
    months.push({ year: y, month: m })
    m += 1
    if (m > 11) {
      m = 0
      y += 1
    }
  }
  return months
}

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

function MonthGrid({
  year,
  month,
  dayMap,
  maxAbs,
  startDate,
  endDate,
  colorFor,
}: {
  year: number
  month: number
  dayMap: Map<string, CalendarHeatmapDay>
  maxAbs: number
  startDate: string
  endDate: string
  colorFor: (value: number, maxAbs: number) => string
}) {
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay()
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const cells: ({ dateStr: string; day: number } | null)[] = []
  for (let i = 0; i < firstWeekday; i++) cells.push(null)
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push({ dateStr: toUTCDateStr(year, month, day), day })
  }
  while (cells.length % 7 !== 0) cells.push(null)

  const monthLabel = new Date(Date.UTC(year, month, 1)).toLocaleString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })

  return (
    <div className="flex flex-col items-center gap-1">
      <p className="text-xs font-medium text-muted-foreground">{monthLabel}</p>
      <div className="grid grid-cols-7 gap-0.5">
        {WEEKDAY_LABELS.map((label, i) => (
          <div
            key={`${label}-${i}`}
            className="w-6 h-3 text-[9px] leading-3 text-center text-muted-foreground"
          >
            {label}
          </div>
        ))}
        {cells.map((cell, idx) => {
          if (!cell) return <div key={`pad-${idx}`} className="w-6 h-6" />
          const inRange = cell.dateStr >= startDate && cell.dateStr <= endDate
          const entry = inRange ? dayMap.get(cell.dateStr) : undefined
          const bg = !inRange
            ? 'transparent'
            : entry
              ? colorFor(entry.value, maxAbs)
              : 'rgba(148, 163, 184, 0.12)'
          return (
            <div
              key={cell.dateStr}
              title={inRange ? (entry?.tooltip ?? `${cell.dateStr}: no trades`) : undefined}
              className="w-6 h-6 rounded-sm border border-border/40 flex items-center justify-center text-[9px] text-muted-foreground"
              style={{ backgroundColor: bg }}
            >
              {inRange ? cell.day : ''}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function CalendarHeatmap({ days, startDate, endDate, colorFor }: CalendarHeatmapProps) {
  const dayMap = useMemo(() => new Map(days.map((d) => [d.date, d])), [days])
  const maxAbs = useMemo(() => Math.max(1, ...days.map((d) => Math.abs(d.value))), [days])
  const months = useMemo(() => enumerateMonths(startDate, endDate), [startDate, endDate])

  return (
    <div className="flex flex-wrap gap-6">
      {months.map(({ year, month }) => (
        <MonthGrid
          key={`${year}-${month}`}
          year={year}
          month={month}
          dayMap={dayMap}
          maxAbs={maxAbs}
          startDate={startDate}
          endDate={endDate}
          colorFor={colorFor}
        />
      ))}
    </div>
  )
}
