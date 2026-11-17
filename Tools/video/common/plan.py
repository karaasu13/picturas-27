"""Splits a video pipeline into stages, one per video service.

A stage is a contiguous part of the pipeline that one service executes:

- ``video_edit_queue``: trim, speed and the frame effects, in a single
  decode/encode pass;
- ``video_subtitles_queue``: automatic subtitles (speech recognition);
- ``video_extract_queue``: frame extraction, always the last stage.

The plan travels inside the message (routing slip): each worker runs its stage
and hands the message to the queue of the next one. Every stage also carries
the slice of the overall progress it accounts for.
"""
from common.errors import InvalidExtraction

EDIT_QUEUE = "video_edit_queue"
SUBTITLES_QUEUE = "video_subtitles_queue"
EXTRACT_QUEUE = "video_extract_queue"

SUBTITLES = "subtitles"
EXTRACT_FRAMES = "extract_frames"
TEMPORAL = {"trim", "speed"}


def _stage(queue: str, tools: list, preview: bool = False) -> dict:
    return {"queue": queue, "tools": tools, "preview": bool(preview)}


def _is(tool: dict, procedure: str) -> bool:
    return tool.get("procedure") == procedure


def _split_at_subtitles(tools: list) -> list:
    """Groups of ordinary effects (lists) separated by caption stages (None).

    The first stage is always an edit stage, even when empty: it normalises the
    input to MP4/H.264 before speech recognition.
    """
    groups, pending = [], []
    for tool in tools:
        if _is(tool, SUBTITLES):
            if pending or not groups:
                groups.append(pending)
                pending = []
            groups.append(None)
        else:
            pending.append(tool)
    if pending:
        groups.append(pending)
    return groups


def _preview_group(groups: list) -> int:
    """Index of the edit stage that cuts the preview excerpt.

    A preview is the first seconds of the final timeline. Cutting the input
    before a later trim/speed would discard needed frames, so preceding stages
    stay complete until the last temporal stage.
    """
    temporal = [i for i, group in enumerate(groups)
                if group is not None and any(t.get("procedure") in TEMPORAL for t in group)]
    return max(temporal, default=0)


def _video_stages(tools: list, preview: bool) -> list:
    """Stages that turn a video into another video."""
    if not any(_is(t, SUBTITLES) for t in tools):
        return [_stage(EDIT_QUEUE, tools, preview)]
    groups = _split_at_subtitles(tools)
    cut_at = _preview_group(groups)
    return [
        _stage(SUBTITLES_QUEUE, [{"procedure": SUBTITLES, "params": {}}]) if group is None
        else _stage(EDIT_QUEUE, group, preview and index == cut_at)
        for index, group in enumerate(groups)
    ]


def _spread_progress(stages: list, start: float, end: float) -> None:
    step = (end - start) / len(stages)
    for index, stage in enumerate(stages):
        stage["progress"] = [start + index * step, start + (index + 1) * step]


def check_extraction_position(tools: list) -> bool:
    """True when the pipeline ends with a frame extraction; it must be unique and last."""
    extractors = [i for i, tool in enumerate(tools) if _is(tool, EXTRACT_FRAMES)]
    if not extractors:
        return False
    if extractors != [len(tools) - 1]:
        raise InvalidExtraction("Frame extraction must appear once, at the end of the pipeline")
    return True


def plan_stages(tools: list, preview: bool = False) -> list:
    """Ordered stages for `tools`: [{"queue", "tools", "preview", "progress": [from, to]}]."""
    tools = list(tools or [])
    if not check_extraction_position(tools):
        stages = _video_stages(tools, preview)
        _spread_progress(stages, 0, 100)
        return stages

    extraction = _stage(EXTRACT_QUEUE, [tools[-1]], preview)
    if len(tools) == 1:
        # No preceding edits: sample the original directly, without transcoding it.
        extraction["progress"] = [0, 100]
        return [extraction]
    # Sampling spans the complete edited timeline, including in preview.
    stages = _video_stages(tools[:-1], preview=False)
    _spread_progress(stages, 0, 70)
    extraction["progress"] = [70, 100]
    return stages + [extraction]
