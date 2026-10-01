# test/test_pnl_dedup_key.py
"""Regression tests for the tradeid dedup-key bug (SKYSHIELD_PATCHES.md,
2026-10-01): Zerodha re-uses a tradeid on later days, but the key was the bare
``tid:<id>``, so one clashing id made a Console CSV import fail as a whole
(UNIQUE constraint, nothing imported) and let the capture job silently skip a
real fill whose id matched an older one. The key is now date + exchange
family + tradeid.
"""

from datetime import datetime

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import scoped_session, sessionmaker

import database.pnl_db as pnl_db
import services.pnl_history_service as svc
from database.pnl_db import (
    Base,
    PnlTrade,
    exchange_family,
    fill_exists,
    make_dedup_key,
)


@pytest.fixture()
def session(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'tradebook.db'}")
    Base.metadata.create_all(engine)
    scoped = scoped_session(sessionmaker(bind=engine, autocommit=False, autoflush=False))
    monkeypatch.setattr(svc, "db_session", scoped)
    monkeypatch.setattr(pnl_db, "engine", engine)
    monkeypatch.setattr(svc, "get_auth_token_broker", lambda api_key: ("token", "zerodha"))
    monkeypatch.setattr(svc, "_lookup_strategy_for_import", lambda orderid: None)
    yield scoped
    scoped.remove()
    engine.dispose()


def _row(tradeid, date, symbol="NIFTY26MAR24300PE", exchange="NSE", action="sell", qty="130", price="298.2"):
    return {
        "symbol": symbol,
        "exchange": exchange,
        "action": action,
        "quantity": qty,
        "average_price": price,
        "orderid": f"order-{tradeid}-{date}",
        "tradeid": tradeid,
        "trade_timestamp": f"{date}T10:03:33",
        "segment": "fno",
    }


def _count(scoped):
    n = scoped.query(PnlTrade).count()
    scoped.remove()
    return n


def test_same_tradeid_on_different_days_gets_different_keys():
    k1 = make_dedup_key("1287081", "o1", "A", "NSE", "SELL", 65, 291.55, datetime(2026, 1, 22, 10, 0))
    k2 = make_dedup_key("1287081", "o2", "B", "NSE", "SELL", 130, 298.2, datetime(2026, 3, 5, 10, 3))
    assert k1 != k2
    assert k1 == "tid:2026-01-22:NSE:1287081"


def test_console_nse_label_and_capture_nfo_label_give_one_key():
    # Console labels a NIFTY option NSE, the capture job stores NFO: the same
    # fill must produce the same key or the overlap double-counts.
    ts = datetime(2026, 9, 10, 9, 30, 4)
    assert make_dedup_key("42", "o", "X", "NSE", "BUY", 1, 1, ts) == make_dedup_key(
        "42", "o", "Y", "NFO", "BUY", 1, 1, ts
    )
    assert make_dedup_key("42", "o", "X", "BSE", "BUY", 1, 1, ts) == make_dedup_key(
        "42", "o", "Y", "BFO", "BUY", 1, 1, ts
    )


def test_nse_and_bse_trade_numbers_are_separate():
    ts = datetime(2026, 9, 10, 9, 30, 4)
    assert make_dedup_key("42", "o", "X", "NSE", "BUY", 1, 1, ts) != make_dedup_key(
        "42", "o", "X", "BSE", "BUY", 1, 1, ts
    )
    assert exchange_family("nfo") == "NSE"
    assert exchange_family("MCX") == "MCX"
    assert exchange_family(None) == "?"


def test_missing_tradeid_still_uses_composite_key():
    key = make_dedup_key(None, "o", "S", "NSE", "BUY", 10, 100.0, datetime(2026, 1, 1, 9, 30))
    assert key.startswith("composite:")


def test_import_with_clashing_tradeids_imports_every_fill(session):
    rows = [
        _row("1287081", "2026-01-22", symbol="NIFTY26JAN25200CE", qty="65", price="291.55"),
        _row("1287081", "2026-03-05"),
        _row("1287080", "2026-01-22", symbol="NIFTY26JAN25200CE", qty="65", price="291.55"),
        _row("1287080", "2026-03-05"),
    ]
    ok, body, status = svc.import_trades_csv("key", rows)
    assert (ok, status) == (True, 200)
    assert body["data"] == {"imported": 4, "skipped_duplicate": 0, "skipped_invalid": 0}
    assert _count(session) == 4


def test_reimporting_the_same_file_is_a_no_op(session):
    rows = [_row("1287081", "2026-01-22"), _row("1287081", "2026-03-05")]
    svc.import_trades_csv("key", rows)
    ok, body, _ = svc.import_trades_csv("key", rows)
    assert ok
    assert body["data"] == {"imported": 0, "skipped_duplicate": 2, "skipped_invalid": 0}
    assert _count(session) == 2


def test_a_repeated_row_inside_one_file_is_skipped_not_fatal(session):
    # autoflush is off, so this used to fail only at commit and lose the file.
    rows = [_row("7", "2026-02-02"), _row("7", "2026-02-02"), _row("8", "2026-02-02")]
    ok, body, status = svc.import_trades_csv("key", rows)
    assert (ok, status) == (True, 200)
    assert body["data"] == {"imported": 2, "skipped_duplicate": 1, "skipped_invalid": 0}


def _legacy_row(tradeid, when, exchange="NSE"):
    return PnlTrade(
        dedup_key=f"tid:{tradeid}",
        tradeid=tradeid,
        orderid="o",
        symbol="NIFTY26JAN25200CE",
        exchange=exchange,
        action="SELL",
        segment="fno",
        quantity=65.0,
        average_price=291.55,
        trade_value=1.0,
        trade_timestamp=when,
        source="import",
    )


def test_legacy_key_row_dedupes_the_same_day_but_not_another_day(session):
    session.add(_legacy_row("111", datetime(2026, 1, 22, 10, 0)))
    session.commit()
    session.remove()

    same_day = _row("111", "2026-01-22", symbol="NIFTY26JAN25200CE", qty="65", price="291.55")
    other_day = _row("111", "2026-03-05")
    ok, body, _ = svc.import_trades_csv("key", [same_day, other_day])
    assert ok
    # The legacy row IS the same fill as same_day; other_day is a different
    # fill that happens to re-use the id and must be kept.
    assert body["data"] == {"imported": 1, "skipped_duplicate": 1, "skipped_invalid": 0}


def test_fill_exists_ignores_a_legacy_row_from_a_different_day(session):
    session.add(_legacy_row("222", datetime(2026, 1, 22, 10, 0)))
    session.commit()
    key = make_dedup_key("222", "o", "S", "NSE", "SELL", 1, 1, datetime(2026, 3, 5, 10, 0))
    assert fill_exists(session, key, "222", datetime(2026, 3, 5, 10, 0)) is False
    assert fill_exists(session, "tid:2026-01-22:NSE:222", "222", datetime(2026, 1, 22, 10, 0)) is True
    session.remove()


def test_migration_rewrites_legacy_keys_and_is_idempotent(session):
    session.add(_legacy_row("1287081", datetime(2026, 1, 22, 10, 0), exchange="NSE"))
    session.add(_legacy_row("555", datetime(2026, 3, 5, 10, 3), exchange="BFO"))
    session.commit()
    session.remove()

    pnl_db._migrate_dedup_keys_add_trade_date()
    pnl_db._migrate_dedup_keys_add_trade_date()  # second run must change nothing

    keys = sorted(r[0] for r in session.execute(text("select dedup_key from tradebook_fills")))
    session.remove()
    assert keys == ["tid:2026-01-22:NSE:1287081", "tid:2026-03-05:BSE:555"]


def test_migrated_key_matches_what_a_fresh_import_would_compute(session):
    session.add(_legacy_row("1287081", datetime(2026, 1, 22, 10, 0), exchange="NFO"))
    session.commit()
    session.remove()
    pnl_db._migrate_dedup_keys_add_trade_date()

    again = _row("1287081", "2026-01-22", symbol="NIFTY26JAN25200CE", qty="65", price="291.55")
    ok, body, _ = svc.import_trades_csv("key", [again])
    assert ok
    assert body["data"]["imported"] == 0 and body["data"]["skipped_duplicate"] == 1
