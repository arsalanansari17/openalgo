// frontend/src/pages/PnlHistory.tsx
/**
 * Consolidated multi-day realized P&L report (fork-only feature, see
 * openalgo's SKYSHIELD_PATCHES.md and docs/design/56-pnl-history). Modeled
 * on Zerodha Console's own Tradebook/P&L report pair under "Reports" -
 * date range in, FIFO-matched realized P&L out. Nothing here is
 * precomputed: every fetch re-runs utils/pnl_fifo.py server-side against
 * the raw fill ledger (compute-on-read, same philosophy as the built-in
 * intraday PnL Tracker).
 */
import { Loader2, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { PnlHistoryClosedTrade, PnlHistoryDailyRow } from '@/api/trading'
import { tradingApi } from '@/api/trading'
import { CalendarHeatmap, type CalendarHeatmapDay } from '@/components/reports/CalendarHeatmap'
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn, makeFormatCurrency } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'
import type { Segment } from '@/types/trading'
import { showToast } from '@/utils/toast'

function defaultStartDate(): string {
  const d = new Date()
  d.setDate(d.getDate() - 30)
  return d.toISOString().split('T')[0]
}

function defaultEndDate(): string {
  return new Date().toISOString().split('T')[0]
}

interface ScripRow {
  symbol: string
  exchange: string
  product: string | null
  quantity: number
  buyValue: number
  sellValue: number
  realizedPnl: number
  tradeCount: number
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

export default function PnlHistory() {
  const { apiKey, user } = useAuthStore()
  const formatCurrency = makeFormatCurrency(user?.broker)

  const [segment, setSegment] = useState<'all' | Segment>('all')
  const [symbol, setSymbol] = useState('')
  const [startDate, setStartDate] = useState(defaultStartDate())
  const [endDate, setEndDate] = useState(defaultEndDate())
  const [isLoading, setIsLoading] = useState(false)
  const [hasFetched, setHasFetched] = useState(false)
  const [totalRealizedPnl, setTotalRealizedPnl] = useState(0)
  const [tradeCount, setTradeCount] = useState(0)
  const [daily, setDaily] = useState<PnlHistoryDailyRow[]>([])
  const [closedTrades, setClosedTrades] = useState<PnlHistoryClosedTrade[]>([])
  const [view, setView] = useState<'day' | 'scrip'>('day')

  const fetchHistory = async () => {
    if (!apiKey) {
      showToast.error('API key not available', 'system')
      return
    }
    if (!startDate || !endDate) {
      showToast.warning('Select both a start and end date', 'system')
      return
    }

    setIsLoading(true)
    try {
      const response = await tradingApi.getPnlHistory(apiKey, startDate, endDate, {
        symbol: symbol.trim().toUpperCase(),
        segment: segment === 'all' ? undefined : segment,
      })
      if (response.status === 'success' && response.data) {
        setTotalRealizedPnl(response.data.total_realized_pnl)
        setTradeCount(response.data.trade_count)
        setDaily(response.data.daily)
        setClosedTrades(response.data.closed_trades)
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

  const pnlColorClass = totalRealizedPnl >= 0 ? 'text-green-600' : 'text-red-600'

  const heatmapDays: CalendarHeatmapDay[] = useMemo(
    () =>
      daily.map((row) => ({
        date: row.date,
        value: row.realized_pnl,
        tooltip: `${row.date}: ${formatCurrency(row.realized_pnl)} (${row.trade_count} trade${row.trade_count === 1 ? '' : 's'})`,
      })),
    [daily, formatCurrency]
  )

  // Scrip-wise view: merges every FIFO-matched lot for the same
  // symbol+exchange+product into one row, matching the Scrip-wise
  // aggregation every broker's own P&L report uses (Zerodha Console's Tax
  // P&L equity sheet, for one, reports buy value/sell value/P&L per scrip
  // rather than per lot). `entry_action` tells direction per lot - a BUY
  // entry closed by a sell is a long (buy value = entry leg, sell value =
  // exit leg); a SELL entry closed by a buy is a short (reversed).
  const scripRows: ScripRow[] = useMemo(() => {
    const rows = new Map<string, ScripRow>()
    for (const trade of closedTrades) {
      const key = `${trade.symbol}|${trade.exchange}|${trade.product ?? ''}`
      const isLong = trade.entry_action === 'BUY'
      const buyValue = trade.quantity * (isLong ? trade.entry_price : trade.exit_price)
      const sellValue = trade.quantity * (isLong ? trade.exit_price : trade.entry_price)
      const existing = rows.get(key)
      if (existing) {
        existing.quantity += trade.quantity
        existing.buyValue += buyValue
        existing.sellValue += sellValue
        existing.realizedPnl += trade.realized_pnl
        existing.tradeCount += 1
      } else {
        rows.set(key, {
          symbol: trade.symbol,
          exchange: trade.exchange,
          product: trade.product,
          quantity: trade.quantity,
          buyValue,
          sellValue,
          realizedPnl: trade.realized_pnl,
          tradeCount: 1,
        })
      }
    }
    return Array.from(rows.values()).sort((a, b) => a.symbol.localeCompare(b.symbol))
  }, [closedTrades])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">P&L History</h1>
          <p className="text-muted-foreground">
            Realized profit and loss across a date range, backfilled from your daily trade history
          </p>
        </div>
      </div>

      {/* Filters: Segment, Symbol, Date range - same order as Zerodha
          Console's own Tradebook/P&L report filters. */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col sm:flex-row sm:items-end gap-4">
            <div className="flex-1 space-y-1">
              <Label htmlFor="pnl-segment">Segment</Label>
              <Select value={segment} onValueChange={(v) => setSegment(v as typeof segment)}>
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
            <div className="flex-1 space-y-1">
              <Label htmlFor="pnl-symbol">Symbol</Label>
              <Input
                id="pnl-symbol"
                placeholder="e.g. INFY"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
              />
            </div>
            <div className="flex-1 space-y-1">
              <Label htmlFor="pnl-start-date">Start date</Label>
              <Input
                id="pnl-start-date"
                type="date"
                value={startDate}
                max={endDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="flex-1 space-y-1">
              <Label htmlFor="pnl-end-date">End date</Label>
              <Input
                id="pnl-end-date"
                type="date"
                value={endDate}
                min={startDate}
                max={defaultEndDate()}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
            <Button onClick={fetchHistory} disabled={isLoading} aria-label="Fetch P&L history">
              {isLoading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Fetch
            </Button>
          </div>
        </CardContent>
      </Card>

      {!hasFetched && !isLoading && (
        <div className="text-center py-16 text-muted-foreground">
          <p className="font-medium">Build a report</p>
          <p className="text-sm">Pick a date range above and click Fetch</p>
        </div>
      )}

      {hasFetched && (
        <>
          {/* Summary Cards */}
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Total Realized P&L</CardDescription>
                <CardTitle className={cn('text-2xl flex items-center gap-2', pnlColorClass)}>
                  {totalRealizedPnl >= 0 ? (
                    <TrendingUp className="h-5 w-5" />
                  ) : (
                    <TrendingDown className="h-5 w-5" />
                  )}
                  {formatCurrency(totalRealizedPnl)}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Closed Trades</CardDescription>
                <CardTitle className="text-2xl">{tradeCount}</CardTitle>
              </CardHeader>
            </Card>
          </div>

          {/* Heat Map, matching Zerodha Console's own P&L report - a
              calendar grid colored green/red by that day's realized P&L,
              shade intensity scaled to magnitude. Always visible (not part
              of the Day-wise/Trade-wise toggle below), since it's a single
              at-a-glance summary rather than a third detail view. */}
          {heatmapDays.length > 0 && (
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

          {/* Day-wise / Scrip-wise toggle, matching Zerodha Console's own
              P&L report - only one breakdown is shown at a time. */}
          <Tabs value={view} onValueChange={(v) => setView(v as typeof view)}>
            <TabsList>
              <TabsTrigger value="day">Day-wise</TabsTrigger>
              <TabsTrigger value="scrip">Scrip-wise</TabsTrigger>
            </TabsList>
          </Tabs>

          {view === 'day' ? (
            <Card>
              <CardHeader>
                <CardTitle>Daily Breakdown</CardTitle>
                <CardDescription>Realized P&L by the day it was closed out</CardDescription>
              </CardHeader>
              <CardContent>
                {daily.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8">
                    No closed trades in this date range
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead className="text-right">Trades</TableHead>
                        <TableHead className="text-right">Realized P&L</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {daily.map((row) => (
                        <TableRow key={row.date}>
                          <TableCell>{row.date}</TableCell>
                          <TableCell className="text-right">{row.trade_count}</TableCell>
                          <TableCell
                            className={cn(
                              'text-right font-medium',
                              row.realized_pnl >= 0 ? 'text-green-600' : 'text-red-600'
                            )}
                          >
                            {formatCurrency(row.realized_pnl)}
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
                  Every closed lot merged by symbol, matching the Scrip-wise P&L report every broker
                  uses
                </CardDescription>
              </CardHeader>
              <CardContent>
                {scripRows.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8">
                    No closed trades in this date range
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Symbol</TableHead>
                          <TableHead>Exchange</TableHead>
                          <TableHead>Product</TableHead>
                          <TableHead className="text-right">Qty</TableHead>
                          <TableHead className="text-right">Buy Value</TableHead>
                          <TableHead className="text-right">Sell Value</TableHead>
                          <TableHead className="text-right">Trades</TableHead>
                          <TableHead className="text-right">Realized P&L</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {scripRows.map((row) => (
                          <TableRow key={`${row.symbol}-${row.exchange}-${row.product}`}>
                            <TableCell>{row.symbol}</TableCell>
                            <TableCell>{row.exchange}</TableCell>
                            <TableCell>{row.product ?? '-'}</TableCell>
                            <TableCell className="text-right">{row.quantity}</TableCell>
                            <TableCell className="text-right">
                              {formatCurrency(row.buyValue)}
                            </TableCell>
                            <TableCell className="text-right">
                              {formatCurrency(row.sellValue)}
                            </TableCell>
                            <TableCell className="text-right">{row.tradeCount}</TableCell>
                            <TableCell
                              className={cn(
                                'text-right font-medium',
                                row.realizedPnl >= 0 ? 'text-green-600' : 'text-red-600'
                              )}
                            >
                              {formatCurrency(row.realizedPnl)}
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
