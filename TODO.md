# OpenAlgo (SkyShieldEdge fork) - TODO

The single place for open OpenAlgo work. Convention: one line per item with the
date it was added and the **next action**; when finished, move it to **Done**
with the date. Bugs/limitations that are not yet scheduled work go in
`SKYSHIELD_PATCHES.md` ("Known limits") - link them here, don't copy them.

Deployed branch today: `upgrade-main-2026-09-27` (worktree `openalgo-sync`), all 3 VMs
on the same commit. **Target: the fork's `main`** (= upstream + our patches, long-lived; sync by merging
upstream into it, never a new dated branch) - see the first item below. Push to the `fork` remote only, never `origin` (upstream).
`D:\Projects\SkyShieldEdge\openalgo` is still checked out on the old
`upgrade-main-2026-09` - work in `openalgo-sync`.

## Open

### Do next

- [ ] **Gunicorn's eventlet worker is deprecated** (warning at every start: "will be removed in Gunicorn 26"; our pin
  is `gunicorn>=25.0,<26`). Our #1421 patches and eventlet assumptions depend on it. Plan before Gunicorn 26 / upstream
  dropping eventlet: evaluate `OPENALGO_WORKER_CLASS=gthread` (opt-in, upstream guide `docs/gthread/README.md`) on one
  account in a market-off window. Not urgent.

- [ ] After a few trading days on `main`: point `openalgo-sync` at `main`, delete the dated branches on the fork
  (`main-sync-*`, `upgrade-main-*`) and the 17 stale local fix branches (check each is contained first).
- [ ] The 24 test failures that also fail on pristine upstream (Windows / async plugin / installer scripts) are
  environment noise on this machine; install `openscript==0.8.1` locally to run `test_openscript*`.
- [ ] **Re-upload Console CSVs to recover rows the old dedup key silently dropped**
  (2026-10-01). Any fill whose Zerodha trade id matched an older fill was skipped
  with no error, in both import and daily capture. Fixed going forward; past
  losses are not auto-recovered. Next action: per Zerodha account (acc1, acc2),
  upload the full Console tradebook for the period captured so far and compare
  row counts. acc2 F&O + equity already done 2026-10-01 (ledger 3,435 rows).
- [ ] **Delete the pre-change DB backups on each VM** (user: later, not now) -
  `/home/arsalanansari17/retag_work/`: `tradebook.pre-dedupfix-20261001.db` and the
  `*.pre-retag-20261001` copies (`openalgo.db`, `sandbox.db`, `tradebook.db`).
  The retag ones contain credentials. Run `ls -la` there first and delete only
  those names.

### Mobile friendly (added 2026-10-01, user request)
- [ ] Make the OpenAlgo web UI usable on a phone. Static audit done 2026-10-02: viewport tag is set
  and every daily-use page (Holdings, Positions, OrderBook, TradeBook, PnlHistory, OptionChain) already
  has a horizontal-scroll wrapper; 18 admin/monitoring pages (Telegram, Holidays, FreezeQty, Latency/
  Security/Traffic dashboards, Health, Arbitrage, Download, chartink, strategy Detail, ...) have tables
  with none. What is NOT known is how it looks: needs a phone-width visual pass. Next action:
  open the pages we use daily at ~390px width (P&L History incl. the CSV import
  dialog, Holdings, Positions, Orderbook, Tradebook, Funds, Dashboard) and list what
  breaks (wide tables, dialogs, filters, navbar) in this file; then fix the worst
  first. The frontend is React in `frontend/`; rebuild `frontend/dist` and compare the
  served bundle hash on each VM after deploying, as in the usual update procedure.
  Fork-only pages (P&L History) are ours to change freely; upstream pages are
  patched only as a logged fork patch.

### Known limits (see SKYSHIELD_PATCHES.md)
- [ ] Imported vs captured F&O symbols differ for Zerodha (`NIFTY2690123900PE` vs
  `NIFTY01SEP2623900PE`), so a position spanning the import/capture boundary does
  not match; 69 single-sided legs from expired contracts leave Jun/Jul ranges wrong
  (2026-09-21).
- [ ] `parse_trade_timestamp` dates an unparseable CSV timestamp as "now" instead of
  skipping the row (2026-10-01). Decide: skip + report, or leave.
- [ ] Kotak statement import: futures/currency/commodity lines are rejected as
  unsupported (not traded here). Revisit only if that changes.
- [ ] Optional: a note on the P&L History page that today's trades appear after
  16:00 IST and Zerodha Console lags a day (2026-09-21).

### Upstream (marketcalls/openalgo)
- [ ] #2137 (`openingbalance`) and #2131 (chart drawings per pane): both still OPEN, 0 comments as of
  2026-10-02; the fix PR #2138 for #2131 was closed unmerged. Re-check later; patch only if blocking.
- [ ] Holdings pledged/T1 quantity fix: live since July, upstream issue/PR not yet
  raised (verify-in-production period is long over).
- [ ] MARKET order near the upper circuit: cap at the circuit in the Zerodha adapter
  (`broker/zerodha/api/order_api.py`) and PR upstream. Deferred - the bot's own
  `_poll_fill` fix already prevents phantom fills.
- [ ] `websocket_proxy/server.py` `authenticate_client()` calls `adapter.connect()`
  synchronously inside a coroutine (latent bug, shows up when `threading.Event`
  is monkey-patched). Issue still "to file".

## Done
- 2026-10-04 CI on the fork: Docker image jobs now run only on marketcalls/openalgo (no more failure emails); the CI
  dist-rebuild commit `84fdb199d` pulled in and deployed to the VMs.
- 2026-10-04 fork `main` (`bbbab68ec` = upstream `ad2a3f505` + our patches) deployed to acc1, acc2, acc3 (previous
  HEAD `b7bf553dc`, rollback = `upgrade-main-2026-09-27`; DB backups in `db/backup_20261004_pre_main_sync/` on each VM).
  Verified per VM: service active, no errors, migrations OK, served bundle = local build, https 200, ledger intact
  (14,236 / 3,435 / 319, 0 legacy keys). Not yet seen: the SkyShieldAT bot running against the new OpenAlgo (see
  SkyShieldAT/TODO.md Monday check).
- 2026-10-02 acc3 ledger verified after the Kotak upload: 319 rows = 266 captured + 53 imported
  (2026-08-21..09-09); equity nets match the statements (WELCORP flat, CYIENT 125, ENGINERSIN 505).
- 2026-10-02 `openalgo/` folder decision: leave it on the old branch (rollback copy), work only in
  `openalgo-sync`; recorded in CLAUDE.md.
- 2026-10-02 Kotak statements uploaded to acc3 by the user. Result figures not checked by us
  (VM was off afterwards); expected acc3 ledger = 266 captured + 53 imported = 319 rows. Check
  next time the VM is up, together with any other acc3 read.
- 2026-10-01 P&L ledger dedup key fixed (date + exchange family + tradeid) - `2037ae4be`,
  all 3 VMs, 14,236 / 1,839 / 266 legacy keys migrated.
- 2026-10-01 Kotak "Transaction Statement" import (header-detected, broker-guarded) -
  `b7bf553dc`, all 3 VMs.
