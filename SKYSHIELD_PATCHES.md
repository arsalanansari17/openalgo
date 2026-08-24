# SkyShieldEdge Patches to OpenAlgo

Tracks local patches applied on top of upstream `marketcalls/openalgo`, per
the modification policy: patch on a dedicated branch, file an upstream issue,
verify in production, then PR upstream.

---

## 2026-07-09 — Pledged/T1 holdings showing quantity=0

**Branch:** `fix/holdings-pledge-t1-quantity`
**Upstream issue:** _not yet filed_
**Upstream PR:** _not yet opened_
**Verified in production:** _not yet — pending live Zerodha (acc1) check_

### Problem

On the Holdings page, stocks pledged as collateral (or held T1/unsettled)
showed quantity `0` instead of the real holding. Root cause: most broker
holdings APIs split a position's quantity across multiple buckets (free,
T1/unsettled, pledged/collateral). OpenAlgo's per-broker `transform_holdings_data`
mappings only read the "free" bucket and silently dropped the others — a
fully-pledged holding (free qty = 0) rendered as 0 even though it was still
held. This was a platform-wide gap: every broker mapping checked had the
same pattern, not just Zerodha.

### Fix

Extended the unified holdings schema with two new fields, mirroring how
Zerodha's own Kite Console displays holdings (separate Qty / T1 Qty / Pledged
Qty columns):

- `t1_quantity` — shares bought but not yet T+1 settled
- `pledged_quantity` — shares pledged as margin collateral

Both default to `0` and are purely additive — existing `quantity` semantics
are unchanged for every broker (see per-broker notes below for the one
exception, Definedge, which already folded T1 into `quantity` and was left
as-is).

**Shared/common files:**
- `services/holdings_service.py` — `format_holdings_data()` rounds the two
  new fields alongside `pnl`/`pnlpercent`.
- `docs/api/account-services/holdings.md` — documents the two new response
  fields and notes which brokers populate them.
- `frontend/src/types/trading.ts` — `Holding` interface gets
  `t1_quantity?`/`pledged_quantity?`.
- `frontend/src/pages/Holdings.tsx` — two new table columns ("T1 Qty",
  "Pledged Qty") next to Quantity.

**Per-broker mapping fix (`broker/<name>/mapping/order_data.py`):**

| Broker | Fields added | Portfolio-value totals also fixed? | Notes |
|---|---|---|---|
| zerodha | `t1_quantity` (`t1_quantity`), `pledged_quantity` (`collateral_quantity`) | Yes | Reference implementation; live-verified pattern for all others. |
| angel | `t1quantity`, `collateralquantity` | No — Angel's stats come from broker-provided `totalholding` aggregate, already correct | |
| arrow | `t1Qty`, `collateralQty` + `brokerCollateralQty` | Yes | |
| aliceblue | `CollateralQty` threaded through `normalize_holding` → `pledged_quantity`; `t1_quantity` only shown when free qty > 0 (avoids double-count with existing Holdqty/HUqty fallback) | Yes | |
| definedge | `pledged_quantity` (`collateral_qty` + `broker_collateral_qty`) only — T1 was already folded into `quantity` via existing `dp_qty + t1_qty` sum | Yes (added collateral to value sum) | No `t1_quantity` field added — would double-count against existing `quantity`. |
| dhan / dhan_sandbox | `t1Qty`, `collateralQty` | No | Dhan's `totalQty` may already be a broker-computed grand total — **unverified**; new fields added as informational breakdown only, existing `quantity` left untouched to avoid a possible regression. |
| flattrade | `btstqty` → `t1_quantity`, `brkcolqty` → `pledged_quantity` | No — existing valuation formula already includes these | |
| upstox | `t1_quantity`, `collateral_quantity` | Yes | |
| zebu | `btstqty` → `t1_quantity`, `brkcolqty` → `pledged_quantity` | No — existing valuation formula already includes these | |
| groww | `t1_quantity`, `pledge_quantity` | No (not verified) | |
| iiflcapital | `t1Quantity`/`t1Qty`, `collateralQuantity`/`collateralQty` | No (not verified) | Existing `_resolve_holding_quantity` fallback chain left untouched. |
| motilal | `btstquantity` → `t1_quantity`, `collateralquantity` → `pledged_quantity` | No (not verified) | |
| mstock | `t1quantity`, `collateralquantity` | No (not verified) | |
| tradesmart | `btstqty` → `t1_quantity`, `brkcolqty` → `pledged_quantity` | No — existing valuation formula already includes these | |
| samco | `collateralQuantity` → `pledged_quantity` only (no T1 field documented) | No — stats use broker-provided `portfolioValue` aggregate | |
| fyers | `qty_t1` → `t1_quantity`, `collateralQuantity` → `pledged_quantity` | No | **Medium confidence** — field names from SDK JSON tags, not a rendered official doc page. Verify against a live response. |
| nubra | `t1_qty` → `t1_quantity`, `pledged_qty` → `pledged_quantity` (threaded through `map_portfolio_data`) | No — stats use broker-provided `holding_stats` aggregate | |

**Not patched — no bug found (quantity already correct):**
- **shoonya** — `transform_holdings_data` already folds `btstqty + brkcolqty + unplgdqty + benqty` into the displayed `quantity` via its existing total formula. No `t1_quantity`/`pledged_quantity` fields added; doing so would risk implying double-countable totals.

**Not patched — separate, unrelated bug (flagged for a future fix, out of scope here):**
- **firstock** — `get_holdings()` calls the wrong endpoint (`/holdings`, which per official docs returns only symbol info, no quantity fields at all). The real data lives at `/holdingsDetails`. This is a pre-existing, broader breakage unrelated to pledge handling specifically.

**Not patched — no confirmed field name / not applicable (per-instruction: skip rather than guess):**
- **deltaexchange** — crypto derivatives exchange, no equity holdings/pledge concept.
- **kotak** — official Kotak Neo SDK docs list only `quantity`/`sellableQuantity`, no pledge/T1 field.
- **fivepaisa** — no pledge field in official docs; `PoolQty` semantics are ambiguous (clearing-pool, not pledge) and unconfirmed.
- **fivepaisaxts, compositedge, wisdom, ibulls, iifl, rmoney** — all on the Symphony Fintech XTS "Interactive API" platform. XTS appears to model T1/collateral status as **separate holding rows per ISIN** (`HoldingType`, `IsCollateralHolding` flags) rather than parallel quantity fields on one row — a structurally different fix (row-grouping) that needs a live sample response to implement safely. Not attempted without one.
- **jainamxts** — the code's two holdings functions (`transform_holdings_data` vs `map_portfolio_data`) appear to target two different response shapes; only doc found described a different endpoint than the code calls. Needs live verification before any fix.
- **pocketful, tradejini, paytm** — no field name confirmable from reachable official documentation.
- **indmoney** — official docs list no pledge/T1 field; existing code already reads undocumented `used_qty`/`t1_qty` fields whose exact semantics (e.g. does `used_qty` mean "pledged"?) could not be confirmed — not guessed.

### Verification

- All 18 touched broker modules import cleanly (`uv run python -c "import broker.<name>.mapping.order_data"`).
- Synthetic fully-pledged holdings sanity-checked for zerodha, angel, upstox, flattrade, arrow — `pledged_quantity`/`t1_quantity` populate correctly and no longer collapse to a `quantity` of 0 with the value silently dropped; portfolio-value totals cross-checked by hand for the brokers where the stats formula was changed.
- `uv run ruff check` — no new lint errors introduced (pre-existing unused-variable/whitespace/deprecated-typing warnings in touched files are unrelated to this patch).
- `uv run pytest test/` — 407 passed, no regressions. Remaining failures/errors (mstock live-credential-gated tests, async-test config issues, eventlet-dependent websocket tests) are pre-existing and reproduce identically on `main`.
- Frontend (`npm run build`) compiles cleanly with the new `Holding` fields and table columns.
- **Verified in production 2026-07-09/10:** deployed to acc1, user confirmed pledged quantities display correctly on real holdings.

---

## 2026-07-10 — Holdings LTP always showing "-"

**Branch:** `main-sync-2026-07-09` (same deploy line as the pledge/T1 fix above)

### Problem

Holdings page LTP column showed `-` for every row (not just pledged ones).
Root cause: several brokers' `transform_holdings_data` never copied the
broker's raw last-traded-price field into the unified `ltp` output key —
it was either unused entirely or only read internally for a P&L%
calculation, never exposed on the transformed row. The frontend's
`useLivePrice` hook falls back to this REST-provided `ltp` outside the
window where live WebSocket/MultiQuotes data is flowing (e.g. after
market close), so with no REST fallback value, LTP had nothing to show.

### Fix

Checked all 17 non-Zerodha brokers patched in the fix above (Zerodha
itself: `holdings.get("last_price")` → `ltp`, fixed 2026-07-09 as part of
frontend redesign work). Of the remaining 17:

**Fixed — broker provides the raw field, it just wasn't mapped:**

| Broker | Raw field | Notes |
|---|---|---|
| angel | `ltp` | Confirmed present in SmartAPI `getAllHolding` schema. |
| aliceblue | `Ltp` (normalized from raw `ltp`) | Already computed as a local var in `transform_holdings_data`, just never put in the output dict. |
| upstox | `last_price` | Already used for the `pnlpercent` calc in the same function. |
| groww | `last_price` | Already extracted by `api/order_api.py::get_holdings` into the raw dict. |
| mstock | `ltp` | Confirmed via mStock Type B docs (mirrors Angel SmartAPI). |
| samco | *(derived)* | No direct price field in the raw response — derived as `holdingsValue / (quantity + pledged_quantity)`, both already-trusted fields used elsewhere in the same function. Not a guess at an unconfirmed raw field name. |

**Not fixed — broker genuinely doesn't provide LTP in the holdings response (confirmed via existing code comments or already-stubbed P&L, not assumed):**
- **definedge** — explicit comment: "Definedge doesn't provide LTP in holdings."
- **flattrade, zebu, tradesmart** — same Noren/Shoonya-family API; Flattrade has an explicit comment confirming the endpoint doesn't return LTP, and Zebu/TradeSmart's `pnl`/`pnlpercent` are correspondingly either broker-precomputed with no local price use or hardcoded `0.0` — same platform, same limitation.
- **motilal** — explicit comment: "P&L calculation would need current LTP, which is not in holdings response."
- **dhan_sandbox** — the real `dhan` adapter gets live pricing via a multiquote-fetch-and-enrich step in its own `map_portfolio_data` (sets a `_ltp` key); `dhan_sandbox`'s `map_portfolio_data` is a much simpler stub with no such enrichment. Fixing this means porting that enrichment logic, not a one-line field-name fix — bigger lift, deferred.

### Verification

- Synthetic per-broker checks for all 6 fixes (angel, aliceblue, upstox, groww, mstock, samco) — `ltp` populates correctly in each.
- `uv run ruff check` — no new lint errors (pre-existing unused-variable warnings in unrelated code, same as before).
- `uv run pytest test/` — 407 passed, identical to the pre-change baseline, no regressions.
- Not live-verified against real accounts for these 6 (only have a Zerodha account) — flag in the eventual upstream PR same as the pledge/T1 fields.

---

## 2026-07-10 — Zerodha margin() undersells required funds for pre-trade sizing

**Branch:** `bugfix/zerodha-margin-premium-credit` (cherry-picked onto `main-sync-2026-07-09` as `78e41a3b`, follow-up fix as `1a82410e`)
**Upstream issue:** [marketcalls/openalgo#1620](https://github.com/marketcalls/openalgo/issues/1620)
**Upstream PR:** [marketcalls/openalgo#1621](https://github.com/marketcalls/openalgo/pull/1621)
**Verified in production:** yes — deployed to acc1 and acc2, sanity-check lot sizing confirmed using `initial_total_margin` on both

### Problem

`IntradayIronFly` sized a 4-leg NIFTY iron fly using `client.margin()` on a
single lot and linearly scaled the lot count. The estimate (~68,339/lot) was
16% below what Zerodha actually required at order time (~79,287/lot),
causing a live entry rejection (`Insufficient funds`) mid-basket, requiring
a rollback of the already-filled legs.

Root cause: `parse_margin_response()` in
`broker/zerodha/mapping/margin_data.py` only returns Zerodha's `final.total`
as `total_margin_required` — a figure that already nets out the option
premium collected from the short legs. That premium isn't actually
available until the sell orders fill, so pre-trade sizing off it is
optimistic by roughly the premium amount.

Note: Shoonya, Flattrade, and Firstock's margin mappings each have
comments claiming Zerodha's `total_margin_required` maps to the
conservative `initial.total` figure — it doesn't (it uses `final.total`).
Those three brokers already behave conservatively; Zerodha is the outlier.
Flagged for maintainers in the PR rather than changing `total_margin_required`'s
existing meaning (see below).

### Fix

Purely additive — `total_margin_required` unchanged, one new field added:

- `initial_total_margin` — the pre-premium-credit total (`initial.total`)

Non-basket (single/aggregated order) responses have no initial/final split,
so `initial_total_margin` falls back to `total_margin_required` in that path.

**Deliberately not done:** changing `total_margin_required` itself to
`initial.total` (which would match Shoonya/Flattrade/Firstock's convention)
— that changes behavior for existing consumers of the field platform-wide;
left as a maintainer decision, noted in the PR.

**`option_premium_credit` field — added then removed (`1a82410e`):** the
initial version of this patch also added `option_premium_credit` (sourced
from `final.option_premium`). `cubic-dev-ai`'s automated review on the PR
flagged that this can come back negative and suggested sourcing it from
`initial.option_premium` instead. Checked against a real production basket
margin response and found neither raw sub-field actually equals "the
credit" — the real credit is the *delta* between `initial.option_premium`
and `final.option_premium` (span/exposure barely move between initial and
final for these strategies, so nearly the entire optimization benefit
shows up as the option_premium component swinging sign). Computing that
delta would just restate `margin_benefit` under a new name, so the field
was dropped entirely rather than "fixed" — `initial_total_margin` (the
field that actually drives sizing) was unaffected throughout.

**Done (SkyShieldAT repo, separate commits):** `_compute_lot_multiplier()`
in `iron_condor.py` and `intraday_ironfly.py` switched from
`total_margin_required` to `initial_total_margin` for sizing;
`sanity_check.py`'s dry-run preview updated to match.

### Verification

- `test/test_zerodha_margin_api.py` — 3 tests (basket response, non-basket
  fallback, error passthrough). All pass.
- `uv run pytest test/test_zerodha_margin_api.py test/test_dhan_margin_api.py -v`
  — 8/8 pass, no regressions in sibling Dhan margin tests.
- `uv run ruff check` / `uv run ruff format --check` — clean.
- Cherry-picked onto `main-sync-2026-07-09` (`78e41a3b`, `1a82410e`) with no
  conflicts.
- Live-verified on both acc1 and acc2: sanity-check lot sizing (IronCondor
  and IntradayIronFly, NIFTY and SENSEX) computed lower, more conservative
  lot counts using `initial_total_margin` on both accounts, matching
  expected values.

---

## 2026-08-02/03 — Kotak scripmaster download fails with "Scripmaster API failed"

**Branch:** `acc3-vm-deploy-2026-08-02` (cherry-picked onto `skyshield-main`)
**Upstream issue:** [marketcalls/openalgo#1729](https://github.com/marketcalls/openalgo/issues/1729)
**Upstream PR:** [marketcalls/openalgo#1730](https://github.com/marketcalls/openalgo/pull/1730)
**Verified in production:** yes — full master contract download succeeds
on acc3 (Iqbal/Kotak), 153,899 records loaded across NSE Cash/F&O, BSE
Cash/F&O, CDS, and MCX.

### Problem

`download_csv_kotak_data()` used a `HEAD` request against Kotak's CDN
(`lapi.kotaksecurities.com`) to check each fallback URL's accessibility
before downloading. That `HEAD` reliably hit an infinite redirect loop
("Exceeded maximum allowed redirects"), even though the identical URL
returns 200 immediately via `GET`. Every fallback URL failed its
accessibility check, `accessible_urls` stayed empty, and the function
raised "Scripmaster API failed" unconditionally — even though the CSV
data was fully downloadable the whole time. Reproduced identically from
two unrelated networks/IPs with a valid, active Kotak session on both, so
not account- or network-specific.

### Fix

Two commits:

1. Swap the accessibility check from `HEAD` to a ranged `GET`
   (`bytes=0-0`) — avoids the redirect loop. Intended to also avoid a full
   duplicate download of each multi-MB file (once for the check, once for
   the real download), though Kotak's CDN currently ignores the `Range`
   header and returns the full body anyway — today this is a correctness
   fix only, not a bandwidth win. Accepts both `200` and `206`.
2. Follow-up from upstream PR review (#1730): the ranged `GET` still
   buffered the entire response body in memory once Kotak's CDN ignores
   `Range` and returns the full multi-MB CSV — doubling peak memory use
   for no reason, since the real download re-fetches the same file right
   after. Switched to `client.stream()`, reading only the status code and
   closing the connection without consuming the body.

### Verification

- `uv run ruff check broker/kotak/database/master_contract_db.py` — clean.
- Full `master_contract_download()` verified end-to-end after each commit:
  153,899 records loaded, no change in downstream behavior.
- Cherry-picked onto `skyshield-main` (`f4beb01a8`, `c0dd6a2c4`) with no
  conflicts.

---

## 2026-08-13 — Known issue (not patched): rare eventlet cross-thread race during heavy startup

**Status:** observed once, not root-caused, not patched — logged here for
future investigation rather than rushed under live-trading time pressure.

### Symptom

During the `main-sync-2026-08-13` deploy restart on acc2, ~43 seconds after
gunicorn boot (overlapping with a 114k-row master-contract bulk insert),
the dashboard became fully unresponsive (`HTTP 524` via Cloudflare, then
`HTTP 000`/timeout on direct localhost checks) for about 4 minutes. Journal
showed:

```
sqlite3.OperationalError: database is locked
  ... database/apilog_db.py:99, async_log_order(), db_session.commit()
...
greenlet.error: Cannot switch to a different thread
  eventlet/hubs/hub.py:471 fire_timers -> eventlet/semaphore.py:147 _do_acquire
```

A plain `sudo systemctl restart` cleared it immediately; it did not recur
on acc2's or acc1's subsequent restart, and the order-update WebSocket
stream (the path that matters for live fills) never dropped throughout.

### Why this isn't the same bug as the 853d74328 eventlet/logging fix

Traced the import order in `app.py` carefully: `websocket_proxy.app_integration`
(which globally monkey-patches `logging.Handler.createLock` to a real OS
`RLock`, plus sweeps and re-patches every already-instantiated handler) is
imported at line 155, *after* `setup_logging()` has already created root's
3 handlers (triggered on first `utils.logging` import, effectively line 2)
but *before* any request is served or any `EventBus`-submitted callback
runs. By the time anything can call `logger.xxx()` from a real OS thread,
root's handlers already carry real OS `RLock`s — confirmed live on the
acc2 VM (fresh interpreter check showed `_thread.RLock`, not an eventlet
Semaphore). So this is very unlikely to be the same `Handler.lock` class
of bug the earlier fix targeted.

### Suspected root cause (unconfirmed)

`database/apilog_db.py`'s module-level `engine`/`scoped_session` is created
once at import time on the main gunicorn worker's OS thread. Order-log
writes are dispatched via `utils/event_bus.py`'s `EventBus`, which runs
callbacks on its own `concurrent.futures.ThreadPoolExecutor` — genuine OS
threads, not eventlet green threads. `scoped_session`'s registry (and/or
some internal SQLAlchemy/DBAPI lock touched during connection setup) likely
relies on `threading.local()`, which eventlet monkey-patches to be
greenlet-local rather than OS-thread-local — a real OS thread from the
executor touching state bound to the main thread's hub is a plausible
mechanism for the same class of "Cannot switch to a different thread"
error, just via a different lock than the logging one. Not confirmed by
live debugging or a controlled reproduction — a guess, not a diagnosis.

### Why not patched now

Applying an unverified threading/locking change to `apilog_db.py` on a
live-trading account under time pressure risks introducing a worse bug
than this rare, restart-clearing race. Needs either a controlled local
reproduction (stress-test the master-contract download racing concurrent
`EventBus` order-log writes) or live debugging before attempting a fix.

### Next steps

- Reproduce locally: trigger a large master-contract bulk insert
  concurrently with several `EventBus`-dispatched `async_log_order` calls,
  under `gunicorn --worker-class eventlet` (not the dev server, which uses
  plain threading and won't reproduce this).
- If reproduced, identify the exact lock object via `py-spy dump` or a
  targeted `sys.settrace`, then apply the narrowest fix (likely: give
  `apilog_db.py`'s executor-submitted path its own real-OS-thread-safe
  session/engine, or route the DB write through `eventlet.tpool.execute()`
  instead of `concurrent.futures.ThreadPoolExecutor`).
- Consider filing upstream once root-caused, same as the other patches
  in this file — this is not SkyShieldEdge-specific, `apilog_db.py` and
  `event_bus.py` are unmodified upstream code.

---

## 2026-05-14 (patched) / 2026-08-23 (documented here for the first time) —
## Zerodha WebSocket adapter: cross-thread greenlet.error under eventlet

**Branch:** carried directly on `skyshield-main`/each `main-sync-*` branch,
never isolated on its own feature branch — this write-up exists only because
the 2026-08-23 sync against `origin/main` (702db205a) needed to reconcile it
by hand and found it undocumented.
**Upstream issue:** #1421 (Lock cross-thread crash), #1419/#1226 (stale
auth-token cache under a separate proxy process)
**Upstream PR:** none opened
**Verified in production:** yes — this is the code currently live on
acc1/acc2, has been through several iterations since 2026-05.

### Problem

Two independent eventlet/greenlet issues in the Zerodha streaming adapter,
fixed together over several commits (`340010caf`, `3e7c92ba9`, `dc6766e4e`,
`1f0f87854`, plus earlier related work: `d077559f0`, `c3564cc8e`,
`c9591ae6e`, `586e5413e`, `a85876013` — `git log` on the files below for the
full sequence, not reproduced commit-by-commit here):

1. **`greenlet.error: Cannot switch to a different thread`** (#1421) —
   `self.lock` in `zerodha_adapter.py`/`zerodha_websocket.py` is acquired
   both from the asyncio WS-proxy thread and the eventlet hub thread.
   eventlet's monkey-patched `threading.Lock` is actually its `Semaphore`,
   which is not OS-thread-safe, and crashes when a cross-thread wakeup fires.
2. **Stale auth token under Docker's separate WS-proxy process** (#1419,
   #1226) — the proxy process has its own `auth_cache` TTLCache, synced only
   by best-effort ZMQ broadcast; a stale entry there builds the adapter with
   yesterday's dead token and 403s.

### Fix

1. `self.lock = eventlet.patcher.original("threading").Lock()` in both
   `zerodha_adapter.py` and `zerodha_websocket.py` — nothing else. **This
   scoping is load-bearing, not a stylistic choice**: an earlier version of
   this patch (`3e7c92ba9`) also switched `Timer`/`Event`/`Thread` to real
   OS primitives, and it broke OpenAlgo — the WebSocket client inside
   `_run_websocket` needs the eventlet hub for socket I/O, so running
   `_ws_thread` as a real OS thread deadlocks every eventlet-patched broker
   call (`/api/v1/history`, `/api/v1/expiry`, etc. hang indefinitely;
   `/api/v1/ping` still returns 200 since it never touches a broker
   adapter). `dc6766e4e` reverted `Timer`/`Event`/`Thread` back to
   eventlet-patched primitives and kept only the `Lock` change — that's the
   fix that's actually live.
2. `database/auth_db.py` gained a dedicated `get_auth_token_no_cache()` that
   queries the DB directly and never touches `auth_cache`'s dict operations
   (`in`, `del`, `[key] =`) at all. `zerodha_adapter.py` calls this instead
   of `get_auth_token(..., bypass_cache=True)` specifically because
   `bypass_cache=True` still performs those same dict operations on the
   TTLCache internally — which still touch the TTLCache's own
   monkey-patched `RLock` from the asyncio thread and can still crash the
   same way. `websocket_proxy/app_integration.py` and `server.py` carry
   related cross-thread TTLCache-access removal from the same investigation
   (`1f0f87854`, `586e5413e`).

**Important for the next sync**: `origin/main` does not yet have any of
this. Its current `zerodha_adapter.py`/`zerodha_websocket.py` still use
`_real_threading` for `Timer`/`Event`/`Thread` too (the exact pattern
`dc6766e4e` reverted) and still call `get_auth_token(...,
bypass_cache=True)` instead of the dedicated no-cache path. **Do not
hand-merge our patch onto whatever `origin/main` has for these files — take
our current file content wholesale instead**, the same way this 2026-08-23
sync ultimately handled it. A first pass of this sync assumed origin's
version was a more-complete independent fix and nearly reapplied the
over-reaching Timer/Event/Thread change on top of it; it isn't independent,
it's the pre-fork original.

### Verification

- Live on acc1/acc2 since 2026-05 (`3e7c92ba9`/`dc6766e4e`) and 2026-08
  (`340010caf` era) respectively — this is the actual code paths currently
  running, not a pending patch.
- Post-restart check specifically for this: `/api/v1/history` and
  `/api/v1/expiry` respond normally (not just `/api/v1/ping`), and
  `journalctl` shows no `greenlet.error` / `Cannot switch to a different
  thread` / deadlock in the minutes after a restart.

---

## 2026-08-23 — Zerodha/Kotak `availablecash` real fix (recovered from uncommitted VM state)

**Branch:** committed directly onto `main-sync-2026-08-23`
**Upstream issue:** #1582 (already "fixed" upstream via `8a5e8700`/
`7f9790ab`, both merged into `origin/main` — that fix is the same broken
formula this patch replaces)
**Upstream PR:** none opened yet
**Verified in production:** yes — this exact content had been live on
acc1/acc2 (`broker/zerodha/api/funds.py`) and acc3
(`broker/kotak/api/funds.py`) as **uncommitted** VM edits since earlier in
this session, found and committed for the first time while preparing this
sync (a plain `git checkout`/`pull` on any of the 3 VMs would otherwise
have silently discarded it).

### Problem

Zerodha: `total_net_margin + total_used_margin - total_collateral`
algebraically always equals `opening_balance` (Kite's own identity is
`net = opening_balance - debits + collateral`, so substituting cancels
debits/collateral out exactly) — never real intraday cash. Verified
against two raw `/user/margins` pulls on the same account six hours apart:
the formula stayed frozen at 408,451.40 in both while real cash moved
21,984.56 -> 411,415.40.

Kotak: `CollateralValue + RmsPayInAmt - RmsPayOutAmt + Collateral` double
counts collateral — it's already reported as its own `collateral` field
in the response.

### Fix

Zerodha: sum `available.live_balance` (commodity + equity) directly —
correct in both verification snapshots, tracks real intraday usage.
Kotak: `RmsPayInAmt - RmsPayOutAmt` only, dropping both collateral terms.

### Verification

- Full write-up and algebraic proof from earlier in this session (see
  session history / the GitHub #1582 comment posted from this repo).
- Live-verified on acc1/acc2/acc3 as uncommitted state before this commit
  formalized it — this is not new/untested code, just newly tracked.

---

## 2026-08-23 — Kotak: ordMrgn margin field + synthetic INDIAVIX SymToken (folded in from acc3)

**Branch:** `fix/kotak-synthetic-indiavix-symtoken` (3 commits: `c9b3c7c05`,
`0a1e94880`, `49972792f`), folded into `main-sync-2026-08-23` since acc3 was
running ahead of `main-sync-2026-08-15` with these and no other sync branch
had them yet.
**Verified in production:** yes, on acc3 (Iqbal/Kotak).

### Fix 1 — `broker/kotak/mapping/margin_data.py`: use `ordMrgn`, not `reqdMrgn`

`reqdMrgn` is the shortfall beyond currently-available margin (0 for a
well-funded account), not the order's actual cost — margin checks always
returned 0 for accounts with enough headroom. `ordMrgn` holds the real
per-order margin; `reqdMrgn` kept as a fallback.

### Fix 2 — `broker/kotak/database/master_contract_db.py`: synthetic INDIAVIX SymToken row

Kotak's own instrument master (`NSE_CM.csv`) never lists India VIX as an
index (confirmed by direct inspection — exactly 4 `NSE_INDEX` rows, no VIX
under any name). Kotak's neosymbol quotes endpoint can still serve VIX by
name, but `services/quotes_service.py`'s `validate_symbol_exchange()`
requires a `SymToken` row to exist first and rejects the request before
any broker code runs. `_ensure_synthetic_index_rows()` inserts one
placeholder row after every `master_contract_download()` refresh (which
otherwise wipes and rebuilds the table from scratch) so the gate passes.

### Fix 3 — `broker/kotak/api/data.py`: correct INDIAVIX neosymbol candidate name

Kotak's neosymbol endpoint is case-sensitive — confirmed live that
`INDIA VIX` (all caps) resolves and `India VIX` does not. Kept the old
form as a second candidate in case Kotak's catalog varies.

### Verification

- `scripts/test_kotak_margin_ordmrgn.py`, `scripts/test_kotak_synthetic_vix_token.py`
  — both pass (re-verified 2026-08-23 after folding into
  `main-sync-2026-08-23`).

---

## 2026-08-24 — Kotak holdings: missing average_price/ltp showed as "-", Invested=0

**Branch:** committed directly onto `main-sync-2026-08-23`
**Verified in production:** yes — reported live by the user on acc3
(Iqbal/Kotak), both in OpenAlgo's own Holdings page and in AlgoMirror
(which reads the same OpenAlgo API and inherited the same bug).

### Problem

`broker/kotak/mapping/order_data.py`'s `transform_holdings_data()` never
set `average_price` or `ltp` on the transformed row at all — unlike every
other broker's mapping (see Zerodha's version, the reference
implementation, which always includes both). The frontend has no fallback
for a missing `average_price`, so it rendered `-`, and
`invested = qty * (holding.average_price || 0)` collapsed to 0 — which
then fed into wrong PnL/PnL% and allocation figures downstream, since
those are computed from `invested`/`current`, not read directly off the
broker's own `pnl`/`pnlpercent` fields.

Root cause: Kotak's holdings API reports `mktValue` and `holdingCost` as
row *totals* (quantity already multiplied in), not per-share prices — the
only two value fields transform_holdings_data actually read. There's no
dedicated average-price or LTP field in Kotak's holdings response to map
directly (unlike positions, which do have `avgnetprice`).

**Separately confirmed, not a bug**: the user also asked whether Kotak
holdings should show T1/Pledged quantity breakdown like Zerodha's do (see
the 2026-07-09 entry above). They don't, and that's already documented and
deliberate — Kotak's official Neo SDK docs list only `quantity`/
`sellableQuantity` for holdings, no pledge/T1 field, so it was left
unpatched rather than guessed at. Quantity showing as a single raw number
on Kotak is expected, not a bug.

### Fix

Derive both from the totals already being read, guarded against
division-by-zero on a zero-quantity row:
`average_price = holdingCost / quantity`, `ltp = mktValue / quantity`.
`pnl`/`pnlpercent` computation unchanged (already correct, computed
directly from `mktValue - holdingCost`, independent of average_price).

### Verification

- Synthetic test: 10 qty, mktValue=15000, holdingCost=12000 ->
  average_price=1200.0, ltp=1500.0, pnl=3000.0, pnlpercent=25.0 (correct
  by hand). Zero-quantity row -> average_price=0.0, ltp=0.0, no
  ZeroDivisionError.
- `uv run ruff check broker/kotak/mapping/order_data.py` — clean.
