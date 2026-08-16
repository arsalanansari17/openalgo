# scripts/test_kotak_synthetic_vix_token.py
"""
Throwaway verification for _ensure_synthetic_index_rows() (Kotak master
contract, fix/kotak-synthetic-indiavix-symtoken branch). Run directly:
    uv run python scripts/test_kotak_synthetic_vix_token.py

Uses a real (temp, isolated) SQLite DB via DATABASE_URL so it exercises the
actual SymToken model/session, not a mock.
"""

import os
import sys
import tempfile
from pathlib import Path

tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{tmp_db.name}"

sys.path.insert(0, str(Path(__file__).parent.parent))

from broker.kotak.database.master_contract_db import (
    SymToken,
    _ensure_synthetic_index_rows,
    db_session,
    init_db,
)

init_db()

# --- 1. No INDIAVIX row exists yet -> gets inserted ---
before = SymToken.query.filter_by(symbol="INDIAVIX", exchange="NSE_INDEX").first()
assert before is None, "test setup invalid: row already present"

_ensure_synthetic_index_rows()

row = SymToken.query.filter_by(symbol="INDIAVIX", exchange="NSE_INDEX").first()
assert row is not None, "synthetic row was not inserted"
assert row.token == "SYNTHETIC_INDIAVIX", row.token
assert row.instrumenttype == "INDEX", row.instrumenttype
assert row.brexchange == "NSE", row.brexchange
print("PASS: synthetic INDIAVIX row inserted with expected fields.")

# --- 2. Simulate the wipe-and-reload cycle: delete_symtoken_table() wipes
#     everything, then a second call to _ensure_synthetic_index_rows() must
#     re-insert it (this is the actual survival guarantee the fix depends
#     on -- master_contract_download() always calls it after every refresh) ---
from broker.kotak.database.master_contract_db import delete_symtoken_table

delete_symtoken_table()
assert SymToken.query.filter_by(symbol="INDIAVIX", exchange="NSE_INDEX").first() is None

_ensure_synthetic_index_rows()
row = SymToken.query.filter_by(symbol="INDIAVIX", exchange="NSE_INDEX").first()
assert row is not None, "synthetic row did not survive a simulated refresh"
print("PASS: synthetic row re-created after a simulated master-contract wipe.")

# --- 3. Calling it again when the row already exists -> no duplicate ---
_ensure_synthetic_index_rows()
count = SymToken.query.filter_by(symbol="INDIAVIX", exchange="NSE_INDEX").count()
assert count == 1, f"expected exactly 1 row, got {count}"
print("PASS: idempotent -- calling again does not create a duplicate.")

db_session.remove()
os.unlink(tmp_db.name)

print("\nAll checks passed.")
