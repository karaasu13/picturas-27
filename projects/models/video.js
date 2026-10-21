const mongoose = require("mongoose");

// Vídeo de um projeto (UC-VID-001). Fica numa coleção própria para não
// mexer na versão do projeto (X-Project-Version) quando um corte termina.
const videoSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    project_id: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true },

    // nome do ficheiro no storage (stage "video")
    storage_key: { type: String, required: true },

    format: { type: String, enum: ["mp4", "mov", "avi"], required: true },
    size: { type: Number, required: true },

    duration: { type: Number, required: true }, // segundos
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    fps: { type: Number, required: true },
    video_codec: { type: String, enum: ["h264", "hevc"], required: true },
    has_audio: { type: Boolean, default: false },

    // "upload" ou "render" (resultado de uma exportação; os originais nunca são alterados)
    source: { type: String, enum: ["upload", "render"], default: "upload" },
    parent_video_id: { type: mongoose.Schema.Types.ObjectId, default: null },
    task_id: { type: mongoose.Schema.Types.ObjectId, default: null },

    // Pré-visualização gerada pelo worker (proxy H.264 480p, sprite de
    // miniaturas e forma de onda), guardada no storage ao lado do original.
    // Sem estado: vídeo enviado antes de existirem pré-visualizações.
    preview: {
      state: { type: String, enum: ["pending", "ready", "failed"] },
      proxy_key: { type: String },
      sprite_key: { type: String },
      waveform_key: { type: String }, // null quando o vídeo não tem áudio
      sprite: {
        interval: Number, // segundos entre miniaturas
        cols: Number,
        count: Number,
        width: Number, // tamanho de cada miniatura
        height: Number,
      },
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("video", videoSchema);
