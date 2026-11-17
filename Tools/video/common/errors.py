"""Errors shared by the video services.

Each error carries the code that is reported to the projects orchestrator, so
the workers do not need to know each other's exceptions.
"""

WRONG_PROCEDURE = 2000
ERROR_PROCESSING = 2001


class VideoError(Exception):
    """Base class of the errors a video stage can report."""
    code = ERROR_PROCESSING


class UnsupportedEffect(VideoError):
    """The pipeline has an effect that is not available for video."""
    code = 2002


class InvalidTrim(VideoError):
    """Trim parameters outside the video duration or with end before start."""
    code = 2003


class InvalidVideo(VideoError):
    """File is not a readable video (corrupted, no video stream, ...)."""
    code = 2004


class InvalidSpeed(VideoError):
    """Speed factor outside the allowed range or not numeric."""
    code = 2005


class ProcessingError(VideoError):
    """ffmpeg failure while decoding or encoding."""


class InvalidExtraction(ValueError):
    """Invalid frame extraction parameters or an excessive output count."""


def error_code(error: BaseException) -> int:
    return getattr(error, "code", ERROR_PROCESSING)
