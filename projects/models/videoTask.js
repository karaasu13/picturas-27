const mongoose = require("mongoose");

// Estados da tarefa (REQ-VID-CUT-013):
// queued = Em Fila, processing = A processar, done = Concluído,
// failed = Falhou, cancelled = Cancelado
const STATES = ["queued", "processing", "done", "failed", "cancelled"];
const ACTIVE_STATES = ["queued", "processing"];

const videoTaskSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    project_id: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    // vídeos de origem: não podem ser apagados enquanto a exportação corre
    video_ids: { type: [mongoose.Schema.Types.ObjectId], index: true },
    // nome do vídeo do primeiro clip (dá o nome ao resultado)
    name: { type: String, required: true },

    op: { type: String, enum: ["render"], default: "render" },
    // receita da timeline no momento da exportação: { output, faixas, duration }
    params: { type: mongoose.Schema.Types.Mixed, required: true },

    state: { type: String, enum: STATES, default: "queued", index: true },
    priority: { type: Number, default: 1 },

    // operações reservadas no users-ms (devolvidas em falha/cancelamento)
    charged_ops: { type: Number, default: 0 },

    msg_id: { type: String, default: null },
    output_video_id: { type: mongoose.Schema.Types.ObjectId, default: null },
    error_code: { type: String, default: null },
    error_msg: { type: String, default: null },

    started_at: { type: Date, default: null },
    finished_at: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("videoTask", videoTaskSchema);
module.exports.STATES = STATES;
module.exports.ACTIVE_STATES = ACTIVE_STATES;
