"""
Verifies broker/{zerodha,kotak}/mapping/order_data.py normalize every order
and trade timestamp to one canonical ISO 8601 shape (YYYY-MM-DDTHH:MM:SS)
before it ever reaches a frontend - see SKYSHIELD_PATCHES.md's timestamp-
format-unification entry. Zerodha's raw Kite REST fields are "YYYY-MM-DD
HH:MM:SS"; Kotak's are "DD-MM-YYYY HH:MM:SS" - both must converge on the
same output shape, and a missing/empty timestamp must stay empty rather
than silently becoming "now".
"""

from broker.kotak.mapping.order_data import (
    transform_order_data as kotak_transform_order_data,
)
from broker.kotak.mapping.order_data import (
    transform_tradebook_data as kotak_transform_tradebook_data,
)
from broker.zerodha.mapping.order_data import (
    transform_order_data as zerodha_transform_order_data,
)
from broker.zerodha.mapping.order_data import (
    transform_tradebook_data as zerodha_transform_tradebook_data,
)

EXPECTED = "2026-09-07T09:30:01"


def test_zerodha_order_timestamp_normalized():
    orders = zerodha_transform_order_data(
        [
            {
                "tradingsymbol": "RELIANCE",
                "exchange": "NSE",
                "transaction_type": "BUY",
                "quantity": 1,
                "price": 1300.0,
                "trigger_price": 0.0,
                "order_type": "MARKET",
                "product": "CNC",
                "order_id": "1",
                "status": "COMPLETE",
                "order_timestamp": "2026-09-07 09:30:01",
            }
        ]
    )
    assert orders[0]["timestamp"] == EXPECTED


def test_zerodha_trade_prefers_fill_timestamp_and_normalizes():
    trades = zerodha_transform_tradebook_data(
        [
            {
                "tradingsymbol": "RELIANCE",
                "exchange": "NSE",
                "product": "CNC",
                "transaction_type": "BUY",
                "quantity": 1,
                "average_price": 1300.0,
                "order_id": "1",
                "trade_id": "t1",
                # order_timestamp is order-level (shared by every fill) and
                # deliberately wrong here to prove fill_timestamp wins.
                "order_timestamp": "2026-09-07 00:00:00",
                "fill_timestamp": "2026-09-07 09:30:01",
            }
        ]
    )
    assert trades[0]["timestamp"] == EXPECTED


def test_zerodha_missing_timestamp_stays_empty():
    orders = zerodha_transform_order_data(
        [
            {
                "tradingsymbol": "RELIANCE",
                "exchange": "NSE",
                "transaction_type": "BUY",
                "quantity": 1,
                "price": 1300.0,
                "trigger_price": 0.0,
                "order_type": "MARKET",
                "product": "CNC",
                "order_id": "1",
                "status": "OPEN",
                "order_timestamp": "",
            }
        ]
    )
    assert orders[0]["timestamp"] == ""


def test_kotak_order_timestamp_normalized():
    orders = kotak_transform_order_data(
        [
            {
                "trdSym": "RELIANCE-EQ",
                "exSeg": "nse_cm",
                "trnsTp": "B",
                "qty": 1,
                "avgPrc": 1300.0,
                "prc": 1300.0,
                "trgPrc": 0.0,
                "prcTp": "MKT",
                "prod": "CNC",
                "nOrdNo": "1",
                "ordSt": "complete",
                "ordEntTm": "07-09-2026 09:30:01",
            }
        ]
    )
    assert orders[0]["timestamp"] == EXPECTED


def test_kotak_trade_timestamp_normalized():
    trades = kotak_transform_tradebook_data(
        [
            {
                "trdSym": "RELIANCE-EQ",
                "exSeg": "nse_cm",
                "prod": "CNC",
                "trnsTp": "BUY",
                "fldQty": 1,
                "avgPrc": 1300.0,
                "nOrdNo": "1",
                "flId": "f1",
                "exTm": "07-09-2026 09:30:01",
            }
        ]
    )
    assert trades[0]["timestamp"] == EXPECTED


def test_kotak_missing_timestamp_stays_empty():
    orders = kotak_transform_order_data(
        [
            {
                "trdSym": "RELIANCE-EQ",
                "exSeg": "nse_cm",
                "trnsTp": "B",
                "qty": 1,
                "avgPrc": 1300.0,
                "prc": 1300.0,
                "trgPrc": 0.0,
                "prcTp": "MKT",
                "prod": "CNC",
                "nOrdNo": "1",
                "ordSt": "open",
                "ordEntTm": "",
            }
        ]
    )
    assert orders[0]["timestamp"] == ""
