# database/pnl_db.py
"""Persistence for the consolidated multi-day realized P&L feature.

Fork-only addition (SKYSHIELD_PATCHES.md, 2026-09 entry) - not part of
upstream OpenAlgo. Upstream permanently rejected an in-platform "Trade
Journal" feature (marketcalls/openalgo#1683); this exists purely for our own
VMs and is not intended to be filed upstream.

Own SQLite file (``db/tradebook.db``), isolated from the main DB, for the
same reason ``sandbox_db.py`` is isolated: this is a distinct,
indefinitely-growing persistence domain (real trade history, not app
config) with its own backup and retention expectations. Mirrors
``sandbox_db.py``'s engine/session setup exactly - NullPool,
check_same_thread=False, scoped_session registered in
``utils/db_sessions.py`` for teardown.

Named for what it actually stores - the raw fill ledger, i.e. a tradebook
- not "pnl.db": realized P&L is never persisted anywhere, always computed
on demand at read time (see the two tables below).

Two tables:
- ``pnl_trades``: the captured/imported per-fill trade ledger. This is the
  only persisted P&L-related state - realized P&L itself is computed on read
  by ``utils/pnl_fifo.py`` from these rows (same "no precomputed P&L, always
  derive it" philosophy the built-in intraday PnL Tracker already uses;
  it's how a real broker's own console report works too).
- ``pnl_capture_runs``: an audit log of the daily capture job, mirroring
  Historify's own job-status bookkeeping (``download_jobs``/``job_items``)
  so a silent capture failure is visible rather than just a data gap.

Dedup key: prefer the broker's own per-fill ``tradeid`` (now correctly
emitted by every broker's ``transform_tradebook_data`` - see the 2026-09-06
tradeid fix) when present. Older trades pulled before that fix, and rows
from a CSV import that doesn't carry a tradeid, fall back to a composite key
so re-running the capture job or importing an overlapping CSV never
double-counts a fill.
"""

import hashlib
import os
from datetime import datetime

from dotenv import load_dotenv
from sqlalchemy import (
    Column,
    DateTime,
    Float,
    Index,
    Integer,
    String,
    Text,
    create_engine,
)
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import scoped_session, sessionmaker
from sqlalchemy.pool import NullPool
from sqlalchemy.sql import func

from utils.logging import get_logger

logger = get_logger(__name__)

load_dotenv()

# Own store, own env var - matches sandbox_db.py's isolation pattern and
# database/engine_factory.py's pooling policy (duplicated here rather than
# imported, exactly as sandbox_db.py does, so this module has no import-time
# dependency beyond SQLAlchemy itself).
#
# Named tradebook.db, not pnl.db: this file holds the raw fill ledger only
# (pnl_trades/pnl_capture_runs) - realized P&L itself is never stored,
# always computed on demand by utils/pnl_fifo.py at read time. "pnl.db"
# would have implied a stored P&L value that doesn't exist.
TRADEBOOK_DATABASE_URL = os.getenv("TRADEBOOK_DATABASE_URL", "sqlite:///db/tradebook.db")

if TRADEBOOK_DATABASE_URL and "sqlite" in TRADEBOOK_DATABASE_URL:
    engine = create_engine(
        TRADEBOOK_DATABASE_URL, poolclass=NullPool, connect_args={"check_same_thread": False}
    )
else:
    engine = create_engine(
        TRADEBOOK_DATABASE_URL, pool_size=20, max_overflow=40, pool_timeout=10
    )

db_session = scoped_session(sessionmaker(autocommit=False, autoflush=False, bind=engine))
Base = declarative_base()
Base.query = db_session.query_property()


def make_dedup_key(tradeid, orderid, symbol, exchange, action, quantity, average_price, timestamp):
    """Stable idempotency key for one fill.

    A genuine ``tradeid`` is unique on its own. Without one (pre-fix capture,
    or a CSV export that never included it), fall back to a composite of
    every field that would differ between two distinct fills of the same
    order - two legitimate fills can share orderid, symbol, action, and even
    price, but not all of those plus quantity and timestamp at once in
    practice. Hashed only to keep the indexed column short and fixed-width.
    """
    tradeid = (tradeid or "").strip()
    if tradeid:
        return f"tid:{tradeid}"

    # Numeric/timestamp fields are normalized before hashing so the same
    # fill produces the same key regardless of caller: the daily capture job
    # hands quantity/price through however the broker mapping typed them
    # (int, float, or occasionally string), while a CSV import parses its
    # own column types independently. int(100), float(100.0), and "100"
    # must all fold to one canonical string, or a CSV backfill of a
    # tradeid-less trade the capture job already stored would double-count
    # instead of deduping against it.
    try:
        quantity_norm = f"{float(quantity):.4f}"
    except (TypeError, ValueError):
        quantity_norm = str(quantity)
    try:
        price_norm = f"{float(average_price):.4f}"
    except (TypeError, ValueError):
        price_norm = str(average_price)

    raw = "|".join(
        str(part)
        for part in (orderid, symbol, exchange, action, quantity_norm, price_norm, timestamp)
    )
    return "composite:" + hashlib.sha1(raw.encode("utf-8")).hexdigest()


def parse_trade_timestamp(value, fallback=None):
    """Best-effort parse of a tradebook/CSV timestamp into a naive datetime
    for storage. Shared by the daily capture job and the CSV import path so
    both writers normalize the same way.

    Falls back to ``fallback`` (or now) rather than raising - one
    malformed timestamp must not lose an entire capture run or import batch.
    """
    if isinstance(value, datetime):
        return value.replace(tzinfo=None) if value.tzinfo else value

    if value:
        for fmt in (
            "%Y-%m-%d %H:%M:%S",
            "%Y-%m-%dT%H:%M:%S",
            "%d-%m-%Y %H:%M:%S",
            "%d-%b-%Y %H:%M:%S",
            "%Y-%m-%d",
            "%d-%m-%Y",
        ):
            try:
                return datetime.strptime(str(value), fmt)
            except ValueError:
                continue
        logger.warning(f"Could not parse trade timestamp {value!r}")

    return fallback if fallback is not None else datetime.now()


# Segment, alongside the existing exchange/product columns - user-requested
# addition so a row's broad category is directly visible on the row itself
# (and trivially filterable with a plain equality check) rather than only
# derivable by re-checking exchange against a set every time. "mutual_fund"
# is included for parity with Zerodha Console's own Tradebook segment
# picker, which this whole filter row is modeled on, but no OpenAlgo
# exchange constant maps to it today (no MF broker support exists yet) -
# it will never actually appear on a real row until that changes.
VALID_SEGMENTS = ("equity", "fno", "currency", "commodity", "mutual_fund")

# Built from utils.constants's own exchange constants rather than hand-typed
# strings, so this can never silently drift from the canonical exchange
# list if that module ever changes a code.
try:
    from utils.constants import (
        EXCHANGE_BCD,
        EXCHANGE_BFO,
        EXCHANGE_BSE,
        EXCHANGE_CDS,
        EXCHANGE_MCX,
        EXCHANGE_NCDEX,
        EXCHANGE_NCO,
        EXCHANGE_NFO,
        EXCHANGE_NSE,
    )

    _EXCHANGE_SEGMENT_MAP = {
        EXCHANGE_NSE: "equity",
        EXCHANGE_BSE: "equity",
        EXCHANGE_NFO: "fno",
        EXCHANGE_BFO: "fno",
        EXCHANGE_CDS: "currency",
        EXCHANGE_BCD: "currency",
        EXCHANGE_MCX: "commodity",
        EXCHANGE_NCDEX: "commodity",
        EXCHANGE_NCO: "commodity",  # "NSE Commodities (futures + options)" - commodity segment despite the name
    }
except ImportError:
    # utils.constants is part of this same codebase and always importable in
    # practice; guarded only so a database-layer module never hard-fails
    # over an import from an unrelated package.
    logger.exception("utils.constants unavailable - segment derivation disabled")
    _EXCHANGE_SEGMENT_MAP = {}


def derive_segment(exchange):
    """Map a raw exchange code to one of VALID_SEGMENTS, or None when it
    doesn't fit any of them (index/quote-only symbols like NSE_INDEX, or
    CRYPTO - not a real segment in this scheme and not traded by either
    broker this feature currently ships for).
    """
    return _EXCHANGE_SEGMENT_MAP.get((exchange or "").strip())


class PnlTrade(Base):
    """One captured or imported fill. The sole source of truth for the
    multi-day P&L feature - realized P&L is always derived from this table
    at read time, never stored.
    """

    __tablename__ = "pnl_trades"

    id = Column(Integer, primary_key=True, autoincrement=True)

    # Idempotency key - see make_dedup_key(). Unique so a re-run of the daily
    # capture job, or an overlapping CSV import, is a no-op rather than a
    # duplicate row.
    dedup_key = Column(String(80), unique=True, nullable=False, index=True)

    tradeid = Column(String(50), nullable=True, index=True)
    orderid = Column(String(50), nullable=True, index=True)

    symbol = Column(String(50), nullable=False, index=True)
    exchange = Column(String(20), nullable=False, index=True)
    product = Column(String(20), nullable=True)
    action = Column(String(10), nullable=False)  # BUY or SELL

    # One of VALID_SEGMENTS, derived from exchange at write time via
    # derive_segment() - stored rather than recomputed on every read/filter,
    # and directly visible when inspecting a row. Nullable: a handful of
    # exchange codes (index/quote symbols, crypto) don't map to any of the
    # five segments and are left unset rather than guessed.
    segment = Column(String(20), nullable=True, index=True)

    # Which SkyShieldAT strategy (or "Holdings", OpenAlgo's own Holdings
    # page placeholder for a manually-clicked order) placed this trade.
    # Backfilled at write time by joining this row's orderid against
    # database/strategy_book_db.py's StrategyOrderTag - a real, already-
    # running upstream feature (built for Flow's per-strategy risk
    # management) that tags orderid -> strategy the moment any order is
    # placed via /api/v1/placeorder, strategy-module or not. Nullable:
    # CSV-imported history predates OpenAlgo entirely for some rows (no
    # orderid to join against), and the order-tag lookup itself is
    # best-effort (a missing/expired tag - 30-day retention - just leaves
    # this unset rather than failing the write). Also settable manually via
    # PATCH /api/v1/pnl/trades/<id> for exactly those unattributed rows.
    strategy = Column(String(120), nullable=True, index=True)

    quantity = Column(Float, nullable=False)
    average_price = Column(Float, nullable=False)
    trade_value = Column(Float, nullable=True)

    # The trade's own execution timestamp (Zerodha: fill_timestamp: see the
    # 2026-09-06 fix; Kotak: exTm) - not this row's insert time.
    trade_timestamp = Column(DateTime, nullable=False, index=True)

    # "capture" (daily automated pull from services/tradebook_service.py) or
    # "import" (CSV upload, backfilling history predating the capture job).
    source = Column(String(20), nullable=False, default="capture")

    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_pnl_trades_symbol_exchange_ts", "symbol", "exchange", "trade_timestamp"),
        Index("idx_pnl_trades_ts", "trade_timestamp"),
    )


class PnlCaptureRun(Base):
    """Audit log for the daily capture job - one row per attempted run, so a
    silent failure (broker API down, auth expired) shows up as a gap instead
    of just missing trades nobody notices until a P&L report looks wrong.
    Mirrors the spirit of Historify's download_jobs/job_items bookkeeping.
    """

    __tablename__ = "pnl_capture_runs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    run_date = Column(String(10), nullable=False, index=True)  # YYYY-MM-DD, IST trading date
    status = Column(String(20), nullable=False)  # success, failed, partial
    trades_fetched = Column(Integer, nullable=False, default=0)
    trades_new = Column(Integer, nullable=False, default=0)
    error = Column(Text, nullable=True)
    started_at = Column(DateTime, nullable=False, default=func.now())
    finished_at = Column(DateTime, nullable=True)


def init_db():
    """Initialize the tradebook database and tables. Idempotent - safe on a
    fresh or pre-existing db/tradebook.db, per project persistence
    discipline (no Alembic; create_all plus targeted migrations if a
    column is ever added).
    """
    from database.db_init_helper import _ensure_sqlite_dir, init_db_with_logging

    _ensure_sqlite_dir(engine)
    init_db_with_logging(Base, engine, "Tradebook DB", logger)
    _migrate_add_segment_column()
    _migrate_add_strategy_column()


def _migrate_add_segment_column():
    """Add pnl_trades.segment to a database created before it existed.

    Mirrors sandbox_db.py's own column-migration pattern
    (_migrate_add_order_gtt_leg_id) - create_all's checkfirst only guards
    at the table level, so an existing table never gets a newly-added
    column without an explicit ALTER TABLE.
    """
    from sqlalchemy import text

    try:
        with engine.connect() as conn:
            existing = {row[1] for row in conn.execute(text("PRAGMA table_info(pnl_trades)"))}
            if not existing or "segment" in existing:
                return
            conn.execute(text("ALTER TABLE pnl_trades ADD COLUMN segment VARCHAR(20)"))
            # ALTER TABLE ADD COLUMN doesn't pick up the model's index=True -
            # that only fires from create_all - so it's created explicitly.
            conn.execute(
                text("CREATE INDEX IF NOT EXISTS ix_pnl_trades_segment ON pnl_trades(segment)")
            )
            conn.commit()
            logger.info("Added pnl_trades.segment")
    except Exception:
        logger.exception("Could not add pnl_trades.segment")


def _migrate_add_strategy_column():
    """Add pnl_trades.strategy to a database created before it existed.
    Same pattern as _migrate_add_segment_column().
    """
    from sqlalchemy import text

    try:
        with engine.connect() as conn:
            existing = {row[1] for row in conn.execute(text("PRAGMA table_info(pnl_trades)"))}
            if not existing or "strategy" in existing:
                return
            conn.execute(text("ALTER TABLE pnl_trades ADD COLUMN strategy VARCHAR(120)"))
            conn.execute(
                text("CREATE INDEX IF NOT EXISTS ix_pnl_trades_strategy ON pnl_trades(strategy)")
            )
            conn.commit()
            logger.info("Added pnl_trades.strategy")
    except Exception:
        logger.exception("Could not add pnl_trades.strategy")
