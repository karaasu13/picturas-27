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
        self._channel.queue_declare(queue=self._queue, durable=True)

        self._channel.basic_publish(exchange="picturas", routing_key=queue, body=msg)

    
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
                
                self._channel.basic_consume(
                    queue=self._queue,
                    on_message_callback=callback,
                    auto_ack=True,
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
