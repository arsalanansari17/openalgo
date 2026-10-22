# services/pnl_intraday_service.py
"""Today's intraday P&L curve for one account, by API key.

Fork-only (SKYSHIELD_PATCHES.md). blueprints/pnltracker.py serves the same curve
to a logged-in browser session; this serves it to AlgoMirror, which holds only
each account's API key. Both go through services/pnl_tracker_m2m.py, so the
curve, and its last point, are the Positions page's own numbers on the chosen
basis ("pnl": the broker's P&L, "m2m": today's move only).

The curve builder returns None whenever it cannot be exact (an unsupported
exchange, a missing previous close or candle history). That is reported as
`data: null` so the caller can fall back to its own calculation, never as a
made-up zero curve.
"""

from services.history_service import get_history
from services.pnl_tracker_m2m import build_m2m_tracker_response
from services.positionbook_service import get_positionbook
from services.quotes_service import get_multiquotes
from services.tradebook_service import get_tradebook
from utils.logging import get_logger

logger = get_logger(__name__)

VALID_BASES = ("pnl", "m2m")


def get_intraday_pnl(api_key: str, basis: str = "pnl"):
    """Returns (success, response_dict, status_code)."""
    # Imported here: blueprints/pnltracker.py owns the broker-timestamp parsing and
    # the candle time-zone handling, and importing it at module load would make the
    # services layer depend on a blueprint at startup.
    from blueprints.pnltracker import (
        convert_timestamp_to_ist,
        history_rate_limiter,
        parse_trade_timestamp,
    )

    if basis not in VALID_BASES:
        return False, {"status": "error", "message": f"basis must be one of {VALID_BASES}"}, 400

    try:
        ok, tradebook, status = get_tradebook(api_key=api_key)
        if not ok:
            return False, tradebook, status
        ok, positionbook, status = get_positionbook(api_key=api_key)
        if not ok:
            return False, positionbook, status

        data = build_m2m_tracker_response(
            basis=basis,
            api_key=api_key,
            positions=list(positionbook.get("data") or []),
            trades=list(tradebook.get("data") or []),
            parse_time=parse_trade_timestamp,
            to_ist=convert_timestamp_to_ist,
            rate_limiter=history_rate_limiter,
            get_history_fn=get_history,
            get_multiquotes_fn=get_multiquotes,
        )
    except Exception as e:
        logger.exception(f"Error building the intraday P&L curve: {e}")
        return False, {"status": "error", "message": "Could not build the intraday P&L curve"}, 500

    if data is None:
        return (
            True,
            {
                "status": "success",
                "data": None,
                "message": "The curve cannot be built exactly for this account today",
            },
            200,
        )
    return True, {"status": "success", "data": data}, 200
