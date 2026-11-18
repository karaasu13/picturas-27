"""Validation of the frame extraction parameters.

Shared by the router, which rejects an invalid pipeline before any work starts,
and by the extraction service. Pure Python: no PIL, no ffmpeg.
"""
import math

from common.errors import InvalidExtraction

MAX_FRAMES = 100


def _is_finite_number(value) -> bool:
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def _check_value(mode, value):
    if not _is_finite_number(value):
        raise InvalidExtraction("Frame count or interval must be a finite number")
    if mode == "count" and (value != int(value) or not 1 <= value <= MAX_FRAMES):
        raise InvalidExtraction("Frame count must be an integer between 1 and 100")
    if mode == "interval" and value <= 0:
        raise InvalidExtraction("Frame interval must be greater than zero")


def validate_params(params):
    if not isinstance(params, dict):
        raise InvalidExtraction("Frame extraction requires parameters")
    mode = params.get("mode", "count")
    fmt = params.get("format", "png")
    if mode not in ("count", "interval") or fmt not in ("png", "jpeg"):
        raise InvalidExtraction("Choose count/interval and PNG/JPEG")
    value = params.get("count", 6) if mode == "count" else params.get("interval", 2)
    _check_value(mode, value)
    return mode, value, fmt
