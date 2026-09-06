# services/pnl_capture_service.py
"""Daily trade-capture job for the consolidated multi-day P&L feature.

Fork-only (SKYSHIELD_PATCHES.md) - not part of upstream OpenAlgo, see
database/pnl_db.py's module docstring for why.

Pulls today's tradebook once after market close, normalizes it through the
*existing* services/tradebook_service.py (never a broker module directly, so
this is broker-agnostic for free - Design Principles: "Broker-Agnostic
Contract"), and idempotently upserts each fill into db/tradebook.db.
Realized P&L itself is never computed or stored here - that happens on
read, in services/pnl_history_service.py.

Scheduling mirrors services/historify_scheduler_service.py: a singleton
BackgroundScheduler backed by a persisted SQLAlchemyJobStore
(database/apscheduler_jobstore_db.py's PNL_JOBSTORE_TABLE), started once
explicitly from app.py at startup - never lazily from request code (Design
Principles: "Background services need explicit start, stop, retry, and
cleanup behavior").
"""

import threading
from datetime import datetime

import pytz
from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from database.apscheduler_jobstore_db import (
    PNL_JOBSTORE_TABLE,
    ensure_jobstore_table,
    get_database_url,
)
from database.engine_factory import create_db_engine
from database.market_calendar_db import is_market_holiday
from database.pnl_db import (
    PnlCaptureRun,
    PnlTrade,
    db_session,
    derive_segment,
    make_dedup_key,
    parse_trade_timestamp,
)
from utils.logging import get_logger

logger = get_logger(__name__)

IST = pytz.timezone("Asia/Kolkata")

# Run once shortly after the exchange square-off/settlement window (NSE/BSE
# auto square-off is 3:20 PM per docs/design/OpenAlgo setup notes) so the
# day's fills, including any post-square-off exit, are final. Not tied to
# any one account's own strategy exit time (SkyShieldAT exits 15:14) since
# this job is a generic OpenAlgo feature, not SkyShieldAT-specific.
CAPTURE_HOUR_IST = 16
CAPTURE_MINUTE_IST = 0


def _default_broker_exchanges():
    """Exchanges this capture job checks for a trading holiday before
    running. NSE is authoritative for equities/derivatives on every broker
    this feature currently ships for (Zerodha, Kotak); a broker trading only
    a different exchange would need this made configurable, not hard-coded
    further.
    """
    return "NSE"


def capture_today_trades(auth_token: str, broker: str) -> dict:
    """Fetch today's tradebook and idempotently persist any new fills.

    Uses the *direct* (auth_token, broker) call into
    services.tradebook_service.get_tradebook - not the api_key path - so
    this always reads the live broker tradebook regardless of whether
    Analyzer/paper mode is currently toggled on for the account. Analyzer
    mode's simulated trades must never enter a real-money P&L ledger; the
    api_key path would silently reroute into sandbox trades when analyze
    mode is on (Design Principles: "the two persistence domains remain
    isolated").

    Returns a summary dict; also writes one PnlCaptureRun audit row so a
    silent failure is visible instead of just a data gap.
    """
    from services.tradebook_service import get_tradebook

    now_ist = datetime.now(IST).replace(tzinfo=None)
    run_date = now_ist.strftime("%Y-%m-%d")
    run = PnlCaptureRun(run_date=run_date, status="running", started_at=now_ist)
    db_session.add(run)
    db_session.commit()

    try:
        success, response, _status_code = get_tradebook(auth_token=auth_token, broker=broker)
        if not success:
            message = response.get("message", "unknown error")
            run.status = "failed"
            run.error = message
            run.finished_at = datetime.now(IST).replace(tzinfo=None)
            db_session.commit()
            logger.error(f"PnL capture failed for {run_date}: {message}")
            return {"status": "failed", "error": message}

        trades = response.get("data") or []
        new_count = 0
        for trade in trades:
            # Parsed once, then reused for both the dedup key and storage -
            # the key must be computed from the *canonical* timestamp so a
            # live-captured fill and its later CSV backfill (raw broker
            # string vs CSV string, possibly formatted differently) hash
            # identically when tradeid is unavailable and the fallback
            # composite key is what's actually comparing them.
            parsed_timestamp = parse_trade_timestamp(trade.get("timestamp"), fallback=now_ist)

            dedup_key = make_dedup_key(
                tradeid=trade.get("tradeid"),
                orderid=trade.get("orderid"),
                symbol=trade.get("symbol"),
                exchange=trade.get("exchange"),
                action=trade.get("action"),
                quantity=trade.get("quantity"),
                average_price=trade.get("average_price"),
                timestamp=parsed_timestamp,
            )

            if db_session.query(PnlTrade.id).filter_by(dedup_key=dedup_key).first():
                continue

            db_session.add(
                PnlTrade(
                    dedup_key=dedup_key,
                    tradeid=trade.get("tradeid") or None,
                    orderid=trade.get("orderid") or None,
                    symbol=trade.get("symbol"),
                    exchange=trade.get("exchange"),
                    product=trade.get("product"),
                    segment=derive_segment(trade.get("exchange")),
                    action=trade.get("action"),
                    quantity=float(trade.get("quantity") or 0),
                    average_price=float(trade.get("average_price") or 0),
                    trade_value=float(trade.get("trade_value") or 0),
                    trade_timestamp=parsed_timestamp,
                    source="capture",
                )
            )
            new_count += 1

        db_session.commit()

        run.status = "success"
        run.trades_fetched = len(trades)
        run.trades_new = new_count
        run.finished_at = datetime.now(IST).replace(tzinfo=None)
        db_session.commit()

        logger.info(
            f"PnL capture {run_date}: fetched {len(trades)} trade(s), {new_count} new"
        )
        return {"status": "success", "trades_fetched": len(trades), "trades_new": new_count}

    except Exception as e:
        db_session.rollback()
        run.status = "failed"
        run.error = str(e)
        run.finished_at = datetime.now(IST).replace(tzinfo=None)
        db_session.commit()
        logger.exception(f"PnL capture crashed for {run_date}: {e}")
        return {"status": "failed", "error": str(e)}
    finally:
        db_session.remove()


def run_daily_capture():
    """The scheduled job body: resolve today's account credentials and
    capture, skipping non-trading days.

    Single-tenant resolution (database.auth_db.get_first_available_api_key,
    the same helper services/historify_scheduler_service.py uses for its own
    background job) because each OpenAlgo instance here is one broker
    account, not a multi-user deployment - see CLAUDE.md.
    """
    today = datetime.now(IST).date()
    if is_market_holiday(today, exchange=_default_broker_exchanges()):
        logger.debug(f"PnL capture skipped: {today} is a market holiday")
        return

    from database.auth_db import get_auth_token_broker, get_first_available_api_key

    api_key = get_first_available_api_key()
    if not api_key:
        logger.warning("PnL capture skipped: no active broker session found")
        return

    auth_token, broker = get_auth_token_broker(api_key)
    if not auth_token or not broker:
        logger.warning("PnL capture skipped: could not resolve auth token/broker")
        return

    capture_today_trades(auth_token, broker)


class PnlCaptureScheduler:
    """Singleton scheduler, mirrors services/historify_scheduler_service.py's
    HistorifyScheduler shape.
    """

    _instance = None
    _scheduler: BackgroundScheduler | None = None
    _lock = threading.Lock()
    _initialized = False

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
        return cls._instance

    @property
    def scheduler(self) -> BackgroundScheduler:
        if self._scheduler is None:
            raise RuntimeError("Scheduler not initialized. Call init() first.")
        return self._scheduler

    def init(self, db_url: str = None):
        if self._initialized:
            return

        with self._lock:
            if self._initialized:
                return

            if db_url is None:
                db_url = get_database_url()

            try:
                # See database/apscheduler_jobstore_db.py's docstring (#1750):
                # app.py's serialized init phase normally creates this already;
                # retried here for any caller starting the scheduler outside
                # that path.
                ensure_jobstore_table(PNL_JOBSTORE_TABLE, database_url=db_url)

                jobstores = {
                    "default": SQLAlchemyJobStore(
                        engine=create_db_engine(db_url), tablename=PNL_JOBSTORE_TABLE
                    )
                }
                self._scheduler = BackgroundScheduler(
                    jobstores=jobstores,
                    job_defaults={
                        "coalesce": True,
                        "max_instances": 1,
                        "misfire_grace_time": 3600,
                    },
                )
                self._scheduler.add_job(
                    run_daily_capture,
                    trigger=CronTrigger(
                        hour=CAPTURE_HOUR_IST, minute=CAPTURE_MINUTE_IST, timezone=IST
                    ),
                    id="pnl_daily_capture",
                    replace_existing=True,
                )
                self._scheduler.start()
                self._initialized = True
                logger.debug("PnL capture scheduler initialized and started")
            except Exception as e:
                logger.exception(f"Failed to initialize PnL capture scheduler: {e}")
                raise

    def stop(self):
        if self._scheduler is not None:
            self._scheduler.shutdown(wait=False)
            self._initialized = False


def init_pnl_scheduler(db_url: str = None):
    """Entry point for app.py's startup block - mirrors
    init_historify_scheduler / init_flow_scheduler.
    """
    PnlCaptureScheduler().init(db_url=db_url)
