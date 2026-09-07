# restx_api/pnl_history.py
"""Fork-only REST resources for the consolidated multi-day P&L feature
(SKYSHIELD_PATCHES.md) - not part of upstream OpenAlgo.

Mounted onto the *existing* "/pnl" path (restx_api/__init__.py already
registers pnl_symbols_ns there for the unrelated sandbox-only /pnl/symbols
endpoint) as a second, independent Namespace object, so this file - and its
registration line in __init__.py - are the only touch points; nothing in
restx_api/pnl_symbols.py or account_schema.py changes.

    GET  /api/v1/pnl/history  - realized P&L for a date range (AlgoMirror's
                                 aggregator calls this once per account)
    GET  /api/v1/pnl/trades   - raw fills for a date range, no FIFO -
                                 backs the historical Trade Book view
    POST /api/v1/pnl/import   - backfill the ledger from an exported
                                 tradebook CSV, for history predating the
                                 daily capture job
"""

import csv
import io
import os

from flask import jsonify, make_response, request
from flask_restx import Namespace, Resource
from marshmallow import ValidationError

from limiter import limiter
from services.pnl_history_service import (
    get_pnl_history,
    get_pnl_trades,
    get_strategy_legs,
    import_trades_csv,
    set_trade_strategy,
)
from utils.logging import get_logger

from .pnl_history_schema import (
    PnlHistorySchema,
    PnlImportSchema,
    PnlSetTradeStrategySchema,
    PnlStrategyLegsSchema,
)

API_RATE_LIMIT = os.getenv("API_RATE_LIMIT", "10 per second")

# Distinct internal namespace name from restx_api/pnl_symbols.py's "pnl", so
# Flask-RESTX/Swagger metadata for the two files never collide even though
# both mount at the same "/pnl" URL path.
api = Namespace("pnl_history", description="Consolidated multi-day P&L (fork-only)")

logger = get_logger(__name__)

pnl_history_schema = PnlHistorySchema()
pnl_import_schema = PnlImportSchema()
pnl_strategy_legs_schema = PnlStrategyLegsSchema()
pnl_set_trade_strategy_schema = PnlSetTradeStrategySchema()

# Column-name aliases across broker tradebook CSV exports. Modeled on
# Zerodha's own tradebook export columns from memory of a real sample seen
# earlier in this project - NOT re-verified against an actual file in this
# change. Kotak's export format has never been checked against a real file
# at all. Treat both as unverified heuristics until confirmed against a
# real exported CSV per account (see SKYSHIELD_PATCHES.md) - this is a
# best-effort mapper, not a confirmed broker contract.
_COLUMN_ALIASES = {
    "symbol": ("symbol", "tradingsymbol", "trdsym", "instrument"),
    "exchange": ("exchange", "exch", "exseg"),
    "product": ("product", "prod"),
    "action": ("action", "trade_type", "transaction_type", "side", "trnstp"),
    "quantity": ("quantity", "qty", "traded_quantity", "fldqty"),
    "average_price": ("average_price", "price", "trade_price", "avgprc"),
    "orderid": ("order_id", "orderid", "nordno"),
    "tradeid": ("trade_id", "tradeid", "flid"),
    # A single column already carrying a full date+time - used as-is when
    # present. Kept separate from trade_date/order_execution_time below,
    # which (per Zerodha's tradebook export) are commonly split into a
    # date-only and a time-only column instead of one combined field - the
    # exact gap the user originally flagged ("doesn't have the dates
    # attached to the trades in csv").
    "trade_timestamp": ("timestamp", "trade_timestamp", "extm", "fill_timestamp"),
    "trade_date": ("trade_date",),
    "order_execution_time": ("order_execution_time",),
}


def _normalize_header(header: str) -> str:
    """"Trade Type" / "Order Execution Time" / "order-id" -> "trade_type" /
    "order_execution_time" / "order_id", so header lookup doesn't depend on
    a broker's own spacing/casing convention. Zerodha's tradebook CSV export
    uses "Title Case With Spaces" headers; Kotak's format is unverified
    (see the module docstring) but likely follows a different convention
    again, which is exactly why this normalizes rather than matching
    verbatim strings.
    """
    return (header or "").strip().lower().replace(" ", "_").replace("-", "_")


def _normalize_csv_row(raw_row: dict) -> dict:
    """Map one broker-CSV row (arbitrary header casing/naming) onto the
    common shape services.pnl_history_service.import_trades_csv expects.
    """
    lower_row = {_normalize_header(key): value for key, value in raw_row.items()}

    normalized = {}
    for field, aliases in _COLUMN_ALIASES.items():
        for alias in aliases:
            if alias in lower_row and lower_row[alias] not in (None, ""):
                normalized[field] = lower_row[alias]
                break

    trade_date = normalized.pop("trade_date", None)
    order_time = normalized.pop("order_execution_time", None)
    if "trade_timestamp" not in normalized:
        if trade_date and order_time:
            # order_execution_time already containing a date (some exports
            # do combine them despite the column name) would double up the
            # date if naively concatenated - only prepend trade_date when
            # order_time looks like a bare HH:MM:SS.
            if len(str(order_time).strip()) <= 8:
                normalized["trade_timestamp"] = f"{trade_date} {order_time}"
            else:
                normalized["trade_timestamp"] = order_time
        elif trade_date:
            normalized["trade_timestamp"] = trade_date
        elif order_time:
            normalized["trade_timestamp"] = order_time

    return normalized


@api.route("/history", strict_slashes=False)
class PnlHistory(Resource):
    @limiter.limit(API_RATE_LIMIT)
    def get(self):
        """Realized P&L for one account over a date range."""
        try:
            params = pnl_history_schema.load(request.args.to_dict())
            success, response_data, status_code = get_pnl_history(
                api_key=params["apikey"],
                start_date=params["start_date"],
                end_date=params["end_date"],
                symbol=params.get("symbol"),
                segment=params.get("segment"),
                strategy=params.get("strategy"),
            )
            return make_response(jsonify(response_data), status_code)
        except ValidationError as err:
            return make_response(jsonify({"status": "error", "message": err.messages}), 400)
        except Exception as e:
            logger.exception(f"Unexpected error in pnl/history endpoint: {e}")
            return make_response(
                jsonify({"status": "error", "message": "An unexpected error occurred"}), 500
            )


@api.route("/trades", strict_slashes=False)
class PnlTrades(Resource):
    @limiter.limit(API_RATE_LIMIT)
    def get(self):
        """Raw fills for one account over a date range - no FIFO matching."""
        try:
            params = pnl_history_schema.load(request.args.to_dict())
            success, response_data, status_code = get_pnl_trades(
                api_key=params["apikey"],
                start_date=params["start_date"],
                end_date=params["end_date"],
                symbol=params.get("symbol"),
                segment=params.get("segment"),
                strategy=params.get("strategy"),
            )
            return make_response(jsonify(response_data), status_code)
        except ValidationError as err:
            return make_response(jsonify({"status": "error", "message": err.messages}), 400)
        except Exception as e:
            logger.exception(f"Unexpected error in pnl/trades endpoint: {e}")
            return make_response(
                jsonify({"status": "error", "message": "An unexpected error occurred"}), 500
            )


@api.route("/import", strict_slashes=False)
class PnlImport(Resource):
    @limiter.limit(API_RATE_LIMIT)
    def post(self):
        """Backfill the ledger from an uploaded broker tradebook CSV."""
        try:
            form_data = pnl_import_schema.load(request.form.to_dict())

            uploaded = request.files.get("file")
            if uploaded is None or not uploaded.filename:
                return make_response(
                    jsonify({"status": "error", "message": "A CSV file is required"}), 400
                )

            try:
                text = uploaded.read().decode("utf-8-sig")
            except UnicodeDecodeError:
                return make_response(
                    jsonify({"status": "error", "message": "CSV must be UTF-8 encoded"}), 400
                )

            reader = csv.DictReader(io.StringIO(text))
            rows = [_normalize_csv_row(row) for row in reader]

            success, response_data, status_code = import_trades_csv(
                api_key=form_data["apikey"], rows=rows
            )
            return make_response(jsonify(response_data), status_code)
        except ValidationError as err:
            return make_response(jsonify({"status": "error", "message": err.messages}), 400)
        except Exception as e:
            logger.exception(f"Unexpected error in pnl/import endpoint: {e}")
            return make_response(
                jsonify({"status": "error", "message": "An unexpected error occurred"}), 500
            )


@api.route("/strategy-legs", strict_slashes=False)
class PnlStrategyLegs(Resource):
    @limiter.limit(API_RATE_LIMIT)
    def get(self):
        """Every currently-tracked strategy leg for this account - a thin
        read wrapper over the already-running strategy book
        (database/strategy_book_db.py). See services/pnl_history_service.py
        ::get_strategy_legs for why this isn't derived from pnl_trades.
        """
        try:
            params = pnl_strategy_legs_schema.load(request.args.to_dict())
            success, response_data, status_code = get_strategy_legs(
                api_key=params["apikey"],
                strategy=params.get("strategy"),
            )
            return make_response(jsonify(response_data), status_code)
        except ValidationError as err:
            return make_response(jsonify({"status": "error", "message": err.messages}), 400)
        except Exception as e:
            logger.exception(f"Unexpected error in pnl/strategy-legs endpoint: {e}")
            return make_response(
                jsonify({"status": "error", "message": "An unexpected error occurred"}), 500
            )


@api.route("/trades/<int:trade_id>/strategy", strict_slashes=False)
class PnlSetTradeStrategy(Resource):
    @limiter.limit(API_RATE_LIMIT)
    def patch(self, trade_id):
        """Manual strategy-tag fallback for one historical trade row - see
        services/pnl_history_service.py::set_trade_strategy. Covers
        CSV-imported history and any trade with no orderid to
        automatically join against the strategy book.
        """
        try:
            data = pnl_set_trade_strategy_schema.load(request.json or {})
            success, response_data, status_code = set_trade_strategy(
                api_key=data["apikey"],
                trade_id=trade_id,
                strategy=data["strategy"],
            )
            return make_response(jsonify(response_data), status_code)
        except ValidationError as err:
            return make_response(jsonify({"status": "error", "message": err.messages}), 400)
        except Exception as e:
            logger.exception(f"Unexpected error in pnl/trades/<id>/strategy endpoint: {e}")
            return make_response(
                jsonify({"status": "error", "message": "An unexpected error occurred"}), 500
            )
