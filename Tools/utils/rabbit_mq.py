import threading
import time

import pika
from pika.exchange_type import ExchangeType

"""
# Callback example for those who need it
def callback(ch, method, properties, body):
    print(f" [x] Received {body.decode()}")
"""

class Rabbit_MQ:
    def __init__(self, host, port, username, password):
        self._host = host
        self._port = port
        self._credentials = pika.PlainCredentials(username, password)
        self._queue = ''
        self._pending = None
        self._connect()

    def _connect(self):
        self._connection = pika.BlockingConnection(pika.ConnectionParameters(self._host, self._port, '/', self._credentials),)
        self._channel = self._connection.channel()
        
        self._channel.exchange_declare(
            exchange="picturas",
            exchange_type=ExchangeType.direct,
            durable=True,
        )

    def send_rabbit_msg(self, msg, queue):
        # Durante um pedido, a resposta só é enviada no fim, pela thread da ligação (o pika não é thread-safe)
        if self._pending is not None:
            self._pending.append((msg, queue))
            return
        self._publish(msg, queue)

    def _publish(self, msg, queue):
        self._channel.queue_declare(queue=self._queue, durable=True)

        self._channel.basic_publish(exchange="picturas", routing_key=queue, body=msg)

    def _handle(self, callback, ch, method, properties, body):
        # O processamento corre noutra thread para a ligação continuar a responder aos heartbeats:
        # sem isso, uma ferramenta lenta perdia a ligação e o pedido voltava à fila em ciclo
        self._pending = []
        worker = threading.Thread(target=callback, args=(ch, method, properties, body), daemon=True)
        worker.start()
        try:
            while worker.is_alive():
                self._connection.sleep(0.2)
        finally:
            # Se a ligação caiu, espera pelo fim do processamento e descarta a resposta:
            # o pedido não foi confirmado e volta à fila
            worker.join()
            pending, self._pending = self._pending, None
        for msg, queue in pending:
            self._publish(msg, queue)
        # Confirma só depois de enviar a resposta
        ch.basic_ack(delivery_tag=method.delivery_tag)

    
    def read_rabbit_msg(self, queue, callback):
        if self._queue == "":
            self._queue = queue

        # Se a ligação cair (por exemplo, o RabbitMQ reiniciou), volta a
        # ligar-se sozinho, com espera crescente: 1 s, 2 s, 4 s... até 30 s
        attempt = 0
        while True:
            try:
                if self._connection.is_closed:
                    self._connect()
                attempt = 0

                self._channel.queue_declare(queue=self._queue, durable=True)
                self._channel.basic_qos(prefetch_count=1)

                self._channel.basic_consume(
                    queue=self._queue,
                    on_message_callback=lambda ch, method, properties, body: self._handle(callback, ch, method, properties, body),
                )

                self._channel.start_consuming()
            except pika.exceptions.AMQPError as e:
                # Sem canal ou sem ligação: fecha o que restar e liga tudo de novo
                try:
                    self._connection.close()
                except Exception:
                    pass
                delay = min(30, 2 ** attempt)
                attempt += 1
                print(f"[RabbitMQ] {self._queue}: ligação perdida ({e!r}); nova tentativa em {delay} s", flush=True)
                time.sleep(delay)
