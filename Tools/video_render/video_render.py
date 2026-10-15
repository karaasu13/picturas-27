"""
Worker de vídeo do editor. Consome uma fila (env VIDEO_QUEUE, com
prioridade: Premium primeiro) e trata dois tipos de pedido:

  video_render   exportação de uma timeline (receita + vídeos de origem)
  video_prepare  pré-visualização de um vídeo novo (proxy, sprite, forma de onda)

Há um serviço por fila (video_render_queue e video_prepare_queue), com esta
mesma imagem, para as pré-visualizações nunca ficarem à espera de um render
longo. Os estados vão para `video_result_queue`:

  processing -> o worker pegou no pedido
  success    -> ficheiros prontos na pasta do pedido (o Projects-MS guarda-os)
  error      -> falhou (código + mensagem)
  cancelled  -> o utilizador cancelou (ficheiro de cancelamento presente)

O cancelamento de um render é sinalizado pelo Projects-MS através de um
ficheiro `cancel` na pasta da tarefa, no volume partilhado. O worker
verifica-o antes de começar e durante o processamento.
"""

import datetime
import json
import os
import shutil
import time

import pika

from preview import make_preview
from renderer import RenderCancelled, RenderError, recipe_duration, render, timeout_for

RABBITMQ_HOST = os.getenv("RABBITMQ_HOST", "rabbitmq")
RABBITMQ_PORT = int(os.getenv("RABBITMQ_PORT", 5672))
RABBITMQ_USER = os.getenv("RABBITMQ_USER", os.getenv("RABBITMQ_USERNAME", "user"))
RABBITMQ_PASS = os.getenv("RABBITMQ_PASS", os.getenv("RABBITMQ_PASSWORD", "password"))

EXCHANGE = "picturas"
REQUEST_QUEUE = os.getenv("VIDEO_QUEUE", "video_render_queue")
RESULT_QUEUE = "video_result_queue"
MAX_PRIORITY = 10


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def log(event, **fields):
    print(json.dumps({"ts": now_iso(), "service": "video_render", "queue": REQUEST_QUEUE, "event": event, **fields}), flush=True)


class VideoWorker:
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

        # Um pedido de cada vez: assim a prioridade da fila tem efeito
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

    def _send(self, req, status, **extra):
        self._counter += 1
        self._publish({
            "messageId": f"video-render-{self._counter}-{req['msg_id']}",
            "correlationId": req["msg_id"],
            "timestamp": now_iso(),
            "procedure": req["procedure"],
            **req["ids"],
            "status": status,
            **extra,
        })

    @staticmethod
    def _cleanup(work_dir):
        if work_dir and os.path.isdir(work_dir):
            shutil.rmtree(work_dir, ignore_errors=True)

    def _render(self, req, params):
        cancel_flag = params["cancelFlagURI"]
        output_path = params["outputVideoURI"]

        def is_cancelled():
            return os.path.exists(cancel_flag)

        # Cancelada enquanto estava na fila: descarta sem processar
        if is_cancelled():
            raise RenderCancelled()

        recipe = {"output": params["output"], "faixas": params["faixas"]}
        timeout_s = timeout_for(recipe_duration(recipe))
        self._send(req, "processing")
        log("render", **req["ids"], duration=recipe_duration(recipe), timeout=timeout_s)
        result = render(
            recipe,
            params["inputs"],
            output_path,
            is_cancelled=is_cancelled,
            sleep=self._connection.sleep,
            timeout_s=timeout_s,
        )

        # Cancelado mesmo no fim: não vale a pena entregar o resultado
        if is_cancelled():
            raise RenderCancelled()
        return result, {"output": {"videoURI": output_path}, "processingTime": result["processingTime"]}

    def _prepare(self, req, params):
        self._send(req, "processing")
        result = make_preview(params["inputVideoURI"], params["workDir"], sleep=self._connection.sleep)
        return result, {"output": result}

    def on_message(self, ch, method, properties, body):
        try:
            info = json.loads(body.decode())
            params = info["parameters"]
            procedure = info["procedure"]
            if procedure == "video_render":
                ids = {"taskId": params["taskId"]}
            elif procedure == "video_prepare":
                ids = {"videoId": params["videoId"], "jobId": params["jobId"]}
            else:
                raise KeyError(f"procedure {procedure}")
            req = {"msg_id": info["messageId"], "procedure": procedure, "ids": ids}
            work_dir = params["workDir"]
        except (KeyError, ValueError, json.JSONDecodeError) as e:
            log("bad-message", error=str(e))
            ch.basic_ack(delivery_tag=method.delivery_tag)
            return

        lost = False
        try:
            log("start", procedure=procedure, **ids)
            handler = self._render if procedure == "video_render" else self._prepare
            result, extra = handler(req, params)
            log("success", procedure=procedure, **ids, **result)
            self._send(req, "success", **extra)

        except pika.exceptions.AMQPError:
            # Ligação ao RabbitMQ perdida a meio (o ffmpeg já foi parado): o
            # pedido não é confirmado, volta para a fila e é repetido quando o
            # worker voltar a ligar-se. Os ficheiros de entrada ficam onde estão.
            lost = True
            log("connection-lost", **ids)
            raise

        except RenderCancelled:
            log("cancelled", **ids)
            self._cleanup(work_dir)
            self._send(req, "cancelled")

        except RenderError as e:
            log("error", **ids, code=e.code, reason=e.msg)
            self._cleanup(work_dir)
            self._send(req, "error", error={"code": e.code, "msg": e.msg})

        except Exception as e:  # noqa: BLE001 - nunca deixar o worker morrer
            log("error", **ids, code="unexpected", reason=str(e))
            self._cleanup(work_dir)
            self._send(req, "error", error={"code": "unexpected", "msg": str(e)})

        finally:
            # Só confirmamos no fim: se o worker reiniciar a meio, o pedido
            # volta para a fila e não se perde
            if not lost:
                ch.basic_ack(delivery_tag=method.delivery_tag)

    def run(self):
        self._channel.basic_consume(queue=REQUEST_QUEUE, on_message_callback=self.on_message, auto_ack=False)
        log("ready")
        self._channel.start_consuming()


def main():
    # Se a ligação ao RabbitMQ cair (por exemplo, reiniciou), volta a ligar-se
    # sozinho, com espera crescente: 1 s, 2 s, 4 s... até 30 s
    attempt = 0
    while True:
        try:
            worker = VideoWorker()
            attempt = 0
            worker.run()
        except pika.exceptions.AMQPError as e:
            delay = min(30, 2 ** attempt)
            attempt += 1
            log("reconnect", reason=repr(e), delay=delay)
            time.sleep(delay)


if __name__ == "__main__":
    main()
