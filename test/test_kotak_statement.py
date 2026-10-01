# test/test_kotak_statement.py
"""Kotak "Transaction Statement" CSV import (SKYSHIELD_PATCHES.md, 2026-10-01).

Sample lines are real rows from acc3's (Iqbal) statement for 2026-07-01..09-30.
"""

from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import scoped_session, sessionmaker

import database.pnl_db as pnl_db
import services.pnl_history_service as svc
from database.pnl_db import Base, PnlTrade
from utils.kotak_statement import (
    is_kotak_statement,
    normalize_company_name,
    normalize_statement_row,
    parse_option_name,
    parse_trade_datetime,
)

HEADER = [
    "Trade Date", "Trade Time", "Order Time", "Security Name", "ISIN", "Exchange", "Order Source",
    "Transaction Type", "Quantity", "Market Rate", "Total", "GST", "Brokerage", "Misc.",
    "Total Charges", "STT/CTT",
]


def raw(date, time, name, exchange, side, qty, rate):
    return {
        "Trade Date": date, "Trade Time": time, "Order Time": time, "Security Name": name,
        "ISIN": "-", "Exchange": exchange, "Order Source": "Kotak Neo", "Transaction Type": side,
        "Quantity": str(qty), "Market Rate": str(rate), "Total": "1", "GST": "0", "Brokerage": "0",
        "Misc.": "0", "Total Charges": "0", "STT/CTT": "0",
    }


NIFTY = "OPTIDXNIFTY     06OCT2026CE  22850.00"
SENSEX = "OPTIDXSENSEX    01OCT2026PE  72000.00"
FAKE_MASTER = {"CYIENT LTD": "CYIENT", "WELSPUN CORP LTD": "WELCORP"}


def fake_resolve(name, exchange):
    return FAKE_MASTER.get(normalize_company_name(name))


# ------------------------------------------------------------ pure parsing


def test_header_identifies_a_kotak_statement_and_not_other_exports():
    assert is_kotak_statement(HEADER)
    zerodha = ["symbol", "isin", "trade_date", "exchange", "segment", "trade_type", "quantity",
               "price", "trade_id", "order_id", "order_execution_time"]
    assert not is_kotak_statement(zerodha)
    assert not is_kotak_statement(None)


def test_option_names_become_openalgo_symbols_with_the_right_exchange():
    assert parse_option_name(NIFTY) == ("NIFTY06OCT2622850CE", "NFO")
    # Kotak labels SENSEX NSEDERV too; the underlying decides BFO.
    assert parse_option_name(SENSEX) == ("SENSEX01OCT2672000PE", "BFO")
    assert parse_option_name("OPTIDXNIFTY     08SEP2026PE  23550.50") == ("NIFTY08SEP2623550.5PE", "NFO")


def test_non_option_names_are_not_guessed():
    assert parse_option_name("FUTIDXNIFTY     29SEP2026") is None
    assert parse_option_name("Cyient Ltd") is None
    assert parse_option_name("") is None


def test_dates_are_read_day_first_with_the_time_column():
    assert parse_trade_datetime("30/09/2026", "15:13:35") == "2026-09-30T15:13:35"
    assert parse_trade_datetime("01/09/2026", "09:40:12") == "2026-09-01T09:40:12"
    assert parse_trade_datetime("2026-09-30", "15:13:35") is None
    assert parse_trade_datetime("30/09/2026", "") is None


def test_company_names_compare_across_statement_and_symbol_master_spellings():
    assert normalize_company_name("Cyient Ltd") == normalize_company_name("CYIENT LIMITED")
    assert normalize_company_name("Engineers India Ltd") == normalize_company_name("ENGINEERS INDIA LTD.")
    assert normalize_company_name("ACME Solar Holdings Ltd") == normalize_company_name("ACME SOLAR HOLDINGS LTD")
    assert normalize_company_name("Cyient Ltd") != normalize_company_name("Cyient DLM Ltd")


def test_equity_row_maps_to_symbol_and_segment():
    row, reason = normalize_statement_row(
        raw("30/09/2026", "15:13:35", "Cyient Ltd", "NSE", "Buy", 125, 1100.3376), fake_resolve
    )
    assert reason is None
    assert row == {
        "symbol": "CYIENT", "exchange": "NSE", "action": "BUY", "quantity": 125.0,
        "average_price": 1100.3376, "trade_timestamp": "2026-09-30T15:13:35", "segment": "equity",
    }


def test_fno_row_maps_to_option_symbol():
    row, _ = normalize_statement_row(raw("30/09/2026", "15:15:26", NIFTY, "NSEDERV ", "Sell", 130, 60.15), fake_resolve)
    assert (row["symbol"], row["exchange"], row["segment"], row["action"]) == (
        "NIFTY06OCT2622850CE", "NFO", "fno", "SELL")


@pytest.mark.parametrize(
    "mutate, reason",
    [
        ({"Trade Date": "2026-09-30"}, "bad_date"),
        ({"Transaction Type": "Transfer"}, "bad_action"),
        ({"Quantity": "abc"}, "bad_number"),
        ({"Market Rate": "0"}, "bad_number"),
        ({"Exchange": "MCX"}, "unsupported_instrument"),
        ({"Security Name": "Unknown Corp Ltd", "Exchange": "NSE"}, "unresolved_symbol"),
        ({"Security Name": "FUTIDXNIFTY     29SEP2026", "Exchange": "NSEDERV"}, "unsupported_instrument"),
    ],
)
def test_bad_rows_are_rejected_with_a_reason(mutate, reason):
    base = raw("30/09/2026", "15:13:35", "Cyient Ltd", "NSE", "Buy", 125, 1100.3376)
    base.update(mutate)
    row, got = normalize_statement_row(base, fake_resolve)
    assert row is None and got == reason


# ---------------------------------------------------------------- service


@pytest.fixture()
def session(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'tradebook.db'}")
    Base.metadata.create_all(engine)
    scoped = scoped_session(sessionmaker(bind=engine, autocommit=False, autoflush=False))
    monkeypatch.setattr(svc, "db_session", scoped)
    monkeypatch.setattr(pnl_db, "engine", engine)
    monkeypatch.setattr(svc, "get_auth_token_broker", lambda key: ("token", "kotak"))
    monkeypatch.setattr(svc, "_lookup_strategy_for_import", lambda orderid: None)
    monkeypatch.setattr(svc, "_statement_equity_resolver", lambda: fake_resolve)
    yield scoped
    scoped.remove()
    engine.dispose()


def _all(scoped):
    rows = scoped.query(PnlTrade).order_by(PnlTrade.trade_timestamp).all()
    out = [(r.symbol, r.exchange, r.segment, r.action, r.quantity, r.trade_timestamp, r.source) for r in rows]
    scoped.remove()
    return out


def test_a_zerodha_account_rejects_a_kotak_statement(session, monkeypatch):
    monkeypatch.setattr(svc, "get_auth_token_broker", lambda key: ("token", "zerodha"))
    ok, body, status = svc.import_kotak_statement(
        "key", [raw("30/09/2026", "15:13:35", "Cyient Ltd", "NSE", "Buy", 125, 1100.3)]
    )
    assert (ok, status) == (False, 400)
    assert "Kotak" in body["message"] and "zerodha" in body["message"]
    assert _all(session) == []


def test_bad_apikey_is_rejected(session, monkeypatch):
    monkeypatch.setattr(svc, "get_auth_token_broker", lambda key: (None, None))
    ok, body, status = svc.import_kotak_statement("bad", [])
    assert (ok, status) == (False, 403)


def test_statement_rows_are_stored_and_a_reupload_is_a_no_op(session):
    rows = [
        raw("01/09/2026", "15:13:43", "Cyient Ltd", "NSE", "Buy", 505, 279),
        raw("01/09/2026", "09:40:12", NIFTY.replace("06OCT", "01SEP"), "NSEDERV ", "Sell", 65, 10.9),
        raw("01/09/2026", "09:40:13", "Mystery Ltd", "NSE", "Buy", 1, 10),
        raw("01/09/2026", "09:40:14", "FUTIDXNIFTY     29SEP2026", "NSEDERV ", "Buy", 1, 10),
    ]
    ok, body, _ = svc.import_kotak_statement("key", rows)
    assert ok
    assert body["data"] == {
        "imported": 2, "skipped_duplicate": 0, "skipped_invalid": 2, "skipped_covered_by_capture": 0,
        "rejected_reasons": {"unresolved_symbol": 1, "unsupported_instrument": 1},
        "unresolved_symbols": ["Mystery Ltd"],
    }
    stored = _all(session)
    assert [(s[0], s[1], s[2], s[6]) for s in stored] == [
        ("NIFTY01SEP2622850CE", "NFO", "fno", "import"),
        ("CYIENT", "NSE", "equity", "import"),
    ]

    ok, body, _ = svc.import_kotak_statement("key", rows)
    assert body["data"]["imported"] == 0 and body["data"]["skipped_duplicate"] == 2
    assert len(_all(session)) == 2


def test_days_the_capture_job_already_holds_are_not_imported(session):
    # The statement is order-level with no ids, so an overlapping day cannot be
    # deduplicated against the capture's per-fill rows and would double-count.
    session.add(
        PnlTrade(
            dedup_key="tid:2026-09-10:NSE:1", tradeid="1", orderid="o", symbol="NIFTY10SEP2623000CE",
            exchange="NFO", action="SELL", segment="fno", quantity=65.0, average_price=10.0,
            trade_value=650.0, trade_timestamp=datetime(2026, 9, 10, 9, 30, 4), source="capture",
        )
    )
    session.commit()
    session.remove()

    rows = [
        raw("09/09/2026", "09:30:04", NIFTY.replace("06OCT", "09SEP"), "NSEDERV ", "Sell", 65, 10.9),
        raw("10/09/2026", "09:30:04", NIFTY.replace("06OCT", "10SEP"), "NSEDERV ", "Sell", 65, 10.9),
        raw("15/09/2026", "09:30:04", NIFTY.replace("06OCT", "15SEP"), "NSEDERV ", "Sell", 65, 10.9),
    ]
    ok, body, _ = svc.import_kotak_statement("key", rows)
    assert ok
    # 9 Sep is before capture started -> imported; 10 Sep is covered -> skipped;
    # 15 Sep has no capture rows in this ledger -> imported.
    assert body["data"]["imported"] == 2
    assert body["data"]["skipped_covered_by_capture"] == 1
    days = sorted(s[5].strftime("%Y-%m-%d") for s in _all(session) if s[6] == "import")
    assert days == ["2026-09-09", "2026-09-15"]
