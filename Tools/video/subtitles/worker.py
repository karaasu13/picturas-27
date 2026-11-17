"""PictuRAS video subtitles service: speech recognition and burned-in captions (video_subtitles_queue)."""
from common.plan import SUBTITLES_QUEUE
from common.worker import StageWorker
from subtitles.captions import subtitles_stage

if __name__ == "__main__":
    StageWorker(SUBTITLES_QUEUE, "picturas-video-subtitles-ms", subtitles_stage).run()
