import {
  AlertTriangle,
  ArrowUpDown,
  Download,
  Loader2,
  Pause,
  Radio,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Wallet,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { tradingApi } from '@/api/trading'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { calculateLiveStats, useLivePrice } from '@/hooks/useLivePrice'
import { useOrderEventRefresh } from '@/hooks/useOrderEventRefresh'
import { usePageVisibility } from '@/hooks/usePageVisibility'
import { cn, makeFormatCurrency, sanitizeCSV } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'
import { onModeChange } from '@/stores/themeStore'
import type { Holding, HoldingsStats } from '@/types/trading'
import { showToast } from '@/utils/toast'
import { EmptyState } from '@/components/ui/empty-state'

function formatPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

/** Free + T1 + pledged — the total held quantity, not just the freely-sellable portion. */
function totalQty(holding: Holding): number {
  return (holding.quantity || 0) + (holding.t1_quantity || 0) + (holding.pledged_quantity || 0)
}

/** Zerodha-style compact quantity: "0 T1:12 P:5" — omits T1/P entirely when zero. */
function formatQuantity(holding: Holding): string {
  const parts = [String(holding.quantity)]
  if (holding.t1_quantity) parts.push(`T1:${holding.t1_quantity}`)
  if (holding.pledged_quantity) parts.push(`P:${holding.pledged_quantity}`)
  return parts.join(' ')
}

type SortColumn =
  | 'symbol'
  | 'quantity'
  | 'average_price'
  | 'ltp'
  | 'invested'
  | 'current'
  | 'pnl'
  | 'pnlpercent'
  | 'allocation'
  | null
type SortDirection = 'asc' | 'desc'

export default function Holdings() {
  const { apiKey, user } = useAuthStore()
  const formatCurrency = useMemo(() => makeFormatCurrency(user?.broker), [user?.broker])
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [stats, setStats] = useState<HoldingsStats | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showStaleWarning, setShowStaleWarning] = useState(false)
  const [sortColumn, setSortColumn] = useState<SortColumn>(null)
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')

  // Page visibility tracking for resource optimization
  const { isVisible, wasHidden, timeSinceHidden } = usePageVisibility()
  const lastFetchRef = useRef<number>(Date.now())

  // Centralized real-time price hook with WebSocket + MultiQuotes fallback
  // Automatically pauses when tab is hidden
  const {
    data: enhancedHoldings,
    isLive,
    isPaused,
  } = useLivePrice(holdings, {
    enabled: holdings.length > 0,
    useMultiQuotesFallback: true,
    staleThreshold: 5000,
    multiQuotesRefreshInterval: 30000,
    pauseWhenHidden: true,
  })

  // Calculate enhanced stats based on real-time data
  const enhancedStats = useMemo(() => {
    if (!stats) return stats

    // Check if any holding has live data
    const hasAnyLiveData = enhancedHoldings.some(
      (h) => (h as Holding & { _dataSource?: string })._dataSource !== 'rest'
    )

    // If no live data, return original REST stats
    if (!hasAnyLiveData) return stats

    // Recalculate stats with real-time data
    return calculateLiveStats(enhancedHoldings, stats)
  }, [stats, enhancedHoldings])

  // Derive per-row Invested/Current/Allocation from the live-priced holdings.
  // Invested and Current both use total quantity (free + T1 + pledged) since
  // pledged/T1 shares are still part of what you own and what you paid for them.
  const rows = useMemo(() => {
    const withValues = enhancedHoldings.map((holding) => {
      const qty = totalQty(holding)
      const ltp = holding.ltp ?? holding.average_price ?? 0
      return {
        ...holding,
        invested: qty * (holding.average_price || 0),
        current: qty * ltp,
      }
    })
    const totalCurrent = withValues.reduce((sum, h) => sum + h.current, 0)
    return withValues.map((holding) => ({
      ...holding,
      allocation: totalCurrent > 0 ? (holding.current / totalCurrent) * 100 : 0,
    }))
  }, [enhancedHoldings])

  const sortedRows = useMemo(() => {
    if (sortColumn === null) return rows

    return [...rows].sort((a, b) => {
      let aVal: string | number
      let bVal: string | number

      switch (sortColumn) {
        case 'symbol':
          aVal = a.symbol
          bVal = b.symbol
          break
        case 'quantity':
          aVal = totalQty(a)
          bVal = totalQty(b)
          break
        case 'average_price':
          aVal = a.average_price || 0
          bVal = b.average_price || 0
          break
        case 'ltp':
          aVal = a.ltp || 0
          bVal = b.ltp || 0
          break
        case 'invested':
          aVal = a.invested
          bVal = b.invested
          break
        case 'current':
          aVal = a.current
          bVal = b.current
          break
        case 'pnl':
          aVal = a.pnl || 0
          bVal = b.pnl || 0
          break
        case 'pnlpercent':
          aVal = a.pnlpercent || 0
          bVal = b.pnlpercent || 0
          break
        case 'allocation':
          aVal = a.allocation
          bVal = b.allocation
          break
        default:
          return 0
      }

      if (typeof aVal === 'string') {
        return sortDirection === 'asc'
          ? aVal.localeCompare(bVal as string)
          : (bVal as string).localeCompare(aVal)
      }
      return sortDirection === 'asc'
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number)
    })
  }, [rows, sortColumn, sortDirection])

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
    } else {
      setSortColumn(column)
      setSortDirection('asc')
    }
  }

  const fetchHoldings = useCallback(
    async (showRefresh = false) => {
      if (!apiKey) {
        setIsLoading(false)
        return
      }

      if (showRefresh) setIsRefreshing(true)

      try {
        const response = await tradingApi.getHoldings(apiKey)
        if (response.status === 'success' && response.data) {
          setHoldings(response.data.holdings || [])
          setStats(response.data.statistics)
          setError(null)
        } else {
          setError(response.message || 'Failed to fetch holdings')
        }
      } catch {
        setError('Failed to fetch holdings')
      } finally {
        setIsLoading(false)
        setIsRefreshing(false)
      }
    },
    [apiKey]
  )

  // Initial fetch and visibility-aware polling
  // Pauses polling when tab is hidden to save resources
  useEffect(() => {
    // Don't poll when tab is hidden
    if (!isVisible) return

    fetchHoldings()
    lastFetchRef.current = Date.now()
  }, [fetchHoldings, isVisible])

  // Refresh on order events instead of polling
  useOrderEventRefresh(fetchHoldings, {
    events: ['order_event', 'analyzer_update'],
  })

  // Refresh data when tab becomes visible after being hidden
  useEffect(() => {
    if (!wasHidden || !isVisible) return

    const timeSinceLastFetch = Date.now() - lastFetchRef.current

    // If hidden for more than 30 seconds, show stale warning and refresh
    if (timeSinceHidden > 30000 || timeSinceLastFetch > 30000) {
      setShowStaleWarning(true)
      fetchHoldings()
      lastFetchRef.current = Date.now()
    }
  }, [wasHidden, isVisible, timeSinceHidden, fetchHoldings])

  // Auto-dismiss stale data warning after 5 seconds
  useEffect(() => {
    if (!showStaleWarning) return
    const timeout = setTimeout(() => setShowStaleWarning(false), 5000)
    return () => clearTimeout(timeout)
  }, [showStaleWarning])

  // Listen for mode changes (live/analyze) and refresh data
  useEffect(() => {
    const unsubscribe = onModeChange(() => {
      fetchHoldings()
    })
    return () => unsubscribe()
  }, [fetchHoldings])

  const exportToCSV = () => {
    if (rows.length === 0) {
      showToast.error('No data to export', 'system')
      return
    }

    try {
      const headers = [
        'Symbol',
        'Quantity',
        'T1 Qty',
        'Pledged Qty',
        'Avg Price',
        'LTP',
        'Invested',
        'Current',
        'P&L',
        'P&L %',
        'Allocation %',
      ]
      const csvRows = rows.map((h) => [
        sanitizeCSV(h.symbol),
        sanitizeCSV(h.quantity),
        sanitizeCSV(h.t1_quantity || 0),
        sanitizeCSV(h.pledged_quantity || 0),
        sanitizeCSV(h.average_price),
        sanitizeCSV(h.ltp),
        sanitizeCSV(h.invested),
        sanitizeCSV(h.current),
        sanitizeCSV(h.pnl),
        sanitizeCSV(h.pnlpercent),
        sanitizeCSV(h.allocation),
      ])

      const csv = [headers, ...csvRows].map((row) => row.join(',')).join('\n')
      const blob = new Blob([csv], { type: 'text/csv' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const filename = `holdings_${new Date().toISOString().split('T')[0]}.csv`
      a.download = filename
      a.click()
      // Revoke the object URL to free memory
      URL.revokeObjectURL(url)
      showToast.success(`Downloaded ${filename}`, 'clipboard')
    } catch {
      showToast.error('Failed to export CSV', 'system')
    }
  }

  const isProfit = (value: number) => value >= 0

  const SortableHeader = ({
    column,
    label,
    className,
  }: {
    column: SortColumn
    label: string
    className?: string
  }) => (
    <TableHead
      className={cn('cursor-pointer hover:bg-muted/50 select-none', className)}
      onClick={() => handleSort(column)}
    >
      <div
        className={cn(
          'flex items-center gap-1 w-full',
          className?.includes('text-right') && 'justify-end'
        )}
      >
        {label}
        <ArrowUpDown className="h-3 w-3 opacity-50" />
      </div>
    </TableHead>
  )

  return (
    <div className="space-y-6">
      {/* Stale Data Warning */}
      {showStaleWarning && (
        <Alert variant="default" className="bg-amber-500/10 border-amber-500/30">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <AlertDescription className="text-amber-700 dark:text-amber-400">
            Data is being refreshed after tab was inactive...
          </AlertDescription>
        </Alert>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">Investor Summary</h1>
            {isPaused ? (
              <Badge
                variant="outline"
                className="bg-amber-500/10 text-amber-600 border-amber-500/30 gap-1"
              >
                <Pause className="h-3 w-3" />
                Paused
              </Badge>
            ) : isLive ? (
              <Badge
                variant="outline"
                className="bg-emerald-500/10 text-emerald-600 border-emerald-500/30 gap-1"
              >
                <Radio className="h-3 w-3 animate-pulse" />
                Live
              </Badge>
            ) : null}
          </div>
          <p className="text-muted-foreground">View your holdings portfolio</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchHoldings(true)}
            disabled={isRefreshing}
          >
            <RefreshCw className={cn('h-4 w-4 mr-2', isRefreshing && 'animate-spin')} />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={exportToCSV}>
            <Download className="h-4 w-4 mr-2" />
            Export
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Invested</CardDescription>
            <CardTitle className="text-2xl">
              {enhancedStats ? formatCurrency(enhancedStats.totalinvvalue) : '---'}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Current</CardDescription>
            <CardTitle className="text-2xl text-primary">
              {enhancedStats ? formatCurrency(enhancedStats.totalholdingvalue) : '---'}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Profit and Loss</CardDescription>
            <CardTitle
              className={cn(
                'text-2xl',
                enhancedStats && isProfit(enhancedStats.totalprofitandloss)
                  ? 'text-green-600'
                  : 'text-red-600'
              )}
            >
              {enhancedStats ? (
                <div className="flex items-center gap-1">
                  {isProfit(enhancedStats.totalprofitandloss) ? (
                    <TrendingUp className="h-5 w-5" />
                  ) : (
                    <TrendingDown className="h-5 w-5" />
                  )}
                  {formatCurrency(enhancedStats.totalprofitandloss)}
                </div>
              ) : (
                '---'
              )}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total PnL Percentage</CardDescription>
            <CardTitle
              className={cn(
                'text-2xl',
                enhancedStats && isProfit(enhancedStats.totalpnlpercentage)
                  ? 'text-green-600'
                  : 'text-red-600'
              )}
            >
              {enhancedStats ? formatPercent(enhancedStats.totalpnlpercentage) : '---'}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Holdings Table */}
      <Card>
        <CardContent className="py-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin" />
            </div>
          ) : error ? (
            <div className="text-center py-12 text-muted-foreground">{error}</div>
          ) : holdings.length === 0 ? (
            <EmptyState
              icon={Wallet}
              title="No holdings found"
              description="Connect a broker to start tracking your portfolio."
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHeader column="symbol" label="Trading Symbol" />
                    <SortableHeader column="quantity" label="Quantity" className="text-right" />
                    <SortableHeader column="average_price" label="Avg Price" className="text-right" />
                    <SortableHeader column="ltp" label="LTP" className="text-right" />
                    <SortableHeader column="invested" label="Invested" className="text-right" />
                    <SortableHeader column="current" label="Current" className="text-right" />
                    <SortableHeader column="pnl" label="PnL" className="text-right" />
                    <SortableHeader column="pnlpercent" label="PnL %" className="text-right" />
                    <SortableHeader column="allocation" label="Allocation" className="text-right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedRows.map((holding, index) => (
                    <TableRow key={`${holding.symbol}-${holding.exchange}-${index}`}>
                      <TableCell className="font-medium">{holding.symbol}</TableCell>
                      <TableCell className="text-right font-mono">
                        {formatQuantity(holding)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {holding.average_price !== undefined
                          ? formatCurrency(holding.average_price)
                          : '-'}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {holding.ltp !== undefined ? formatCurrency(holding.ltp) : '-'}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(holding.invested)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(holding.current)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right font-medium',
                          isProfit(holding.pnl) ? 'text-green-600' : 'text-red-600'
                        )}
                      >
                        <div className="flex items-center justify-end gap-1">
                          {isProfit(holding.pnl) ? (
                            <TrendingUp className="h-4 w-4" />
                          ) : (
                            <TrendingDown className="h-4 w-4" />
                          )}
                          {formatCurrency(holding.pnl)}
                        </div>
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right',
                          isProfit(holding.pnlpercent) ? 'text-green-600' : 'text-red-600'
                        )}
                      >
                        {formatPercent(holding.pnlpercent)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">
                        {holding.allocation.toFixed(2)}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow className="bg-muted/50">
                    <TableCell colSpan={6} className="text-right text-muted-foreground">
                      Total P&L:
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right font-bold',
                        enhancedStats && isProfit(enhancedStats.totalprofitandloss)
                          ? 'text-green-600'
                          : 'text-red-600'
                      )}
                    >
                      {enhancedStats
                        ? `${enhancedStats.totalprofitandloss >= 0 ? '+' : ''}${formatCurrency(enhancedStats.totalprofitandloss)}`
                        : '-'}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right font-bold',
                        enhancedStats && isProfit(enhancedStats.totalpnlpercentage)
                          ? 'text-green-600'
                          : 'text-red-600'
                      )}
                    >
                      {enhancedStats ? formatPercent(enhancedStats.totalpnlpercentage) : '-'}
                    </TableCell>
                    <TableCell className="text-right font-bold text-muted-foreground">
                      {rows.length > 0 ? '100.00%' : '-'}
                    </TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
