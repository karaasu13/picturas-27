"""Bounded still-frame extraction and a small preview contact sheet."""
import math
import os
from pathlib import Path
import subprocess
import tempfile
import uuid

from PIL import Image, ImageDraw

from common.errors import InvalidExtraction  # noqa: F401 - re-exported for callers
from common.extraction_params import MAX_FRAMES, validate_params
from common.media import probe

def sampling_times(params, duration, fps):
    mode, value, fmt = validate_params(params)
    if mode == "count":
        times = [i * duration / int(value) for i in range(int(value))]
    else:
        # Avoid allocating huge lists for very small, otherwise valid intervals.
        times = [i * value for i in range(MAX_FRAMES + 1) if i * value < duration]
        if len(times) > MAX_FRAMES:
            raise InvalidExtraction("Interval would produce more than 100 frames; increase it")
    # CFR-normalized videos may contain fewer frames than the requested count.
    # Repeating the final frame is preferable to seeking beyond its last timestamp.
    last_frame = max(0, duration - 1 / fps)
    return [min(t, last_frame) for t in times], fmt


def _extract_still(input_path, timestamp, path, index):
    """Writes the frame at `timestamp` to `path` (PNG or high-quality JPEG, by extension)."""
    cmd = ["ffmpeg", "-y", "-v", "error", "-ss", f"{timestamp:.9f}",
           "-i", str(Path(input_path).resolve()), "-map", "0:v:0", "-an", "-frames:v", "1"]
    if path.suffix == ".jpg":
        cmd += ["-q:v", "2"]
    cmd += [str(path)]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode or not path.is_file() or not path.stat().st_size:
        raise RuntimeError(f"Could not extract frame {index + 1}: {result.stderr[-500:]}")


class _ContactSheet:
    """Preview: up to six thumbnails with their timestamps, three per row."""

    def __init__(self, count):
        self.image = Image.new("RGB", (384 * min(3, count), 240 * math.ceil(count / 3)), "#181818")

    def add(self, path, index, timestamp):
        with Image.open(path) as frame:
            frame = frame.convert("RGB")
            frame.thumbnail((384, 216))
            x, y = (index % 3) * 384, (index // 3) * 240
            self.image.paste(frame, (x + (384 - frame.width) // 2, y + (216 - frame.height) // 2))
            ImageDraw.Draw(self.image).text((x + 8, y + 220), f"{timestamp:.3f} s", fill="white")

    def save(self, work, parent, stem):
        preview_path = parent / f"{stem}-contact-{uuid.uuid4().hex}.png"
        self.image.save(work / "contact.png", format="PNG")
        os.replace(work / "contact.png", preview_path)
        return preview_path


def _preview_times(times):
    if len(times) > 6:
        return [times[round(i * (len(times) - 1) / 5)] for i in range(6)]
    return times


def extract_frames(input_path, output_path, info, params, progress, preview=False):
    times, fmt = sampling_times(params, info["duration"], info["fps"])
    if preview:
        times = _preview_times(times)
    extension = "png" if preview or fmt == "png" else "jpg"
    stem = Path(output_path).stem
    parent = Path(output_path).resolve().parent
    parent.mkdir(parents=True, exist_ok=True)
    # Every successful render gets its own directory. A failed retry cannot
    # overwrite a previous generation that the storage service still needs.
    destination = parent / f"{stem}-frames-{uuid.uuid4().hex}"
    with tempfile.TemporaryDirectory(prefix="extract-", dir=parent) as work:
        work = Path(work)
        frames_dir = work / "frames"
        frames_dir.mkdir()
        records = []
        sheet = _ContactSheet(len(times)) if preview else None
        for index, timestamp in enumerate(times):
            name = f"frame-{index + 1:04d}-{round(timestamp * 1000):09d}ms.{extension}"
            _extract_still(input_path, timestamp, frames_dir / name, index)
            if sheet:
                sheet.add(frames_dir / name, index, timestamp)
            records.append({"file": str(destination / name), "time": timestamp})
            progress(min(99, round((index + 1) * 99 / len(times))))
        if sheet:
            output = {"output_type": "image", "output_path": str(sheet.save(work, parent, stem)),
                      "frames": len(times), "width": sheet.image.width, "height": sheet.image.height}
        else:
            os.replace(frames_dir, destination)
            output = {"output_type": "frames", "output_path": str(destination), "frames": records,
                      "width": info["width"], "height": info["height"]}
    progress(100)
    return {**info, **output}


def extraction_stage(context) -> dict:
    """Stage handler of the extraction service: stills sampled from the stage's input."""
    # On the original, use the video stream duration so a longer audio stream
    # does not create out-of-range sample times.
    info = probe(context.input_path, prefer_video_duration=context.first)
    return extract_frames(context.input_path, context.final_output, info,
                          context.tools[-1].get("params", {}), context.progress,
                          preview=context.preview)
