# test/test_pnl_history_fallback.py
"""_daily_closes: the account's own broker first, the optional fallback instance second.

Only the two data sources are faked (the broker history service and the HTTP
client); the bar parsing, the cache and the fallback decision run for real.
"""

import threading
import time
from datetime import date, datetime

import pytest

import services.history_service as history_service
import services.pnl_history_service as svc

START, END = date(2026, 11, 2), date(2026, 11, 6)
# 2026-11-03 and 2026-11-04 as midnight-IST bars written as 00:00 UTC.
BARS = [
    {"timestamp": 1793664000, "close": 100.5},
    {"timestamp": 1793750400, "close": 101.5},
]
EXPECTED = {date(2026, 11, 3): 100.5, date(2026, 11, 4): 101.5}


class FakeResponse:
    def __init__(self, status_code=200, body=None):
        self.status_code = status_code
        self._body = body

    def json(self):
        return self._body


class FakeClient:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls = []

    def post(self, url, json=None, timeout=None):
        self.calls.append({"url": url, "json": json, "timeout": timeout})
        if self.error:
            raise self.error
        return self.response


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    svc._daily_close_cache.clear()
    monkeypatch.delenv("PNL_HISTORY_FALLBACK_URL", raising=False)
    monkeypatch.delenv("PNL_HISTORY_FALLBACK_API_KEY", raising=False)
    yield
    svc._daily_close_cache.clear()


def _own_broker(monkeypatch, result):
    calls = []

    def fake(**kwargs):
        calls.append(kwargs)
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(history_service, "get_history", fake)
    return calls


def _configure(monkeypatch, client):
    monkeypatch.setenv("PNL_HISTORY_FALLBACK_URL", "https://primary.example/")
    monkeypatch.setenv("PNL_HISTORY_FALLBACK_API_KEY", "secret-key")
    monkeypatch.setattr(svc, "get_httpx_client", lambda: client)


def test_own_broker_answers_so_the_fallback_is_not_asked(monkeypatch):
    _own_broker(monkeypatch, (True, {"data": BARS}, 200))
    client = FakeClient(FakeResponse(200, {"status": "success", "data": []}))
    _configure(monkeypatch, client)

    assert svc._daily_closes("k", "ABC", "NSE", START, END) == EXPECTED
    assert client.calls == []


def test_no_fallback_configured_returns_empty_when_broker_has_none(monkeypatch):
    _own_broker(monkeypatch, (False, {"status": "error"}, 403))
    client = FakeClient(FakeResponse(200, {"status": "success", "data": BARS}))
    monkeypatch.setattr(svc, "get_httpx_client", lambda: client)

    assert svc._daily_closes("k", "ABC", "NSE", START, END) == {}
    assert client.calls == []


def test_fallback_fills_in_when_own_broker_returns_nothing(monkeypatch):
    _own_broker(monkeypatch, (False, {"status": "error"}, 403))
    client = FakeClient(FakeResponse(200, {"status": "success", "data": BARS}))
    _configure(monkeypatch, client)

    assert svc._daily_closes("k", "ABC", "NSE", START, END) == EXPECTED
    call = client.calls[0]
    assert call["url"] == "https://primary.example/api/v1/history"
    assert call["json"] == {
        "apikey": "secret-key",
        "symbol": "ABC",
        "exchange": "NSE",
        "interval": "D",
        "start_date": "2026-11-02",
        "end_date": "2026-11-06",
    }
    assert call["timeout"] == svc._FALLBACK_TIMEOUT_SECONDS


def test_fallback_used_when_own_broker_raises(monkeypatch):
    _own_broker(monkeypatch, RuntimeError("session expired"))
    client = FakeClient(FakeResponse(200, {"status": "success", "data": BARS}))
    _configure(monkeypatch, client)

    assert svc._daily_closes("k", "ABC", "NSE", START, END) == EXPECTED


def test_fallback_result_is_cached_for_the_same_span(monkeypatch):
    _own_broker(monkeypatch, (False, {"status": "error"}, 403))
    client = FakeClient(FakeResponse(200, {"status": "success", "data": BARS}))
    _configure(monkeypatch, client)

    svc._daily_closes("k", "ABC", "NSE", START, END)
    svc._daily_closes("k", "ABC", "NSE", START, END)

    assert len(client.calls) == 1


@pytest.mark.parametrize(
    "client",
    [
        FakeClient(FakeResponse(500, None)),
        FakeClient(FakeResponse(200, {"status": "error", "message": "no data"})),
        FakeClient(FakeResponse(200, ["not", "a", "dict"])),
        FakeClient(error=TimeoutError("slow")),
    ],
)
def test_a_failing_fallback_gives_empty_and_never_raises(monkeypatch, client):
    _own_broker(monkeypatch, (False, {"status": "error"}, 403))
    _configure(monkeypatch, client)

    assert svc._daily_closes("k", "ABC", "NSE", START, END) == {}
    assert svc._daily_close_cache.get(("ABC", "NSE")) is None


def test_fallback_first_skips_the_accounts_own_broker(monkeypatch):
    own_calls = _own_broker(monkeypatch, (True, {"data": []}, 200))
    client = FakeClient(FakeResponse(200, {"status": "success", "data": BARS}))
    _configure(monkeypatch, client)
    monkeypatch.setenv("PNL_HISTORY_FALLBACK_FIRST", "1")

    assert svc._daily_closes("k", "ABC", "NSE", START, END) == EXPECTED
    assert own_calls == []


def test_a_wider_cached_span_serves_a_narrower_range_without_a_call(monkeypatch):
    _own_broker(monkeypatch, (False, {"status": "error"}, 403))
    client = FakeClient(FakeResponse(200, {"status": "success", "data": BARS}))
    _configure(monkeypatch, client)

    svc._daily_closes("k", "ABC", "NSE", START, END)
    narrow = svc._daily_closes("k", "ABC", "NSE", date(2026, 11, 4), date(2026, 11, 5))

    assert narrow == {date(2026, 11, 4): 101.5}
    assert len(client.calls) == 1


def test_a_range_starting_earlier_than_the_cache_refetches_the_whole_span(monkeypatch):
    _own_broker(monkeypatch, (False, {"status": "error"}, 403))
    client = FakeClient(FakeResponse(200, {"status": "success", "data": BARS}))
    _configure(monkeypatch, client)

    svc._daily_closes("k", "ABC", "NSE", date(2026, 11, 3), END)
    svc._daily_closes("k", "ABC", "NSE", date(2026, 10, 1), END)

    assert [c["json"]["start_date"] for c in client.calls] == ["2026-11-03", "2026-10-01"]


def test_a_later_end_fetches_only_the_tail_and_merges(monkeypatch):
    _own_broker(monkeypatch, (False, {"status": "error"}, 403))
    client = FakeClient(FakeResponse(200, {"status": "success", "data": BARS}))
    _configure(monkeypatch, client)
    svc._daily_closes("k", "ABC", "NSE", START, date(2026, 11, 4))
    new_bar = {"timestamp": 1793836800, "close": 102.5}  # 2026-11-05
    client.response = FakeResponse(200, {"status": "success", "data": [new_bar]})

    got = svc._daily_closes("k", "ABC", "NSE", START, date(2026, 11, 5))

    assert got == {**EXPECTED, date(2026, 11, 5): 102.5}
    assert (
        client.calls[-1]["json"]["start_date"] == "2026-11-02"
    )  # entry.end - 5 days, floored at entry.start


def test_todays_bar_is_refreshed_after_the_close_but_not_while_trading(monkeypatch):
    _own_broker(monkeypatch, (False, {"status": "error"}, 403))
    client = FakeClient(FakeResponse(200, {"status": "success", "data": BARS}))
    _configure(monkeypatch, client)
    today = datetime.now(svc._IST).date()
    svc._daily_closes("k", "ABC", "NSE", START, today)
    assert len(client.calls) == 1

    later = svc.monotonic() + 10_000  # well past the refresh interval
    monkeypatch.setattr(svc, "monotonic", lambda: later)
    monkeypatch.setattr(svc, "_market_is_open", lambda *a, **k: True)
    svc._daily_closes("k", "ABC", "NSE", START, today)
    assert len(client.calls) == 1  # market trading: cached bar kept

    monkeypatch.setattr(svc, "_market_is_open", lambda *a, **k: False)
    svc._daily_closes("k", "ABC", "NSE", START, today)
    assert len(client.calls) == 2  # market shut and cache older than the interval


def test_the_fallback_key_is_never_logged(monkeypatch, caplog):
    _own_broker(monkeypatch, (False, {"status": "error"}, 403))
    _configure(monkeypatch, FakeClient(error=TimeoutError("slow")))

    with caplog.at_level("DEBUG"):
        svc._daily_closes("k", "ABC", "NSE", START, END)

    assert "secret-key" not in caplog.text


def test_two_requests_for_one_instrument_make_one_broker_call(monkeypatch):
    """A retry that arrives while the first request is still fetching waits for
    it and reads the cache, instead of repeating the broker call."""
    calls = []

    def slow_broker(**kwargs):
        calls.append(kwargs)
        time.sleep(0.2)
        return True, {"data": BARS}, 200

    monkeypatch.setattr(history_service, "get_history", slow_broker)
    results = []
    threads = [
        threading.Thread(target=lambda: results.append(svc._daily_closes("k", "ABC", "NSE", START, END)))
        for _ in range(4)
    ]
    for th in threads:
        th.start()
    for th in threads:
        th.join()

    assert len(calls) == 1
    assert results == [EXPECTED] * 4


def test_prefetch_fills_the_cache_for_every_instrument_concurrently(monkeypatch):
    seen = []
    lock = threading.Lock()
    inflight = {"now": 0, "peak": 0}

    def broker(**kwargs):
        with lock:
            inflight["now"] += 1
            inflight["peak"] = max(inflight["peak"], inflight["now"])
        time.sleep(0.1)
        with lock:
            inflight["now"] -= 1
            seen.append(kwargs["symbol"])
        return True, {"data": BARS}, 200

    monkeypatch.setattr(history_service, "get_history", broker)
    wanted = [(f"S{i}", "NSE") for i in range(8)]

    svc._prefetch_closes("k", dict.fromkeys(wanted, (START, END)))

    assert sorted(seen) == sorted(s for s, _ in wanted)
    assert inflight["peak"] > 1  # not one at a time
    assert inflight["peak"] <= 4  # and bounded
    for symbol, exchange in wanted:
        assert svc._daily_close_cache.get((symbol, exchange)) is not None


def test_one_failing_instrument_does_not_stop_the_prefetch(monkeypatch):
    def broker(**kwargs):
        if kwargs["symbol"] == "BAD":
            raise RuntimeError("boom")
        return True, {"data": BARS}, 200

    monkeypatch.setattr(history_service, "get_history", broker)

    svc._prefetch_closes("k", {("BAD", "NSE"): (START, END), ("GOOD", "NSE"): (START, END)})

    assert svc._daily_close_cache.get(("GOOD", "NSE")) is not None


def test_prefetch_asks_each_instrument_for_its_own_span_with_a_lead_in(monkeypatch):
    seen = {}

    def broker(**kwargs):
        seen[kwargs["symbol"]] = (kwargs["start_date"], kwargs["end_date"])
        return True, {"data": BARS}, 200

    monkeypatch.setattr(history_service, "get_history", broker)

    svc._prefetch_closes(
        "k",
        {
            ("SHORT", "NSE"): (date(2026, 11, 10), date(2026, 11, 12)),
            ("LONG", "NSE"): (date(2026, 11, 3), date(2026, 11, 20)),
        },
    )

    assert seen["SHORT"] == ("2026-11-05", "2026-11-12")
    assert seen["LONG"] == ("2026-10-29", "2026-11-20")
