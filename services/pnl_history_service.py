# services/pnl_history_service.py
"""Compute-on-read realized P&L for the consolidated multi-day P&L feature.

Fork-only (SKYSHIELD_PATCHES.md). Backs the /api/v1/pnl/history and
/api/v1/pnl/import REST resources (restx_api/pnl_history.py).

No realized P&L is ever persisted: every request re-reads the raw fills
from db/tradebook.db and re-runs utils/pnl_fifo.py. Matches the intraday
PnL Tracker's own philosophy (blueprints/pnltracker.py) and the user's
explicit design call - "this is how zerodha or broker would be doing" -
extended from one trading day to an arbitrary date range.
"""

from datetime import datetime

from database.auth_db import get_auth_token_broker
from database.pnl_db import (
    VALID_SEGMENTS,
    PnlTrade,
    db_session,
    derive_segment,
    make_dedup_key,
    parse_trade_timestamp,
)
from database.strategy_book_db import StrategyBookUnavailable, get_order_tag
from utils.logging import get_logger
from utils.pnl_fifo import compute_realized_pnl, summarize_by_day

logger = get_logger(__name__)


def _parse_range_and_build_query(start_date, end_date, symbol=None, segment=None, strategy=None):
    """Shared by get_pnl_history and get_pnl_trades: parse the date range,
    validate segment, and build the base PnlTrade query. Returns
    (error_response_or_None, query_or_None, start, end).

    strategy is a pre-filter, same as segment/symbol: applied to PnlTrade
    rows *before* get_pnl_history's FIFO matching ever runs, not threaded
    through utils/pnl_fifo.py's lot objects. A closed_trades/daily/scrip
    response filtered to one strategy is therefore already guaranteed
    single-strategy by construction - no ambiguity about which strategy a
    given closed lot (which can span two physical fills) belongs to,
    because only that one strategy's fills were ever in the query.
    """
    try:
        start = datetime.strptime(start_date, "%Y-%m-%d")
        end = datetime.strptime(end_date, "%Y-%m-%d").replace(hour=23, minute=59, second=59)
    except ValueError:
        return (
            (False, {"status": "error", "message": "start_date/end_date must be YYYY-MM-DD"}, 400),
            None,
            None,
            None,
        )

    if segment and segment not in VALID_SEGMENTS:
        return (
            (
                False,
                {"status": "error", "message": f"segment must be one of {VALID_SEGMENTS}"},
                400,
            ),
            None,
            None,
            None,
        )

    query = db_session.query(PnlTrade).filter(
        PnlTrade.trade_timestamp >= start, PnlTrade.trade_timestamp <= end
    )
    if symbol:
        query = query.filter(PnlTrade.symbol == symbol)
    if segment:
        # Filters on the stored segment column (derive_segment(), set once
        # at write time by both writers) rather than re-deriving from
        # exchange on every read. Safe as a pre-filter for get_pnl_history's
        # FIFO matching specifically because exchange - and therefore
        # segment, which is a pure function of it - is already part of the
        # FIFO grouping key (utils/pnl_fifo.py groups by
        # symbol+exchange+product); for get_pnl_trades it's just a plain row
        # filter with no matching involved at all.
        query = query.filter(PnlTrade.segment == segment)
    if strategy:
        query = query.filter(PnlTrade.strategy == strategy)

    return None, query, start, end


def get_pnl_history(
    api_key: str,
    start_date: str,
    end_date: str,
    symbol: str | None = None,
    segment: str | None = None,
    strategy: str | None = None,
):
    """Realized P&L for one account over [start_date, end_date] (inclusive,
    "YYYY-MM-DD"), optionally narrowed to one symbol, one segment (one of
    database.pnl_db.VALID_SEGMENTS), and/or one strategy (a free-text name
    from database.strategy_book_db - see PnlTrade.strategy's docstring).

    Returns (success, response_dict, status_code) - same tuple shape as
    every other service in services/ (docs/design/27-service-layer).
    """
    auth_token, broker = get_auth_token_broker(api_key)
    if not auth_token:
        return False, {"status": "error", "message": "Invalid openalgo apikey"}, 403

    error, query, start, end = _parse_range_and_build_query(
        start_date, end_date, symbol=symbol, segment=segment, strategy=strategy
    )
    if error:
        return error

    try:
        # Chronological order matters for FIFO correctness (utils/pnl_fifo.py
        # sorts again internally, but ties on an identical timestamp then
        # fall back to this insertion/id order rather than an arbitrary one).
        rows = query.order_by(PnlTrade.trade_timestamp.asc(), PnlTrade.id.asc()).all()

        trades = [
            {
                "symbol": row.symbol,
                "exchange": row.exchange,
                "product": row.product,
                "action": row.action,
                "quantity": row.quantity,
                "average_price": row.average_price,
                "trade_timestamp": row.trade_timestamp.isoformat(),
            }
            for row in rows
        ]

        result = compute_realized_pnl(trades)
        daily = summarize_by_day(result)

        return (
            True,
            {
                "status": "success",
                "data": {
                    "start_date": start_date,
                    "end_date": end_date,
                    "total_realized_pnl": round(result.total_realized_pnl, 2),
                    "trade_count": len(trades),
                    "daily": [
                        {
                            "date": day["date"],
                            "realized_pnl": round(day["realized_pnl"], 2),
                            "trade_count": day["trade_count"],
                        }
                        for day in daily
                    ],
                    "closed_trades": [
                        {
                            "symbol": lot.symbol,
                            "exchange": lot.exchange,
                            "product": lot.product,
                            "entry_action": lot.entry_action,
                            "quantity": lot.quantity,
                            "entry_price": round(lot.entry_price, 2),
                            "entry_timestamp": str(lot.entry_timestamp),
                            "exit_price": round(lot.exit_price, 2),
                            "exit_timestamp": str(lot.exit_timestamp),
                            "realized_pnl": round(lot.realized_pnl, 2),
                        }
                        for lot in result.realized_lots
                    ],
                    "open_positions": [
                        {
                            "symbol": pos.symbol,
                            "exchange": pos.exchange,
                            "product": pos.product,
                            "action": pos.action,
                            "quantity": pos.quantity,
                            "average_price": round(pos.average_price, 2),
                        }
                        for pos in result.open_positions
                    ],
                },
            },
            200,
        )
    except Exception as e:
        logger.exception(f"Error computing PnL history: {e}")
        return False, {"status": "error", "message": str(e)}, 500
    finally:
        db_session.remove()


def get_pnl_trades(
    api_key: str,
    start_date: str,
    end_date: str,
    symbol: str | None = None,
    segment: str | None = None,
    strategy: str | None = None,
):
    """Raw fills for one account over [start_date, end_date] - no FIFO
    matching, just the ledger rows as-is. Backs the historical Tradebook
    view (frontend/src/pages/TradeBook.tsx switches to this endpoint once
    the selected date range isn't "today"; the live view keeps using the
    broker's own tradebook API via services/tradebook_service.py, since
    today's trades aren't in the ledger yet - the daily capture job runs
    at 16:00 IST, after close).

    Returns each row in the same shape frontend/src/types/trading.ts's
    Trade interface expects, so the existing Trade Book table needs no
    per-source branching to render either kind of data. `id` is included
    (unlike get_pnl_history's trade shapes) so the frontend can address a
    specific row for the manual strategy-tag fallback
    (set_trade_strategy below).
    """
    auth_token, broker = get_auth_token_broker(api_key)
    if not auth_token:
        return False, {"status": "error", "message": "Invalid openalgo apikey"}, 403

    error, query, start, end = _parse_range_and_build_query(
        start_date, end_date, symbol=symbol, segment=segment, strategy=strategy
    )
    if error:
        return error

    try:
        rows = query.order_by(PnlTrade.trade_timestamp.desc(), PnlTrade.id.desc()).all()
        data = [
            {
                "id": row.id,
                "symbol": row.symbol,
                "exchange": row.exchange,
                "product": row.product or "",
                "action": row.action,
                "quantity": row.quantity,
                "average_price": row.average_price,
                "trade_value": row.trade_value or 0,
                "orderid": row.orderid or "",
                "tradeid": row.tradeid or "",
                "segment": row.segment,
                "strategy": row.strategy,
                "timestamp": row.trade_timestamp.isoformat(sep=" "),
            }
            for row in rows
        ]
        return True, {"status": "success", "data": data}, 200
    except Exception as e:
        logger.exception(f"Error fetching PnL trades: {e}")
        return False, {"status": "error", "message": str(e)}, 500
    finally:
        db_session.remove()


def _lookup_strategy_for_import(orderid) -> str | None:
    """Same best-effort orderid -> strategy lookup as
    services/pnl_capture_service.py::_lookup_strategy - duplicated rather
    than imported across services/ to avoid coupling the CSV-import path
    to the daily-capture module for a four-line helper.
    """
    if not orderid:
        return None
    tag = get_order_tag(orderid)
    return tag.strategy if tag else None


def _normalize_action(value) -> str:
    """"B"/"S" (Kotak's raw trnsTp) or "buy"/"sell"/"BUY"/"SELL" -> "BUY"/
    "SELL". Anything else is returned upper-cased unchanged so the caller's
    ``action in ("BUY", "SELL")`` validation still rejects it explicitly
    rather than this function guessing.
    """
    normalized = (value or "").strip().upper()
    return {"B": "BUY", "S": "SELL"}.get(normalized, normalized)


def import_trades_csv(api_key: str, rows: list[dict]) -> tuple[bool, dict, int]:
    """Backfill the ledger from an already-parsed CSV (list of dict rows -
    the REST resource owns CSV parsing/validation; this owns normalization,
    dedup, and persistence, matching the service-layer boundary).

    Expects each row to carry at least: symbol, exchange, action ("BUY"/
    "SELL"), quantity, average_price/price, and a trade date/time. Column
    naming varies by broker export (e.g. Zerodha's own tradebook CSV columns
    differ from Kotak's); the REST resource maps broker-specific column
    names to this common shape before calling here, so this function stays
    broker-agnostic.

    Dedup uses the same make_dedup_key as the daily capture job: a CSV
    covering dates the capture job already captured live is a safe,
    idempotent no-op rather than a double-count.
    """
    auth_token, _broker = get_auth_token_broker(api_key)
    if not auth_token:
        return False, {"status": "error", "message": "Invalid openalgo apikey"}, 403

    imported = 0
    skipped_duplicate = 0
    skipped_invalid = 0

    try:
        for row in rows:
            symbol = row.get("symbol")
            exchange = row.get("exchange")
            # Some broker exports use single-letter codes (Kotak's raw
            # trnsTp: "B"/"S") rather than the full word.
            action = _normalize_action(row.get("action"))
            quantity = row.get("quantity")
            price = row.get("average_price")

            if not (symbol and exchange and action in ("BUY", "SELL") and quantity and price):
                skipped_invalid += 1
                continue

            parsed_timestamp = parse_trade_timestamp(row.get("trade_timestamp"))

            dedup_key = make_dedup_key(
                tradeid=row.get("tradeid"),
                orderid=row.get("orderid"),
                symbol=symbol,
                exchange=exchange,
                action=action,
                quantity=quantity,
                average_price=price,
                timestamp=parsed_timestamp,
            )

            if db_session.query(PnlTrade.id).filter_by(dedup_key=dedup_key).first():
                skipped_duplicate += 1
                continue

            db_session.add(
                PnlTrade(
                    dedup_key=dedup_key,
                    tradeid=row.get("tradeid") or None,
                    orderid=row.get("orderid") or None,
                    symbol=symbol,
                    exchange=exchange,
                    product=row.get("product"),
                    segment=derive_segment(exchange),
                    # Best-effort - a CSV row's orderid only matches the
                    # strategy book when it happens to be a real OpenAlgo
                    # order still within the order-tag's 30-day retention;
                    # older/pre-OpenAlgo history stays unattributed unless
                    # manually tagged later (set_trade_strategy below).
                    strategy=_lookup_strategy_for_import(row.get("orderid")),
                    action=action,
                    quantity=float(quantity),
                    average_price=float(price),
                    trade_value=float(quantity) * float(price),
                    trade_timestamp=parsed_timestamp,
                    source="import",
                )
            )
            imported += 1

        db_session.commit()
        return (
            True,
            {
                "status": "success",
                "data": {
                    "imported": imported,
                    "skipped_duplicate": skipped_duplicate,
                    "skipped_invalid": skipped_invalid,
                },
            },
            200,
        )
    except Exception as e:
        db_session.rollback()
        logger.exception(f"Error importing PnL CSV: {e}")
        return False, {"status": "error", "message": str(e)}, 500
    finally:
        db_session.remove()


def get_strategy_legs(api_key: str, strategy: str | None = None):
    """Every currently-tracked strategy leg for this account - a thin read
    wrapper over database.strategy_book_db.get_strategy_legs(), the
    already-running upstream strategy book (see PnlTrade.strategy's
    docstring). Each leg carries quantity, average_price and cumulative
    realized_pnl per (strategy, symbol, exchange, product) - this is
    "holdings, per strategy", already computed, not derived from
    pnl_trades/the FIFO ledger at all.

    Unlike get_pnl_history/get_pnl_trades this isn't scoped by date range -
    the strategy book tracks current open legs, not historical trades.
    """
    from database.strategy_book_db import get_strategy_legs as _get_strategy_legs

    auth_token, broker = get_auth_token_broker(api_key)
    if not auth_token:
        return False, {"status": "error", "message": "Invalid openalgo apikey"}, 403

    try:
        legs = _get_strategy_legs(strategy=strategy)
        return True, {"status": "success", "data": legs}, 200
    except StrategyBookUnavailable as e:
        # Distinguished from "no legs" (an empty list is a legitimate,
        # correct answer) - an unavailable book must never be reported as
        # a flat/zero strategy (see strategy_book_db.py's own docstring).
        return False, {"status": "error", "message": str(e)}, 503
    except Exception as e:
        logger.exception(f"Error reading strategy legs: {e}")
        return False, {"status": "error", "message": str(e)}, 500


def set_trade_strategy(api_key: str, trade_id: int, strategy: str):
    """Manual strategy-tag fallback for one historical trade row - for
    CSV-imported history and any trade with no orderid to automatically
    join against the strategy book (see PnlTrade.strategy's docstring).
    Overwrites whatever strategy value (if any) the row already has,
    automatic or manual.
    """
    auth_token, broker = get_auth_token_broker(api_key)
    if not auth_token:
        return False, {"status": "error", "message": "Invalid openalgo apikey"}, 403

    strategy = (strategy or "").strip()
    if not strategy:
        return False, {"status": "error", "message": "strategy is required"}, 400

    try:
        row = db_session.query(PnlTrade).filter_by(id=trade_id).one_or_none()
        if row is None:
            return False, {"status": "error", "message": "Trade not found"}, 404

        row.strategy = strategy
        db_session.commit()
        return True, {"status": "success", "data": {"id": row.id, "strategy": row.strategy}}, 200
    except Exception as e:
        db_session.rollback()
        logger.exception(f"Error setting strategy tag on trade {trade_id}: {e}")
        return False, {"status": "error", "message": str(e)}, 500
    finally:
        db_session.remove()
