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
import { ChevronDown, ChevronRight, Download, Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import type { PnlEmbeddedFilters } from '@/hooks/usePnlFilters'
import {
  type CurveData,
  type CurveLot,
  type CurveMode,
  cumulative,
  curveSeries,
  dailySeries,
  drawdown,
  foldCurveStrategies,
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

function thirtyDaysAgoStr(): string {
  const d = new Date()
  d.setDate(d.getDate() - 30)
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

const CURVE_PANE_HEIGHT = 400
const DRAWDOWN_PANE_HEIGHT = 120
const CHART_HEIGHT = CURVE_PANE_HEIGHT + DRAWDOWN_PANE_HEIGHT

// One toast after a fetch instead of a list that stays on the page.
function notifyCurveNotes(notes: CurveData['notes']) {
  const brief = (names: string[]) =>
    names.length > 4
      ? `${names.slice(0, 4).join(', ')} +${names.length - 4} more`
      : names.join(', ')
  const parts: string[] = []
  const orphanSymbols = Array.from(new Set(notes.orphan_sells.map((o) => o.symbol)))
  if (orphanSymbols.length > 0) {
    parts.push(
      `${orphanSymbols.length} symbols had a sell with no earlier buy in the ledger and were left out (${brief(orphanSymbols)})`
    )
  }
  if (notes.missing_close.length > 0) {
    parts.push(`no daily price for ${brief(notes.missing_close)}, held at cost`)
  }
  if (notes.calendar) parts.push(`trading days: ${notes.calendar}`)
  if (parts.length > 0) showToast.warning(parts.join('; '), 'system')
}

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

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

export default function PnlCurve({ embedded }: { embedded?: PnlEmbeddedFilters } = {}) {
  const { apiKey, user } = useAuthStore()
  const { mode } = useThemeStore()
  const isDark = mode === 'dark'
  const formatCurrency = useMemo(() => makeFormatCurrency(user?.broker), [user?.broker])
  const formatCurrencyRef = useRef(formatCurrency)
  formatCurrencyRef.current = formatCurrency

  const [localSegment, setSegment] = useState<'all' | Segment>('all')
  const [localStartDate, setStartDate] = useState(thirtyDaysAgoStr())
  const [localEndDate, setEndDate] = useState(todayStr())
  // Inside the merged P&L page the filters come from the shared bar.
  const segment = embedded ? embedded.segment : localSegment
  const startDate = embedded ? embedded.startDate : localStartDate
  const endDate = embedded ? embedded.endDate : localEndDate
  const [activeDatePreset, setActiveDatePreset] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [hasFetched, setHasFetched] = useState(false)
  const [lots, setLots] = useState<CurveLot[]>([])
  // Equity uses the daily realized + unrealized curve; every other segment
  // keeps the realized-only lots.
  const [curveData, setCurveData] = useState<CurveData | null>(null)
  const [localPnlType, setPnlType] = useState<CurveMode>('combined')
  const pnlType: CurveMode = embedded ? embedded.pnlType : localPnlType
  const [view, setView] = useState<'chart' | 'table'>('chart')
  // Series the user switched off in the legend. Colours follow the strategy,
  // so hiding one never repaints the rest.
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  // Lines switched off on the plot itself. Separate from `hidden`, which is the
  // strategy selection and drives the statistics; this only hides a line.
  const [hiddenLines, setHiddenLines] = useState<Set<string>>(new Set())
  const [strategiesOpen, setStrategiesOpen] = useState(true)
  const chartRef = useRef<IChartApi | null>(null)

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
      if (segment === 'equity') {
        const response = await tradingApi.getPnlCurve(apiKey, start, end, 'actual_cost')
        if (seq !== loadSeq.current) return
        if (response.status === 'success' && response.data) {
          setCurveData(response.data)
          setLots([])
          notifyCurveNotes(response.data.notes)
          setHasFetched(true)
        } else {
          showToast.error(response.message || 'Failed to load the P&L curve', 'system')
        }
      } else {
        const response = await tradingApi.getPnlHistory(apiKey, start, end, {
          segment: segment === 'all' ? undefined : segment,
        })
        if (seq !== loadSeq.current) return
        if (response.status === 'success' && response.data) {
          setCurveData(null)
          setLots(
            response.data.closed_trades.map((t) => ({
              exit_timestamp: t.exit_timestamp,
              realized_pnl: t.realized_pnl,
              strategy: t.strategy,
            }))
          )
          setHasFetched(true)
        } else {
          showToast.error(response.message || 'Failed to load P&L history', 'system')
        }
      }
    } catch {
      if (seq === loadSeq.current) showToast.error('Failed to load P&L history', 'system')
    } finally {
      if (seq === loadSeq.current) setIsLoading(false)
    }
  }

  // Embedded: fetch when the shared Fetch is clicked, and when this tab opens
  // after a fetch (the counter is already above zero then).
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the counter should trigger a fetch
  useEffect(() => {
    if (embedded && embedded.fetchToken > 0) fetchCurve()
  }, [embedded?.fetchToken])

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

  // Every strategy in the fetched range, regardless of the selection. Used for the
  // strategy chips, so an excluded strategy keeps its name, colour and own total.
  const curveFolded = useMemo(
    () => (curveData ? foldCurveStrategies(curveData.by_strategy, MAX_STRATEGY_SERIES) : null),
    [curveData]
  )
  // Strategy names in colour order, from whichever source is on screen.
  const orderedNames = curveFolded ? curveFolded.names : folded.names
  const curveMode: CurveMode = curveData ? pnlType : 'realized'
  const allSeries = useMemo(
    () =>
      curveData && curveFolded
        ? curveSeries(curveData.dates, curveFolded.byName, curveMode)
        : dailySeries(folded.lots),
    [curveData, curveFolded, curveMode, folded]
  )
  // The selection: a strategy in `hidden` is out of the total, the drawdown, the
  // statistics and both tables, not just off the chart.
  const activeLots = useMemo(
    () => folded.lots.filter((lot) => !hidden.has(strategyOf(lot))),
    [folded, hidden]
  )
  const series = useMemo(
    () =>
      curveData && curveFolded
        ? curveSeries(curveData.dates, curveFolded.byName, curveMode, (n) => !hidden.has(n))
        : dailySeries(activeLots),
    [curveData, curveFolded, curveMode, hidden, activeLots]
  )
  // Realized and unrealized of the selection, drawn beside Combined.
  const splitLines = useMemo(() => {
    if (!curveData || !curveFolded || curveMode !== 'combined') return null
    const include = (n: string) => !hidden.has(n)
    return {
      realized: cumulative(
        curveSeries(curveData.dates, curveFolded.byName, 'realized', include).total
      ),
      unrealized: cumulative(
        curveSeries(curveData.dates, curveFolded.byName, 'unrealized', include).total
      ),
    }
  }, [curveData, curveFolded, curveMode, hidden])
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
    orderedNames.forEach((name, i) => {
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
    if (splitLines) {
      out.push({ name: 'Realized', color: '#16a34a', width: 2, values: splitLines.realized })
      out.push({ name: 'Unrealized', color: '#d97706', width: 2, values: splitLines.unrealized })
    }
    return out
  }, [series, totalCum, orderedNames, isDark, splitLines])

  // One chip per strategy in the fetched range, in the same order and colours as the
  // lines. The Total chip is the total of the selection.
  const chips = useMemo(() => {
    const palette = isDark ? SERIES_COLORS.dark : SERIES_COLORS.light
    const ink = isDark ? INK.dark : INK.light
    const last = (daily: number[] | undefined) => {
      if (!daily) return 0
      const cum = cumulative(daily)
      return cum.length ? cum[cum.length - 1] : 0
    }
    const out: { name: string; color: string; value: number }[] = []
    orderedNames.forEach((name, i) => {
      out.push({ name, color: palette[i], value: last(allSeries.byStrategy.get(name)) })
    })
    for (const [name, color] of [
      [OTHER, ink.other],
      [UNTAGGED, ink.untagged],
    ] as const) {
      if (allSeries.byStrategy.has(name)) {
        out.push({ name, color, value: last(allSeries.byStrategy.get(name)) })
      }
    }
    return out
  }, [allSeries, orderedNames, isDark])

  const strategyNames = chips.filter((c) => c.name !== TOTAL).map((c) => c.name)

  const chartHeight = CHART_HEIGHT

  const colorOf = (name: string): string =>
    lines.find((l) => l.name === name)?.color ?? INK.light.untagged

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
      height: chartHeight,
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
      if (hiddenLines.has(line.name)) continue
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
    panes[0]?.setHeight(CURVE_PANE_HEIGHT)
    panes[1]?.setHeight(DRAWDOWN_PANE_HEIGHT)
    chartRef.current = chart
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
      chartRef.current = null
      setTooltip(null)
    }
  }, [lines, hiddenLines, view, isDark, totalDrawdown])

  const toggleSeries = (name: string) =>
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const selectAllStrategies = () =>
    setHidden((prev) => (prev.has(TOTAL) ? new Set([TOTAL]) : new Set()))
  const clearAllStrategies = () => setHidden((prev) => new Set([...prev, ...strategyNames]))

  const toggleLine = (name: string) =>
    setHiddenLines((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  // Alt+R: every strategy back in, every line back on, zoom back to the whole range.
  const resetPlot = useCallback(() => {
    setHidden(new Set())
    setHiddenLines(new Set())
    setTooltip(null)
    chartRef.current?.timeScale().fitContent()
  }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'r') {
        event.preventDefault()
        resetPlot()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [resetPlot])

  // Save the chart as a PNG: the plot, the drawdown pane and a legend band drawn on top.
  const downloadImage = () => {
    const chart = chartRef.current
    if (!chart) return
    try {
      const shot = chart.takeScreenshot()
      const entries = lines.filter((l) => !hiddenLines.has(l.name))
      const band = 56
      const out = document.createElement('canvas')
      out.width = shot.width
      out.height = shot.height + band
      const ctx = out.getContext('2d')
      if (!ctx) return
      ctx.fillStyle = isDark ? '#0b0b0b' : '#ffffff'
      ctx.fillRect(0, 0, out.width, out.height)
      ctx.fillStyle = isDark ? '#ffffff' : '#0b0b0b'
      ctx.font = 'bold 16px sans-serif'
      ctx.fillText(`P&L curve  ${startDate} to ${endDate}  (${curveMode})`, 12, 22)
      ctx.font = '13px sans-serif'
      let x = 12
      for (const entry of entries) {
        ctx.fillStyle = entry.color
        ctx.fillRect(x, 36, 10, 10)
        ctx.fillStyle = isDark ? '#c3c2b7' : '#52514e'
        const label = `${entry.name}  ${formatCurrency(entry.values[entry.values.length - 1] ?? 0)}`
        ctx.fillText(label, x + 16, 46)
        x += 16 + ctx.measureText(label).width + 18
      }
      ctx.drawImage(shot, 0, band)
      out.toBlob((blob) => {
        if (!blob) return
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = `PnL_Curve_${new Date().toISOString().slice(0, 10)}.png`
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        URL.revokeObjectURL(url)
        showToast.success('Chart saved', 'system')
      }, 'image/png')
    } catch {
      showToast.error('Could not save the chart image', 'system')
    }
  }

  // Realized so far and the open level at the end, for the selection, whatever
  // the P&L type shown.
  const splitTotals = useMemo(() => {
    if (!curveData || !curveFolded) return null
    const include = (n: string) => !hidden.has(n)
    const realizedTotal = curveSeries(
      curveData.dates,
      curveFolded.byName,
      'realized',
      include
    ).total.reduce((a, b) => a + b, 0)
    const level = cumulative(
      curveSeries(curveData.dates, curveFolded.byName, 'unrealized', include).total
    )
    return { realized: realizedTotal, unrealized: level.length ? level[level.length - 1] : 0 }
  }, [curveData, curveFolded, hidden])

  const pnlClass = (value: number) => (value >= 0 ? 'text-green-600' : 'text-red-600')
  const maxDd = totalDrawdown.max
  const monthMaxAbs = Math.max(
    0,
    ...monthlyRows.flatMap((r) => r.months.map((m) => Math.abs(m ?? 0)))
  )

  return (
    <div className="space-y-6">
      {!embedded && (
        <div>
          <h1 className="text-3xl font-bold tracking-tight">P&L Curve</h1>
          <p className="text-muted-foreground">
            Cumulative realized P&L by the day trades were closed out, per strategy
          </p>
        </div>
      )}

      {!embedded && (
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
                <Select
                  value={segment === 'equity' ? pnlType : 'realized'}
                  onValueChange={(v) => setPnlType(v as CurveMode)}
                >
                  <SelectTrigger id="curve-pnl-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="realized">Realized</SelectItem>
                    <SelectItem value="unrealized" disabled={segment !== 'equity'}>
                      Unrealized
                    </SelectItem>
                    <SelectItem value="combined" disabled={segment !== 'equity'}>
                      Combined
                    </SelectItem>
                  </SelectContent>
                </Select>
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
              Equity: realized is booked on the day a lot is sold; unrealized is the open lots at
              each day's close. Other segments show realized only. Corporate actions are not
              adjusted for.
            </p>
          </CardContent>
        </Card>
      )}

      {!hasFetched && !isLoading && (
        <div className="text-center py-16 text-muted-foreground">
          <p className="font-medium">Build a report</p>
          <p className="text-sm">Pick a date range above and click Fetch</p>
        </div>
      )}

      {hasFetched && allSeries.dates.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          No closed trades in this date range
        </div>
      )}

      {hasFetched && allSeries.dates.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                className="flex items-start gap-2 text-left"
                onClick={() => setStrategiesOpen((open) => !open)}
                aria-expanded={strategiesOpen}
              >
                {strategiesOpen ? (
                  <ChevronDown className="mt-1 h-4 w-4" />
                ) : (
                  <ChevronRight className="mt-1 h-4 w-4" />
                )}
                <span>
                  <CardTitle className="text-base">Strategies</CardTitle>
                  <CardDescription>
                    Click a name to include or exclude it. The chart, drawdown, statistics and
                    tables all follow the selection.
                  </CardDescription>
                </span>
              </button>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={selectAllStrategies}>
                  All
                </Button>
                <Button size="sm" variant="outline" onClick={clearAllStrategies}>
                  None
                </Button>
              </div>
            </div>
          </CardHeader>
          {strategiesOpen && (
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {chips.map((chip) => {
                  const off = hidden.has(chip.name)
                  return (
                    <button
                      key={chip.name}
                      type="button"
                      aria-pressed={!off}
                      onClick={() => toggleSeries(chip.name)}
                      className={cn(
                        'flex items-center gap-2 rounded-full border px-3 py-1 text-sm transition-opacity',
                        off && 'opacity-40'
                      )}
                    >
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: chip.color }}
                      />
                      <span>{chip.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {formatCurrency(chip.value)}
                      </span>
                    </button>
                  )
                })}
              </div>
              {strategyRows.length > 0 && (
                <div className="overflow-x-auto">
                  <p className="mb-2 text-xs text-muted-foreground">
                    Each strategy judged on the days it closed something. Untagged covers imported
                    and manual trades with no strategy.
                  </p>
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
                          <TableCell className="text-right">
                            {formatCurrency(row.maxDrawdown)}
                          </TableCell>
                          <TableCell className="text-right">{percent(row.winRate)}</TableCell>
                          <TableCell className="text-right">{ratio(row.profitFactor)}</TableCell>
                          <TableCell className="text-right">{row.activeDays}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          )}
        </Card>
      )}

      {hasFetched && allSeries.dates.length > 0 && series.dates.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          No strategy is selected. Pick at least one above.
        </div>
      )}

      {hasFetched && series.dates.length > 0 && (
        <>
          {/* Headline numbers: Net P&L first, split into realized and unrealized. */}
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Net P&L</CardDescription>
                <CardTitle className={cn('text-3xl', pnlClass(summary.netPnl))}>
                  {formatCurrency(summary.netPnl)}
                </CardTitle>
                {splitTotals && (
                  <div className="mt-1 flex flex-wrap gap-x-6 gap-y-1 text-sm">
                    <span>
                      <span className="text-muted-foreground">Realized </span>
                      <span className={cn('font-medium', pnlClass(splitTotals.realized))}>
                        {formatCurrency(splitTotals.realized)}
                      </span>
                    </span>
                    <span>
                      <span className="text-muted-foreground">Unrealized </span>
                      <span className={cn('font-medium', pnlClass(splitTotals.unrealized))}>
                        {formatCurrency(splitTotals.unrealized)}
                      </span>
                    </span>
                  </div>
                )}
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Max drawdown</CardDescription>
                <CardTitle className="text-3xl">{formatCurrency(maxDd.depth)}</CardTitle>
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
          </div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
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
                <CardDescription>Profit factor</CardDescription>
                <CardTitle className="text-2xl">{ratio(summary.profitFactor)}</CardTitle>
                <p className="text-xs text-muted-foreground">Winning days over losing days</p>
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
                <p className="text-xs text-muted-foreground">
                  Longest streak {summary.longestWinStreak} up / {summary.longestLossStreak} down
                </p>
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
          </div>

          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div>
                <CardTitle>Cumulative P&L</CardTitle>
                <CardDescription>
                  {curveData
                    ? 'Click a name on the plot to show or hide a line. Alt+R resets.'
                    : 'Realized, by the day lots were closed, for the selected strategies.'}
                </CardDescription>
              </div>
              <fieldset className="m-0 flex min-w-0 gap-2 border-0 p-0" aria-label="Chart or table">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={downloadImage}
                  disabled={view !== 'chart'}
                  aria-label="Download the chart as an image"
                >
                  <Download className="h-4 w-4" />
                </Button>
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
                  <div className="relative">
                    <div ref={containerRef} style={{ height: chartHeight }} />
                    <div className="absolute left-2 top-2 z-10 flex max-w-[85%] flex-wrap gap-1">
                      {lines.map((line) => {
                        const off = hiddenLines.has(line.name)
                        return (
                          <button
                            key={line.name}
                            type="button"
                            aria-pressed={!off}
                            onClick={() => toggleLine(line.name)}
                            className={cn(
                              'flex items-center gap-1.5 rounded-full border bg-background/80 px-2 py-0.5 text-xs backdrop-blur-sm transition-opacity',
                              off && 'opacity-40'
                            )}
                          >
                            <span
                              className="inline-block h-2 w-2 rounded-full"
                              style={{ backgroundColor: line.color }}
                            />
                            {line.name}
                          </button>
                        )
                      })}
                    </div>
                    {tooltip && (
                      <div
                        className="pointer-events-none absolute z-10 rounded-md border bg-popover px-3 py-2 text-xs shadow-md"
                        style={{
                          left: Math.min(
                            tooltip.left + 16,
                            (containerRef.current?.clientWidth ?? 600) - 220
                          ),
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
                    Lower pane: drawdown of the combined curve from its running high.
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
                          <TableCell
                            className={cn('text-right font-medium', pnlClass(series.total[i]))}
                          >
                            {formatCurrency(series.total[i])}
                          </TableCell>
                          <TableCell
                            className={cn('text-right font-medium', pnlClass(totalCum[i]))}
                          >
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
