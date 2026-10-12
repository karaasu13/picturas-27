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

    // "upload" ou "cut" (resultado de um corte; o original nunca é alterado)
    source: { type: String, enum: ["upload", "cut"], default: "upload" },
    parent_video_id: { type: mongoose.Schema.Types.ObjectId, default: null },
    task_id: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("video", videoSchema);
