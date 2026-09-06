import {
  ArrowDown,
  ArrowUp,
  Download,
  Loader2,
  RefreshCw,
  Settings2,
  TrendingDown,
  TrendingUp,
  Upload,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { tradingApi } from '@/api/trading'
import { Badge } from '@/components/ui/badge'
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
import { useOrderEventRefresh } from '@/hooks/useOrderEventRefresh'
import { useSupportedExchanges } from '@/hooks/useSupportedExchanges'
import { cn, makeFormatCurrency, sanitizeCSV } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'
import { onModeChange } from '@/stores/themeStore'
import type { Segment, Trade } from '@/types/trading'
import { showToast } from '@/utils/toast'

interface FilterState {
  action: string[]
  exchange: string[]
  product: string[]
}

// Sort configuration types
type SortKey = 'timestamp' | 'symbol' | 'action'
interface SortConfig {
  key: SortKey
  direction: 'asc' | 'desc'
}

// Fork-only historical view (SKYSHIELD_PATCHES.md): mirrors
// database/pnl_db.py's derive_segment()/_EXCHANGE_SEGMENT_MAP exactly.
// Kept in sync by hand since the frontend has no import path into that
// Python module; if that mapping changes, update this one too. Live-today
// Trade objects have no `segment` field at all (the broker's own tradebook
// API doesn't have this concept), so this is the fallback used for those -
// historical rows from GET /api/v1/pnl/trades carry a real stored
// `segment` already and this is never called for them (see
// segmentOf below).
const EXCHANGE_SEGMENT_MAP: Record<string, Segment> = {
  NSE: 'equity',
  BSE: 'equity',
  NFO: 'fno',
  BFO: 'fno',
  CDS: 'currency',
  BCD: 'currency',
  MCX: 'commodity',
  NCDEX: 'commodity',
  NCO: 'commodity',
}

function segmentOf(trade: Trade): Segment | undefined {
  return (trade.segment as Segment | undefined) ?? EXCHANGE_SEGMENT_MAP[trade.exchange]
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0]
}

function sevenDaysAgoStr(): string {
  const d = new Date()
  d.setDate(d.getDate() - 7)
  return d.toISOString().split('T')[0]
}

/**
 * Helper to convert various broker timestamp formats into a sortable number.
 * Ensures chronological accuracy for non-ISO formats.
 */
function parseTimestamp(timestamp: string): number {
  if (!timestamp) return 0

  let date = new Date(timestamp)

  // If invalid, try "HH:MM:SS DD-MM-YYYY" (Flattrade/Shoonya/Zebu/Firstock norentm format)
  if (Number.isNaN(date.getTime())) {
    const norentm = timestamp.match(/^(\d{2}:\d{2}:\d{2})\s+(\d{2})-(\d{2})-(\d{4})$/)
    if (norentm) {
      date = new Date(`${norentm[4]}-${norentm[3]}-${norentm[2]}T${norentm[1]}`)
    }
  }

  // If invalid, try "DD-MM-YYYY HH:MM:SS"
  if (Number.isNaN(date.getTime())) {
    const ddmmyyyy = timestamp.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}:\d{2}:\d{2})$/)
    if (ddmmyyyy) {
      date = new Date(`${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}T${ddmmyyyy[4]}`)
    }
  }

  return date.getTime() || 0
}

function formatTime(timestamp: string): string {
  if (!timestamp) return '-'

  const timeValue = parseTimestamp(timestamp)
  if (timeValue === 0) {
    // Last resort: extract HH:MM:SS if embedded in the string
    const timeMatch = timestamp.match(/(\d{2}:\d{2}:\d{2})/)
    return timeMatch ? timeMatch[1] : timestamp
  }

  const date = new Date(timeValue)
  return date.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export default function TradeBook() {
  const { apiKey, user } = useAuthStore()
  const { isCrypto } = useSupportedExchanges()
  const formatCurrency = useMemo(() => makeFormatCurrency(user?.broker), [user?.broker])
  const [trades, setTrades] = useState<Trade[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Filter state
  const [filters, setFilters] = useState<FilterState>({
    action: [],
    exchange: [],
    product: [],
  })
  const [settingsOpen, setSettingsOpen] = useState(false)

  // P&L history CSV import (fork-only feature - SKYSHIELD_PATCHES.md)
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [isImporting, setIsImporting] = useState(false)

  // Historical view (fork-only - SKYSHIELD_PATCHES.md). Default date range
  // is the last 7 days, matching the Zerodha Console reference this filter
  // row is modeled on - end date defaults to today, so isHistorical is true
  // by default and fetchTrades starts on the ledger-backed
  // GET /api/v1/pnl/trades. Narrowing the range to today only switches back
  // to the existing live broker call, since today's trades aren't captured
  // into the ledger until the 16:00 IST daily job runs.
  const [segment, setSegment] = useState<'all' | Segment>('all')
  const [symbolFilter, setSymbolFilter] = useState('')
  const [startDate, setStartDate] = useState(sevenDaysAgoStr())
  const [endDate, setEndDate] = useState(todayStr())
  const isHistorical = startDate !== todayStr() || endDate !== todayStr()

  // Sort state - Default: most recent first
  const [sortConfig, setSortConfig] = useState<SortConfig>({
    key: 'timestamp',
    direction: 'desc',
  })

  // Filter and Sort trades
  const sortedAndFilteredTrades = useMemo(() => {
    // 1. Filter Logic
    const filtered = trades.filter((trade) => {
      if (filters.action.length > 0 && !filters.action.includes(trade.action)) return false
      if (filters.exchange.length > 0 && !filters.exchange.includes(trade.exchange)) return false
      if (filters.product.length > 0 && !filters.product.includes(trade.product)) return false
      if (segment !== 'all' && segmentOf(trade) !== segment) return false
      if (
        symbolFilter &&
        !trade.symbol.toUpperCase().includes(symbolFilter.trim().toUpperCase())
      )
        return false
      return true
    })

    // 2. Sort Logic
    return [...filtered].sort((a, b) => {
      const aValue = a[sortConfig.key]
      const bValue = b[sortConfig.key]

      if (sortConfig.key === 'timestamp') {
        const aTime = parseTimestamp(aValue as string)
        const bTime = parseTimestamp(bValue as string)
        return sortConfig.direction === 'asc' ? aTime - bTime : bTime - aTime
      }

      // Standard alphabetical sort for Symbol and Action
      if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1
      if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1
      return 0
    })
  }, [trades, filters, segment, symbolFilter, sortConfig])

  const requestSort = (key: SortKey) => {
    setSortConfig((prev) => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc',
    }))
  }

  const hasActiveFilters =
    filters.action.length > 0 || filters.exchange.length > 0 || filters.product.length > 0

  const toggleFilter = (type: keyof FilterState, value: string) => {
    setFilters((prev) => {
      const arr = prev[type]
      const index = arr.indexOf(value)
      if (index > -1) {
        return { ...prev, [type]: arr.filter((v) => v !== value) }
      }
      return { ...prev, [type]: [...arr, value] }
    })
  }

  const clearFilters = () => {
    setFilters({ action: [], exchange: [], product: [] })
  }

  const fetchTrades = useCallback(
    async (showRefresh = false) => {
      if (!apiKey) {
        setIsLoading(false)
        return
      }

      if (showRefresh) setIsRefreshing(true)

      try {
        // A date range other than "today" switches to the ledger-backed
        // historical endpoint - see the isHistorical comment above. Segment/
        // Symbol stay client-side filters applied uniformly to either
        // source in sortedAndFilteredTrades, rather than branching here too.
        const response = isHistorical
          ? await tradingApi.getPnlTrades(apiKey, startDate, endDate)
          : await tradingApi.getTrades(apiKey)
        if (response.status === 'success' && response.data) {
          setTrades(response.data)
          setError(null)
        } else {
          setError(response.message || 'Failed to fetch trades')
        }
      } catch {
        setError('Failed to fetch trades')
      } finally {
        setIsLoading(false)
        setIsRefreshing(false)
      }
    },
    [apiKey, isHistorical, startDate, endDate]
  )

  // Runs once on mount (and again if apiKey only becomes available after
  // mount) - deliberately not depending on fetchTrades itself, which also
  // changes identity on every Segment/Symbol/date edit. Re-fetching on
  // every such edit would fire a request per keystroke/date-picker
  // interaction; the explicit Fetch button below is the trigger for that
  // instead, matching PnlHistory.tsx's pattern.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional - see comment above
  useEffect(() => {
    fetchTrades()
  }, [apiKey])

  // Refresh on order events instead of polling
  useOrderEventRefresh(fetchTrades, {
    events: ['order_event', 'analyzer_update'],
  })

  // Listen for mode changes (live/analyze) and refresh data
  useEffect(() => {
    const unsubscribe = onModeChange(() => {
      fetchTrades()
    })
    return () => unsubscribe()
  }, [fetchTrades])

  const exportToCSV = () => {
    if (sortedAndFilteredTrades.length === 0) {
      showToast.error('No data to export', 'system')
      return
    }

    try {
      const headers = [
        'Symbol',
        'Exchange',
        ...(isCrypto ? [] : ['Product']),
        'Action',
        'Qty',
        'Price',
        'Trade Value',
        'Order ID',
        'Trade ID',
        'Time',
      ]
      const rows = sortedAndFilteredTrades.map((t) => [
        sanitizeCSV(t.symbol),
        sanitizeCSV(t.exchange),
        ...(isCrypto ? [] : [sanitizeCSV(t.product)]),
        sanitizeCSV(t.action),
        sanitizeCSV(t.quantity),
        sanitizeCSV(t.average_price),
        sanitizeCSV(t.trade_value),
        sanitizeCSV(t.orderid),
        sanitizeCSV(t.tradeid || ''),
        sanitizeCSV(t.timestamp),
      ])

      const csv = [headers, ...rows].map((row) => row.join(',')).join('\n')
      const blob = new Blob([csv], { type: 'text/csv' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const filename = `tradebook_${new Date().toISOString().split('T')[0]}.csv`
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      showToast.success(`Downloaded ${filename}`, 'clipboard')
    } catch {
      showToast.error('Failed to export CSV', 'system')
    }
  }

  // P&L history CSV import (fork-only feature, backfills the consolidated
  // multi-day P&L ledger - see openalgo's SKYSHIELD_PATCHES.md). Distinct
  // from exportToCSV above: this uploads a broker-exported tradebook CSV
  // rather than downloading the currently-filtered view.
  const importPnlHistory = async () => {
    if (!apiKey) {
      showToast.error('API key not available', 'system')
      return
    }
    if (!importFile) {
      showToast.warning('Please select a CSV file', 'system')
      return
    }

    setIsImporting(true)
    try {
      const response = await tradingApi.importPnlHistoryCsv(apiKey, importFile)
      if (response.status === 'success' && response.data) {
        const { imported, skipped_duplicate, skipped_invalid } = response.data
        showToast.success(
          `Imported ${imported} trade(s)` +
            (skipped_duplicate ? `, ${skipped_duplicate} already had them` : '') +
            (skipped_invalid ? `, ${skipped_invalid} row(s) could not be read` : ''),
          'clipboard'
        )
        setImportDialogOpen(false)
        setImportFile(null)
      } else {
        showToast.error(response.message || 'Failed to import CSV', 'system')
      }
    } catch (error: unknown) {
      // Matching the pattern already used elsewhere (e.g. ActionCenter.tsx):
      // a non-2xx response still carries our own {status, message} JSON
      // body, so show that instead of a generic string when it's there.
      const err = error as { response?: { data?: { message?: string } } }
      showToast.error(err.response?.data?.message || 'Failed to import CSV', 'system')
    } finally {
      setIsImporting(false)
    }
  }

  const stats = {
    total: sortedAndFilteredTrades.length,
    buyTrades: sortedAndFilteredTrades.filter((t) => t.action === 'BUY').length,
    sellTrades: sortedAndFilteredTrades.filter((t) => t.action === 'SELL').length,
  }

  const FilterChip = ({
    type,
    value,
    label,
  }: {
    type: keyof FilterState
    value: string
    label: string
  }) => (
    <Button
      variant={filters[type].includes(value) ? 'default' : 'outline'}
      size="sm"
      className={cn(
        'rounded-full',
        filters[type].includes(value) && 'bg-pink-500 hover:bg-pink-600'
      )}
      onClick={() => toggleFilter(type, value)}
    >
      {label}
    </Button>
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Trade Book</h1>
          <p className="text-muted-foreground">
            {isHistorical
              ? 'Historical trades from the consolidated P&L ledger'
              : "View today's executed trades"}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Settings Button */}
          <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
            <DialogTrigger asChild>
              <Button
                variant={hasActiveFilters ? 'default' : 'outline'}
                size="sm"
                className="relative"
                aria-label="Open trade filters"
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
                <DialogTitle>Trade Filters</DialogTitle>
                <DialogDescription>Filter trades by action, exchange, or product</DialogDescription>
              </DialogHeader>

              <div className="space-y-6 py-4">
                {/* Action */}
                <div className="space-y-3">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Action
                  </Label>
                  <div className="flex flex-wrap gap-2">
                    <FilterChip type="action" value="BUY" label="Buy" />
                    <FilterChip type="action" value="SELL" label="Sell" />
                  </div>
                </div>

                {/* Exchange */}
                <div className="space-y-3">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Exchange
                  </Label>
                  <div className="flex flex-wrap gap-2">
                    <FilterChip type="exchange" value="NSE" label="NSE" />
                    <FilterChip type="exchange" value="BSE" label="BSE" />
                    <FilterChip type="exchange" value="NFO" label="NFO" />
                    <FilterChip type="exchange" value="BFO" label="BFO" />
                    <FilterChip type="exchange" value="MCX" label="MCX" />
                    <FilterChip type="exchange" value="CDS" label="CDS" />
                  </div>
                </div>

                {/* Product */}
                {!isCrypto && (
                  <div className="space-y-3">
                    <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Product
                    </Label>
                    <div className="flex flex-wrap gap-2">
                      <FilterChip type="product" value="CNC" label="CNC" />
                      <FilterChip type="product" value="MIS" label="MIS" />
                      <FilterChip type="product" value="NRML" label="NRML" />
                    </div>
                  </div>
                )}
              </div>

              <DialogFooter>
                <Button variant="ghost" onClick={clearFilters}>
                  Clear All
                </Button>
                <Button onClick={() => setSettingsOpen(false)}>Done</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchTrades(true)}
            disabled={isRefreshing}
            aria-label="Refresh tradebook"
          >
            <RefreshCw className={cn('h-4 w-4 mr-2', isRefreshing && 'animate-spin')} />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={exportToCSV}
            aria-label="Export tradebook to CSV"
          >
            <Download className="h-4 w-4 mr-2" />
            Export
          </Button>

          {/* P&L history CSV import (fork-only) */}
          <Dialog
            open={importDialogOpen}
            onOpenChange={(open) => {
              setImportDialogOpen(open)
              if (!open) setImportFile(null)
            }}
          >
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" aria-label="Import P&L history from CSV">
                <Upload className="h-4 w-4 mr-2" />
                Upload
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Import P&L History</DialogTitle>
                <DialogDescription>
                  Upload an exported tradebook CSV to backfill historical P&L for dates before
                  automated capture started. Trades already recorded are skipped automatically.
                </DialogDescription>
              </DialogHeader>
              <div className="py-2">
                <Label htmlFor="pnl-import-file">Tradebook CSV</Label>
                <Input
                  id="pnl-import-file"
                  type="file"
                  accept=".csv"
                  className="mt-2"
                  onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
                />
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setImportDialogOpen(false)}
                  disabled={isImporting}
                >
                  Cancel
                </Button>
                <Button onClick={importPnlHistory} disabled={isImporting || !importFile}>
                  {isImporting ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4 mr-2" />
                  )}
                  Upload
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Segment / Symbol / Date range (fork-only - SKYSHIELD_PATCHES.md).
          Same layout as PnlHistory.tsx's filter row, and the same reference
          this whole historical view was modeled on (Zerodha Console's own
          Tradebook report). Leaving the date range at today keeps this page
          on the existing live broker view untouched - see isHistorical. */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col sm:flex-row sm:items-end gap-4">
            <div className="flex-1 space-y-1">
              <Label htmlFor="tb-segment">Segment</Label>
              <Select value={segment} onValueChange={(v) => setSegment(v as typeof segment)}>
                <SelectTrigger id="tb-segment">
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
              <Label htmlFor="tb-symbol">Symbol</Label>
              <Input
                id="tb-symbol"
                placeholder="e.g. INFY"
                value={symbolFilter}
                onChange={(e) => setSymbolFilter(e.target.value)}
              />
            </div>
            <div className="flex-1 space-y-1">
              <Label htmlFor="tb-start-date">Start date</Label>
              <Input
                id="tb-start-date"
                type="date"
                value={startDate}
                max={endDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="flex-1 space-y-1">
              <Label htmlFor="tb-end-date">End date</Label>
              <Input
                id="tb-end-date"
                type="date"
                value={endDate}
                min={startDate}
                max={todayStr()}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
            <Button
              onClick={() => fetchTrades(true)}
              disabled={isRefreshing}
              aria-label="Fetch trades for the selected filters"
            >
              {isRefreshing ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Fetch
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Active Filters Bar */}
      {hasActiveFilters && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted-foreground">Active Filters:</span>
          {filters.action.map((v) => (
            <Badge
              key={v}
              variant="secondary"
              className="bg-pink-500/10 text-pink-600 border-pink-500/30"
            >
              {v}
            </Badge>
          ))}
          {filters.exchange.map((v) => (
            <Badge
              key={v}
              variant="secondary"
              className="bg-pink-500/10 text-pink-600 border-pink-500/30"
            >
              {v}
            </Badge>
          ))}
          {!isCrypto &&
            filters.product.map((v) => (
              <Badge
                key={v}
                variant="secondary"
                className="bg-pink-500/10 text-pink-600 border-pink-500/30"
              >
                {v}
              </Badge>
            ))}
          <Button
            variant="outline"
            size="sm"
            className="text-red-500 border-red-500/50 hover:bg-red-500/10"
            onClick={clearFilters}
            aria-label="Clear active filters"
          >
            Clear All
          </Button>
        </div>
      )}

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Trades</CardDescription>
            <CardTitle className="text-2xl">{stats.total}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Buy Trades</CardDescription>
            <CardTitle className="text-2xl text-green-600 flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              {stats.buyTrades}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Sell Trades</CardDescription>
            <CardTitle className="text-2xl text-red-600 flex items-center gap-2">
              <TrendingDown className="h-5 w-5" />
              {stats.sellTrades}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Trades Table */}
      <Card>
        <CardContent className="py-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin" />
            </div>
          ) : error ? (
            <div className="text-center py-12 text-muted-foreground">{error}</div>
          ) : sortedAndFilteredTrades.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              {hasActiveFilters ? (
                <div>
                  <p className="mb-4">No trades match your filters</p>
                  <Button variant="ghost" size="sm" onClick={clearFilters}>
                    Clear Filters
                  </Button>
                </div>
              ) : isHistorical ? (
                'No trades in this date range'
              ) : (
                'No trades today'
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead
                      onClick={() => requestSort('symbol')}
                      className="cursor-pointer hover:bg-muted/50 transition-colors"
                    >
                      <div className="flex items-center gap-1">
                        Symbol
                        {sortConfig.key === 'symbol' &&
                          (sortConfig.direction === 'asc' ? (
                            <ArrowUp className="h-3 w-3" />
                          ) : (
                            <ArrowDown className="h-3 w-3" />
                          ))}
                      </div>
                    </TableHead>
                    <TableHead>Exchange</TableHead>
                    {!isCrypto && <TableHead>Product</TableHead>}
                    <TableHead
                      onClick={() => requestSort('action')}
                      className="cursor-pointer hover:bg-muted/50 transition-colors"
                    >
                      <div className="flex items-center gap-1">
                        Action
                        {sortConfig.key === 'action' &&
                          (sortConfig.direction === 'asc' ? (
                            <ArrowUp className="h-3 w-3" />
                          ) : (
                            <ArrowDown className="h-3 w-3" />
                          ))}
                      </div>
                    </TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead className="text-right">Trade Value</TableHead>
                    <TableHead>Order ID</TableHead>
                    <TableHead>Trade ID</TableHead>
                    <TableHead
                      onClick={() => requestSort('timestamp')}
                      className="cursor-pointer hover:bg-muted/50 transition-colors"
                    >
                      <div className="flex items-center gap-1">
                        Time
                        {sortConfig.key === 'timestamp' &&
                          (sortConfig.direction === 'asc' ? (
                            <ArrowUp className="h-3 w-3" />
                          ) : (
                            <ArrowDown className="h-3 w-3" />
                          ))}
                      </div>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedAndFilteredTrades.map((trade, index) => (
                    <TableRow key={`${trade.orderid}-${index}`}>
                      <TableCell className="font-medium">{trade.symbol}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{trade.exchange}</Badge>
                      </TableCell>
                      {!isCrypto && (
                        <TableCell>
                          <Badge variant="secondary">{trade.product}</Badge>
                        </TableCell>
                      )}
                      <TableCell>
                        <Badge
                          variant={trade.action === 'BUY' ? 'default' : 'destructive'}
                          className={cn('gap-1', trade.action === 'BUY' ? 'bg-green-500' : '')}
                        >
                          {trade.action === 'BUY' ? (
                            <TrendingUp className="h-3 w-3" />
                          ) : (
                            <TrendingDown className="h-3 w-3" />
                          )}
                          {trade.action}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono">{trade.quantity}</TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(trade.average_price)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(trade.trade_value)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{trade.orderid}</TableCell>
                      <TableCell className="font-mono text-xs">{trade.tradeid || '-'}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {isHistorical ? trade.timestamp : formatTime(trade.timestamp)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
