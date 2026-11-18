"""Runs one stage of a video pipeline, independently of how the job arrived.

Intermediate files live in a work directory next to the final output
(``.video-work-<messageId>``). The worker removes it only after the pipeline has
replied to the orchestrator, with success or with an error, so no partial
output is ever left at the final path.

A stage can be delivered more than once: RabbitMQ redelivers a message whose
service died before acknowledging it, possibly after it had already handed the
job to the next stage. `claim_stage` makes each stage run once per job:

- a stage after the first whose input file no longer exists belongs to a job
  that has already ended (replied and cleaned up), so it is dropped;
- before running, the stage creates ``stage-<index>.claim`` atomically
  (O_CREAT | O_EXCL) in the work directory, which every replica sees through
  the shared volume. If the claim already exists, a redelivered message takes
  the stage over (RabbitMQ only redelivers after the previous owner's channel
  closed), and any other delivery is a duplicate and is dropped.
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
    stages: list          # the plan of the whole pipeline


def work_dir(final_output: str, job_id: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", str(job_id))
    return Path(final_output).resolve().parent / f".video-work-{safe}"


def _stage_file(work: Path, index: int) -> str:
    return str(work / f"stage-{index}.mp4")


def claim_stage(job_id: str, final_output: str, index: int, redelivered: bool):
    """Reason to skip this delivery of stage `index`, or None when it must run."""
    work = work_dir(final_output, job_id)
    if index > 0 and not os.path.exists(_stage_file(work, index - 1)):
        return "the job has already ended"
    work.mkdir(parents=True, exist_ok=True)
    try:
        os.close(os.open(work / f"stage-{index}.claim", os.O_CREAT | os.O_EXCL | os.O_WRONLY))
    except FileExistsError:
        if not redelivered:
            return "another delivery of this stage is already running"
    return None


def cleanup(job_id: str, final_output: str) -> None:
    """Removes the work directory of a job (after its reply was sent)."""
    shutil.rmtree(work_dir(final_output, job_id), ignore_errors=True)


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


def _context(input_path: str, final_output: str, stages: list, index: int, work: Path,
             progress: Callable) -> StageContext:
    stage = stages[index]
    return StageContext(
        input_path=input_path if index == 0 else _stage_file(work, index - 1),
        stage_output=_stage_file(work, index),
        final_output=final_output,
        tools=stage.get("tools") or [],
        preview=bool(stage.get("preview")),
        progress=progress,
        first=index == 0,
        stages=stages,
    )


def run_stage(job_id: str, input_path: str, final_output: str, stages: list, index: int,
              handler: Callable, report: Callable = None) -> tuple:
    """Executes stage `index`. Returns (result, finished).

    `handler(context)` does the work and returns the characteristics of what it
    produced. `report(percent)` receives the overall progress of the pipeline.
    The work directory is left in place: the caller removes it with `cleanup`
    once the pipeline has replied.
    """
    stage = stages[index]
    last = index == len(stages) - 1
    work = work_dir(final_output, job_id)
    progress = _Progress(stage, last, report)
    work.mkdir(parents=True, exist_ok=True)
    if len(stages) > 1:
        progress(0)
    context = _context(input_path, final_output, stages, index, work, progress)
    result = handler(context)
    if last:
        if os.path.exists(context.stage_output):
            os.replace(context.stage_output, final_output)
        progress.finish()
    return result, last
