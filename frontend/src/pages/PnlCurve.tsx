// frontend/src/pages/PnlCurve.tsx
/**
 * P&L Curve (fork-only, see openalgo's SKYSHIELD_PATCHES.md): the cumulative
 * realized P&L over a date range, one line per strategy plus the total, with a
 * drawdown pane, summary statistics, a per-strategy table and a monthly table.
 *
 * Everything is derived in the browser from the closed lots GET
 * /api/v1/pnl/history already returns (lib/pnlCurve.ts holds the maths and its
 * tests), by the day each lot was closed out. Unrealized and Combined need a
 * daily price for every open position and are not built yet.
 */
import {
  BaselineSeries,
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  LineSeries,
} from 'lightweight-charts'
import { Loader2, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { tradingApi } from '@/api/trading'
import { DateRangePresets } from '@/components/reports/DateRangePresets'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  type CurveLot,
  cumulative,
  dailySeries,
  drawdown,
  monthly,
  stats,
  strategyOf,
  strategySummaries,
  UNTAGGED,
} from '@/lib/pnlCurve'
import { cn, makeFormatCurrency } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'
import { useThemeStore } from '@/stores/themeStore'
import type { Segment } from '@/types/trading'
import { showToast } from '@/utils/toast'

// Local calendar dates: toISOString() is the UTC date, still yesterday before
// 05:30 IST.
function todayStr(): string {
  return new Date().toLocaleDateString('en-CA')
}

function yearAgoStr(): string {
  const d = new Date()
  d.setFullYear(d.getFullYear() - 1)
  return d.toLocaleDateString('en-CA')
}

// Categorical colours, assigned in this fixed order to strategies sorted by
// name and never cycled; a ninth strategy folds into "Other". Both columns
// are the same eight hues stepped for each surface (the validated reference
// palette of the dataviz method). The canvas cannot read CSS tokens, so the
// values are literal.
const SERIES_COLORS = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
}
const MAX_STRATEGY_SERIES = SERIES_COLORS.light.length
const OTHER = 'Other'
const TOTAL = 'Total'

// Neutral inks: the total line, untagged and folded series, grid and text.
const INK = {
  light: { total: '#0b0b0b', untagged: '#8a8984', other: '#6b6a66', text: '#52514e' },
  dark: { total: '#ffffff', untagged: '#8f8e86', other: '#a9a89f', text: '#c3c2b7' },
}

const CHART_HEIGHT = 520
const CURVE_PANE_HEIGHT = 400
const DRAWDOWN_PANE_HEIGHT = CHART_HEIGHT - CURVE_PANE_HEIGHT

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

interface TooltipState {
  left: number
  top: number
  date: string
  rows: { name: string; color: string; value: number }[]
  drawdown: number | null
}

function percent(value: number | null): string {
  return value === null ? '-' : `${(value * 100).toFixed(0)}%`
}

function ratio(value: number | null): string {
  return value === null ? '-' : value.toFixed(2)
}

function monthTint(value: number, maxAbs: number): string {
  if (value === 0 || maxAbs === 0) return 'transparent'
  const alpha = 0.1 + Math.min(Math.abs(value) / maxAbs, 1) * 0.5
  return value > 0 ? `rgba(34, 197, 94, ${alpha})` : `rgba(239, 68, 68, ${alpha})`
}

export default function PnlCurve() {
  const { apiKey, user } = useAuthStore()
  const { mode } = useThemeStore()
  const isDark = mode === 'dark'
  const formatCurrency = useMemo(() => makeFormatCurrency(user?.broker), [user?.broker])
  const formatCurrencyRef = useRef(formatCurrency)
  formatCurrencyRef.current = formatCurrency

  const [segment, setSegment] = useState<'all' | Segment>('all')
  const [startDate, setStartDate] = useState(yearAgoStr())
  const [endDate, setEndDate] = useState(todayStr())
  const [activeDatePreset, setActiveDatePreset] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [hasFetched, setHasFetched] = useState(false)
  const [lots, setLots] = useState<CurveLot[]>([])
  const [view, setView] = useState<'chart' | 'table'>('chart')
  // Series the user switched off in the legend. Colours follow the strategy,
  // so hiding one never repaints the rest.
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)

  const loadSeq = useRef(0)

  const fetchCurve = async (overrideStart?: string, overrideEnd?: string) => {
    const start = overrideStart ?? startDate
    const end = overrideEnd ?? endDate
    if (!apiKey) {
      showToast.error('API key not available', 'system')
      return
    }
    if (!start || !end) {
      showToast.warning('Select both a start and end date', 'system')
      return
    }
    const seq = ++loadSeq.current
    setIsLoading(true)
    try {
      const response = await tradingApi.getPnlHistory(apiKey, start, end, {
        segment: segment === 'all' ? undefined : segment,
      })
      if (seq !== loadSeq.current) return
      if (response.status === 'success' && response.data) {
        setLots(
          response.data.closed_trades.map((t) => ({
            exit_timestamp: t.exit_timestamp,
            realized_pnl: t.realized_pnl,
            strategy: t.strategy,
          }))
        )
        setHidden(new Set())
        setHasFetched(true)
      } else {
        showToast.error(response.message || 'Failed to load P&L history', 'system')
      }
    } catch {
      if (seq === loadSeq.current) showToast.error('Failed to load P&L history', 'system')
    } finally {
      if (seq === loadSeq.current) setIsLoading(false)
    }
  }

  const handleDatePresetSelect = (start: string, end: string, key: string) => {
    setStartDate(start)
    setEndDate(end)
    setActiveDatePreset(key)
    fetchCurve(start, end)
  }

  // Strategy names in colour order: sorted by name, the first eight keep a
  // colour and the rest fold into "Other". Untagged is its own neutral line.
  const folded = useMemo(() => {
    const names = Array.from(new Set(lots.map(strategyOf)))
      .filter((n) => n !== UNTAGGED)
      .sort()
    const kept = new Set(names.slice(0, MAX_STRATEGY_SERIES))
    return {
      names: names.slice(0, MAX_STRATEGY_SERIES),
      lots: lots.map((lot) => {
        const name = strategyOf(lot)
        return name === UNTAGGED || kept.has(name) ? lot : { ...lot, strategy: OTHER }
      }),
    }
  }, [lots])

  const series = useMemo(() => dailySeries(folded.lots), [folded])
  const totalCum = useMemo(() => cumulative(series.total), [series])
  const totalDrawdown = useMemo(() => drawdown(series.dates, totalCum), [series, totalCum])
  const summary = useMemo(() => stats(series.dates, series.total), [series])
  const monthlyRows = useMemo(() => monthly(series.dates, series.total), [series])
  const strategyRows = useMemo(() => strategySummaries(series), [series])

  // One entry per drawn line, in a stable order: total, strategies, then the
  // neutral ones.
  const lines = useMemo(() => {
    const palette = isDark ? SERIES_COLORS.dark : SERIES_COLORS.light
    const ink = isDark ? INK.dark : INK.light
    const out: { name: string; color: string; width: number; values: number[] }[] = [
      { name: TOTAL, color: ink.total, width: 3, values: totalCum },
    ]
    folded.names.forEach((name, i) => {
      const daily = series.byStrategy.get(name)
      if (daily) out.push({ name, color: palette[i], width: 2, values: cumulative(daily) })
    })
    for (const [name, color] of [
      [OTHER, ink.other],
      [UNTAGGED, ink.untagged],
    ] as const) {
      const daily = series.byStrategy.get(name)
      if (daily) out.push({ name, color, width: 2, values: cumulative(daily) })
    }
    return out
  }, [series, totalCum, folded.names, isDark])

  const colorOf = (name: string): string => lines.find((l) => l.name === name)?.color ?? INK.light.untagged

  // Draw. Rebuilt on every change of data, legend or theme: the data is a few
  // hundred daily points at most.
  const containerRef = useRef<HTMLDivElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: lines already carries series, folded and the theme; formatCurrency is read through its ref
  useEffect(() => {
    const container = containerRef.current
    if (!container || view !== 'chart' || series.dates.length === 0) return

    const ink = isDark ? INK.dark : INK.light
    const gridColor = isDark ? 'rgba(166, 173, 187, 0.12)' : 'rgba(0, 0, 0, 0.08)'
    const axisColor = isDark ? 'rgba(166, 173, 187, 0.25)' : 'rgba(0, 0, 0, 0.2)'

    const chart: IChartApi = createChart(container, {
      width: container.clientWidth,
      height: CHART_HEIGHT,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: ink.text,
        panes: {
          enableResize: true,
          separatorColor: axisColor,
          separatorHoverColor: axisColor,
        },
      },
      grid: { vertLines: { visible: false }, horzLines: { color: gridColor } },
      rightPriceScale: { borderColor: axisColor, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: axisColor },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { width: 1, color: axisColor, style: 2, labelVisible: false },
        horzLine: { width: 1, color: axisColor, style: 2 },
      },
      localization: { priceFormatter: (price: number) => formatCurrencyRef.current(price) },
    })

    const drawn = new Map<ISeriesApi<'Line'>, { name: string; color: string }>()
    for (const line of lines) {
      if (hidden.has(line.name)) continue
      const lineSeries = chart.addSeries(
        LineSeries,
        {
          color: line.color,
          lineWidth: line.width as 1 | 2 | 3,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerRadius: 4,
        },
        0
      )
      lineSeries.setData(series.dates.map((date, i) => ({ time: date, value: line.values[i] })))
      drawn.set(lineSeries, { name: line.name, color: line.color })
    }

    // Drawdown in its own pane (it is a different scale and the same unit),
    // hanging from zero so the fill reads as depth.
    const ddColor = isDark ? 'rgba(201, 200, 190, 0.85)' : 'rgba(82, 81, 78, 0.85)'
    const ddSeries = chart.addSeries(
      BaselineSeries,
      {
        baseValue: { type: 'price', price: 0 },
        topLineColor: ddColor,
        topFillColor1: 'rgba(0, 0, 0, 0)',
        topFillColor2: 'rgba(0, 0, 0, 0)',
        bottomLineColor: ddColor,
        bottomFillColor1: isDark ? 'rgba(201, 200, 190, 0.04)' : 'rgba(82, 81, 78, 0.04)',
        bottomFillColor2: isDark ? 'rgba(201, 200, 190, 0.3)' : 'rgba(82, 81, 78, 0.3)',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      },
      1
    )
    ddSeries.setData(
      series.dates.map((date, i) => ({ time: date, value: totalDrawdown.series[i] }))
    )

    const panes = chart.panes()
    if (panes.length > 1) {
      panes[0].setHeight(CURVE_PANE_HEIGHT)
      panes[1].setHeight(DRAWDOWN_PANE_HEIGHT)
    }
    chart.timeScale().fitContent()

    chart.subscribeCrosshairMove((param) => {
      if (!param.point || !param.time || param.point.x < 0 || param.point.y < 0) {
        setTooltip(null)
        return
      }
      const rows: TooltipState['rows'] = []
      for (const [lineSeries, meta] of drawn) {
        const point = param.seriesData.get(lineSeries) as { value?: number } | undefined
        if (point && typeof point.value === 'number') rows.push({ ...meta, value: point.value })
      }
      const dd = param.seriesData.get(ddSeries) as { value?: number } | undefined
      setTooltip({
        left: param.point.x,
        top: param.point.y,
        date: String(param.time),
        rows,
        drawdown: dd && typeof dd.value === 'number' ? dd.value : null,
      })
    })

    const observer = new ResizeObserver(() => chart.applyOptions({ width: container.clientWidth }))
    observer.observe(container)

    return () => {
      observer.disconnect()
      chart.remove()
      setTooltip(null)
    }
  }, [lines, hidden, view, isDark, totalDrawdown])

  const toggleSeries = (name: string) =>
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const pnlClass = (value: number) => (value >= 0 ? 'text-green-600' : 'text-red-600')
  const maxDd = totalDrawdown.max
  const monthMaxAbs = Math.max(
    0,
    ...monthlyRows.flatMap((r) => r.months.map((m) => Math.abs(m ?? 0)))
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">P&L Curve</h1>
        <p className="text-muted-foreground">
          Cumulative realized P&L by the day trades were closed out, per strategy
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col sm:flex-row sm:items-end gap-4">
            <div className="flex-1 space-y-1">
              <Label htmlFor="curve-segment">Segment</Label>
              <Select value={segment} onValueChange={(v) => setSegment(v as typeof segment)}>
                <SelectTrigger id="curve-segment">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="equity">Equity</SelectItem>
                  <SelectItem value="fno">Futures & Options</SelectItem>
                  <SelectItem value="currency">Currency</SelectItem>
                  <SelectItem value="commodity">Commodity</SelectItem>
                  <SelectItem value="mutual_fund">Mutual Funds</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1 space-y-1">
              <Label>P&L</Label>
              <fieldset className="m-0 flex min-w-0 gap-2 border-0 p-0" aria-label="P&L basis">
                <Button type="button" size="sm" variant="default">
                  Realized
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled
                  title="Needs a daily price for every open position - not built yet"
                >
                  Unrealized
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled
                  title="Needs a daily price for every open position - not built yet"
                >
                  Combined
                </Button>
              </fieldset>
            </div>
            <div className="flex-1 space-y-1">
              <Label htmlFor="curve-start-date">Start date</Label>
              <Input
                id="curve-start-date"
                type="date"
                value={startDate}
                max={endDate}
                onChange={(e) => {
                  setStartDate(e.target.value)
                  setActiveDatePreset(null)
                }}
              />
            </div>
            <div className="flex-1 space-y-1">
              <Label htmlFor="curve-end-date">End date</Label>
              <Input
                id="curve-end-date"
                type="date"
                value={endDate}
                min={startDate}
                max={todayStr()}
                onChange={(e) => {
                  setEndDate(e.target.value)
                  setActiveDatePreset(null)
                }}
              />
            </div>
            <Button
              onClick={() => fetchCurve()}
              disabled={isLoading}
              aria-label="Fetch the P&L curve"
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Fetch
            </Button>
          </div>
          <div className="flex flex-col sm:flex-row gap-4 mt-4">
            <div className="hidden sm:block flex-[2]" />
            <div className="flex-[2]">
              <DateRangePresets activeKey={activeDatePreset} onSelect={handleDatePresetSelect} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Realized only for now. Unrealized and Combined need a daily price for every open
            position and come next.
          </p>
        </CardContent>
      </Card>

      {!hasFetched && !isLoading && (
        <div className="text-center py-16 text-muted-foreground">
          <p className="font-medium">Build a report</p>
          <p className="text-sm">Pick a date range above and click Fetch</p>
        </div>
      )}

      {hasFetched && series.dates.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          No closed trades in this date range
        </div>
      )}

      {hasFetched && series.dates.length > 0 && (
        <>
          {/* Headline numbers. Max drawdown leads: it is the figure a curve
              exists to show, and the one the Net P&L alone hides. */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2">
                <CardDescription>Max drawdown</CardDescription>
                <CardTitle className="text-2xl">{formatCurrency(maxDd.depth)}</CardTitle>
                <p className="text-xs text-muted-foreground">
                  {maxDd.troughDate
                    ? `${maxDd.peakDate ?? 'start'} to ${maxDd.troughDate}; ${
                        maxDd.recoveryDate
                          ? `recovered ${maxDd.recoveryDate} (${maxDd.days} days)`
                          : `not recovered (${maxDd.days} days so far)`
                      }`
                    : 'The curve never fell below a previous high'}
                </p>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Net realized P&L</CardDescription>
                <CardTitle className={cn('text-2xl', pnlClass(summary.netPnl))}>
                  {formatCurrency(summary.netPnl)}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Profit factor</CardDescription>
                <CardTitle className="text-2xl">{ratio(summary.profitFactor)}</CardTitle>
                <p className="text-xs text-muted-foreground">Winning days over losing days</p>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Win days</CardDescription>
                <CardTitle className="text-2xl">{percent(summary.winRate)}</CardTitle>
                <p className="text-xs text-muted-foreground">
                  {summary.winDays} up, {summary.lossDays} down, of {summary.activeDays} days
                </p>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Average win / loss day</CardDescription>
                <CardTitle className="text-lg">
                  <span className="text-green-600">
                    {summary.avgWinDay === null ? '-' : formatCurrency(summary.avgWinDay)}
                  </span>
                  {' / '}
                  <span className="text-red-600">
                    {summary.avgLossDay === null ? '-' : formatCurrency(summary.avgLossDay)}
                  </span>
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Best / worst day</CardDescription>
                <CardTitle className="text-lg">
                  <span className="text-green-600">
                    {summary.bestDay ? formatCurrency(summary.bestDay.value) : '-'}
                  </span>
                  {' / '}
                  <span className="text-red-600">
                    {summary.worstDay ? formatCurrency(summary.worstDay.value) : '-'}
                  </span>
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  {summary.bestDay?.date} / {summary.worstDay?.date}
                </p>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Longest streak</CardDescription>
                <CardTitle className="text-lg">
                  {summary.longestWinStreak} up / {summary.longestLossStreak} down
                </CardTitle>
                <p className="text-xs text-muted-foreground">Consecutive days</p>
              </CardHeader>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div>
                <CardTitle>Cumulative P&L</CardTitle>
                <CardDescription>
                  Realized, by the day lots were closed. Click a name to show or hide a line.
                </CardDescription>
              </div>
              <fieldset className="m-0 flex min-w-0 gap-2 border-0 p-0" aria-label="Chart or table">
                <Button
                  size="sm"
                  variant={view === 'chart' ? 'default' : 'outline'}
                  onClick={() => setView('chart')}
                >
                  Chart
                </Button>
                <Button
                  size="sm"
                  variant={view === 'table' ? 'default' : 'outline'}
                  onClick={() => setView('table')}
                >
                  Table
                </Button>
              </fieldset>
            </CardHeader>
            <CardContent>
              {view === 'chart' ? (
                <>
                  <div className="flex flex-wrap gap-2 mb-4">
                    {lines.map((line) => {
                      const off = hidden.has(line.name)
                      const last = line.values[line.values.length - 1]
                      return (
                        <button
                          key={line.name}
                          type="button"
                          aria-pressed={!off}
                          onClick={() => toggleSeries(line.name)}
                          className={cn(
                            'flex items-center gap-2 rounded-full border px-3 py-1 text-sm transition-opacity',
                            off && 'opacity-40'
                          )}
                        >
                          <span
                            className="inline-block h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: line.color }}
                          />
                          <span>{line.name}</span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {formatCurrency(last)}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  <div className="relative">
                    <div ref={containerRef} style={{ height: CHART_HEIGHT }} />
                    {tooltip && (
                      <div
                        className="pointer-events-none absolute z-10 rounded-md border bg-popover px-3 py-2 text-xs shadow-md"
                        style={{
                          left: Math.min(tooltip.left + 16, (containerRef.current?.clientWidth ?? 600) - 220),
                          top: Math.max(tooltip.top - 20, 0),
                          minWidth: 190,
                        }}
                      >
                        <div className="mb-1 font-medium">{tooltip.date}</div>
                        {tooltip.rows.map((row) => (
                          <div key={row.name} className="flex items-center justify-between gap-4">
                            <span className="flex items-center gap-2">
                              <span
                                className="inline-block h-2 w-2 rounded-full"
                                style={{ backgroundColor: row.color }}
                              />
                              {row.name}
                            </span>
                            <span className="font-mono">{formatCurrency(row.value)}</span>
                          </div>
                        ))}
                        {tooltip.drawdown !== null && (
                          <div className="mt-1 flex justify-between gap-4 border-t pt-1 text-muted-foreground">
                            <span>Drawdown</span>
                            <span className="font-mono">{formatCurrency(tooltip.drawdown)}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Lower pane: drawdown of the total from its running high.
                  </p>
                </>
              ) : (
                <div className="max-h-[520px] overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead className="text-right">Day</TableHead>
                        <TableHead className="text-right">Cumulative</TableHead>
                        <TableHead className="text-right">Drawdown</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {series.dates.map((date, i) => (
                        <TableRow key={date}>
                          <TableCell>{date}</TableCell>
                          <TableCell className={cn('text-right font-medium', pnlClass(series.total[i]))}>
                            {formatCurrency(series.total[i])}
                          </TableCell>
                          <TableCell className={cn('text-right font-medium', pnlClass(totalCum[i]))}>
                            {formatCurrency(totalCum[i])}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">
                            {formatCurrency(totalDrawdown.series[i])}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>By strategy</CardTitle>
              <CardDescription>
                Each strategy judged on the days it closed something. Untagged covers imported and
                manual trades with no strategy.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Strategy</TableHead>
                      <TableHead className="text-right">Net P&L</TableHead>
                      <TableHead className="text-right">Max drawdown</TableHead>
                      <TableHead className="text-right">Win days</TableHead>
                      <TableHead className="text-right">Profit factor</TableHead>
                      <TableHead className="text-right">Active days</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {strategyRows.map((row) => (
                      <TableRow key={row.strategy}>
                        <TableCell>
                          <span className="flex items-center gap-2">
                            <span
                              className="inline-block h-2.5 w-2.5 rounded-full"
                              style={{ backgroundColor: colorOf(row.strategy) }}
                            />
                            {row.strategy}
                          </span>
                        </TableCell>
                        <TableCell className={cn('text-right font-medium', pnlClass(row.netPnl))}>
                          {formatCurrency(row.netPnl)}
                        </TableCell>
                        <TableCell className="text-right">{formatCurrency(row.maxDrawdown)}</TableCell>
                        <TableCell className="text-right">{percent(row.winRate)}</TableCell>
                        <TableCell className="text-right">{ratio(row.profitFactor)}</TableCell>
                        <TableCell className="text-right">{row.activeDays}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Monthly P&L</CardTitle>
              <CardDescription>Realized P&L by the month lots were closed</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Year</TableHead>
                      {MONTH_LABELS.map((label) => (
                        <TableHead key={label} className="text-right">
                          {label}
                        </TableHead>
                      ))}
                      <TableHead className="text-right">Year</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {monthlyRows.map((row) => (
                      <TableRow key={row.year}>
                        <TableCell className="font-medium">{row.year}</TableCell>
                        {row.months.map((value, i) => (
                          <TableCell
                            key={MONTH_LABELS[i]}
                            className="text-right font-mono text-xs"
                            style={{ backgroundColor: monthTint(value ?? 0, monthMaxAbs) }}
                          >
                            {value === null ? '' : formatCurrency(value)}
                          </TableCell>
                        ))}
                        <TableCell className={cn('text-right font-medium', pnlClass(row.total))}>
                          {formatCurrency(row.total)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
