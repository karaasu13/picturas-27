"""Base of the video stage services (RabbitMQ workers).

A stage service receives a video job whose message carries the plan of the
whole pipeline (`parameters.stages`) and the position reached
(`parameters.stage`). It runs its own stage and then either hands the message
to the queue of the next stage or, after the last one, replies to the projects
orchestrator on project_queue. Progress goes straight to the WebSocket gateway
(ws_queue), as a percentage of the whole pipeline.
"""
from common.errors import WRONG_PROCEDURE
from common.messaging import Consumer, now
from common.stage import run_stage


class StageWorker(Consumer):
    def __init__(self, queue: str, microservice: str, handler):
        super().__init__(queue, microservice)
        self.handler = handler

    def handle(self, info: dict, started) -> None:
        msg_id = info["messageId"]
        params = info["parameters"]
        input_uri, output_uri = params["inputImageURI"], params["outputImageURI"]
        stages = params.get("stages") or []
        index = params.get("stage", 0)
        preview = bool(params.get("preview"))
        target = params.get("progress") or {}

        if not 0 <= index < len(stages) or stages[index].get("queue") != self.queue:
            self.reply_error(msg_id, started, WRONG_PROCEDURE,
                             "The procedure received does not fit into this tool", input_uri)
            return

        print(f"[{self.queue}] msg={msg_id} stage={index + 1}/{len(stages)} preview={preview} "
              f"tools={[t.get('procedure') for t in stages[index].get('tools') or []]}", flush=True)
        try:
            result, finished = run_stage(
                msg_id, input_uri, output_uri, stages, index, self.handler,
                report=lambda percent: self.progress(target, preview, percent),
            )
        except Exception as e:  # noqa: BLE001 - every failure is reported to the orchestrator
            self.reply_failure(msg_id, started, e, input_uri)
            return

        if finished:
            self.reply_success(msg_id, started, output_uri, result)
        else:
            params["stage"] = index + 1
            self.publish(stages[index + 1]["queue"], info)
        print(f"[{self.queue}] msg={msg_id} stage={index + 1}/{len(stages)} ok "
              f"t={(now() - started).total_seconds():.1f}s", flush=True)
