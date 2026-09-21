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


# --- Product is not part of the grouping key (SKYSHIELD_PATCHES.md, 2026-09-21) ---


def test_imported_buy_without_product_matches_captured_cnc_sell():
    # MINDACORP on acc1: bought via a Console CSV import (no product column,
    # stored as None), sold later by the bot and captured live as CNC. Keyed
    # on product these never met: the sell became a phantom short and the
    # P&L was never booked.
    trades = [
        _trade("BUY", 117, 595.83, "2026-05-26T10:00:00", product=None, symbol="MINDACORP"),
        _trade("SELL", 117, 677.68, "2026-09-15T15:13:00", product="CNC", symbol="MINDACORP"),
    ]
    result = compute_realized_pnl(trades)

    assert result.open_positions == []
    assert len(result.realized_lots) == 1
    assert round(result.total_realized_pnl, 2) == round((677.68 - 595.83) * 117, 2)
    # The lot reports the entry fill's own product, not a merged placeholder.
    assert result.realized_lots[0].product is None


def test_fno_mis_and_nrml_fills_of_one_symbol_match_per_symbol():
    # Zerodha's statement is per symbol: NIFTY08SEP2623550PE traded as MIS and
    # NRML shows one row. A buy under one product closed by a sell under the
    # other is still one position.
    trades = [
        _trade("BUY", 65, 10.0, "2026-09-07T09:30:00", exchange="NFO", segment="fno", product="NRML",
               symbol="NIFTY08SEP2623550PE"),
        _trade("SELL", 65, 14.0, "2026-09-08T09:30:00", exchange="NFO", segment="fno", product="MIS",
               symbol="NIFTY08SEP2623550PE"),
    ]
    result = compute_realized_pnl(trades)

    assert result.open_positions == []
    assert result.total_realized_pnl == (14.0 - 10.0) * 65


def test_open_position_reports_its_own_product():
    trades = [_trade("BUY", 10, 100.0, "2026-01-01T09:00:00", product="CNC")]
    result = compute_realized_pnl(trades)

    assert len(result.open_positions) == 1
    assert result.open_positions[0].product == "CNC"


def test_different_symbols_are_still_separate_positions():
    trades = [
        _trade("BUY", 10, 100.0, "2026-01-01T09:00:00", symbol="AAA"),
        _trade("SELL", 10, 110.0, "2026-01-02T09:00:00", symbol="BBB"),
    ]
    result = compute_realized_pnl(trades)

    assert result.realized_lots == []
    assert len(result.open_positions) == 2
