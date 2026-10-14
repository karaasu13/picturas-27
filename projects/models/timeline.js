const mongoose = require("mongoose");

// Timeline do editor de vídeo: um documento por projeto. Editar a timeline
// não gera ficheiros nem gasta quota; só a exportação cria um vídeo novo. Os
// vídeos originais nunca são alterados.

const clipSchema = new mongoose.Schema(
  {
    // Clips de faixas diferentes com o mesmo link_id formam um grupo (vídeo +
    // áudio ligados) que o editor move e corta em conjunto
    link_id: { type: String, required: true },
    video_id: { type: mongoose.Schema.Types.ObjectId, required: true },
    in: { type: Number, required: true, min: 0 }, // segundos no vídeo de origem
    out: { type: Number, required: true, min: 0 },
    speed: { type: Number, default: 1, min: 0.25, max: 4 },
    posicao: { type: Number, required: true, min: 0 }, // início na timeline (s)
  },
  { _id: false },
);

const trackSchema = new mongoose.Schema(
  {
    tipo: { type: String, enum: ["video", "audio"], required: true },
    clips: { type: [clipSchema], default: [] },
  },
  { _id: false },
);

const timelineSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, required: true },
    project_id: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },

    output: {
      formato: { type: String, enum: ["mp4", "mov", "avi"], default: "mp4" },
      qualidade: { type: String, enum: ["baixa", "media", "alta"], default: "media" },
      largura: { type: Number, default: 1920 },
      altura: { type: Number, default: 1080 },
      fit: { type: String, enum: ["pad", "crop"], default: "pad" },
    },

    faixas: {
      type: [trackSchema],
      default: () => [
        { tipo: "video", clips: [] },
        { tipo: "audio", clips: [] },
      ],
    },

    // Controlo de concorrência, como o `version` dos projetos
    version: { type: Number, default: 0 },

    // Estados anteriores/seguintes ({ output, faixas }) para desfazer/refazer
    undo: { type: Array, default: [] },
    redo: { type: Array, default: [] },
  },
  { timestamps: true },
);

module.exports = mongoose.model("timeline", timelineSchema);
module.exports.HISTORY_LIMIT = 50;
