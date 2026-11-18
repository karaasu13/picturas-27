"""PictuRAS video router (RabbitMQ worker).

Entry point of the video services: receives from the projects orchestrator one
message per video with the whole effect pipeline (video_queue), splits the
pipeline into stages (common.plan) and hands the job to the service of the
first stage. It does no media processing, so it is never busy for long.
"""
from common.errors import WRONG_PROCEDURE
from common.messaging import Consumer
from common.plan import plan_stages

VIDEO_QUEUE = "video_queue"
MICROSERVICE = "picturas-video-router-ms"


class VideoRouter(Consumer):
    def __init__(self):
        super().__init__(VIDEO_QUEUE, MICROSERVICE)

    def handle(self, info: dict, started, redelivered: bool = False) -> None:
        msg_id = info["messageId"]
        params = info["parameters"]
        input_uri = params["inputImageURI"]

        if info.get("procedure") != "video":
            self.reply_error(msg_id, started, WRONG_PROCEDURE,
                             "The procedure received does not fit into this tool", input_uri)
            return
        try:
            stages = plan_stages(params.get("tools") or [], bool(params.get("preview")))
        except Exception as e:  # noqa: BLE001 - an invalid pipeline is reported to the orchestrator
            self.reply_failure(msg_id, started, e, input_uri)
            return

        params["stages"], params["stage"] = stages, 0
        print(f"[video-router] msg={msg_id} preview={bool(params.get('preview'))} "
              f"stages={[s['queue'] for s in stages]}", flush=True)
        self.publish(stages[0]["queue"], info)


if __name__ == "__main__":
    VideoRouter().run()
