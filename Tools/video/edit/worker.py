"""PictuRAS video edit service: trim, speed and frame effects (video_edit_queue)."""
from common.plan import EDIT_QUEUE
from common.worker import StageWorker
from edit.processor import edit_stage

if __name__ == "__main__":
    StageWorker(EDIT_QUEUE, "picturas-video-edit-ms", edit_stage).run()
