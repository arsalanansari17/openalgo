# test/test_pnl_unrealized_pricing.py
"""Which price values the open lots in /pnl/history.

Live quotes while the market trades; the latest daily close once it is shut.
Found 24 Oct 2026 (SKYSHIELD_PATCHES.md): Kotak's quotes feed returned prices
that were not the session's close on a Saturday (CYIENT 1387.9 against a real
close of 1233.0), so the report's unrealized P&L did not match the Kotak app.
"""

from datetime import date, datetime

import pytest

import services.pnl_history_service as svc
from services.pnl_history_service import _IST, _live_open_rows, _market_is_open


@pytest.mark.parametrize(
    ("when", "expected"),
    [
        (datetime(2026, 10, 23, 9, 14, tzinfo=_IST), False),
        (datetime(2026, 10, 23, 9, 15, tzinfo=_IST), True),
        (datetime(2026, 10, 23, 15, 29, tzinfo=_IST), True),
        (datetime(2026, 10, 23, 15, 30, tzinfo=_IST), False),
        (datetime(2026, 10, 24, 11, 0, tzinfo=_IST), False),  # Saturday
        (datetime(2026, 10, 25, 11, 0, tzinfo=_IST), False),  # Sunday
    ],
)
def test_market_is_open_window(when, expected):
    assert _market_is_open(when) is expected


@pytest.fixture
def book(monkeypatch):
    import database.strategy_book_db as strategy_book
    from services import holdings_service, positionbook_service, quotes_service

    state = {"quote_calls": [], "close_calls": [], "closes": {}, "quotes": {}}

    monkeypatch.setattr(strategy_book, "get_strategy_legs", lambda strategy=None: [])
    monkeypatch.setattr(
        holdings_service,
        "get_holdings",
        lambda api_key=None: (
            True,
            {
                "data": {
                    "holdings": [
                        {
                            "symbol": "CYIENT",
                            "exchange": "NSE",
                            "product": "CNC",
                            "quantity": 125,
                            "t1_quantity": 0,
                            "pledged_quantity": 0,
                            "average_price": 1100.55,
                        }
                    ]
                }
            },
            200,
        ),
    )
    monkeypatch.setattr(
        positionbook_service, "get_positionbook", lambda api_key=None: (True, {"data": []}, 200)
    )

    def fake_quotes(wanted, api_key=None):
        state["quote_calls"].append([(w["symbol"], w["exchange"]) for w in wanted])
        results = [
            {"symbol": s, "exchange": e, "data": {"ltp": state["quotes"][(s, e)]}}
            for s, e in [(w["symbol"], w["exchange"]) for w in wanted]
            if (s, e) in state["quotes"]
        ]
        return True, {"results": results}, 200

    def fake_closes(api_key, symbol, exchange, start, end):
        state["close_calls"].append((symbol, exchange))
        return state["closes"].get((symbol, exchange), {})

    monkeypatch.setattr(quotes_service, "get_multiquotes", fake_quotes)
    monkeypatch.setattr(svc, "_daily_closes", fake_closes)
    return state


def test_closed_market_prices_at_the_last_close_not_the_quote(monkeypatch, book):
    monkeypatch.setattr(svc, "_market_is_open", lambda now=None: False)
    book["quotes"][("CYIENT", "NSE")] = 1387.9  # the bad Kotak quote
    book["closes"][("CYIENT", "NSE")] = {date(2026, 10, 22): 1143.7, date(2026, 10, 23): 1233.0}

    rows, total = _live_open_rows("key", "2999-01-01")

    assert [r["ltp"] for r in rows] == [1233.0]
    assert rows[0]["price_source"] == "close"
    assert rows[0]["unrealized_pnl"] == round((1233.0 - 1100.55) * 125, 2)
    assert total == rows[0]["unrealized_pnl"]
    assert book["quote_calls"] == []  # nothing needed a quote


def test_closed_market_without_history_falls_back_to_the_quote(monkeypatch, book):
    monkeypatch.setattr(svc, "_market_is_open", lambda now=None: False)
    book["quotes"][("CYIENT", "NSE")] = 1233.0

    rows, _total = _live_open_rows("key", "2999-01-01")

    assert rows[0]["ltp"] == 1233.0
    assert rows[0]["price_source"] == "quote"
    assert book["quote_calls"] == [[("CYIENT", "NSE")]]


def test_open_market_uses_the_quote_and_never_asks_for_history(monkeypatch, book):
    monkeypatch.setattr(svc, "_market_is_open", lambda now=None: True)
    book["quotes"][("CYIENT", "NSE")] = 1250.0
    book["closes"][("CYIENT", "NSE")] = {date(2026, 10, 23): 1233.0}

    rows, _total = _live_open_rows("key", "2999-01-01")

    assert rows[0]["ltp"] == 1250.0
    assert rows[0]["price_source"] == "quote"
    assert book["close_calls"] == []


def test_a_close_dated_after_today_is_never_used(monkeypatch, book):
    monkeypatch.setattr(svc, "_market_is_open", lambda now=None: False)
    book["closes"][("CYIENT", "NSE")] = {date(2999, 1, 1): 9999.0}
    book["quotes"][("CYIENT", "NSE")] = 1233.0

    rows, _total = _live_open_rows("key", "2999-01-01")

    assert rows[0]["ltp"] == 1233.0
    assert rows[0]["price_source"] == "quote"
