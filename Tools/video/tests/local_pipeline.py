"""Runs a whole video pipeline in-process, for the tests.

It uses the same plan (common.plan) and the same stage runner (common.stage)
as the services; only RabbitMQ is left out, so each stage runs right after the
previous one instead of travelling through a queue.
"""
import uuid

from common.plan import EDIT_QUEUE, EXTRACT_QUEUE, SUBTITLES_QUEUE, plan_stages
from common.stage import run_stage
from edit import processor
from extract_frames import extraction
from subtitles import captions

HANDLERS = {
    EDIT_QUEUE: lambda context: processor.edit_stage(context),
    SUBTITLES_QUEUE: lambda context: captions.subtitles_stage(context),
    EXTRACT_QUEUE: lambda context: extraction.extraction_stage(context),
}


def process_video(input_path, output_path, tools, progress_cb=None, preview=False):
    stages = plan_stages(tools, preview)
    job = f"test-{uuid.uuid4()}"
    result = None
    for index, stage in enumerate(stages):
        result, _finished = run_stage(job, input_path, output_path, stages, index,
                                      HANDLERS[stage["queue"]], progress_cb)
    return result
