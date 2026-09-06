# restx_api/pnl_history_schema.py
"""Marshmallow schemas for the fork-only /api/v1/pnl/history and
/api/v1/pnl/import resources (restx_api/pnl_history.py).

Deliberately its own file rather than an addition to restx_api/account_schema.py:
that file is upstream-tracked and this feature is fork-only
(SKYSHIELD_PATCHES.md) - keeping it here means an upstream sync can replace
account_schema.py wholesale without touching this at all.
"""

from marshmallow import Schema, fields, validate


class PnlHistorySchema(Schema):
    apikey = fields.Str(required=True, validate=validate.Length(min=1, max=256))
    start_date = fields.Str(required=True, validate=validate.Length(equal=10))
    end_date = fields.Str(required=True, validate=validate.Length(equal=10))
    symbol = fields.Str(required=False, load_default=None)
    # "equity" (NSE/BSE cash) or "fno" (derivatives - reuses OpenAlgo's own
    # FNO_EXCHANGES, see services/pnl_history_service.py). Omitted/empty
    # means no segment filter.
    segment = fields.Str(
        required=False, load_default=None, validate=validate.OneOf(["equity", "fno"])
    )


class PnlImportSchema(Schema):
    apikey = fields.Str(required=True, validate=validate.Length(min=1, max=256))
    # The uploaded file itself arrives as multipart/form-data, not JSON, so
    # it's read directly from request.files in the resource rather than
    # validated by this schema - Marshmallow here only covers the apikey
    # form field sent alongside it.
