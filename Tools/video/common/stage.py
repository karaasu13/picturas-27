"""Runs one stage of a video pipeline, independently of how the job arrived.

Intermediate files live in a work directory next to the final output and are
removed when the pipeline ends or fails, so no partial output is ever left at
the final path.
"""
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


@dataclass
class StageContext:
    """What a service needs to execute its stage."""
    input_path: str       # file to read: the original or the previous stage's output
    stage_output: str     # where a video-to-video stage writes its result
    final_output: str     # final output path of the whole pipeline
    tools: list           # the tools of this stage, in order
    preview: bool
    progress: Callable    # progress(percent of this stage)
    first: bool           # the input is the original file


def work_dir(final_output: str, job_id: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", str(job_id))
    return Path(final_output).resolve().parent / f".video-work-{safe}"


def _stage_file(work: Path, index: int) -> str:
    return str(work / f"stage-{index}.mp4")


class _Progress:
    """Turns the progress of one stage into the progress of the whole pipeline."""

    def __init__(self, stage: dict, last: bool, report: Callable):
        self.start, self.end = stage.get("progress") or [0, 100]
        self.last = last
        self.report = report or (lambda _percent: None)
        self.latest = None

    def __call__(self, percent) -> None:
        overall = int(self.start + percent * (self.end - self.start) / 100)
        self._send(overall if self.last else min(99, overall))

    def finish(self) -> None:
        if self.latest != 100:
            self._send(100)

    def _send(self, percent: int) -> None:
        self.latest = percent
        self.report(percent)


def _context(input_path: str, final_output: str, stage: dict, index: int, work: Path,
             progress: Callable) -> StageContext:
    return StageContext(
        input_path=input_path if index == 0 else _stage_file(work, index - 1),
        stage_output=_stage_file(work, index),
        final_output=final_output,
        tools=stage.get("tools") or [],
        preview=bool(stage.get("preview")),
        progress=progress,
        first=index == 0,
    )


def run_stage(job_id: str, input_path: str, final_output: str, stages: list, index: int,
              handler: Callable, report: Callable = None) -> tuple:
    """Executes stage `index`. Returns (result, finished).

    `handler(context)` does the work and returns the characteristics of what it
    produced. `report(percent)` receives the overall progress of the pipeline.
    """
    stage = stages[index]
    last = index == len(stages) - 1
    work = work_dir(final_output, job_id)
    progress = _Progress(stage, last, report)
    try:
        work.mkdir(parents=True, exist_ok=True)
        if len(stages) > 1:
            progress(0)
        context = _context(input_path, final_output, stage, index, work, progress)
        result = handler(context)
        if last and os.path.exists(context.stage_output):
            os.replace(context.stage_output, final_output)
    except BaseException:
        shutil.rmtree(work, ignore_errors=True)
        raise
    if last:
        shutil.rmtree(work, ignore_errors=True)
        progress.finish()
    return result, last
