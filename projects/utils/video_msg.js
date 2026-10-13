// Mensagens RabbitMQ das tarefas de vídeo (UC-VID-001).
//
//  Projects-MS --video_cut_queue (prioridade)--> worker video_cut
//  worker --video_result_queue--> Projects-MS (processing/success/error/cancelled)
//  Projects-MS --ws_queue--> ws_gateway --"video-task"--> browser do dono

const amqp = require("amqplib");
const { send_rabbit_msg } = require("./rabbit_mq");
const { serializeTask } = require("./video");

const rabbit_url = `amqp://${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASS}@${process.env.RABBITMQ_HOST}:${process.env.RABBITMQ_PORT}`;

const EXCHANGE = "picturas";
const CUT_QUEUE = "video_cut_queue";
const RESULT_QUEUE = "video_result_queue";
const WS_QUEUE = "ws_queue";
const MAX_PRIORITY = 10;

let channelPromise = null;

async function getChannel() {
  if (!channelPromise) {
    channelPromise = (async () => {
      const conn = await amqp.connect(rabbit_url);
      conn.on("error", () => (channelPromise = null));
      conn.on("close", () => (channelPromise = null));

      const ch = await conn.createConfirmChannel();
      await ch.assertExchange(EXCHANGE, "direct", { durable: true });
      await ch.assertQueue(CUT_QUEUE, {
        durable: true,
        arguments: { "x-max-priority": MAX_PRIORITY },
      });
      await ch.bindQueue(CUT_QUEUE, EXCHANGE, CUT_QUEUE);
      await ch.assertQueue(RESULT_QUEUE, { durable: true });
      await ch.bindQueue(RESULT_QUEUE, EXCHANGE, RESULT_QUEUE);
      return ch;
    })().catch((err) => {
      channelPromise = null;
      throw err;
    });
  }
  return channelPromise;
}

/**
 * Publica o pedido de corte. As mensagens são persistentes (não se perdem se
 * o RabbitMQ reiniciar) e as tarefas Premium têm prioridade maior.
 */
async function send_video_cut(msg_id, task, paths) {
  const ch = await getChannel();
  const msg = {
    messageId: msg_id,
    timestamp: new Date().toISOString(),
    procedure: "video_cut",
    parameters: {
      taskId: String(task._id),
      inputVideoURI: paths.input,
      outputVideoURI: paths.output,
      workDir: paths.dir,
      cancelFlagURI: paths.cancelFlag,
      start: task.params.start,
      end: task.params.end,
    },
  };

  await new Promise((resolve, reject) => {
    ch.publish(
      EXCHANGE,
      CUT_QUEUE,
      Buffer.from(JSON.stringify(msg)),
      { persistent: true, priority: task.priority || 1, contentType: "application/json" },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

/** Consome os estados enviados pelo worker. `handler` é async. */
async function read_video_results(handler) {
  const start = async () => {
    try {
      const ch = await getChannel();
      await ch.prefetch(1);
      await ch.consume(RESULT_QUEUE, async (msg) => {
        if (!msg) return;
        try {
          await handler(JSON.parse(msg.content.toString()));
        } catch (err) {
          console.error("[VIDEO] error handling worker message:", err);
        } finally {
          ch.ack(msg);
        }
      });
      console.log("[VIDEO] listening on", RESULT_QUEUE);
    } catch (err) {
      console.error("[VIDEO] RabbitMQ not ready, retrying in 5s:", err.message);
      setTimeout(start, 5000);
    }
  };
  start();
}

/** Notifica o dono da tarefa em tempo real (REQ-VID-CUT-013/016). */
function send_video_task_update(task) {
  send_rabbit_msg(
    {
      type: "video-task",
      messageId: `video-task-${task._id}-${Date.now()}`,
      timestamp: new Date().toISOString(),
      status: "success",
      user: String(task.user_id),
      projectId: String(task.project_id),
      task: serializeTask(task),
    },
    WS_QUEUE,
  );
}

module.exports = { send_video_cut, read_video_results, send_video_task_update };
