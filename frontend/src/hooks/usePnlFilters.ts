// frontend/src/hooks/usePnlFilters.ts
/**
 * Shared filters for the merged P&L page (fork-only, SKYSHIELD_PATCHES.md):
 * segment, P&L type, date range and the active tab live in the URL query, so a
 * refresh or a shared link opens the same view. Segment and P&L type start
 * empty on purpose: nothing is fetched until both are chosen.
 */
import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { Segment } from '@/types/trading'

export type PnlSegmentChoice = '' | 'all' | Segment
export type PnlTypeChoice = '' | 'realized' | 'unrealized' | 'combined'
export type PnlTab = 'report' | 'curve'

/** What an embedded tab gets: always complete, plus a counter that bumps on Fetch. */
export interface PnlEmbeddedFilters {
  segment: 'all' | Segment
  pnlType: 'realized' | 'unrealized' | 'combined'
  startDate: string
  endDate: string
  fetchToken: number
}

const SEGMENTS: PnlSegmentChoice[] = [
  'all',
  'equity',
  'fno',
  'currency',
  'commodity',
  'mutual_fund',
]
const TYPES: PnlTypeChoice[] = ['realized', 'unrealized', 'combined']

function isoDate(d: Date): string {
  return d.toLocaleDateString('en-CA')
}

export function usePnlFilters() {
  const [params, setParams] = useSearchParams()
  const [fetchToken, setFetchToken] = useState(0)
  const [activePreset, setActivePreset] = useState<string | null>(null)

  const today = isoDate(new Date())
  const thirtyAgo = (() => {
    const d = new Date()
    d.setDate(d.getDate() - 30)
    return isoDate(d)
  })()

  const rawSegment = params.get('segment') ?? ''
  const segment = (
    SEGMENTS.includes(rawSegment as PnlSegmentChoice) ? rawSegment : ''
  ) as PnlSegmentChoice
  const rawType = params.get('type') ?? ''
  const pnlType = (TYPES.includes(rawType as PnlTypeChoice) ? rawType : '') as PnlTypeChoice
  const startDate = params.get('start') || thirtyAgo
  const endDate = params.get('end') || today
  const tab: PnlTab = params.get('tab') === 'curve' ? 'curve' : 'report'

  const update = useCallback(
    (changes: Record<string, string | null>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          for (const [key, value] of Object.entries(changes)) {
            if (value === null || value === '') next.delete(key)
            else next.set(key, value)
          }
          return next
        },
        { replace: true }
      )
    },
    [setParams]
  )

  const ready = segment !== '' && pnlType !== ''

  const embedded: PnlEmbeddedFilters | null = useMemo(
    () =>
      ready
        ? {
            segment: segment as 'all' | Segment,
            pnlType: pnlType as 'realized' | 'unrealized' | 'combined',
            startDate,
            endDate,
            fetchToken,
          }
        : null,
    [ready, segment, pnlType, startDate, endDate, fetchToken]
  )

  return {
    segment,
    pnlType,
    startDate,
    endDate,
    tab,
    ready,
    embedded,
    activePreset,
    today,
    setSegment: (value: PnlSegmentChoice) => update({ segment: value }),
    setPnlType: (value: PnlTypeChoice) => update({ type: value }),
    setStartDate: (value: string) => {
      setActivePreset(null)
      update({ start: value })
    },
    setEndDate: (value: string) => {
      setActivePreset(null)
      update({ end: value })
    },
    setTab: (value: PnlTab) => update({ tab: value }),
    applyPreset: (start: string, end: string, key: string) => {
      setActivePreset(key)
      update({ start, end })
      setFetchToken((n) => n + 1)
    },
    fetch: () => setFetchToken((n) => n + 1),
  }
}
