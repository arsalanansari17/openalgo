#!/usr/bin/env python3
"""
Backfill: give untagged fills the strategy tag their order already carries

One order is filled in many pieces and each piece is its own row in
tradebook_fills. A tag set one row at a time (CSV import, manual tagging
before the fork tagged by order) can leave an order with some fills tagged
and some not. This copies the tag onto the untagged fills of the SAME order
and symbol.

Only unambiguous groups are touched: an order whose tagged fills all carry
one strategy. An order whose fills carry two different strategies is listed
and left alone. Tagged rows are never changed.

This is a data repair, so it is NOT in migrate_all.py's MIGRATIONS and is
never run by an update. The operator runs it deliberately. --apply copies
tradebook.db to db/backups/ first and aborts if the copy cannot be written.

Usage:
    cd upgrade
    uv run backfill_pnl_order_tags.py           # Report only
    uv run backfill_pnl_order_tags.py --apply   # Back up, then write
"""

import argparse
import os
import shutil
import sys
from datetime import datetime

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_ROOT)
import _pragmas  # noqa: F401,E402
from sqlalchemy import create_engine, inspect, text  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

TABLE = "tradebook_fills"
SQLITE_PREFIX = "sqlite:///"

# Orders with at least one tagged and at least one untagged fill, grouped the
# same way set_trade_strategy groups them (order id + symbol).
GROUPS_SQL = f"""
SELECT orderid, symbol,
       COUNT(*) AS fills,
       SUM(CASE WHEN strategy IS NULL OR strategy = '' THEN 1 ELSE 0 END) AS untagged,
       COUNT(DISTINCT CASE WHEN strategy IS NOT NULL AND strategy <> '' THEN strategy END) AS tags,
       MIN(CASE WHEN strategy IS NOT NULL AND strategy <> '' THEN strategy END) AS tag
FROM {TABLE}
WHERE orderid IS NOT NULL AND orderid <> ''
GROUP BY orderid, symbol
HAVING untagged > 0 AND tags > 0
"""


def database_url():
    from dotenv import load_dotenv

    load_dotenv(os.path.join(PROJECT_ROOT, ".env"))
    url = os.getenv("TRADEBOOK_DATABASE_URL", "sqlite:///db/tradebook.db")
    if url.startswith(SQLITE_PREFIX):
        path = url[len(SQLITE_PREFIX) :]
        if path and path != ":memory:" and not os.path.isabs(path):
            url = SQLITE_PREFIX + os.path.join(PROJECT_ROOT, path)
    return url


def backup(url):
    """Copy the SQLite file next to the database. Returns the path or None."""
    if not url.startswith(SQLITE_PREFIX):
        print("Not a SQLite database: back it up with your database tooling, then re-run.")
        return None
    source = url[len(SQLITE_PREFIX) :]
    directory = os.path.join(os.path.dirname(source), "backups")
    target = os.path.join(
        directory, f"tradebook.pre-ordertags-{datetime.now().strftime('%Y%m%d_%H%M%S')}.db"
    )
    try:
        os.makedirs(directory, exist_ok=True)
        shutil.copy2(source, target)
    except OSError as exc:
        print(f"Backup failed ({exc}); nothing was changed.")
        return None
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--apply", action="store_true", help="back up, then write the tags")
    args = parser.parse_args()

    url = database_url()
    engine = create_engine(url, poolclass=NullPool)
    if TABLE not in inspect(engine).get_table_names():
        print(f"No {TABLE} table in this database; nothing to do.")
        return 0

    with engine.connect() as conn:
        groups = conn.execute(text(GROUPS_SQL)).fetchall()

    clean = [g for g in groups if g.tags == 1]
    conflicts = [g for g in groups if g.tags > 1]
    fills = sum(g.untagged for g in clean)

    print(f"Orders with a mix of tagged and untagged fills: {len(groups)}")
    print(f"  will be completed: {len(clean)} orders, {fills} untagged fills")
    print(f"  left alone (two different strategies on one order): {len(conflicts)}")
    for g in conflicts:
        print(f"    order {g.orderid} {g.symbol}: {g.fills} fills, {g.untagged} untagged")

    if not args.apply:
        print("Report only. Re-run with --apply to write.")
        return 0
    if not clean:
        print("Nothing to write.")
        return 0

    saved = backup(url)
    if saved is None and url.startswith(SQLITE_PREFIX):
        return 1
    if saved:
        print(f"Backup written: {saved}")

    changed = 0
    with engine.begin() as conn:
        for g in clean:
            result = conn.execute(
                text(
                    f"UPDATE {TABLE} SET strategy = :tag "
                    "WHERE orderid = :orderid AND symbol = :symbol "
                    "AND (strategy IS NULL OR strategy = '')"
                ),
                {"tag": g.tag, "orderid": g.orderid, "symbol": g.symbol},
            )
            changed += result.rowcount
    print(f"Tagged {changed} fills.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
