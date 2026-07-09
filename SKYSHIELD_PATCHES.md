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
- **Pending:** live comparison against Kite Console for the Zerodha acc1 account (needs a real pledged holding + browser check — a manual step).
