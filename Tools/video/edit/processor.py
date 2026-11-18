"""PictuRAS video edit stage.

Decodes the video once with ffmpeg, applies the stage's effects to every
frame with the same PIL operations as the image tools, and encodes once to
MP4/H.264 + AAC, keeping the audio.

Trim (time cut) is resolved before decoding: only the [start, end] window is
read, and the audio is cut on the same window so it stays in sync with the
picture.

Speed changes the playback rate (0.25x to 5x): frame timestamps are rescaled
while decoding and the audio tempo is changed by the same factor, so both stay
in sync. Trim times always refer to the video the stage receives.
"""
import os
import subprocess
import tempfile

from PIL import Image

from common.errors import InvalidSpeed, InvalidTrim, InvalidVideo, ProcessingError
from common.media import probe
from common.plan import EDIT_QUEUE
from edit.effects import apply_frame_effects, frame_effect

# Preview: only the first seconds
PREVIEW_SECONDS = float(os.getenv("VIDEO_PREVIEW_SECONDS", "3"))

# Allowed playback speed factors
MIN_SPEED = 0.25
MAX_SPEED = 5.0

# Effects that act on time, resolved before decoding
TIME_EFFECTS = {"trim", "speed"}


def _trim_times(params: dict) -> tuple:
    try:
        return float(params.get("start", 0)), float(params.get("end"))
    except (TypeError, ValueError):
        raise InvalidTrim("Trim requires numeric start and end (seconds)")


def resolve_trim(tools: list, duration: float) -> tuple:
    """Composes the pipeline trims, in order, into one [start, end] window in seconds.

    Each trim's times are relative to the video as it is at that point of the
    pipeline (after the previous trims).
    """
    start, end = 0.0, float(duration)
    for tool in tools:
        if tool.get("procedure") != "trim":
            continue
        t_start, t_end = _trim_times(tool.get("params") or {})
        length = end - start
        if t_start < 0 or t_end <= t_start:
            raise InvalidTrim("Trim end must be after its start")
        if t_start >= length or t_end > length + 1e-3:
            raise InvalidTrim(
                f"Trim [{t_start}, {t_end}] s is outside the video duration ({length:.2f} s)"
            )
        start, end = start + t_start, start + min(t_end, length)
    return start, end


def resolve_speed(tools: list) -> float:
    """Combined playback speed of the pipeline (several speed effects multiply)."""
    factor = 1.0
    for tool in tools:
        if tool.get("procedure") != "speed":
            continue
        try:
            f = float((tool.get("params") or {}).get("factor"))
        except (TypeError, ValueError):
            raise InvalidSpeed("Speed requires a numeric factor")
        if not MIN_SPEED <= f <= MAX_SPEED:
            raise InvalidSpeed(f"Speed must be between {MIN_SPEED}x and {MAX_SPEED}x (got {f}x)")
        factor *= f
    return factor


def atempo_chain(factor: float) -> str:
    """ffmpeg atempo filters for `factor` (each atempo stage must be in [0.5, 2])."""
    stages = []
    while factor > 2.0:
        stages.append(2.0)
        factor /= 2.0
    while factor < 0.5:
        stages.append(0.5)
        factor /= 0.5
    stages.append(factor)
    return ",".join(f"atempo={s:.6f}" for s in stages)


def frame_tools(tools: list) -> list:
    """The frame effects of the stage, checked against the available effects."""
    selected = [tool for tool in tools if tool.get("procedure") not in TIME_EFFECTS]
    for tool in selected:
        frame_effect(tool.get("procedure"))
    return selected


def _decode_command(input_path: str, info: dict, start: float, duration: float, speed: float) -> list:
    # rescale timestamps by the speed factor, then resample to the original frame rate
    # (frames are dropped when speeding up and duplicated when slowing down)
    return [
        "ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{duration:.3f}",
        "-i", input_path, "-map", "0:v:0", "-an",
        "-vf", f"setpts=PTS/{speed:.6f},fps={info['fps_str']}",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]


def _encode_command(input_path, out_path, size, info, start, duration, speed) -> list:
    ow, oh = size
    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{ow}x{oh}",
        "-r", info["fps_str"], "-i", "-",
    ]
    if info["has_audio"]:
        # same time window as the video => audio in sync with the picture
        cmd += ["-ss", f"{start:.3f}", "-t", f"{duration:.3f}", "-i", input_path,
                "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "128k"]
        if abs(speed - 1.0) > 1e-6:
            # same speed factor on the audio => still in sync with the picture
            cmd += ["-af", atempo_chain(speed)]
    else:
        cmd += ["-map", "0:v:0"]
    return cmd + [
        # H.264/yuv420p requires even dimensions
        "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        "-shortest", "-f", "mp4", out_path,
    ]


class _Progress:
    """Reports the percentage of frames processed, at most every 2 %."""

    def __init__(self, callback, expected_frames: int):
        self.callback = callback
        self.expected = expected_frames
        self.last = -1

    def frame_done(self, frames: int) -> None:
        pct = min(99, int(frames * 100 / self.expected))
        if self.callback and pct != self.last and (pct - self.last >= 2 or pct == 99):
            self.last = pct
            self.callback(pct)


class _Transcode:
    """One decode -> frame effects -> encode pass, with both ffmpeg processes."""

    def __init__(self, input_path, tmp_out, info, window, speed):
        self.input_path, self.tmp_out, self.info = input_path, tmp_out, info
        self.start, self.duration = window
        self.speed = speed
        self.dec_err = tempfile.TemporaryFile()
        self.enc_err = tempfile.TemporaryFile()
        self.decoder = subprocess.Popen(
            _decode_command(input_path, info, self.start, self.duration, speed),
            stdout=subprocess.PIPE, stderr=self.dec_err)
        self.encoder = None

    def frames(self):
        width, height = self.info["width"], self.info["height"]
        frame_bytes = width * height * 3
        while True:
            raw = self.decoder.stdout.read(frame_bytes)
            if len(raw) < frame_bytes:
                return
            yield Image.frombytes("RGB", (width, height), raw)

    def write(self, frame: Image.Image) -> None:
        if self.encoder is None:
            # the output size is only known after the first frame went through the effects
            self.encoder = subprocess.Popen(
                _encode_command(self.input_path, self.tmp_out, frame.size, self.info,
                                self.start, self.duration, self.speed),
                stdin=subprocess.PIPE, stderr=self.enc_err)
        self.encoder.stdin.write(frame.tobytes())

    def finish(self) -> None:
        self.decoder.stdout.close()
        if self.decoder.wait() != 0:
            raise ProcessingError(_read(self.dec_err) or "Failed to decode the video")
        if self.encoder is None:
            raise InvalidVideo("The video has no readable frames in the requested window")
        self.encoder.stdin.close()
        if self.encoder.wait() != 0:
            raise ProcessingError(_read(self.enc_err) or "Failed to encode the video")

    def abort(self) -> None:
        for process in (self.decoder, self.encoder):
            if process and process.poll() is None:
                process.kill()
                process.wait()
        if os.path.exists(self.tmp_out):
            os.remove(self.tmp_out)

    def close(self) -> None:
        self.dec_err.close()
        self.enc_err.close()


def _process_video(input_path: str, output_path: str, tools: list,
                   progress_cb=None, preview: bool = False) -> dict:
    """Applies `tools` (ordered) to the video at `input_path` and writes MP4 to `output_path`.

    `progress_cb(percent: int)` is called as frames are processed.
    On failure no partial file is left at `output_path`.
    The input is never modified.
    """
    effects = frame_tools(tools)
    speed = resolve_speed(tools)
    info = probe(input_path)
    start, end = resolve_trim(tools, info["duration"])
    if preview:
        # the preview shows PREVIEW_SECONDS of output, i.e. PREVIEW_SECONDS * speed of source
        end = min(end, start + PREVIEW_SECONDS * speed)
    duration = end - start
    progress = _Progress(progress_cb, max(1, round(duration / speed * info["fps"])))

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    tmp_out = output_path + ".part.mp4"
    transcode = _Transcode(input_path, tmp_out, info, (start, duration), speed)
    frames = 0
    try:
        for frame in transcode.frames():
            transcode.write(apply_frame_effects(frame, effects))
            frames += 1
            progress.frame_done(frames)
        transcode.finish()
        os.replace(tmp_out, output_path)
    except BaseException:
        transcode.abort()
        raise
    finally:
        transcode.close()

    if progress_cb:
        progress_cb(100)

    result = probe(output_path)
    result["frames"] = frames
    return result


def _read(f) -> str:
    f.seek(0)
    return f.read().decode(errors="replace").strip()[-500:]


def check_plan_effects(stages: list) -> None:
    """Every frame effect of the pipeline exists, checked before any stage does work.

    Every pipeline with frame effects starts with an edit stage (captions are
    always preceded by a normalising edit stage), so the first edit stage
    rejects an unknown effect before speech recognition or extraction run.
    The list of effects is the edit/effects package itself: the router does not
    need to know it.
    """
    for stage in stages:
        if stage.get("queue") == EDIT_QUEUE:
            frame_tools(stage.get("tools") or [])


def edit_stage(context) -> dict:
    """Stage handler of the edit service: one decode/encode pass over the stage's tools."""
    check_plan_effects(context.stages)
    return _process_video(context.input_path, context.stage_output, context.tools,
                          context.progress, context.preview)
