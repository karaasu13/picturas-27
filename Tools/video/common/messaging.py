"""RabbitMQ plumbing shared by the video services, and the messages they exchange.

The reply and progress messages keep the format the projects orchestrator and
the WebSocket gateway already understand.
"""
import datetime
import json
import os
import time
import uuid

import pika
from pika.exchange_type import ExchangeType

from common.errors import error_code

EXCHANGE = "picturas"
PROJECT_QUEUE = "project_queue"
WS_QUEUE = "ws_queue"

RABBITMQ_HOST = os.getenv("RABBITMQ_HOST", "rabbitmq")
RABBITMQ_PORT = int(os.getenv("RABBITMQ_PORT", "5672"))
RABBITMQ_USERNAME = os.getenv("RABBITMQ_USERNAME", "user")
RABBITMQ_PASSWORD = os.getenv("RABBITMQ_PASSWORD", "password")


def now():
    return datetime.datetime.now(datetime.timezone.utc)


def connect():
    credentials = pika.PlainCredentials(RABBITMQ_USERNAME, RABBITMQ_PASSWORD)
    params = pika.ConnectionParameters(
        RABBITMQ_HOST, RABBITMQ_PORT, "/", credentials,
        # processing a video blocks this thread for minutes; without a
        # heartbeat the broker does not drop the connection midway
        heartbeat=0,
    )
    for _attempt in range(30):
        try:
            return pika.BlockingConnection(params)
        except pika.exceptions.AMQPConnectionError:
            time.sleep(2)
    raise RuntimeError("Could not connect to RabbitMQ")


class Consumer:
    """Consumes one durable queue of the `picturas` exchange, one message at a time.

    The message is only acknowledged after `handle` returns: if the service dies
    midway, RabbitMQ redelivers it. Parallelism comes from replicas.
    """

    def __init__(self, queue: str, microservice: str):
        self.queue = queue
        self.microservice = microservice
        self._connection = connect()
        self._channel = self._connection.channel()
        self._channel.exchange_declare(exchange=EXCHANGE,
                                       exchange_type=ExchangeType.direct, durable=True)
        self._channel.queue_declare(queue=queue, durable=True)
        self._channel.queue_bind(queue=queue, exchange=EXCHANGE, routing_key=queue)
        self._channel.basic_qos(prefetch_count=1)

    # ---- outgoing messages ----
    def publish(self, queue: str, msg: dict) -> None:
        self._channel.basic_publish(exchange=EXCHANGE, routing_key=queue, body=json.dumps(msg))

    def reply_success(self, msg_id, started, output_uri, video_info) -> None:
        output = {"type": video_info.get("output_type", "video"),
                  "imageURI": video_info.get("output_path", output_uri)}
        if output["type"] == "frames":
            output["frames"] = video_info["frames"]
        self.publish(PROJECT_QUEUE, {
            "messageId": f"video-{uuid.uuid4()}",
            "correlationId": msg_id,
            "timestamp": now().isoformat(),
            "status": "success",
            "output": output,
            "metadata": {
                "processingTime": (now() - started).total_seconds() * 1000,
                "microservice": self.microservice,
                "video": video_info,
            },
        })

    def reply_error(self, msg_id, started, code, message, input_uri) -> None:
        self.publish(PROJECT_QUEUE, {
            "messageId": f"video-{uuid.uuid4()}",
            "correlationId": msg_id,
            "timestamp": now().isoformat(),
            "status": "error",
            "error": {
                "code": code,
                "message": message,
                "msg": message,  # the orchestrator reads error.msg
                "details": {"inputFileURI": input_uri},
            },
            "metadata": {
                "processingTime": (now() - started).total_seconds() * 1000,
                "microservice": self.microservice,
            },
        })

    def reply_failure(self, msg_id, started, error, input_uri) -> None:
        self.reply_error(msg_id, started, error_code(error), str(error), input_uri)

    def progress(self, target: dict, preview: bool, percent: int) -> None:
        if not target or not target.get("user"):
            return
        self.publish(WS_QUEUE, {
            "messageId": f"update-client-video-progress-{uuid.uuid4()}",
            "timestamp": now().isoformat(),
            "status": "success",
            "user": target["user"],
            "projectId": target.get("projectId"),
            "imgId": target.get("imgId"),
            "preview": bool(preview),
            "percent": percent,
        })

    # ---- incoming messages ----
    def handle(self, info: dict, started, redelivered: bool = False) -> None:
        raise NotImplementedError

    def callback(self, ch, method, _properties, body) -> None:
        started = now()
        try:
            info = json.loads(body.decode())
            for field in ("inputImageURI", "outputImageURI"):
                info["parameters"][field]
            info["messageId"]
        except (ValueError, KeyError, TypeError) as e:
            print(f"[{self.queue}] invalid message discarded: {e}", flush=True)
        else:
            # redelivered: RabbitMQ is delivering this message again because the
            # consumer that had it died before acknowledging it
            self.handle(info, started, bool(getattr(method, "redelivered", False)))
        # manual ack only at the end
        ch.basic_ack(delivery_tag=method.delivery_tag)

    def run(self) -> None:
        self._channel.basic_consume(queue=self.queue, on_message_callback=self.callback,
                                    auto_ack=False)
        print(f"[{self.queue}] waiting for jobs", flush=True)
        self._channel.start_consuming()
