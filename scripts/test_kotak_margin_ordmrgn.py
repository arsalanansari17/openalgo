# scripts/test_kotak_margin_ordmrgn.py
"""
Throwaway verification for parse_margin_response()'s ordMrgn-first fix
(fix/kotak-margin-ordmrgn-field branch). Run directly:
    uv run python scripts/test_kotak_margin_ordmrgn.py

No network calls.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from broker.kotak.mapping.margin_data import parse_margin_response

# --- 1. Real Kotak response captured live (NIFTY sell, qty 65, NRML):
#     reqdMrgn=0 (already covered by available funds) but ordMrgn holds the
#     real per-order cost -> must use ordMrgn, not reqdMrgn ---
real_response = {
    "avlCash": "451000.000000",
    "totMrgnUsd": "166066.606000",
    "mrgnUsd": "0.000000",
    "ordMrgn": "166066.606000",
    "rmsVldtd": "OK",
    "reqdMrgn": "0.000000",
    "avlMrgn": "0.000000",
    "insufFund": "0.000000",
    "stat": "Ok",
    "stCode": 200,
}
result = parse_margin_response(real_response)
assert result["status"] == "success", result
assert result["data"]["total_margin_required"] == 166066.606, result
print("PASS: real Kotak response -> ordMrgn (166066.606) used instead of reqdMrgn (0).")

# --- 2. ordMrgn missing (older/different response shape) -> falls back to reqdMrgn ---
fallback_response = {"stat": "Ok", "reqdMrgn": "5000.00"}
result = parse_margin_response(fallback_response)
assert result["data"]["total_margin_required"] == 5000.0, result
print("PASS: ordMrgn absent -> falls back to reqdMrgn.")

# --- 3. Both missing -> defaults to 0, no crash ---
empty_response = {"stat": "Ok"}
result = parse_margin_response(empty_response)
assert result["data"]["total_margin_required"] == 0, result
print("PASS: both fields absent -> defaults to 0 without error.")

# --- 4. stat != Ok -> error path unaffected ---
error_response = {"stat": "error", "errMsg": "invalid session token"}
result = parse_margin_response(error_response)
assert result["status"] == "error", result
assert result["message"] == "invalid session token", result
print("PASS: stat=error -> error path unchanged.")

print("\nAll checks passed.")
