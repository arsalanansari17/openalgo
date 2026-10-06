# OpenAlgo (SkyShieldEdge fork) - TODO

The single place for open OpenAlgo work. Convention: one line per item with the
date it was added and the **next action**; when finished, move it to **Done**
with the date. Bugs/limitations that are not yet scheduled work go in
`SKYSHIELD_PATCHES.md` ("Known limits") - link them here, don't copy them.

Deployed and local branch: the fork's `main` (= upstream + our patches; all 3 VMs run the same commit). `openalgo/` is the
only local checkout. Sync = merge upstream into `main` (never a new dated branch). Push to the `fork` remote only,
never `origin` (upstream). Rollback branch on the fork: `upgrade-main-2026-09-27`.

## Open

### Do next

- [ ] **Gunicorn's eventlet worker is deprecated** (warning at every start: "will be removed in Gunicorn 26"; our pin
  is `gunicorn>=25.0,<26`). Our #1421 patches and eventlet assumptions depend on it. Plan before Gunicorn 26 / upstream
  dropping eventlet: evaluate `OPENALGO_WORKER_CLASS=gthread` (opt-in, upstream guide `docs/gthread/README.md`) on one
  account in a market-off window. Not urgent.

- [ ] After a few trading days on `main`: delete the dated branches on the fork
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

### Strategy view on Positions / Holdings (added 2026-10-06)
Plan: `~/.claude/plans/let-s-first-make-a-tingly-wreath.md`. Source of truth is the strategy book
(`strategy_positions`), via `POST /api/v1/pnl/attribution`. See SKYSHIELD_PATCHES.md 2026-10-06.
- [ ] **Phase 1+2 built locally on `main`, uncommitted, not deployed** (2026-10-06). Next action: user reviews the
  diff, commit, then deploy to acc1, acc2, acc3 only after 15:40 IST (never in market hours; VMs stop 16:15).
- [ ] **Phase 0: check the book on each VM** (read-only): do `strategy_positions` legs match live holdings and
  positions, and do legs still carry the old name `DonchianSwing` (the 10-01 retag may have missed
  `strategy_positions` / `strategy_order_tags`)? Needs approval inside 08:30-15:30 IST.
- [ ] Browser check after deploy: Positions > Filters > Grouping "Strategy"; Holdings > Filters > Strategy chips;
  totals vs the broker's own; 390px width.
- [ ] **P&L | M2M switch on Positions built locally, uncommitted, not deployed** (2026-10-06). P&L = the broker's own
  figure (default); M2M = today's move from fills and yesterday's close, verified exact against Zerodha (acc1) and
  Kotak (acc3) on real rows. Next action: user reviews the diff, commit, deploy after 15:40 IST, then check in the
  browser (Positions > P&L | M2M).
- [ ] **Fork `main` is AHEAD of what the VMs run (2026-10-06 night) - do not deploy before the market closes.** All three
  VMs run `f5e77130a` (verified: sanity passed on each, bots active). Two later commits on `main` port upstream PR #2181's
  two review rounds (bad data and unusable fills, stale and duplicate requests, the tracker naming its basis, Holdings
  and Positions fixes). Tests pass (111 backend, 59 frontend) but they are NOT deployed. Next action: deploy to acc1,
  acc2, acc3 only after 15:40 IST on a trading day, with a DB backup, then the bot sanity check on each, and not on a day
  you cannot watch it. Rollback = `git checkout f5e77130a` and restart OpenAlgo.
- [ ] **P&L Tracker with the P&L | M2M switch, deployed to acc1** (2026-10-06; acc2 and acc3 not yet): `services/pnl_tracker_m2m.py` + a 33-line hook in
  `blueprints/pnltracker.py` + a switch on the page; replayed on acc1 with real data (P&L basis ends on 3,906.50, M2M on
  10,887.50, each equal to the Positions page). Reviewed by the user on acc1. Next action: acc2 and acc3 after 15:40 IST,
  and watch PR #2181.
  Upstream: issue marketcalls/openalgo#2180 and PR #2181 (widened 2026-10-06 to the tracker, the attribution
  endpoint, Positions and Holdings; CI running, mergeable). Next action: watch the PR and the maintainers' review; see
  SKYSHIELD_PATCHES.md for what to remove and re-apply when it merges.
- [x] **Flow Position Check (`pnl_above` / `pnl_below`) stays on the broker's P&L, by decision** (2026-10-06): it is a
  risk rule that other people's flows rely on, so the P&L | M2M switch must not change it.
- [ ] **Other places that show a position P&L, not yet decided** (2026-10-06): Telegram `/pnl` and WhatsApp `/pnl`
  (broker figure; could show M2M too) and the trading terminal blotter (not yet looked at). Holdings, Tradebook and P&L
  History do not need it.
- [ ] Open question for the strategy book: a manual exit (22450PE, 2026-10-06) leaves a stale open leg (IronCondor -65)
  in `strategy_positions`. Phase 3 manual assignment should be able to close such a leg.
- [ ] Phase 3: manual assignment for Unattributed (manual / pre-OpenAlgo holdings) via a fork-only overlay table
  with an `upgrade/` migration. Decision pending.
- [ ] Phase 4: AlgoMirror reads `/pnl/attribution` per account and drops its `position_tags` (see Algomirror/TODO.md).

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
  superseded 2026-10-04: `openalgo/` is on `main` and is the only checkout.
- 2026-10-02 Kotak statements uploaded to acc3 by the user. Result figures not checked by us
  (VM was off afterwards); expected acc3 ledger = 266 captured + 53 imported = 319 rows. Check
  next time the VM is up, together with any other acc3 read.
- 2026-10-01 P&L ledger dedup key fixed (date + exchange family + tradeid) - `2037ae4be`,
  all 3 VMs, 14,236 / 1,839 / 266 legacy keys migrated.
- 2026-10-01 Kotak "Transaction Statement" import (header-detected, broker-guarded) -
  `b7bf553dc`, all 3 VMs.
