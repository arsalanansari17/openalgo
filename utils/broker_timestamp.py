"""
Shared broker-timestamp parsing (fork-only). Deliberately has zero
dependency on database/pnl_db.py's PnlTrade/P&L-ledger machinery, unlike
that module's near-identical parse_trade_timestamp() - broker/{zerodha,
kotak}/mapping/order_data.py need this for every order/trade fetch
regardless of which fork branch an account is running, while pnl_db.py
(and the P&L History feature it backs) exists only on upgrade-main-2026-09
today. A broker mapping file importing from the P&L feature's own database
module would silently break order/trade fetching with an ImportError on
any other branch - see SKYSHIELD_PATCHES.md's timestamp-format-unification
entry for the incident this was caught in.

database/pnl_db.py's own parse_trade_timestamp is a thin wrapper around
this function, so there is exactly one implementation.
"""

from datetime import datetime

from utils.logging import get_logger

logger = get_logger(__name__)


def parse_broker_timestamp(value, fallback=None):
    """Best-effort parse of a broker/CSV/ledger timestamp into a naive
    datetime. Falls back to ``fallback`` (or now) rather than raising - one
    malformed timestamp must not take down an entire order/trade fetch,
    capture run, or import batch.
    """
    if isinstance(value, datetime):
        return value.replace(tzinfo=None) if value.tzinfo else value

    if value:
        for fmt in (
            "%Y-%m-%d %H:%M:%S",
            "%Y-%m-%dT%H:%M:%S",
            "%d-%m-%Y %H:%M:%S",
            "%d-%b-%Y %H:%M:%S",
            "%Y-%m-%d",
            "%d-%m-%Y",
        ):
            try:
                return datetime.strptime(str(value), fmt)
            except ValueError:
                continue
        logger.warning(f"Could not parse broker timestamp {value!r}")

    return fallback if fallback is not None else datetime.now()
