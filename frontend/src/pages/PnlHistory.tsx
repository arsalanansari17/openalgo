// frontend/src/pages/PnlHistory.tsx
/**
 * Consolidated multi-day P&L report (fork-only feature, see openalgo's
 * SKYSHIELD_PATCHES.md and docs/design/56-pnl-history). Modeled on Zerodha
 * Console's own Tradebook/P&L report pair under "Reports" - date range in,
 * FIFO-matched realized P&L out, plus unrealized P&L on the positions still
 * open at the live LTP. Nothing here is precomputed: every fetch re-runs
 * utils/pnl_fifo.py server-side against the raw fill ledger (compute-on-read,
 * same philosophy as the built-in intraday PnL Tracker).
 */
import { Download, Loader2, RefreshCw, Settings2, TrendingDown, TrendingUp } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import type {
  PnlHistoryClosedTrade,
  PnlHistoryOpenPosition,
} from '@/api/trading'
import { tradingApi } from '@/api/trading'
import { CalendarHeatmap, type CalendarHeatmapDay } from '@/components/reports/CalendarHeatmap'
import { DateRangePresets } from '@/components/reports/DateRangePresets'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn, makeFormatCurrency, sanitizeCSV } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'
import type { Segment } from '@/types/trading'
import { showToast } from '@/utils/toast'

type PnlMode = 'combined' | 'realized' | 'unrealized'

const PNL_MODE_LABEL: Record<PnlMode, string> = {
  combined: 'Combined',
  realized: 'Realized P&L',
  unrealized: 'Unrealized P&L',
}

function defaultStartDate(): string {
  const d = new Date()
  d.setDate(d.getDate() - 30)
  return d.toISOString().split('T')[0]
}

function defaultEndDate(): string {
  return new Date().toISOString().split('T')[0]
}

interface DayRow {
  date: string
  realized: number
  unrealized: number | null
  cumulative: number
}

interface ScripRow {
  key: string
  symbol: string
  exchange: string
  product: string | null
  // Closed-lot side
  closedQuantity: number
  buyValue: number
  sellValue: number
  realized: number
  // Open-position side
  openQuantity: number
  averagePrice: number | null
  ltp: number | null
  unrealized: number | null
  cumulative: number
}

// Green/red-by-realized-P&L, matching Zerodha Console's own P&L heat map:
// lighter shades for smaller swings, darker for larger ones, gray for a
// day with closed trades that netted exactly zero.
function pnlHeatColor(value: number, maxAbs: number): string {
  if (value === 0) return 'rgba(148, 163, 184, 0.3)'
  const intensity = Math.min(Math.abs(value) / maxAbs, 1)
  const alpha = 0.15 + intensity * 0.75
  return value > 0 ? `rgba(34, 197, 94, ${alpha})` : `rgba(239, 68, 68, ${alpha})`
}

function scripKey(symbol: string, exchange: string, product: string | null): string {
  return `${symbol}|${exchange}|${product ?? ''}`
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

export default function PnlHistory() {
  const { apiKey, user } = useAuthStore()
  const formatCurrency = makeFormatCurrency(user?.broker)

  // Applied fetch parameters. The Fetch dialog edits drafts (d*) and applies
  // them together, so nothing changes until the user clicks Fetch there.
  const [segment, setSegment] = useState<'all' | Segment>('all')
  const [startDate, setStartDate] = useState(defaultStartDate())
  const [endDate, setEndDate] = useState(defaultEndDate())
  const [pnlMode, setPnlMode] = useState<PnlMode>('combined')

  const [fetchOpen, setFetchOpen] = useState(false)
  const [dSegment, setDSegment] = useState<'all' | Segment>('all')
  const [dStart, setDStart] = useState(startDate)
  const [dEnd, setDEnd] = useState(endDate)
  const [dMode, setDMode] = useState<PnlMode>('combined')
  const [activeDatePreset, setActiveDatePreset] = useState<string | null>(null)

  const [isLoading, setIsLoading] = useState(false)
  const [hasFetched, setHasFetched] = useState(false)
  const [closedTrades, setClosedTrades] = useState<PnlHistoryClosedTrade[]>([])
  const [openPositions, setOpenPositions] = useState<PnlHistoryOpenPosition[]>([])
  // null when the range ends before today (unrealized P&L exists only at the
  // live LTP) or when the quotes could not be fetched.
  const [unrealizedAvailable, setUnrealizedAvailable] = useState(false)
  const [view, setView] = useState<'day' | 'scrip'>('day')

  // Table filters (client-side, applied to whichever table is showing).
  const [filterOpen, setFilterOpen] = useState(false)
  const [symbolFilter, setSymbolFilter] = useState('')
  const [exchangeFilter, setExchangeFilter] = useState<string[]>([])
  const [productFilter, setProductFilter] = useState<string[]>([])

  const showRealized = pnlMode !== 'unrealized'
  const showUnrealized = pnlMode !== 'realized'

  const loadHistory = async (start: string, end: string, seg: 'all' | Segment) => {
    if (!apiKey) {
      showToast.error('API key not available', 'system')
      return
    }
    if (!start || !end) {
      showToast.warning('Select both a start and end date', 'system')
      return
    }

    setIsLoading(true)
    try {
      const response = await tradingApi.getPnlHistory(apiKey, start, end, {
        segment: seg === 'all' ? undefined : seg,
      })
      if (response.status === 'success' && response.data) {
        setClosedTrades(response.data.closed_trades)
        setOpenPositions(response.data.open_positions)
        setUnrealizedAvailable(response.data.total_unrealized_pnl != null)
        setHasFetched(true)
      } else {
        showToast.error(response.message || 'Failed to load P&L history', 'system')
      }
    } catch {
      showToast.error('Failed to load P&L history', 'system')
    } finally {
      setIsLoading(false)
    }
  }

  const applyFetch = () => {
    setSegment(dSegment)
    setStartDate(dStart)
    setEndDate(dEnd)
    setPnlMode(dMode)
    setFetchOpen(false)
    loadHistory(dStart, dEnd, dSegment)
  }

  const handleDatePresetSelect = (start: string, end: string, key: string) => {
    setDStart(start)
    setDEnd(end)
    setActiveDatePreset(key)
  }

  // Filter options come from whatever the report returned.
  const exchangeOptions = useMemo(
    () =>
      Array.from(
        new Set([...closedTrades.map((t) => t.exchange), ...openPositions.map((p) => p.exchange)])
      ).sort(),
    [closedTrades, openPositions]
  )
  const productOptions = useMemo(
    () =>
      Array.from(
        new Set(
          [...closedTrades.map((t) => t.product), ...openPositions.map((p) => p.product)].filter(
            (p): p is string => !!p
          )
        )
      ).sort(),
    [closedTrades, openPositions]
  )

  const hasActiveFilters =
    symbolFilter.trim() !== '' || exchangeFilter.length > 0 || productFilter.length > 0

  const clearFilters = () => {
    setSymbolFilter('')
    setExchangeFilter([])
    setProductFilter([])
  }

  const matchesFilters = useCallback(
    (symbol: string, exchange: string, product: string | null) => {
      if (symbolFilter.trim() && !symbol.toUpperCase().includes(symbolFilter.trim().toUpperCase()))
        return false
      if (exchangeFilter.length > 0 && !exchangeFilter.includes(exchange)) return false
      if (productFilter.length > 0 && !(product && productFilter.includes(product))) return false
      return true
    },
    [symbolFilter, exchangeFilter, productFilter]
  )

  const filteredClosed = useMemo(
    () => closedTrades.filter((t) => matchesFilters(t.symbol, t.exchange, t.product)),
    [closedTrades, matchesFilters]
  )
  const filteredOpen = useMemo(
    () => openPositions.filter((p) => matchesFilters(p.symbol, p.exchange, p.product)),
    [openPositions, matchesFilters]
  )

  const totalRealized = filteredClosed.reduce((sum, t) => sum + t.realized_pnl, 0)
  const totalUnrealized = filteredOpen.reduce((sum, p) => sum + (p.unrealized_pnl ?? 0), 0)
  const unquotedCount = filteredOpen.filter((p) => p.unrealized_pnl == null).length

  // Day-wise: realized by the day a lot closed. Unrealized exists only at
  // the live LTP, so it lands on the most recent date (the end date) and
  // every earlier row has none.
  const dayRows: DayRow[] = useMemo(() => {
    const byDate = new Map<string, number>()
    for (const t of filteredClosed) {
      const date = t.exit_timestamp.slice(0, 10)
      byDate.set(date, (byDate.get(date) ?? 0) + t.realized_pnl)
    }
    const latestUnrealized = unrealizedAvailable ? totalUnrealized : null
    if (showUnrealized && latestUnrealized !== null && !byDate.has(endDate)) {
      byDate.set(endDate, 0)
    }
    const dates = Array.from(byDate.keys()).sort()
    let running = 0
    return dates.map((date) => {
      const realized = byDate.get(date) ?? 0
      const unrealized = showUnrealized && date === endDate ? latestUnrealized : null
      running += (showRealized ? realized : 0) + (unrealized ?? 0)
      return { date, realized, unrealized, cumulative: running }
    })
  }, [filteredClosed, unrealizedAvailable, totalUnrealized, showRealized, showUnrealized, endDate])

  // In Unrealized mode only the live row is meaningful.
  const visibleDayRows = showRealized ? dayRows : dayRows.filter((r) => r.unrealized !== null)

  // Scrip-wise: every closed lot and open position merged by symbol,
  // exchange and product, matching the Scrip-wise aggregation every broker's
  // own P&L report uses. `entry_action` tells direction per lot - a BUY
  // entry closed by a sell is a long (buy value = entry leg, sell value =
  // exit leg); a SELL entry closed by a buy is a short (reversed).
  const scripRows: ScripRow[] = useMemo(() => {
    const rows = new Map<string, ScripRow>()
    const blank = (symbol: string, exchange: string, product: string | null): ScripRow => ({
      key: scripKey(symbol, exchange, product),
      symbol,
      exchange,
      product,
      closedQuantity: 0,
      buyValue: 0,
      sellValue: 0,
      realized: 0,
      openQuantity: 0,
      averagePrice: null,
      ltp: null,
      unrealized: null,
      cumulative: 0,
    })
    if (showRealized) {
      for (const t of filteredClosed) {
        const key = scripKey(t.symbol, t.exchange, t.product)
        const row = rows.get(key) ?? blank(t.symbol, t.exchange, t.product)
        const isLong = t.entry_action === 'BUY'
        row.closedQuantity += t.quantity
        row.buyValue += t.quantity * (isLong ? t.entry_price : t.exit_price)
        row.sellValue += t.quantity * (isLong ? t.exit_price : t.entry_price)
        row.realized += t.realized_pnl
        rows.set(key, row)
      }
    }
    if (showUnrealized) {
      for (const p of filteredOpen) {
        const key = scripKey(p.symbol, p.exchange, p.product)
        const row = rows.get(key) ?? blank(p.symbol, p.exchange, p.product)
        row.openQuantity += p.quantity
        row.averagePrice = p.average_price
        row.ltp = p.ltp
        row.unrealized = p.unrealized_pnl
        rows.set(key, row)
      }
    }
    return Array.from(rows.values())
      .map((row) => ({
        ...row,
        cumulative: (showRealized ? row.realized : 0) + (showUnrealized ? (row.unrealized ?? 0) : 0),
      }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol))
  }, [filteredClosed, filteredOpen, showRealized, showUnrealized])

  const heatmapDays: CalendarHeatmapDay[] = useMemo(
    () =>
      dayRows.map((row) => ({
        date: row.date,
        value: row.realized,
        tooltip: `${row.date}: ${formatCurrency(row.realized)}`,
      })),
    [dayRows, formatCurrency]
  )

  const pnlClass = (value: number) => (value >= 0 ? 'text-green-600' : 'text-red-600')

  const exportToCSV = () => {
    const isDay = view === 'day'
    const hasRows = isDay ? visibleDayRows.length > 0 : scripRows.length > 0
    if (!hasRows) {
      showToast.error('No data to export', 'system')
      return
    }
    try {
      let headers: string[]
      let rows: (string | number)[][]
      if (isDay) {
        headers = [
          'Date',
          ...(showRealized ? ['Realized P&L'] : []),
          ...(showUnrealized ? ['Unrealized P&L'] : []),
          'Cumulative',
        ]
        rows = visibleDayRows.map((r) => [
          r.date,
          ...(showRealized ? [r.realized.toFixed(2)] : []),
          ...(showUnrealized ? [r.unrealized == null ? '' : r.unrealized.toFixed(2)] : []),
          r.cumulative.toFixed(2),
        ])
      } else {
        headers = [
          'Symbol',
          'Exchange',
          'Product',
          ...(showRealized ? ['Closed Qty', 'Buy Value', 'Sell Value', 'Realized P&L'] : []),
          ...(showUnrealized ? ['Open Qty', 'Avg Price', 'LTP', 'Unrealized P&L'] : []),
          'Cumulative',
        ]
        rows = scripRows.map((r) => [
          r.symbol,
          r.exchange,
          r.product ?? '',
          ...(showRealized
            ? [r.closedQuantity, r.buyValue.toFixed(2), r.sellValue.toFixed(2), r.realized.toFixed(2)]
            : []),
          ...(showUnrealized
            ? [
                r.openQuantity,
                r.averagePrice == null ? '' : r.averagePrice.toFixed(2),
                r.ltp == null ? '' : r.ltp.toFixed(2),
                r.unrealized == null ? '' : r.unrealized.toFixed(2),
              ]
            : []),
          r.cumulative.toFixed(2),
        ])
      }
      const csv = [headers, ...rows.map((row) => row.map((c) => sanitizeCSV(c)))]
        .map((row) => row.join(','))
        .join('\n')
      const blob = new Blob([csv], { type: 'text/csv' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const filename = `pnl_${isDay ? 'daywise' : 'scripwise'}_${startDate}_${endDate}.csv`
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      showToast.success(`Downloaded ${filename}`, 'clipboard')
    } catch {
      showToast.error('Failed to export CSV', 'system')
    }
  }

  const FilterChip = ({
    options,
    selected,
    onToggle,
  }: {
    options: string[]
    selected: string[]
    onToggle: (value: string) => void
  }) => (
    <div className="flex flex-wrap gap-2">
      {options.map((name) => (
        <Button
          key={name}
          type="button"
          size="sm"
          variant={selected.includes(name) ? 'default' : 'outline'}
          className={cn('rounded-full', selected.includes(name) && 'bg-pink-500 hover:bg-pink-600')}
          onClick={() => onToggle(name)}
        >
          {name}
        </Button>
      ))}
    </div>
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">P&L History</h1>
          <p className="text-muted-foreground">
            Realized and unrealized profit and loss across a date range, backfilled from your daily
            trade history
          </p>
        </div>
      </div>

      {/* Fetch: date range, Segment and P&L type apply together on Fetch. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {startDate} to {endDate}
          {segment !== 'all' && ` | ${segment}`}
          {` | ${PNL_MODE_LABEL[pnlMode]}`}
        </p>
        <Dialog
          open={fetchOpen}
          onOpenChange={(open) => {
            if (open) {
              setDSegment(segment)
              setDStart(startDate)
              setDEnd(endDate)
              setDMode(pnlMode)
              setActiveDatePreset(null)
            }
            setFetchOpen(open)
          }}
        >
          <DialogTrigger asChild>
            <Button disabled={isLoading} aria-label="Open fetch options">
              {isLoading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Fetch
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Fetch P&L</DialogTitle>
              <DialogDescription>
                Choose the date range and which P&L to show, then fetch.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label htmlFor="pnl-start-date">Start date</Label>
                  <Input
                    id="pnl-start-date"
                    type="date"
                    value={dStart}
                    max={dEnd}
                    onChange={(e) => {
                      setDStart(e.target.value)
                      setActiveDatePreset(null)
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="pnl-end-date">End date</Label>
                  <Input
                    id="pnl-end-date"
                    type="date"
                    value={dEnd}
                    min={dStart}
                    max={defaultEndDate()}
                    onChange={(e) => {
                      setDEnd(e.target.value)
                      setActiveDatePreset(null)
                    }}
                  />
                </div>
              </div>
              <DateRangePresets activeKey={activeDatePreset} onSelect={handleDatePresetSelect} />
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label htmlFor="pnl-segment">Segment</Label>
                  <Select value={dSegment} onValueChange={(v) => setDSegment(v as typeof dSegment)}>
                    <SelectTrigger id="pnl-segment">
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
                <div className="space-y-1">
                  <Label htmlFor="pnl-mode">P&L</Label>
                  <Select value={dMode} onValueChange={(v) => setDMode(v as PnlMode)}>
                    <SelectTrigger id="pnl-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="combined">Combined</SelectItem>
                      <SelectItem value="realized">Realized P&L</SelectItem>
                      <SelectItem value="unrealized">Unrealized P&L</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Realized counts only booked positions. Unrealized counts only positions still open,
                at the live price, so it is available only when the end date is today.
              </p>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setFetchOpen(false)}>
                Cancel
              </Button>
              <Button onClick={applyFetch}>Fetch</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {!hasFetched && !isLoading && (
        <div className="text-center py-16 text-muted-foreground">
          <p className="font-medium">Build a report</p>
          <p className="text-sm">Click Fetch and pick a date range</p>
        </div>
      )}

      {hasFetched && (
        <>
          {/* Summary Cards */}
          <div className={cn('grid gap-4', showRealized && showUnrealized && 'md:grid-cols-2')}>
            {showRealized && (
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Total Realized P&L</CardDescription>
                  <CardTitle
                    className={cn('text-2xl flex items-center gap-2', pnlClass(totalRealized))}
                  >
                    {totalRealized >= 0 ? (
                      <TrendingUp className="h-5 w-5" />
                    ) : (
                      <TrendingDown className="h-5 w-5" />
                    )}
                    {formatCurrency(totalRealized)}
                  </CardTitle>
                </CardHeader>
              </Card>
            )}
            {showUnrealized && (
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Total Unrealized P&L</CardDescription>
                  {unrealizedAvailable ? (
                    <>
                      <CardTitle
                        className={cn(
                          'text-2xl flex items-center gap-2',
                          pnlClass(totalUnrealized)
                        )}
                      >
                        {totalUnrealized >= 0 ? (
                          <TrendingUp className="h-5 w-5" />
                        ) : (
                          <TrendingDown className="h-5 w-5" />
                        )}
                        {formatCurrency(totalUnrealized)}
                      </CardTitle>
                      {unquotedCount > 0 && (
                        <p className="text-xs text-muted-foreground">
                          {unquotedCount} open position{unquotedCount === 1 ? '' : 's'} without a
                          live price left out
                        </p>
                      )}
                    </>
                  ) : (
                    <CardTitle className="text-base font-normal text-muted-foreground">
                      Not available - needs an end date of today and live prices
                    </CardTitle>
                  )}
                </CardHeader>
              </Card>
            )}
          </div>

          {/* Heat Map, matching Zerodha Console's own P&L report - a
              calendar grid colored green/red by that day's realized P&L,
              shade intensity scaled to magnitude. Hidden in Unrealized
              mode, which has no per-day history. */}
          {showRealized && heatmapDays.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Heat Map</CardTitle>
                <CardDescription>
                  Daily realized P&L - darker means a larger profit or loss. Hover a day for
                  details.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto pb-2">
                  <CalendarHeatmap
                    days={heatmapDays}
                    startDate={startDate}
                    endDate={endDate}
                    colorFor={pnlHeatColor}
                  />
                </div>
                <div className="flex items-center gap-2 mt-4 text-xs text-muted-foreground">
                  <span>Loss</span>
                  <span
                    className="w-4 h-4 rounded-sm"
                    style={{ backgroundColor: 'rgba(239, 68, 68, 0.9)' }}
                  />
                  <span
                    className="w-4 h-4 rounded-sm"
                    style={{ backgroundColor: 'rgba(239, 68, 68, 0.3)' }}
                  />
                  <span
                    className="w-4 h-4 rounded-sm"
                    style={{ backgroundColor: 'rgba(148, 163, 184, 0.3)' }}
                  />
                  <span
                    className="w-4 h-4 rounded-sm"
                    style={{ backgroundColor: 'rgba(34, 197, 94, 0.3)' }}
                  />
                  <span
                    className="w-4 h-4 rounded-sm"
                    style={{ backgroundColor: 'rgba(34, 197, 94, 0.9)' }}
                  />
                  <span>Profit</span>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Table toolbar: the Day-wise / Scrip-wise toggle on the left,
              Filter and Export on the right. Both act on whichever table is
              showing, so they sit directly above it. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Tabs value={view} onValueChange={(v) => setView(v as typeof view)}>
              <TabsList>
                <TabsTrigger value="day">Day-wise</TabsTrigger>
                <TabsTrigger value="scrip">Scrip-wise</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="flex items-center gap-2">
              <Dialog open={filterOpen} onOpenChange={setFilterOpen}>
                <DialogTrigger asChild>
                  <Button
                    variant={hasActiveFilters ? 'default' : 'outline'}
                    size="sm"
                    className="relative"
                    aria-label="Open table filters"
                  >
                    <Settings2 className="h-4 w-4 mr-2" />
                    Filters
                    {hasActiveFilters && (
                      <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-red-500 rounded-full" />
                    )}
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-md">
                  <DialogHeader>
                    <DialogTitle>Table Filters</DialogTitle>
                    <DialogDescription>
                      Narrow the Day-wise and Scrip-wise tables by symbol, exchange or product
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-6 py-4">
                    <div className="space-y-2">
                      <Label htmlFor="pnl-filter-symbol">Symbol</Label>
                      <Input
                        id="pnl-filter-symbol"
                        placeholder="e.g. INFY"
                        value={symbolFilter}
                        onChange={(e) => setSymbolFilter(e.target.value)}
                      />
                    </div>
                    {exchangeOptions.length > 0 && (
                      <div className="space-y-2">
                        <Label>Exchange</Label>
                        <FilterChip
                          options={exchangeOptions}
                          selected={exchangeFilter}
                          onToggle={(v) => setExchangeFilter((prev) => toggle(prev, v))}
                        />
                      </div>
                    )}
                    {productOptions.length > 0 && (
                      <div className="space-y-2">
                        <Label>Product</Label>
                        <FilterChip
                          options={productOptions}
                          selected={productFilter}
                          onToggle={(v) => setProductFilter((prev) => toggle(prev, v))}
                        />
                      </div>
                    )}
                  </div>
                  <DialogFooter>
                    <Button variant="ghost" onClick={clearFilters}>
                      Clear All
                    </Button>
                    <Button onClick={() => setFilterOpen(false)}>Done</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              <Button
                variant="outline"
                size="sm"
                onClick={exportToCSV}
                aria-label="Export the table to CSV"
              >
                <Download className="h-4 w-4 mr-2" />
                Export
              </Button>
            </div>
          </div>

          {view === 'day' ? (
            <Card>
              <CardHeader>
                <CardTitle>Daily Breakdown</CardTitle>
                <CardDescription>
                  Realized P&L by the day it was closed out
                  {showUnrealized && '; unrealized P&L on open positions appears on the latest day'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {visibleDayRows.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8">
                    No matching trades in this date range
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        {showRealized && <TableHead className="text-right">Realized P&L</TableHead>}
                        {showUnrealized && (
                          <TableHead className="text-right">Unrealized P&L</TableHead>
                        )}
                        <TableHead className="text-right">Cumulative</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleDayRows.map((row) => (
                        <TableRow key={row.date}>
                          <TableCell>{row.date}</TableCell>
                          {showRealized && (
                            <TableCell className={cn('text-right font-medium', pnlClass(row.realized))}>
                              {formatCurrency(row.realized)}
                            </TableCell>
                          )}
                          {showUnrealized && (
                            <TableCell
                              className={cn(
                                'text-right font-medium',
                                row.unrealized == null
                                  ? 'text-muted-foreground'
                                  : pnlClass(row.unrealized)
                              )}
                            >
                              {row.unrealized == null ? '-' : formatCurrency(row.unrealized)}
                            </TableCell>
                          )}
                          <TableCell
                            className={cn('text-right font-medium', pnlClass(row.cumulative))}
                          >
                            {formatCurrency(row.cumulative)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Scrip-wise</CardTitle>
                <CardDescription>
                  Every closed lot and open position merged by symbol, matching the Scrip-wise P&L
                  report every broker uses. Cumulative is the scrip's total over the selected P&L.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {scripRows.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8">
                    No matching trades in this date range
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Symbol</TableHead>
                          <TableHead>Exchange</TableHead>
                          <TableHead>Product</TableHead>
                          {showRealized && (
                            <>
                              <TableHead className="text-right">Qty</TableHead>
                              <TableHead className="text-right">Buy Value</TableHead>
                              <TableHead className="text-right">Sell Value</TableHead>
                              <TableHead className="text-right">Realized P&L</TableHead>
                            </>
                          )}
                          {showUnrealized && (
                            <>
                              <TableHead className="text-right">Open Qty</TableHead>
                              <TableHead className="text-right">Avg Price</TableHead>
                              <TableHead className="text-right">LTP</TableHead>
                              <TableHead className="text-right">Unrealized P&L</TableHead>
                            </>
                          )}
                          <TableHead className="text-right">Cumulative</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {scripRows.map((row) => (
                          <TableRow key={row.key}>
                            <TableCell>{row.symbol}</TableCell>
                            <TableCell>{row.exchange}</TableCell>
                            <TableCell>{row.product ?? '-'}</TableCell>
                            {showRealized && (
                              <>
                                <TableCell className="text-right">
                                  {row.closedQuantity || '-'}
                                </TableCell>
                                <TableCell className="text-right">
                                  {row.closedQuantity ? formatCurrency(row.buyValue) : '-'}
                                </TableCell>
                                <TableCell className="text-right">
                                  {row.closedQuantity ? formatCurrency(row.sellValue) : '-'}
                                </TableCell>
                                <TableCell
                                  className={cn(
                                    'text-right font-medium',
                                    row.closedQuantity ? pnlClass(row.realized) : 'text-muted-foreground'
                                  )}
                                >
                                  {row.closedQuantity ? formatCurrency(row.realized) : '-'}
                                </TableCell>
                              </>
                            )}
                            {showUnrealized && (
                              <>
                                <TableCell className="text-right">
                                  {row.openQuantity || '-'}
                                </TableCell>
                                <TableCell className="text-right">
                                  {row.averagePrice == null ? '-' : formatCurrency(row.averagePrice)}
                                </TableCell>
                                <TableCell className="text-right">
                                  {row.ltp == null ? '-' : formatCurrency(row.ltp)}
                                </TableCell>
                                <TableCell
                                  className={cn(
                                    'text-right font-medium',
                                    row.unrealized == null
                                      ? 'text-muted-foreground'
                                      : pnlClass(row.unrealized)
                                  )}
                                >
                                  {row.unrealized == null ? '-' : formatCurrency(row.unrealized)}
                                </TableCell>
                              </>
                            )}
                            <TableCell
                              className={cn('text-right font-medium', pnlClass(row.cumulative))}
                            >
                              {formatCurrency(row.cumulative)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
