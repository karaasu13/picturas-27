"""Base of the video stage services (RabbitMQ workers).

A stage service receives a video job whose message carries the plan of the
whole pipeline (`parameters.stages`) and the position reached
(`parameters.stage`). It runs its own stage and then either hands the message
to the queue of the next stage or, after the last one, replies to the projects
orchestrator on project_queue. Progress goes straight to the WebSocket gateway
(ws_queue), as a percentage of the whole pipeline.

Each stage runs once per job even if RabbitMQ delivers it again (see
common.stage.claim_stage), and the work directory is only removed after the
reply to the orchestrator has been published.
"""
from common.errors import WRONG_PROCEDURE
from common.messaging import Consumer, now
from common.stage import claim_stage, cleanup, run_stage


class StageWorker(Consumer):
    def __init__(self, queue: str, microservice: str, handler):
        super().__init__(queue, microservice)
        self.handler = handler

    def handle(self, info: dict, started, redelivered: bool = False) -> None:
        msg_id = info["messageId"]
        params = info["parameters"]
        stages = params.get("stages") or []
        index = params.get("stage", 0)

        if not 0 <= index < len(stages) or stages[index].get("queue") != self.queue:
            self.reply_error(msg_id, started, WRONG_PROCEDURE,
                             "The procedure received does not fit into this tool",
                             params["inputImageURI"])
            return

        skip = claim_stage(msg_id, params["outputImageURI"], index, redelivered)
        if skip:
            # no reply: the orchestrator already has (or will get) the reply of the delivery that ran
            print(f"[{self.queue}] msg={msg_id} stage={index + 1}/{len(stages)} "
                  f"duplicate dropped: {skip}", flush=True)
            return

        print(f"[{self.queue}] msg={msg_id} stage={index + 1}/{len(stages)} "
              f"preview={bool(params.get('preview'))} redelivered={redelivered} "
              f"tools={[t.get('procedure') for t in stages[index].get('tools') or []]}", flush=True)
        self._execute(info, started, stages, index)
        print(f"[{self.queue}] msg={msg_id} stage={index + 1}/{len(stages)} done "
              f"t={(now() - started).total_seconds():.1f}s", flush=True)

    def _execute(self, info: dict, started, stages: list, index: int) -> None:
        """Runs the stage, then hands the job on or replies, and only then cleans up."""
        msg_id = info["messageId"]
        params = info["parameters"]
        input_uri, output_uri = params["inputImageURI"], params["outputImageURI"]
        preview, target = bool(params.get("preview")), params.get("progress") or {}
        try:
            result, finished = run_stage(
                msg_id, input_uri, output_uri, stages, index, self.handler,
                report=lambda percent: self.progress(target, preview, percent),
            )
        except Exception as e:  # noqa: BLE001 - every failure is reported to the orchestrator
            # reply first, then clean up: a redelivery after a crash in between still
            # finds the work directory and repeats the stage instead of being dropped
            self.reply_failure(msg_id, started, e, input_uri)
            cleanup(msg_id, output_uri)
            return

        if finished:
            self.reply_success(msg_id, started, output_uri, result)
            cleanup(msg_id, output_uri)
        else:
            params["stage"] = index + 1
            self.publish(stages[index + 1]["queue"], info)
