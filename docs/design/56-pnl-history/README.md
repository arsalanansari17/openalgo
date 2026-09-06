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
account's own broker session, on that account's own VM. AlgoMirror's future
role is a thin aggregator calling each account's `/api/v1/pnl/history`.

## Architecture

```text
services/tradebook_service.py (existing, unmodified)
        |
        v  (auth_token, broker) - never the api_key path, so Analyzer
        |   mode's sandbox trades can never enter this ledger
services/pnl_capture_service.py  --daily, APScheduler-- >  database/pnl_db.py
        (capture)                                          (pnl_trades,
                                                              pnl_capture_runs -
                                                              db/pnl.db,
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
| `database/pnl_db.py` | New | Own isolated SQLite store (`db/pnl.db`); `pnl_trades` (the ledger) and `pnl_capture_runs` (job audit log); `make_dedup_key`/`parse_trade_timestamp` shared helpers |
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
| `.sample.env` | Touched | Documents `PNL_DATABASE_URL` default alongside the other five store URLs |

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
  trade count), a daily breakdown table, and a per-lot closed-trades table.
  Nothing precomputed or cached client-side; every "Fetch" click re-runs
  the FIFO match server-side. Registered at `/pnl-history` in `App.tsx`.
- `frontend/src/api/trading.ts`: `getPnlHistory`, plus TypeScript
  interfaces mirroring `services/pnl_history_service.py::get_pnl_history`'s
  response shape exactly.

### Segment and Symbol filters

Added after seeing the page live, comparing against Zerodha Console's own
Tradebook/P&L filter row (Segment, Symbol, Date range). Symbol was already
supported server-side (`get_pnl_history`'s `symbol` param existed from the
first version) but never wired to the UI; Segment ("Equity" vs "Futures &
Options") is new on both ends.

`services/pnl_history_service.py::get_pnl_history` gained a `segment`
param, filtering `PnlTrade.exchange` before FIFO matching - safe because
exchange is already part of the FIFO grouping key
(`utils/pnl_fifo.py` groups by symbol+exchange+product), so a segment
filter can never split one FIFO queue across the filter boundary. The
exchange sets aren't reinvented: "equity" is `{NSE, BSE}`, "fno" reuses
`utils.constants.FNO_EXCHANGES` directly (NFO/BFO/MCX/CDS/BCD/NCDEX/NCO/
crypto - the same set every other OpenAlgo service already treats as
"derivatives"), so this can never drift from the canonical definition.
`restx_api/pnl_history_schema.py`'s `segment` field validates against
`OneOf(["equity", "fno"])` - the frontend sends `undefined` (dropped by
axios, not an empty string) rather than a literal "all" value for the
unfiltered case, since the schema has no third valid value for it.

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

**Deployed and live on acc1.** Backend + Upload button deployed first;
verified on the running service: `db/pnl.db` created with both tables,
`pnl_apscheduler_jobs` has the daily-capture job registered, no errors in
`journalctl`, and the served `TradeBook-*.js` bundle contains the new
import strings. The Reports dropdown + P&L History page (this section's
own subject) is a same-day follow-up built after seeing the first deploy
live - type-checks, lints, and unit tests (`navigation.test.ts`,
`Navbar.test.tsx`, `MobileBottomNav.test.tsx`) all pass, `npm run build`
confirmed compiling, ready for the same deploy procedure.

**Still unverified**: no real trade has been captured or imported yet on
any account (Sunday, markets closed - deployed ahead of Monday's live
verification, by explicit user decision); the CSV column-alias mapper
against a real exported file from either broker; the Upload button and the
new P&L History page have not been clicked in a live browser session, only
built and type/lint/unit-tested.
