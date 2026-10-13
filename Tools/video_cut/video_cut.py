"""
Worker de corte de vídeo (UC-VID-001).

Consome pedidos da fila `video_cut_queue` (com prioridade: Premium primeiro),
executa o corte com o ffmpeg e publica o estado na fila `video_result_queue`:

  processing -> o worker pegou na tarefa
  success    -> resultado em outputVideoURI (o Projects-MS guarda-o e limpa)
  error      -> falhou (código + mensagem)
  cancelled  -> o utilizador cancelou (ficheiro de cancelamento presente)

O cancelamento é sinalizado pelo Projects-MS através de um ficheiro
`cancel` na pasta da tarefa, no volume partilhado. O worker verifica-o antes
de começar e durante o processamento.
"""

import datetime
import json
import os
import shutil
import time

import pika

from cutter import CutCancelled, CutError, cut_video

RABBITMQ_HOST = os.getenv("RABBITMQ_HOST", "rabbitmq")
RABBITMQ_PORT = int(os.getenv("RABBITMQ_PORT", 5672))
RABBITMQ_USER = os.getenv("RABBITMQ_USER", os.getenv("RABBITMQ_USERNAME", "user"))
RABBITMQ_PASS = os.getenv("RABBITMQ_PASS", os.getenv("RABBITMQ_PASSWORD", "password"))

EXCHANGE = "picturas"
REQUEST_QUEUE = "video_cut_queue"
RESULT_QUEUE = "video_result_queue"
MAX_PRIORITY = 10

TASK_TIMEOUT_S = int(os.getenv("VIDEO_TASK_TIMEOUT", 900))  # 15 min (REQ-VID-CUT-024)


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def log(event, **fields):
    print(json.dumps({"ts": now_iso(), "service": "video_cut", "event": event, **fields}), flush=True)


class VideoCutWorker:
    def __init__(self):
        self._counter = 0
        self._connection = self._connect()
        self._channel = self._connection.channel()

        self._channel.exchange_declare(exchange=EXCHANGE, exchange_type="direct", durable=True)

        self._channel.queue_declare(
            queue=REQUEST_QUEUE,
            durable=True,
            arguments={"x-max-priority": MAX_PRIORITY},
        )
        self._channel.queue_bind(queue=REQUEST_QUEUE, exchange=EXCHANGE, routing_key=REQUEST_QUEUE)

        self._channel.queue_declare(queue=RESULT_QUEUE, durable=True)
        self._channel.queue_bind(queue=RESULT_QUEUE, exchange=EXCHANGE, routing_key=RESULT_QUEUE)

        # Uma tarefa de cada vez: assim a prioridade da fila tem efeito
        self._channel.basic_qos(prefetch_count=1)

    @staticmethod
    def _connect():
        params = pika.ConnectionParameters(
            host=RABBITMQ_HOST,
            port=RABBITMQ_PORT,
            credentials=pika.PlainCredentials(RABBITMQ_USER, RABBITMQ_PASS),
            heartbeat=60,
        )
        # O RabbitMQ pode ainda estar a arrancar
        for attempt in range(30):
            try:
                return pika.BlockingConnection(params)
            except pika.exceptions.AMQPConnectionError:
                time.sleep(2)
        return pika.BlockingConnection(params)

    def _publish(self, msg):
        self._channel.basic_publish(
            exchange=EXCHANGE,
            routing_key=RESULT_QUEUE,
            body=json.dumps(msg),
            properties=pika.BasicProperties(delivery_mode=2),
        )

    def _send(self, req_msg_id, task_id, status, **extra):
        self._counter += 1
        msg = {
            "messageId": f"video-cut-{self._counter}-{req_msg_id}",
            "correlationId": req_msg_id,
            "timestamp": now_iso(),
            "taskId": task_id,
            "status": status,
            **extra,
        }
        self._publish(msg)

    @staticmethod
    def _cleanup(work_dir):
        if work_dir and os.path.isdir(work_dir):
            shutil.rmtree(work_dir, ignore_errors=True)

    def on_message(self, ch, method, properties, body):
        try:
            info = json.loads(body.decode())
            params = info["parameters"]
            msg_id = info["messageId"]
            task_id = params["taskId"]
            input_path = params["inputVideoURI"]
            output_path = params["outputVideoURI"]
            work_dir = params["workDir"]
            cancel_flag = params["cancelFlagURI"]
            start = float(params["start"])
            end = float(params["end"])
        except (KeyError, ValueError, json.JSONDecodeError) as e:
            log("bad-message", error=str(e))
            ch.basic_ack(delivery_tag=method.delivery_tag)
            return

        def is_cancelled():
            return os.path.exists(cancel_flag)

        try:
            # Cancelada enquanto estava na fila: descarta sem processar
            if is_cancelled() or not os.path.exists(input_path):
                log("skip-cancelled", taskId=task_id)
                self._cleanup(work_dir)
                self._send(msg_id, task_id, "cancelled")
                return

            self._send(msg_id, task_id, "processing")
            log("start", taskId=task_id, start=start, end=end)

            result = cut_video(
                input_path,
                output_path,
                start,
                end,
                is_cancelled=is_cancelled,
                sleep=self._connection.sleep,
                timeout_s=TASK_TIMEOUT_S,
            )

            # Cancelado mesmo no fim: não vale a pena entregar o resultado
            if is_cancelled():
                raise CutCancelled()

            log("success", taskId=task_id, **result)
            self._send(
                msg_id,
                task_id,
                "success",
                output={"videoURI": output_path},
                processingTime=result["processingTime"],
            )

        except CutCancelled:
            log("cancelled", taskId=task_id)
            self._cleanup(work_dir)
            self._send(msg_id, task_id, "cancelled")

        except CutError as e:
            log("error", taskId=task_id, code=e.code, reason=e.msg)
            self._cleanup(work_dir)
            self._send(msg_id, task_id, "error", error={"code": e.code, "msg": e.msg})

        except Exception as e:  # noqa: BLE001 - nunca deixar o worker morrer
            log("error", taskId=task_id, code="unexpected", reason=str(e))
            self._cleanup(work_dir)
            self._send(msg_id, task_id, "error", error={"code": "unexpected", "msg": str(e)})

        finally:
            # Só confirmamos no fim: se o worker reiniciar a meio, a tarefa
            # volta para a fila e não se perde
            ch.basic_ack(delivery_tag=method.delivery_tag)

    def run(self):
        self._channel.basic_consume(queue=REQUEST_QUEUE, on_message_callback=self.on_message, auto_ack=False)
        log("ready", queue=REQUEST_QUEUE, timeout=TASK_TIMEOUT_S)
        self._channel.start_consuming()


if __name__ == "__main__":
    VideoCutWorker().run()
