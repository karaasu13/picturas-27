"""PictuRAS video frame extraction service (video_extract_queue)."""
from common.plan import EXTRACT_QUEUE
from common.worker import StageWorker
from extract_frames.extraction import extraction_stage

if __name__ == "__main__":
    StageWorker(EXTRACT_QUEUE, "picturas-video-extract-ms", extraction_stage).run()
