# 56 - Consolidated Multi-Day P&L (fork-only)

> **Not part of upstream OpenAlgo.** This subsystem exists only on our fork
> (branch `feature/pnl-history`, off `upgrade-main-2026-09`) and is not
> intended to be filed upstream. Upstream permanently rejected an
> in-platform "Trade Journal"/persistent-P&L-history feature
> (marketcalls/openalgo#1683); everything here is our own operational
> tooling. See `SKYSHIELD_PATCHES.md` for the patch entry and touch-point
> inventory.
>
> This doc is numbered `56` to sit alongside the rest of `docs/design/`
> without colliding with the currently-highest number (`55`); if a future
> upstream sync introduces its own `56-...`, renumber this one rather than
> resolving a real conflict.

## Why a separate subsystem, not an extension of PnL Tracker

The built-in PnL Tracker (`docs/design/44-pnl-tracker`) is intraday-only and
persists nothing - by design, and correctly so for what it does. This
feature is the same "compute on read from a fills ledger, never persist a
result" philosophy, deliberately extended from one trading day to an
arbitrary multi-day range, modeled on Zerodha Console's own P&L report.
Multi-day requires *some* persistence (the day's trades still have to exist
somewhere once the trading day is over), which is exactly the "Trade
Journal" surface upstream rejected - hence a separate, fork-only subsystem
rather than a PR to `blueprints/pnltracker.py`.

## Where it lives, and why here rather than AlgoMirror

Storage and computation live in *each* per-account OpenAlgo instance
(acc1/arsalan, acc2/iram, acc3/iqbal), not centralized. AlgoMirror runs as
one instance aggregating all three accounts; putting the ledger there would
recreate the "one space for everyone's data" problem this design
deliberately avoids - each account's trade history lives with that
account's own broker session, on that account's own VM. AlgoMirror is a
thin aggregator calling each account's `/api/v1/pnl/history` (and, as of
2026-09-07, `/pnl/trades`, `/pnl/strategy-legs`, and the manual-tag PATCH
too) - built, not just planned; see AlgoMirror's own `KNOWN_ISSUES.md` for
its side of the story.

## Architecture

```text
services/tradebook_service.py (existing, unmodified)
        |
        v  (auth_token, broker) - never the api_key path, so Analyzer
        |   mode's sandbox trades can never enter this ledger
services/pnl_capture_service.py  --daily, APScheduler-- >  database/pnl_db.py
        (capture)                                          (pnl_trades,
                                                              pnl_capture_runs -
                                                              db/tradebook.db,
                                                              isolated file)
                                                                   ^
restx_api/pnl_history.py (POST /pnl/import) ----------------------|
        (CSV backfill, broker-agnostic column mapper)

restx_api/pnl_history.py (GET /pnl/history)
        -> services/pnl_history_service.py
              -> utils/pnl_fifo.py (pure calculation, FIFO, compute-on-read)

frontend/src/pages/TradeBook.tsx ("Upload" button, next to the existing
        "Export" button) -> frontend/src/api/trading.ts::importPnlHistoryCsv
        -> POST /api/v1/pnl/import  (reuses the page's own apiKey from
                                      useAuthStore - no separate session
                                      route; matches how every other call
                                      on this page already works)
```

## Files

| File | New/Touched | Purpose |
|---|---|---|
| `database/pnl_db.py` | New | Own isolated SQLite store (`db/tradebook.db`); `pnl_trades` (the ledger) and `pnl_capture_runs` (job audit log); `make_dedup_key`/`parse_trade_timestamp` shared helpers |
| `utils/pnl_fifo.py` | New | Pure FIFO matcher - no I/O, no Flask |
| `services/pnl_capture_service.py` | New | Daily capture job + `PnlCaptureScheduler` singleton (mirrors `HistorifyScheduler`) |
| `services/pnl_history_service.py` | New | Compute-on-read history service + CSV-import persistence |
| `restx_api/pnl_history_schema.py` | New | Marshmallow schemas - kept out of `account_schema.py` deliberately |
| `restx_api/pnl_history.py` | New | `GET /pnl/history`, `POST /pnl/import`; CSV column-alias mapper |
| `frontend/src/api/trading.ts` | Touched | `importPnlHistoryCsv` - one new function alongside the existing `getTrades` etc. |
| `frontend/src/pages/TradeBook.tsx` | Touched | "Upload" button + dialog next to the existing "Export" button |
| `database/apscheduler_jobstore_db.py` | Touched | `PNL_JOBSTORE_TABLE` constant + serialized init-phase registration |
| `utils/db_sessions.py` | Touched | One line: register `database.pnl_db`'s scoped session for teardown |
| `app.py` | Touched | One `db_init_functions` entry, one scheduler-startup `try/except` block (same shape repeated for Flow/Historify) |
| `restx_api/__init__.py` | Touched | Import + `add_namespace(pnl_history_ns, path="/pnl")` - a second namespace sharing `pnl_symbols_ns`'s existing path; verified no route collision |
| `.sample.env` | Touched | Documents `TRADEBOOK_DATABASE_URL` default alongside the other five store URLs |

Every touch to an existing upstream file is a small, additive, low-churn
change mirroring a pattern that already repeats 3-4 times in that same file
- the same discipline already proven for the eventlet monkey-patch (see
`SKYSHIELD_PATCHES.md`).

## Data model

**`pnl_trades`** - the sole source of truth. One row per fill, captured live
or imported from CSV. `dedup_key` (unique) is the idempotency key: the
broker's own `tradeid` when available (now correctly emitted as `tradeid`,
not `trade_id` - see the 2026-09-06 tradebook fix), or a normalized
composite of orderid/symbol/exchange/action/quantity/price/timestamp when
not. Numeric fields are coerced to a fixed-precision string before hashing
so `100`, `100.0`, and `"100"` from different callers (capture vs. CSV
import) hash identically.

`segment` - one of `database.pnl_db.VALID_SEGMENTS` (`equity`, `fno`,
`currency`, `commodity`, `mutual_fund`) - is computed once at write time by
`derive_segment(exchange)` and stored on the row, rather than re-derived
from `exchange` on every read/filter. Nullable: a few exchange codes
(index/quote symbols, crypto) don't map to any of the five and are left
unset. See "Segment and Symbol filters" below for why this replaced an
earlier query-time-only, two-value (`equity`/`fno`) version.

`strategy` - which SkyShieldAT strategy placed this trade (or `"Holdings"`,
OpenAlgo's own Holdings page placeholder for a manually-clicked order) -
backfilled at write time by joining the row's `orderid` against
`database.strategy_book_db`'s already-running orderid -> strategy tag (see
"Strategy attribution" below). Nullable for the same reasons `segment` can
be: CSV-imported history with no matching order, or a missing/expired tag.

**`pnl_capture_runs`** - one row per attempted daily capture, so a silent
failure (broker API down, auth expired) is a visible gap rather than
missing trades nobody notices until a report looks wrong.

No realized-P&L table exists. `utils/pnl_fifo.py::compute_realized_pnl` is
called fresh on every `GET /pnl/history` request.

## Daily capture job

`services/pnl_capture_service.py`'s `PnlCaptureScheduler` runs
`run_daily_capture` once daily at 16:00 IST (after NSE/BSE auto square-off
at 15:20), skipping NSE holidays via the existing
`database/market_calendar_db.py::is_market_holiday`. It resolves the
account's own auth via `database.auth_db.get_first_available_api_key` +
`get_auth_token_broker` (single-tenant instance, per `CLAUDE.md`), then
calls `get_tradebook(auth_token=..., broker=...)` directly - **not** the
`api_key=` path, because that path reroutes into sandbox trades whenever
Analyzer mode is toggled on, which must never happen for a real-money
ledger.

## Tradebook becomes historical too

User's original intent for the Upload feature was for Tradebook itself to
be able to show what got uploaded - not just a separate P&L report.
Comparing against the Zerodha screenshot again, `frontend/src/pages/
TradeBook.tsx` now has the same Segment/Symbol/Date-range filter row as
P&L History.

The real constraint: today's trades aren't in `pnl_trades` until the
16:00 IST daily capture job runs, so Tradebook can't switch to the ledger
unconditionally without losing live intraday visibility. Resolution:
`isHistorical = startDate !== today || endDate !== today`. Only when the
range is exactly today/today does `fetchTrades` fall back to the existing
live `services/tradebook_service.py`-backed `/tradebook` endpoint,
unchanged. Any other range uses the new `GET /api/v1/pnl/trades`
(`services/pnl_history_service.py::get_pnl_trades`) - raw ledger rows, no
FIFO matching at all (unlike `/pnl/history`, which is FIFO-matched
realized P&L - these are deliberately different shapes for deliberately
different questions: "what did I trade" vs. "what did I realize").

**Default range is the last 7 days** (start = today-7, end = today),
matching the Zerodha Console reference - so `isHistorical` is `true` by
default and the page opens on the ledger view, not the live-today view.
Narrowing the range to just today switches back to live.

Segment and Symbol are applied as **client-side** filters uniformly across
both data sources in `sortedAndFilteredTrades`, via `segmentOf()` -
preferring a row's own stored `segment` (present on historical rows from
`/pnl/trades`) and falling back to `EXCHANGE_SEGMENT_MAP`, a hand-mirrored
copy of `derive_segment()`/`_EXCHANGE_SEGMENT_MAP` on the backend for the
live-today path, which has no `segment` field at all (the broker's own
tradebook API doesn't have this concept).

**Fetch button**: added after the Segment/Symbol/Date filters landed,
matching `PnlHistory.tsx`'s pattern exactly. Data only auto-loads once, on
mount (or when `apiKey` first becomes available) - editing Segment,
Symbol, or either date no longer triggers an automatic re-fetch, since
that would fire a request per keystroke/date-picker interaction. The
mount effect deliberately depends on `[apiKey]`, not `[fetchTrades]` (that
would defeat the point, since `fetchTrades`'s own identity changes on
every filter edit) - flagged with a `biome-ignore lint/correctness/
useExhaustiveDependencies` comment rather than silently disabling the
rule project-wide. The existing header "Refresh" button is unchanged and
does the same thing as "Fetch" - left as-is rather than removed, since
removing it wasn't asked for.

A **Trade ID** column was added to the table (and CSV export) alongside
the existing Order ID - it was already correctly emitted end-to-end for
the live path since the 2026-09-06 tradebook fix, just never rendered.

## CSV import

`POST /api/v1/pnl/import` accepts a `multipart/form-data` upload
(`apikey` field + `file`). `restx_api/pnl_history.py`'s column-alias mapper
normalizes broker-specific CSV headers (case/spacing-insensitive) onto the
common shape, including combining a split `Trade Date` + `Order Execution
Time` pair into one timestamp when a broker's export doesn't carry a single
combined column - the exact gap that originally motivated using the
tradebook over Zerodha's raw P&L CSV export.

**Unverified**: the column-alias list is a best-effort mapper based on
general knowledge of Zerodha's tradebook CSV shape, not re-checked against
a real exported file in this change, and Kotak's export format has never
been checked against a real file at all. Confirm against a real CSV from
each broker before relying on this for anything but Zerodha.

### Real bug found on first real upload: multipart Content-Type

First actual click-test (a real Zerodha tradebook CSV, ~1300 rows) failed
with a generic "Failed to import CSV" toast. `nginx`'s access log showed
the real signal: `POST /api/v1/pnl/import` -> **400, 77 bytes** - reproduced
locally as the exact byte count of Marshmallow's
`{"apikey": ["Missing data for required field."]}`. The `apikey` field
never reached Flask at all.

Root cause, confirmed by reading `node_modules/axios/lib/defaults/index.js`
and `AxiosHeaders.js` directly rather than trusting the original comment's
assumption: `api/trading.ts`'s `apiClient` axios instance sets a default
`Content-Type: application/json` header. Axios's own `transformRequest`
checks `headers.getContentType()` *before* deciding whether to pass a
`FormData` body through untouched - since that default header was already
`application/json`, axios took the `hasJSONContentType` branch and
`JSON.stringify`'d the FormData instead of sending it as multipart. Flask
never saw a multipart body, so `request.form` was empty and the `apikey`
schema check failed first, before the file-presence check ever ran.

Fix: `importPnlHistoryCsv` now passes `headers: { 'Content-Type': undefined }`
in the per-request config. Verified via `AxiosHeaders.js`'s own merge
logic that an explicit `undefined` (not the literal string "undefined")
correctly clears the instance default - only a literal `false` blocks an
overwrite - so `getContentType()` returns falsy and `transformRequest`
passes the `FormData` through unmodified, letting the browser's XHR
adapter set its own `multipart/form-data; boundary=...` header.

Also hardened error surfacing while investigating: `TradeBook.tsx`'s
import handler previously showed a hardcoded "Failed to import CSV" on
any thrown error, discarding the real message the backend had already
sent back in the response body. Now matches the pattern already used in
`ActionCenter.tsx` - reads `error.response.data.message` when present.

## Navigation and the P&L History page

Deployed once with only the CSV Upload button on Trade Book (no dedicated
report page). User feedback after seeing it live: a new **Reports**
dropdown in the main navbar, next to Tools, modeled directly on Zerodha
Console's own Reports menu - Tradebook and P&L as its two options for now
("later we will see how we expand it").

- `frontend/src/config/navigation.ts`: `NavItem` gained an optional
  `children` field. Tradebook moved out of its own top-level `navItems`
  slot into a new `Reports` group's children, alongside a new `P&L` entry
  (`/pnl-history`). `navItems` stays at its existing length of 9 - the
  removal and the addition cancel out - so the existing
  `navigation.test.ts` length/ordering assertions needed no changes, only
  additions.
- `frontend/src/components/layout/Navbar.tsx`: the desktop nav's render
  loop special-cases `item.children` to open a `DropdownMenu` (the same
  component already used for the profile menu) instead of navigating
  directly; the trigger highlights active when the current route matches
  any child, not just the group's own placeholder href.
- Mobile has no nested-dropdown affordance in its "more" sheet - a group
  would 404 if linked to directly. `mobileSheetItems` now flattens a
  group's `children` into the sheet instead of showing the group itself
  (Tradebook still excluded there, same as before, since it already has a
  bottom-bar slot; P&L has no bottom-bar slot so the sheet is its only
  mobile entry point).
- `frontend/src/pages/PnlHistory.tsx` (new): date range in, `GET
  /api/v1/pnl/history` out - summary cards (total realized P&L, closed
  trade count), plus a Day-wise/Trade-wise `Tabs` toggle (see below) that
  shows either the daily breakdown table or the per-lot closed-trades
  table, never both at once. Nothing precomputed or cached client-side;
  every "Fetch" click re-runs the FIFO match server-side. Registered at
  `/pnl-history` in `App.tsx`.
- `frontend/src/api/trading.ts`: `getPnlHistory`, plus TypeScript
  interfaces mirroring `services/pnl_history_service.py::get_pnl_history`'s
  response shape exactly.

### Segment and Symbol filters

Added after seeing the page live, comparing against Zerodha Console's own
Tradebook/P&L filter row (Segment, Symbol, Date range). Symbol was already
supported server-side (`get_pnl_history`'s `symbol` param existed from the
first version) but never wired to the UI; Segment is new on both ends.

**First version** (query-time only, two values): `services/
pnl_history_service.py::get_pnl_history` filtered `PnlTrade.exchange`
directly against two hardcoded sets - "equity" = `{NSE, BSE}`, "fno" =
`utils.constants.FNO_EXCHANGES` (which bundles NFO/BFO/MCX/CDS/BCD/NCDEX/
NCO/crypto together). Filtering pre-FIFO was safe because exchange is
already part of the FIFO grouping key (`utils/pnl_fifo.py` groups by
symbol+exchange+product).

**Current version** (stored column, five values): the same day, comparing
against Zerodha Console's actual segment list, the two-value bundle was
replaced with five: Equity, Futures & Options, Currency, Commodity, Mutual
Funds - see the Data model section above for the exact exchange mapping
(`database/pnl_db.py::derive_segment`/`_EXCHANGE_SEGMENT_MAP`). Filtering
now checks the *stored* `PnlTrade.segment` column
(`WHERE segment = ?`) rather than an exchange-set membership test computed
fresh on every query - simpler, and the value is directly visible when
inspecting a row rather than only derivable by re-checking exchange.
`restx_api/pnl_history_schema.py`'s `segment` field validates against
`OneOf(list(database.pnl_db.VALID_SEGMENTS))`, importing the tuple rather
than hardcoding a second copy of the five values. "mutual_fund" is
accepted by the schema and appears in both dropdowns for parity with the
Zerodha reference, but no OpenAlgo exchange constant maps to it - no real
row will ever carry that segment until MF broker support exists.

The frontend has no import path into `database/pnl_db.py`, so
`frontend/src/pages/TradeBook.tsx`'s `EXCHANGE_SEGMENT_MAP` mirrors
`_EXCHANGE_SEGMENT_MAP` by hand (kept in sync manually - update both if the
mapping ever changes). This fallback is only reached for live-today Trade
rows, which have no `segment` field at all (the broker's own tradebook API
doesn't have this concept); historical rows from `GET /api/v1/pnl/trades`
carry the real stored value already. The `Segment` type itself lives once
in `frontend/src/types/trading.ts`, imported by `TradeBook.tsx`,
`PnlHistory.tsx`, and `api/trading.ts` so the value set can't drift between
them.

**Migration**: `pnl_trades.segment` was added to an already-deployed (but
still-empty on every VM) table via `database/pnl_db.py::_migrate_add_
segment_column`, mirroring `sandbox_db.py`'s own column-migration pattern
exactly (`PRAGMA table_info` check, `ALTER TABLE ADD COLUMN`, explicit
index creation since `ALTER TABLE` doesn't pick up the model's
`index=True`).

**Rename**: the store itself was renamed from `db/pnl.db`
(`PNL_DATABASE_URL`) to `db/tradebook.db` (`TRADEBOOK_DATABASE_URL`) in the
same round - it holds the raw fill ledger only, never a computed P&L
value, so "pnl.db" was a misleading name from the start. Safe to rename
outright (no migration needed) since every VM's copy was still empty at
the time.

### Day-wise / Scrip-wise toggle

Added 2026-09-06 after the 7-day-default/Fetch-button round on Trade Book:
`PnlHistory.tsx` previously rendered both the Daily Breakdown table and the
Closed Trades table stacked on the same page at once. User asked for only
one to show at a time, picked by a toggle - matching Zerodha Console's own
P&L report, which shows either its "Day-wise" or "Scrip-wise" view, never
both. Implemented with the existing `Tabs`/`TabsList`/`TabsTrigger`
primitives (`frontend/src/components/ui/tabs.tsx`, already in the design
system, unused until now) rather than adding a new toggle component - a
`view: 'day' | 'scrip'` state var controls which Card renders, defaulting
to `'day'`. No new fetch is triggered by switching tabs; `closedTrades` is
already in state from the last Fetch, so the toggle is purely a
client-side render switch.

**Scrip-wise aggregation** (same day, immediate follow-up): the second tab
first shipped as a flat list of every FIFO-matched lot (one row per
entry/exit pair, labeled "Trade-wise"). User then asked to merge rows by
symbol instead - confirmed via web search that this is the real Scrip-wise
convention (Zerodha's own Tax P&L equity sheet reports buy value, sell
value and P&L per scrip, not per lot; "all brokers follow this" per the
user). Replaced the flat list with a `scripRows` aggregation
(`useMemo` over `closedTrades`, grouped by `symbol|exchange|product`):
`entry_action` on each lot says which leg was the entry, so a `BUY`-entry
lot's buy value is its entry leg and sell value its exit leg, and a
`SELL`-entry lot (a short) is the reverse - summed per group into total
quantity, buy value, sell value, trade count, and net realized P&L. Tab
renamed "Trade-wise" -> "Scrip-wise" to match; the per-lot Entry/Exit price
columns were dropped from the table since they stop being meaningful once
multiple lots at different prices are merged into one row.

### Heat maps

Added 2026-09-06, same day: user asked about the calendar heat maps on
Zerodha Console's own reports - confirmed via Zerodha's support docs there
are two, distinct in both data and color:

- **P&L report's heat map**: green/red by that day's gross realized P&L,
  shade intensity scaled to magnitude (lighter = smaller swing, darker =
  larger). Hovering a tile shows the day's realized P&L.
- **Tradebook report's heat map**: blue by that day's trade count, shade
  intensity scaled to volume (4 levels per Zerodha's own docs - lighter =
  fewer trades, darker = more). Clicking a tile drills into that day's
  trades on the real Console; this fork's version shows the count on
  hover instead, since drill-down would just reopen the same trade list
  already on the page below it, filtered to one day.

Both are the same calendar-grid layout with a different value and color
function, so the layout itself lives once in `frontend/src/components/
reports/CalendarHeatmap.tsx` (new) - a `CalendarHeatmap` component taking
`days: {date, value, tooltip}[]`, a `startDate`/`endDate` (for month
enumeration and to gray out days outside the fetched range even when they
fall inside a rendered month), and a `colorFor(value, maxAbs)` function.
Each page supplies its own data and color scale:

- `PnlHistory.tsx`: `heatmapDays` maps `daily` (already in state from the
  last Fetch) to `{date, value: realized_pnl, tooltip}`; `pnlHeatColor`
  does the green/red scale. Rendered as its own Card, always visible above
  the Day-wise/Trade-wise toggle (a user decision - "always visible above
  the toggle" over a third tab - since it's a single at-a-glance summary
  rather than another detail view to switch to).
- `TradeBook.tsx`: `tradeHeatmapDays` groups `sortedAndFilteredTrades`
  (already Segment/Symbol/date-filtered) by day via a new `dateKeyOf`
  helper - reads the `YYYY-MM-DD` prefix directly when the timestamp is
  already ISO-shaped (every historical/ledger row), otherwise falls back
  through the existing `parseTimestamp` and reads the calendar date in the
  browser's local timezone (the same implicit timezone assumption
  `formatTime`'s `toLocaleTimeString('en-IN', ...)` already makes
  elsewhere on this page, not a new one). `tradeCountHeatColor` does the
  blue scale. Rendered above the Trades Table, below the Stats Cards.

Both heat maps are pure client-side renders of data already being
fetched for their page's table/breakdown - no new endpoint, no new
request on render.

### Strategy attribution

Added 2026-09-07, following a discussion that started as "let's add
strategy-wise P&L" and turned up something worth documenting carefully:
an earlier claim in that same discussion (that SkyShieldAT's `strategy`
field - required on every `placeorder` call - is submitted then discarded,
never persisted) was **wrong**, caught and corrected before any code was
written against the false premise.

What was actually missed: OpenAlgo already has a real, already-running
upstream feature called the **strategy book**
(`database/strategy_book_db.py` + `subscribers/strategy_book_subscriber.py`,
built for Flow's per-strategy risk management). Its subscriber listens to
the **generic** event-bus topics `order.placed`/`order.update` (plus the
batch-completion topics for basket/split/options orders) - topics
`services/place_order_service.py::place_order_with_auth` publishes for
every order, Flow or not, live or analyze - not a Flow-only hook. Verified
directly against a real account's `openalgo.db`: 54 real
`strategy_positions` rows, real strategy names (`DonchianSwing`,
`IntradayIronFly`, `IronCondor`), persisting across days (`quantity`/
`average_price`/cumulative `realized_pnl` carry forward; only
`today_realized_pnl` resets on the first fill of a new trading date). So
the capture problem was already solved - the actual gap was narrower:
nothing exposed this data via a REST endpoint or UI, and `pnl_trades` had
no `strategy` column to filter or group by.

**What this feature adds on top of the already-running strategy book:**

- `database.pnl_db.PnlTrade.strategy` (see Data model above) - backfilled
  by `services/pnl_capture_service.py::_lookup_strategy` (and the
  equivalent in the CSV import path), joining each fill's `orderid`
  against `strategy_book_db.get_order_tag()` - a function that already
  existed, previously only called internally by the strategy book's own
  fill-booking code (`_apply_fill_locked`).
- `strategy` as a third pre-filter alongside segment/symbol
  (`_parse_range_and_build_query`) - applied to `PnlTrade` rows *before*
  `get_pnl_history`'s FIFO matching ever runs, exactly like segment/symbol
  already work. A strategy-filtered response's `closed_trades`/`daily`/
  `scrip_rows` are single-strategy by construction, with zero changes
  needed to `utils/pnl_fifo.py` itself - no ambiguity about which strategy
  a closed lot (which can span two physical fills) belongs to, because
  only that one strategy's fills were ever in the query.
- `GET /api/v1/pnl/strategy-legs` (new) - a thin read wrapper over
  `strategy_book_db.get_strategy_legs()`. This is "holdings, per
  strategy" already computed server-side (current open quantity, average
  price, cumulative realized P&L per leg) - genuinely not derived from
  `pnl_trades`/the FIFO ledger at all, a different and more direct data
  source for the same underlying question.
- `PATCH /api/v1/pnl/trades/<id>/strategy` (new) - the manual fallback,
  for CSV-imported history and any trade placed with no `orderid` to
  automatically join against (a manual buy placed directly in a broker's
  own app rather than through OpenAlgo, for instance).
- `PnlHistory.tsx` gained a Strategy filter (dropdown, populated from this
  account's own strategy book rather than a fixed enum like Segment) and
  a "Strategy Positions" table reading `strategy-legs` directly -
  independent of the date-range Fetch cycle, since strategy legs are
  current state, not historical trades.
- `TradeBook.tsx` gained a Strategy filter and a per-row inline tag editor
  on historical rows (click the cell, type a name, Enter to save) - `id`
  and `strategy` were added to both the `Trade` type and
  `get_pnl_trades`'s response so the editor can address one specific row.

**Found while verifying against a real account, not a bug in this
feature**: `strategy_positions` already had a `'Holdings'` value from
OpenAlgo's own Holdings page hardcoding `strategy="Holdings"` on any
manual Add/Exit click (`frontend/src/pages/Holdings.tsx:1011`), and a
real diverging `DonchianSwing`/`CREDITACC` quantity from a manual top-up
the user placed outside OpenAlgo's own order flow (confirmed with the
user - a real, expected divergence, not a data bug). Both are exactly the
class of gap a future "holdings from tradebook, reconciled against the
broker's own Holdings API rather than replacing it" feature would need to
handle - discussed, not yet scoped or started.

AlgoMirror's own strategy-attribution work (client methods, the
cross-account merge, new routes, and the corresponding UI on both pages)
is documented in AlgoMirror's own `KNOWN_ISSUES.md` item #8, not
duplicated here.

## Import UI

An "Upload" button sits next to the existing "Export" button on the Trade
Book page (`frontend/src/pages/TradeBook.tsx`), opening a dialog for a
single CSV file. It reuses the page's own `apiKey` (already in
`useAuthStore` from login - never typed by hand) via a new
`tradingApi.importPnlHistoryCsv` function
(`frontend/src/api/trading.ts`), which posts a `FormData` body to
`/api/v1/pnl/import` through the existing `apiClient` axios instance -
consistent with how every other call on that page already works (unlike
Historify's own upload, which goes through a session-authenticated
blueprint route instead; that pattern wasn't a fit here because this page's
existing data calls already go through `/api/v1/*` with an explicit
`apiKey`, not a session route).

Deliberately placed on the Trade Book page only, not a standalone page -
this was a user decision, matching "a simple upload button in the tradebook
page only" over a full dedicated import page or a bare API-only endpoint.

## Status (as of 2026-09-06)

**Deployed and live on acc1**, in four same-day rounds, each verified
directly on the running service after deploy (not just built locally):
storage + daily capture + Upload button; the Reports dropdown + P&L
History page; Segment/Symbol filters (two-value version, since superseded);
Tradebook's historical view + Trade ID column. See `SKYSHIELD_PATCHES.md`
for the full chronological log of each round's specific verification
evidence.

**Pending deploy** (this section's most recent edit): the stored `segment`
column (five values, replacing the two-value query-time version) and the
`db/pnl.db` -> `db/tradebook.db` rename - built and verified locally
(migration tested against a simulated pre-existing table, `derive_segment`
checked against every mapped exchange, a full equity/currency/commodity
split test, schema validation for all five values including the
never-yet-real `mutual_fund`), not yet pushed to any VM.

**Still unverified anywhere**: no real trade has been captured or imported
on any account yet (deployed ahead of Monday market open, by explicit user
decision); the CSV column-alias mapper against a real exported file from
either broker; every UI surface (Upload button, Reports dropdown, P&L
History page, Tradebook's historical mode, all the Segment/Symbol filters)
has been type-checked/linted/unit-tested but never clicked through in an
actual browser session.
