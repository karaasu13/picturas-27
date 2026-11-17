"""Reading the characteristics of a video with ffprobe (shared by the video services)."""
import json
import os
import subprocess
from fractions import Fraction

from common.errors import InvalidVideo


def _frame_rate(video: dict) -> tuple:
    fps_str = video.get("avg_frame_rate") or video.get("r_frame_rate") or "0/1"
    try:
        fps = float(Fraction(fps_str))
    except (ZeroDivisionError, ValueError):
        fps = 0.0
    if fps <= 0:
        return "25/1", 25.0
    return fps_str, fps


def _duration(video: dict, fmt: dict, prefer_video_duration: bool) -> float:
    candidates = [fmt.get("duration"), video.get("duration")]
    if prefer_video_duration:
        candidates.insert(0, video.get("duration"))
    duration = float(next((value for value in candidates if value), 0))
    if duration <= 0:
        raise InvalidVideo("Could not determine the video duration")
    return duration


def _stream(streams: list, kind: str):
    return next((s for s in streams if s.get("codec_type") == kind), None)


def probe(path: str, prefer_video_duration: bool = False) -> dict:
    """Reads the video characteristics with ffprobe."""
    cmd = [
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", path,
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise InvalidVideo(f"Unreadable video file: {res.stderr.strip()[:200]}")

    data = json.loads(res.stdout or "{}")
    streams = data.get("streams", [])
    video = _stream(streams, "video")
    audio = _stream(streams, "audio")
    if video is None:
        raise InvalidVideo("The file has no video stream")

    fmt = data.get("format", {})
    duration = _duration(video, fmt, prefer_video_duration)
    fps_str, fps = _frame_rate(video)
    return {
        "duration": duration,
        "width": int(video["width"]),
        "height": int(video["height"]),
        "fps": fps,
        "fps_str": fps_str,
        "video_codec": video.get("codec_name"),
        "audio_codec": audio.get("codec_name") if audio else None,
        "has_audio": audio is not None,
        "format_name": fmt.get("format_name"),
        "size_bytes": int(fmt.get("size") or os.path.getsize(path)),
    }
