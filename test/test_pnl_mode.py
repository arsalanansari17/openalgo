# test/test_pnl_mode.py
"""tradebook_fills.mode (live / analyzer): paper fills from the SkyShield client
(POST /api/v1/pnl/paperfill) are stored as analyzer, reports filter on mode
(default live, so existing reports are unchanged), and FIFO never matches a
paper fill against a live one. Also the migration on a pre-mode table.
"""

from datetime import datetime

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import scoped_session, sessionmaker
from sqlalchemy.pool import StaticPool

import database.auth_db as auth_db
import database.pnl_db as pnl_db
import services.pnl_history_service as svc
from database.pnl_db import PnlTrade
from restx_api.pnl_history import _normalize_csv_row


@pytest.fixture
def session(monkeypatch):
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    PnlTrade.__table__.create(engine)
    scoped = scoped_session(sessionmaker(bind=engine, autoflush=False))
    monkeypatch.setattr(svc, "db_session", scoped)
    monkeypatch.setattr(svc, "get_auth_token_broker", lambda api_key: ("token", "zerodha"))
    monkeypatch.setattr(svc, "_live_open_rows", lambda *a, **k: ([], None))
    monkeypatch.setattr(svc, "get_order_tag", lambda orderid: None)
    monkeypatch.setattr(auth_db, "verify_api_key", lambda k: "arsalan" if k == "good" else None)
    yield scoped
    engine.dispose()


def _live(n, action, price, ts, symbol="NIFTY17NOV2623700PE"):
    return PnlTrade(dedup_key=f"live{n}", tradeid=f"L{n}", orderid=f"L{n}", symbol=symbol, exchange="NFO",
                    product="NRML", segment="fno", action=action, quantity=65, average_price=price,
                    trade_value=65 * price, trade_timestamp=ts, source="capture")


def _paper(n, action, price, ts, symbol="NIFTY17NOV2623700PE"):
    return {"tradeid": f"PAPER-{n}", "orderid": f"PAPER-{n}", "symbol": symbol, "exchange": "NFO",
            "product": "NRML", "action": action, "quantity": 65, "average_price": price,
            "trade_timestamp": ts, "strategy": "NiftyDirectionalOptionSelling"}


def test_paper_fill_stored_as_analyzer_and_idempotent(session):
    ok, body, code = svc.add_paper_fill("good", _paper(1, "SELL", 40.0, "2026-11-09 10:15:02"))
    assert ok and code == 200 and body["data"]["imported"] == 1
    ok, body, _ = svc.add_paper_fill("good", _paper(1, "SELL", 40.0, "2026-11-09 10:15:02"))
    assert body["data"]["skipped_duplicate"] == 1
    row = session.query(PnlTrade).one()
    assert (row.mode, row.source, row.strategy, row.segment) == ("analyzer", "paper", "NiftyDirectionalOptionSelling", "fno")


def test_paper_fill_rejects_bad_key_and_bad_fill(session):
    assert svc.add_paper_fill("bad", _paper(1, "SELL", 40.0, "2026-11-09 10:15:02"))[2] == 403
    assert svc.add_paper_fill("good", {**_paper(2, "SELL", 40.0, "2026-11-09 10:15:02"), "symbol": ""})[2] == 400
    assert svc.add_paper_fill("good", {**_paper(3, "SELL", 40.0, "2026-11-09 10:15:02"), "mode": "x"})[2] == 400


def test_reports_filter_on_mode_and_fifo_keeps_them_apart(session):
    # live: short at 40, covered at 20 -> +1300. paper: short at 41, covered at 21 -> +1300 as its own lot.
    session.add_all([_live(1, "SELL", 40.0, datetime(2026, 11, 9, 10, 15)),
                     _live(2, "BUY", 20.0, datetime(2026, 11, 9, 14, 0))])
    session.commit()
    svc.add_paper_fill("good", _paper(1, "SELL", 41.0, "2026-11-09 10:15:03"))
    svc.add_paper_fill("good", _paper(2, "BUY", 21.0, "2026-11-09 14:00:01"))
    # a paper BUY with no paper short before it must NOT close the live lot
    svc.add_paper_fill("good", _paper(3, "BUY", 5.0, "2026-11-09 09:30:00", symbol="NIFTY17NOV2623500PE"))

    live = svc.get_pnl_history("k", "2026-11-09", "2026-11-09")[1]["data"]
    assert live["mode"] == "live" and live["total_realized_pnl"] == 1300.0
    assert {t["mode"] for t in live["closed_trades"]} == {"live"}

    paper = svc.get_pnl_history("k", "2026-11-09", "2026-11-09", mode="analyzer")[1]["data"]
    assert paper["total_realized_pnl"] == 1300.0 and paper["open_positions"] == []
    assert {t["mode"] for t in paper["closed_trades"]} == {"analyzer"}

    both = svc.get_pnl_history("k", "2026-11-09", "2026-11-09", mode="all")[1]["data"]
    assert both["total_realized_pnl"] == 2600.0 and len(both["closed_trades"]) == 2
    assert sorted(t["mode"] for t in both["closed_trades"]) == ["analyzer", "live"]

    trades = svc.get_pnl_trades("k", "2026-11-09", "2026-11-09", mode="analyzer")[1]["data"]
    assert len(trades) == 3 and {t["mode"] for t in trades} == {"analyzer"}
    assert len(svc.get_pnl_trades("k", "2026-11-09", "2026-11-09")[1]["data"]) == 2      # default live


def test_csv_import_mode_column(session):
    row = _normalize_csv_row({"symbol": "INFY", "exchange": "NSE", "trade_type": "buy", "quantity": "10",
                              "price": "1500", "trade_id": "9", "order_id": "9", "trade_date": "2026-11-09",
                              "order_execution_time": "10:00:00", "Mode": "analyzer"})
    assert row["mode"] == "analyzer"
    svc.import_trades_csv("k", [row])
    assert session.query(PnlTrade).one().mode == "analyzer"
    svc.import_trades_csv("k", [{**row, "trade_id": "10", "tradeid": "10", "mode": "weird"}])
    assert sorted(r.mode for r in session.query(PnlTrade).all()) == ["analyzer", "live"]


def test_migration_adds_mode_as_live(monkeypatch):
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    with engine.connect() as c:
        c.execute(text("CREATE TABLE tradebook_fills (id INTEGER PRIMARY KEY, symbol VARCHAR(50))"))
        c.execute(text("INSERT INTO tradebook_fills (symbol) VALUES ('CYIENT')"))
        c.commit()
    monkeypatch.setattr(pnl_db, "engine", engine)
    pnl_db._migrate_add_mode_column()
    pnl_db._migrate_add_mode_column()                    # idempotent
    with engine.connect() as c:
        assert c.execute(text("SELECT mode FROM tradebook_fills")).scalar() == "live"
