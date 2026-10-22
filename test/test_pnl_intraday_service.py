"""services/pnl_intraday_service.py: the API-key route to the P&L Tracker curve."""

from unittest.mock import patch

import services.pnl_intraday_service as svc


def test_rejects_an_unknown_basis():
    ok, body, status = svc.get_intraday_pnl("k", basis="nope")
    assert (ok, status) == (False, 400)


def test_tradebook_failure_is_passed_through():
    with patch.object(svc, "get_tradebook", return_value=(False, {"status": "error"}, 403)):
        ok, body, status = svc.get_intraday_pnl("k")
    assert (ok, status) == (False, 403)


def test_builder_none_means_data_null_not_a_zero_curve():
    with (
        patch.object(svc, "get_tradebook", return_value=(True, {"data": []}, 200)),
        patch.object(svc, "get_positionbook", return_value=(True, {"data": []}, 200)),
        patch.object(svc, "build_m2m_tracker_response", return_value=None),
    ):
        ok, body, status = svc.get_intraday_pnl("k", basis="m2m")
    assert ok and status == 200
    assert body["data"] is None


def test_builder_result_is_returned_and_basis_forwarded():
    seen = {}

    def fake_builder(**kwargs):
        seen.update(kwargs)
        return {"current_mtm": 12.5, "basis": kwargs["basis"], "pnl_series": []}

    rows = [{"symbol": "X", "exchange": "NFO", "product": "NRML"}]
    with (
        patch.object(svc, "get_tradebook", return_value=(True, {"data": []}, 200)),
        patch.object(svc, "get_positionbook", return_value=(True, {"data": rows}, 200)),
        patch.object(svc, "build_m2m_tracker_response", fake_builder),
    ):
        ok, body, status = svc.get_intraday_pnl("k", basis="pnl")
    assert body["data"]["current_mtm"] == 12.5
    assert seen["basis"] == "pnl" and seen["positions"] == rows and seen["api_key"] == "k"
