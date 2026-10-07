# utils/pnl_fifo.py
"""FIFO realized-P&L matcher for the consolidated multi-day P&L feature.

Pure calculation module - no I/O, no database, no Flask. Per OpenAlgo's own
layer-ownership convention (docs/design/20-design-principles), calculation
is its own layer beneath services; this is called by
services/pnl_history_service.py, never by a route directly.

Compute-on-read: nothing here is persisted. Every call re-derives realized
P&L from the raw fill rows handed to it. This mirrors the built-in intraday
PnL Tracker (blueprints/pnltracker.py), which also computes MTM/realized P&L
live from tradebook + positions on every request rather than caching a
result - and it's how a real broker's own back-office P&L report works.

FIFO, not average-cost or LIFO: matches Zerodha Console's own realized P&L
methodology (the report this feature is modeled on), and is the convention
most Indian retail traders expect for tax/reporting purposes.
"""

from collections import defaultdict, deque
from dataclasses import dataclass, field


@dataclass
class RealizedLot:
    """One closed (or partially closed) lot: an entry fill matched against
    exit fill(s), possibly across several exit trades or several days.
    """

    symbol: str
    exchange: str
    product: str | None
    entry_action: str  # BUY (long trade) or SELL (short trade)
    quantity: float
    entry_price: float
    entry_timestamp: object
    exit_price: float
    exit_timestamp: object
    realized_pnl: float
    # Strategy tag of the entry fill (None when untagged) - the position's identity.
    strategy: str | None = None


@dataclass
class OpenPosition:
    """Quantity still unmatched at the end of the requested range - carried
    forward from before the range, or simply still open.
    """

    symbol: str
    exchange: str
    product: str | None
    action: str  # BUY (net long) or SELL (net short)
    quantity: float
    average_price: float
    strategy: str | None = None


@dataclass
class FifoResult:
    realized_lots: list[RealizedLot] = field(default_factory=list)
    open_positions: list[OpenPosition] = field(default_factory=list)

    @property
    def total_realized_pnl(self) -> float:
        return sum(lot.realized_pnl for lot in self.realized_lots)


def compute_realized_pnl(trades: list[dict]) -> FifoResult:
    """FIFO-match a list of fills into realized lots plus any leftover open
    quantity.

    Each ``trades`` item is a dict with at minimum: ``symbol``, ``exchange``,
    ``action`` ("BUY"/"SELL"), ``quantity``, ``average_price``,
    ``trade_timestamp`` (sortable - a datetime or ISO string), and
    optionally ``product`` and ``segment``. Trades are grouped by (symbol,
    grouping exchange) and matched independently within each group.
    Product is deliberately NOT part of the key: Zerodha Console's own P&L
    statement matches per symbol regardless of MIS/NRML/CNC, and the ledger
    can hold one holding under two product labels - fills imported from a
    Console CSV carry no product (the export has no such column) while fills
    captured live carry the real one (CNC/MIS/NRML). Keyed on product, a buy
    imported as ``None`` and its later sell captured as ``CNC`` never met,
    which left the sell as a phantom short and the P&L unbooked
    (MINDACORP/WELCORP, SKYSHIELD_PATCHES.md). Each lot and open position
    still reports its own entry fill's product.

    For ``segment == "equity"``, exchange is dropped from the grouping key:
    NSE and BSE are the same depository security (one ISIN) for cash
    equity, and it's routine to buy on one and sell on the other within the
    same demat account - splitting them into separate FIFO queues produces
    phantom open positions (verified against a real account's Zerodha Tax
    P&L export: ~80 symbols traded cross-exchange, all fungible by ISIN).
    F&O is not merged - NFO and BFO are different contracts, not the same
    fungible instrument, so exchange stays in the key there. A missing/None
    segment (pre-migration rows) also keeps exchange in the key, the
    conservative default. Individual realized lots and open positions still
    report the fill's own actual exchange, not a merged placeholder.

    Order within a group matters for FIFO correctness: trades are sorted by
    ``trade_timestamp`` before matching, so callers do not need to
    pre-sort - but two fills with an identical or missing timestamp fall
    back to insertion order, which is why the caller should still hand
    trades in a stable, chronological order (e.g. by primary key) when
    timestamps can tie.
    """
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for trade in trades:
        exchange = trade.get("exchange")
        grouping_exchange = None if trade.get("segment") == "equity" else exchange
        key = (trade.get("symbol"), grouping_exchange)
        groups[key].append(trade)

    result = FifoResult()

    for (symbol, _grouping_exchange), group_trades in groups.items():
        ordered = sorted(
            enumerate(group_trades),
            key=lambda pair: (_sort_timestamp(pair[1].get("trade_timestamp")), pair[0]),
        )

        # Two FIFO queues: fills waiting to be closed, one per direction. A
        # BUY queue is drained by SELLs (closing a long) and vice versa. Both
        # can be non-empty only if the position flipped sign within the
        # range, which is legitimate (long -> flat -> short in one day).
        long_queue: deque[dict] = deque()
        short_queue: deque[dict] = deque()

        for _, trade in ordered:
            action = (trade.get("action") or "").upper()
            qty = float(trade.get("quantity") or 0)
            price = float(trade.get("average_price") or 0)
            ts = trade.get("trade_timestamp")
            fill_exchange = trade.get("exchange")
            fill_product = trade.get("product")
            fill_strategy = trade.get("strategy")

            if qty <= 0:
                continue

            if action == "BUY":
                remaining = qty
                # Closing shorts first (FIFO against the short queue) before
                # opening/adding to a long.
                while remaining > 0 and short_queue:
                    open_fill = short_queue[0]
                    matched = min(remaining, open_fill["quantity"])
                    realized_pnl = (open_fill["price"] - price) * matched
                    result.realized_lots.append(
                        RealizedLot(
                            symbol=symbol,
                            exchange=open_fill["exchange"],
                            product=open_fill["product"],
                            entry_action="SELL",
                            quantity=matched,
                            entry_price=open_fill["price"],
                            entry_timestamp=open_fill["timestamp"],
                            exit_price=price,
                            exit_timestamp=ts,
                            realized_pnl=realized_pnl,
                            strategy=open_fill.get("strategy"),
                        )
                    )
                    open_fill["quantity"] -= matched
                    remaining -= matched
                    if open_fill["quantity"] <= 1e-9:
                        short_queue.popleft()
                if remaining > 1e-9:
                    long_queue.append(
                        {
                            "price": price,
                            "quantity": remaining,
                            "timestamp": ts,
                            "exchange": fill_exchange,
                            "product": fill_product,
                            "strategy": fill_strategy,
                        }
                    )

            elif action == "SELL":
                remaining = qty
                while remaining > 0 and long_queue:
                    open_fill = long_queue[0]
                    matched = min(remaining, open_fill["quantity"])
                    realized_pnl = (price - open_fill["price"]) * matched
                    result.realized_lots.append(
                        RealizedLot(
                            symbol=symbol,
                            exchange=open_fill["exchange"],
                            product=open_fill["product"],
                            entry_action="BUY",
                            quantity=matched,
                            entry_price=open_fill["price"],
                            entry_timestamp=open_fill["timestamp"],
                            exit_price=price,
                            exit_timestamp=ts,
                            realized_pnl=realized_pnl,
                            strategy=open_fill.get("strategy"),
                        )
                    )
                    open_fill["quantity"] -= matched
                    remaining -= matched
                    if open_fill["quantity"] <= 1e-9:
                        long_queue.popleft()
                if remaining > 1e-9:
                    short_queue.append(
                        {
                            "price": price,
                            "quantity": remaining,
                            "timestamp": ts,
                            "exchange": fill_exchange,
                            "product": fill_product,
                            "strategy": fill_strategy,
                        }
                    )

        for open_fill in long_queue:
            if open_fill["quantity"] > 1e-9:
                result.open_positions.append(
                    OpenPosition(
                        symbol=symbol,
                        exchange=open_fill["exchange"],
                        product=open_fill["product"],
                        action="BUY",
                        quantity=open_fill["quantity"],
                        average_price=open_fill["price"],
                        strategy=open_fill.get("strategy"),
                    )
                )
        for open_fill in short_queue:
            if open_fill["quantity"] > 1e-9:
                result.open_positions.append(
                    OpenPosition(
                        symbol=symbol,
                        exchange=open_fill["exchange"],
                        product=open_fill["product"],
                        action="SELL",
                        quantity=open_fill["quantity"],
                        average_price=open_fill["price"],
                        strategy=open_fill.get("strategy"),
                    )
                )

    return result


def _sort_timestamp(value):
    """Make trade_timestamp sortable regardless of whether the caller passed
    a datetime, an ISO string, or None (pushed last rather than raising).
    """
    if value is None:
        return ""
    return str(value)


def summarize_by_day(realized_lots: list[RealizedLot]) -> list[dict]:
    """Roll realized lots up into per-day totals (date, realized_pnl, number
    of closed lots) - the shape a Zerodha-Console-style calendar view wants.
    Uses the lot's exit date (when the P&L was actually realized), not the
    entry date.

    Takes a plain list of lots rather than a whole FifoResult so a caller
    can hand in a date-range-filtered subset - see
    services/pnl_history_service.py::get_pnl_history, which FIFO-matches a
    wider lookback than the requested range (so a position opened long
    before start_date is still carried in correctly), then filters down to
    only the lots that actually closed within [start_date, end_date]
    before summarizing here.
    """
    by_day: dict[str, dict] = {}
    for lot in realized_lots:
        day = str(lot.exit_timestamp)[:10] if lot.exit_timestamp else "unknown"
        bucket = by_day.setdefault(day, {"date": day, "realized_pnl": 0.0, "trade_count": 0})
        bucket["realized_pnl"] += lot.realized_pnl
        bucket["trade_count"] += 1

    return sorted(by_day.values(), key=lambda row: row["date"])
