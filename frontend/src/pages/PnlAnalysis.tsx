// frontend/src/pages/PnlAnalysis.tsx
/**
 * P&L Analysis (fork-only, SKYSHIELD_PATCHES.md): the P&L History report and
 * the P&L Curve under one filter bar and two tabs. Both tabs run on the same
 * matching engine, so the same filters always give the same realized number.
 * The old /pnl-history and /pnl-curve pages stay available side by side.
 */
import { PnlFilterBar } from '@/components/reports/PnlFilterBar'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { type PnlTab, usePnlFilters } from '@/hooks/usePnlFilters'
import PnlCurve from '@/pages/PnlCurve'
import PnlHistory from '@/pages/PnlHistory'

export default function PnlAnalysis() {
  const filters = usePnlFilters()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">P&L Analysis</h1>
        <p className="text-muted-foreground">
          Realized and unrealized profit and loss for a date range: the report tables and the curve
          share one set of filters
        </p>
      </div>

      <PnlFilterBar filters={filters} />

      <Tabs value={filters.tab} onValueChange={(v) => filters.setTab(v as PnlTab)}>
        <TabsList>
          <TabsTrigger value="report">Report</TabsTrigger>
          <TabsTrigger value="curve">Curve</TabsTrigger>
        </TabsList>
      </Tabs>

      {!filters.embedded ? (
        <div className="text-center py-16 text-muted-foreground">
          <p className="font-medium">Build a report</p>
          <p className="text-sm">Choose a segment and a P&L type, then click Fetch</p>
        </div>
      ) : filters.tab === 'report' ? (
        <PnlHistory embedded={filters.embedded} />
      ) : (
        <PnlCurve embedded={filters.embedded} />
      )}
    </div>
  )
}
