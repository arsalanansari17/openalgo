# test/test_pnl_fifo.py
"""Regression tests for utils/pnl_fifo.py's grouping key.

Bug found verifying P&L against a real account's Zerodha Tax P&L export
(SKYSHIELD_PATCHES.md): grouping by (symbol, exchange, product) treats a
cash-equity ISIN bought on NSE and sold on BSE as two unrelated positions,
producing phantom open positions and understated realized loss. Equity
must merge NSE/BSE by ISIN-equivalent symbol; F&O must not, since NFO/BFO
are genuinely different contracts.
"""

from utils.pnl_fifo import compute_realized_pnl


def _trade(action, qty, price, ts, exchange="NSE", segment="equity", product="CNC", symbol="AMARAJABAT"):
    return {
        "symbol": symbol,
        "exchange": exchange,
        "product": product,
        "segment": segment,
        "action": action,
        "quantity": qty,
        "average_price": price,
        "trade_timestamp": ts,
    }


def test_equity_buy_on_nse_sell_on_bse_is_matched_not_left_open():
    trades = [
        _trade("BUY", 100, 500.0, "2026-01-05T09:30:00", exchange="NSE"),
        _trade("SELL", 100, 520.0, "2026-01-06T09:30:00", exchange="BSE"),
    ]
    result = compute_realized_pnl(trades)

    assert result.open_positions == []
    assert len(result.realized_lots) == 1
    lot = result.realized_lots[0]
    assert lot.realized_pnl == 2000.0
    # The lot still records the entry fill's own real exchange, not a
    # merged placeholder.
    assert lot.exchange == "NSE"


def test_equity_same_symbol_different_exchange_nets_correctly_both_directions():
    trades = [
        _trade("BUY", 50, 100.0, "2026-01-01T09:00:00", exchange="NSE"),
        _trade("BUY", 50, 110.0, "2026-01-02T09:00:00", exchange="BSE"),
        _trade("SELL", 100, 120.0, "2026-01-03T09:00:00", exchange="NSE"),
    ]
    result = compute_realized_pnl(trades)

    assert result.open_positions == []
    assert len(result.realized_lots) == 2
    assert result.total_realized_pnl == (120.0 - 100.0) * 50 + (120.0 - 110.0) * 50


def test_fno_segment_does_not_merge_across_exchange():
    # NFO and BFO are different contracts for the "same" underlying - must
    # stay as separate FIFO queues, unlike cash equity.
    trades = [
        _trade("BUY", 75, 200.0, "2026-01-05T09:30:00", exchange="NFO", segment="fno", product="NRML",
               symbol="NIFTY26JANFUT"),
        _trade("SELL", 75, 210.0, "2026-01-06T09:30:00", exchange="BFO", segment="fno", product="NRML",
               symbol="NIFTY26JANFUT"),
    ]
    result = compute_realized_pnl(trades)

    assert result.realized_lots == []
    assert len(result.open_positions) == 2
    exchanges = {op.exchange for op in result.open_positions}
    assert exchanges == {"NFO", "BFO"}


def test_missing_segment_keeps_exchange_separate_conservative_default():
    trades = [
        _trade("BUY", 10, 100.0, "2026-01-01T09:00:00", exchange="NSE", segment=None),
        _trade("SELL", 10, 110.0, "2026-01-02T09:00:00", exchange="BSE", segment=None),
    ]
    result = compute_realized_pnl(trades)

    assert result.realized_lots == []
    assert len(result.open_positions) == 2


def test_same_exchange_equity_matching_unaffected_by_the_fix():
    trades = [
        _trade("BUY", 10, 100.0, "2026-01-01T09:00:00", exchange="NSE"),
        _trade("SELL", 10, 105.0, "2026-01-02T09:00:00", exchange="NSE"),
    ]
    result = compute_realized_pnl(trades)

    assert len(result.realized_lots) == 1
    assert result.realized_lots[0].realized_pnl == 50.0
    assert result.open_positions == []
