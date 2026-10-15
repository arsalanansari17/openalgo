// frontend/src/components/pnl/PnlStrategiesPanel.tsx
/**
 * Strategies pane of the P&L page (fork-only): a chip per strategy and the
 * per-strategy table. The chips ARE the strategy filter: clicking one edits the
 * same list the Filters dialog edits, so there is one switch. An empty list
 * means every strategy is in.
 */
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { PnlTableFilters } from '@/hooks/usePnlFilters'
import { cumulative, strategySummaries } from '@/lib/pnlCurve'
import { NO_STRATEGY, type PnlModel } from '@/lib/pnlModel'
import { strategyColor } from '@/lib/pnlPalette'
import { cn } from '@/lib/utils'

const pnlClass = (value: number) => (value >= 0 ? 'text-green-600' : 'text-red-600')

function percent(value: number | null): string {
  return value === null ? '-' : `${(value * 100).toFixed(0)}%`
}

function ratio(value: number | null): string {
  return value === null ? '-' : value.toFixed(2)
}

interface Props {
  model: PnlModel
  filters: PnlTableFilters
  onFilters: (value: PnlTableFilters) => void
  formatCurrency: (value: number) => string
  isDark: boolean
}

export function PnlStrategiesPanel({ model, filters, onFilters, formatCurrency, isDark }: Props) {
  const [open, setOpen] = useState(true)
  const rows = useMemo(() => strategySummaries(model.series), [model.series])
  const names = model.strategyNames

  const lastOf = (name: string): number => {
    const daily = model.allSeries.byStrategy.get(name)
    if (!daily) return 0
    const cum = cumulative(daily)
    return cum.length ? cum[cum.length - 1] : 0
  }

  // Toggle one chip against the inclusion list. Clicking while every strategy
  // is in switches that one off; the list collapses back to "all" when full.
  const toggle = (name: string) => {
    const current = filters.strategies.filter((s) => s !== NO_STRATEGY)
    const all = names
    let next: string[]
    if (filters.strategies.length === 0) {
      next = all.filter((n) => n !== name)
    } else if (current.includes(name)) {
      next = current.filter((n) => n !== name)
    } else {
      next = [...current, name]
    }
    if (next.length === 0) next = [NO_STRATEGY]
    else if (next.length >= all.length && all.every((n) => next.includes(n))) next = []
    onFilters({ ...filters, strategies: next })
  }

  if (names.length === 0) return null

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            className="flex items-start gap-2 text-left"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            {open ? (
              <ChevronDown className="mt-1 h-4 w-4" />
            ) : (
              <ChevronRight className="mt-1 h-4 w-4" />
            )}
            <span>
              <CardTitle className="text-base">Strategies</CardTitle>
              <CardDescription>
                Click a name to include or exclude it. Everything on the page follows.
              </CardDescription>
            </span>
          </button>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => onFilters({ ...filters, strategies: [] })}
            >
              All
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onFilters({ ...filters, strategies: [NO_STRATEGY] })}
            >
              None
            </Button>
          </div>
        </div>
      </CardHeader>
      {open && (
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {names.map((name) => {
              const on = model.isSelected(name)
              return (
                <button
                  key={name}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(name)}
                  className={cn(
                    'flex items-center gap-2 rounded-full border px-3 py-1 text-sm transition-opacity',
                    !on && 'opacity-40'
                  )}
                >
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: strategyColor(name, model.coloured, isDark) }}
                  />
                  <span>{name}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {formatCurrency(lastOf(name))}
                  </span>
                </button>
              )
            })}
          </div>
          {rows.length > 0 && (
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
                  {rows.map((row) => (
                    <TableRow key={row.strategy}>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <span
                            className="inline-block h-2.5 w-2.5 rounded-full"
                            style={{
                              backgroundColor: strategyColor(row.strategy, model.coloured, isDark),
                            }}
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
  )
}
