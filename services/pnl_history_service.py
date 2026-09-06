# services/pnl_history_service.py
"""Compute-on-read realized P&L for the consolidated multi-day P&L feature.

Fork-only (SKYSHIELD_PATCHES.md). Backs the /api/v1/pnl/history and
/api/v1/pnl/import REST resources (restx_api/pnl_history.py).

No realized P&L is ever persisted: every request re-reads the raw fills
from db/pnl.db and re-runs utils/pnl_fifo.py. Matches the intraday PnL
Tracker's own philosophy (blueprints/pnltracker.py) and the user's explicit
design call - "this is how zerodha or broker would be doing" - extended
from one trading day to an arbitrary date range.
"""

from datetime import datetime

from database.auth_db import get_auth_token_broker
from database.pnl_db import PnlTrade, db_session, make_dedup_key, parse_trade_timestamp
from utils.constants import EXCHANGE_BSE, EXCHANGE_NSE, FNO_EXCHANGES
from utils.logging import get_logger
from utils.pnl_fifo import compute_realized_pnl, summarize_by_day

logger = get_logger(__name__)

# "Equity" here is the cash segment (NSE/BSE); "fno" reuses OpenAlgo's own
# canonical FNO_EXCHANGES (utils/constants.py) rather than redefining a
# second exchange-segment mapping that could drift from it - covers
# NFO/BFO/MCX/CDS/BCD/NCDEX/NCO/crypto, the same set every other service
# already treats as "derivatives" for margin/product-type purposes.
_SEGMENT_EXCHANGES = {
    "equity": {EXCHANGE_NSE, EXCHANGE_BSE},
    "fno": set(FNO_EXCHANGES),
}


def _parse_range_and_build_query(start_date, end_date, symbol=None, segment=None):
    """Shared by get_pnl_history and get_pnl_trades: parse the date range,
    validate segment, and build the base PnlTrade query. Returns
    (error_response_or_None, query_or_None, start, end).
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

    if segment and segment not in _SEGMENT_EXCHANGES:
        return (
            (False, {"status": "error", "message": "segment must be 'equity' or 'fno'"}, 400),
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
        # Exchange is a legitimate pre-filter for both consumers: for
        # get_pnl_history's FIFO matching it's safe because exchange is
        # already part of the FIFO grouping key (utils/pnl_fifo.py groups by
        # symbol+exchange+product), and for get_pnl_trades it's just a plain
        # row filter with no matching involved at all.
        query = query.filter(PnlTrade.exchange.in_(_SEGMENT_EXCHANGES[segment]))

    return None, query, start, end


def get_pnl_history(
    api_key: str,
    start_date: str,
    end_date: str,
    symbol: str | None = None,
    segment: str | None = None,
):
    """Realized P&L for one account over [start_date, end_date] (inclusive,
    "YYYY-MM-DD"), optionally narrowed to one symbol and/or one segment
    ("equity" or "fno" - see _SEGMENT_EXCHANGES above).

    Returns (success, response_dict, status_code) - same tuple shape as
    every other service in services/ (docs/design/27-service-layer).
    """
    auth_token, broker = get_auth_token_broker(api_key)
    if not auth_token:
        return False, {"status": "error", "message": "Invalid openalgo apikey"}, 403

    error, query, start, end = _parse_range_and_build_query(
        start_date, end_date, symbol=symbol, segment=segment
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
    per-source branching to render either kind of data.
    """
    auth_token, broker = get_auth_token_broker(api_key)
    if not auth_token:
        return False, {"status": "error", "message": "Invalid openalgo apikey"}, 403

    error, query, start, end = _parse_range_and_build_query(
        start_date, end_date, symbol=symbol, segment=segment
    )
    if error:
        return error

    try:
        rows = query.order_by(PnlTrade.trade_timestamp.desc(), PnlTrade.id.desc()).all()
        data = [
            {
                "symbol": row.symbol,
                "exchange": row.exchange,
                "product": row.product or "",
                "action": row.action,
                "quantity": row.quantity,
                "average_price": row.average_price,
                "trade_value": row.trade_value or 0,
                "orderid": row.orderid or "",
                "tradeid": row.tradeid or "",
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
