const amqp = require('amqplib/callback_api');

const rabbit_host = process.env.RABBITMQ_HOST;
const rabbit_port = process.env.RABBITMQ_PORT;
const rabbit_username = process.env.RABBITMQ_USER;
const rabbit_password = process.env.RABBITMQ_PASS;
const exchange = "picturas";

const rabbit_mq_sv = `amqp://${rabbit_username}:${rabbit_password}@${rabbit_host}:${rabbit_port}`;

function send_rabbit_msg(msg, queue) {
    amqp.connect(rabbit_mq_sv, (err_sv, connection) => {
        // Um throw aqui (callback assíncrono) derrubava o serviço inteiro
        // enquanto o RabbitMQ estivesse a reiniciar: a mensagem perde-se e fica no log
        if (err_sv) return console.error(`[RabbitMQ] mensagem para ${queue} não enviada:`, err_sv.message);
        connection.on("error", (err) => console.error("[RabbitMQ] erro na ligação:", err.message));
        
        connection.createChannel( (err_conn, channel) => {
            if (err_conn) return console.error(`[RabbitMQ] mensagem para ${queue} não enviada:`, err_conn.message);
            
            channel.assertExchange(exchange, 'direct', {
                durable: true
            });

            channel.publish(exchange, queue, Buffer.from(JSON.stringify(msg)));
        });
        
        setTimeout(() => {
            connection.close();
        }, 500);
    });
    
}

// Consome a fila. Se a ligação cair (por exemplo, o RabbitMQ reiniciou),
// volta a ligar-se sozinho, com espera crescente: 1 s, 2 s, 4 s... até 30 s.
function read_rabbit_msg(queue, callback, attempt = 0) {
    const again = (n, reason) => {
        const delay = Math.min(30000, 1000 * 2 ** n);
        console.error(`[RabbitMQ] ${queue}: ${reason}: nova tentativa em ${delay / 1000} s`);
        setTimeout(() => read_rabbit_msg(queue, callback, n + 1), delay);
    };

    amqp.connect(rabbit_mq_sv, (err_sv, connection) => {
        if (err_sv) return again(attempt, `sem ligação (${err_sv.message})`);

        // A ligação chegou a funcionar: se cair, a espera recomeça do início
        connection.on("error", (err) => console.error("[RabbitMQ] erro na ligação:", err.message));
        connection.once("close", () => again(0, "ligação perdida"));
        const drop = () => {
            try { connection.close(); } catch (_) { /* já estava fechada */ }
        };

        connection.createChannel((err_conn, channel) => {
            if (err_conn) return drop();

            // Sem canal não há consumo: fecha a ligação para ligar tudo de novo
            channel.on("error", (err) => console.error("[RabbitMQ] erro no canal:", err.message));
            channel.on("close", drop);

            channel.assertExchange(exchange, 'direct', {
                durable: true
              });

            channel.assertQueue(queue, { durable: true }, (err_queue, q) => {
                if (err_queue) return drop();

                channel.consume(q.queue, (msg) => {
                    if(msg != null){
                        callback(msg);
                        // Acknowledge the message
                        channel.ack(msg);
                    }
                }, {
                    noAck: false
                });
                console.log(`[RabbitMQ] a consumir ${queue}`);
            });
        });
    });
}

module.exports = { send_rabbit_msg, read_rabbit_msg };
