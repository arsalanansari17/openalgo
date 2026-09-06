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
import { useState } from 'react'
import type { PnlHistoryClosedTrade, PnlHistoryDailyRow } from '@/api/trading'
import { tradingApi } from '@/api/trading'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn, makeFormatCurrency } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'
import { showToast } from '@/utils/toast'

function defaultStartDate(): string {
  const d = new Date()
  d.setDate(d.getDate() - 30)
  return d.toISOString().split('T')[0]
}

function defaultEndDate(): string {
  return new Date().toISOString().split('T')[0]
}

export default function PnlHistory() {
  const { apiKey, user } = useAuthStore()
  const formatCurrency = makeFormatCurrency(user?.broker)

  const [startDate, setStartDate] = useState(defaultStartDate())
  const [endDate, setEndDate] = useState(defaultEndDate())
  const [isLoading, setIsLoading] = useState(false)
  const [hasFetched, setHasFetched] = useState(false)
  const [totalRealizedPnl, setTotalRealizedPnl] = useState(0)
  const [tradeCount, setTradeCount] = useState(0)
  const [daily, setDaily] = useState<PnlHistoryDailyRow[]>([])
  const [closedTrades, setClosedTrades] = useState<PnlHistoryClosedTrade[]>([])

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
      const response = await tradingApi.getPnlHistory(apiKey, startDate, endDate)
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">P&L History</h1>
          <p className="text-muted-foreground">
            Realized profit and loss across a date range, backfilled from your daily trade
            history
          </p>
        </div>
      </div>

      {/* Date Range */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col sm:flex-row sm:items-end gap-4">
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

          {/* Daily Breakdown */}
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

          {/* Closed Trades */}
          {closedTrades.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Closed Trades</CardTitle>
                <CardDescription>Each FIFO-matched entry/exit pair</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Symbol</TableHead>
                        <TableHead>Exchange</TableHead>
                        <TableHead>Product</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Entry</TableHead>
                        <TableHead className="text-right">Exit</TableHead>
                        <TableHead className="text-right">Realized P&L</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {closedTrades.map((trade, idx) => (
                        <TableRow key={`${trade.symbol}-${trade.exit_timestamp}-${idx}`}>
                          <TableCell>{trade.symbol}</TableCell>
                          <TableCell>{trade.exchange}</TableCell>
                          <TableCell>{trade.product ?? '-'}</TableCell>
                          <TableCell className="text-right">{trade.quantity}</TableCell>
                          <TableCell className="text-right">
                            {formatCurrency(trade.entry_price)}
                          </TableCell>
                          <TableCell className="text-right">
                            {formatCurrency(trade.exit_price)}
                          </TableCell>
                          <TableCell
                            className={cn(
                              'text-right font-medium',
                              trade.realized_pnl >= 0 ? 'text-green-600' : 'text-red-600'
                            )}
                          >
                            {formatCurrency(trade.realized_pnl)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
