// Regras e utilitários de vídeo (UC-VID-001 e REQ-VID-PLAT-001).
// As funções de validação são puras para poderem ser testadas sem Docker.

const { execFile } = require("child_process");
const path = require("path");

const LIMITS = {
  // REQ-VID-PLAT-001: até 2 GB
  maxUploadBytes: Number(process.env.VIDEO_MAX_UPLOAD_BYTES) || 2 * 1024 * 1024 * 1024,
  // Perfil Registado: vídeos até 10 min (Premium sem limite)
  freeMaxDuration: Number(process.env.VIDEO_FREE_MAX_DURATION) || 10 * 60,
  // O intervalo eliminado tem de durar mais de 1 s
  minCut: 1,
  // O vídeo resultante tem de ter pelo menos 5 s
  minResult: 5,
};

// Extensão -> nomes que o ffprobe usa para o contentor
const FORMATS = {
  mp4: ["mp4", "mov"],
  mov: ["mov", "mp4"],
  avi: ["avi"],
};

const VIDEO_CODECS = ["h264", "hevc"];

const MIME_TYPES = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
};

const MESSAGES = {
  unsupported_format:
    "Formato não suportado. Só são aceites vídeos MP4, MOV ou AVI codificados em H.264 ou H.265.",
  unreadable:
    "Não foi possível ler o vídeo. Confirma que o ficheiro não está corrompido e tenta novamente.",
  too_large: "O vídeo excede o tamanho máximo de 2 GB. Reduz o tamanho do ficheiro e tenta novamente.",
  invalid_interval:
    "O intervalo a eliminar deve ser interior ao vídeo e ter uma duração superior a 1 segundo.",
  result_too_short:
    "O vídeo resultante é demasiado curto. O resultado final deve ter pelo menos 5 segundos.",
  duration_limit:
    "O perfil Registado só permite editar vídeos até 10 minutos. Escolhe um vídeo mais curto ou faz upgrade para Premium.",
  quota_exceeded:
    "Atingiu o limite de 5 operações diárias do perfil gratuito. Efetue upgrade para Premium para continuar.",
  anonymous: "Os utilizadores anónimos não têm acesso às ferramentas de vídeo. Cria uma conta para continuar.",
};

function extOf(fileName) {
  return path.extname(fileName || "").toLowerCase().replace(".", "");
}

function parseFps(rate) {
  if (!rate || typeof rate !== "string") return null;
  const [n, d] = rate.split("/").map(Number);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (d === undefined) return n;
  if (!Number.isFinite(d) || d <= 0) return null;
  return n / d;
}

/**
 * Valida o resultado do ffprobe contra o REQ-VID-PLAT-001.
 * Devolve { ok: true, meta } ou { ok: false, code, message }.
 */
function validateProbe(probe, originalName) {
  const ext = extOf(originalName);
  if (!FORMATS[ext]) {
    return { ok: false, code: "unsupported_format", message: MESSAGES.unsupported_format };
  }

  const formatNames = String(probe?.format?.format_name || "").split(",");
  if (!FORMATS[ext].some((f) => formatNames.includes(f))) {
    return { ok: false, code: "unsupported_format", message: MESSAGES.unsupported_format };
  }

  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const video = streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === "audio");

  if (!video || !VIDEO_CODECS.includes(video.codec_name)) {
    return { ok: false, code: "unsupported_format", message: MESSAGES.unsupported_format };
  }

  const duration = Number(probe?.format?.duration ?? video.duration);
  const fps = parseFps(video.avg_frame_rate) ?? parseFps(video.r_frame_rate);

  if (!Number.isFinite(duration) || duration <= 0 || !video.width || !video.height || !fps) {
    return { ok: false, code: "unreadable", message: MESSAGES.unreadable };
  }

  return {
    ok: true,
    meta: {
      format: ext,
      duration,
      width: video.width,
      height: video.height,
      fps: Math.round(fps * 1000) / 1000,
      video_codec: video.codec_name,
      has_audio: !!audio,
    },
  };
}

/**
 * Valida o pedido de corte (passo 3 e exceções 1-2 do UC-VID-001) e o
 * limite de duração do perfil. Os instantes são em segundos.
 */
function validateCut({ start, end, duration, userType }) {
  const s = Number(start);
  const e = Number(end);
  const d = Number(duration);

  if (userType === "anonymous") {
    return { ok: false, status: 403, code: "anonymous", message: MESSAGES.anonymous };
  }

  if (userType !== "premium" && d > LIMITS.freeMaxDuration) {
    return { ok: false, status: 422, code: "duration_limit", message: MESSAGES.duration_limit };
  }

  // Interior ao vídeo (não pode começar no 0 nem acabar no fim) e > 1 s
  if (
    !Number.isFinite(s) ||
    !Number.isFinite(e) ||
    s <= 0 ||
    e >= d ||
    e - s <= LIMITS.minCut
  ) {
    return { ok: false, status: 422, code: "invalid_interval", message: MESSAGES.invalid_interval };
  }

  if (d - (e - s) < LIMITS.minResult) {
    return { ok: false, status: 422, code: "result_too_short", message: MESSAGES.result_too_short };
  }

  // Precisão ao milissegundo, como no campo hh:mm:ss.mmm
  return { ok: true, start: Math.round(s * 1000) / 1000, end: Math.round(e * 1000) / 1000 };
}

/** Nome para o resultado de um corte que não colide com os existentes. */
function cutResultName(originalName, existingNames) {
  const ext = path.extname(originalName);
  const base = path.basename(originalName, ext);
  const taken = new Set(existingNames);
  for (let i = 1; ; i++) {
    const name = `${base}_corte${i > 1 ? `_${i}` : ""}${ext}`;
    if (!taken.has(name)) return name;
  }
}

function ffprobe(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-show_format", "-show_streams", "-of", "json", filePath],
      { maxBuffer: 10 * 1024 * 1024, timeout: 120000 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          resolve(JSON.parse(stdout || "{}"));
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

function serializeVideo(video, url = null) {
  return {
    _id: video._id,
    name: video.name,
    format: video.format,
    size: video.size,
    duration: video.duration,
    width: video.width,
    height: video.height,
    fps: video.fps,
    codec: video.video_codec,
    hasAudio: video.has_audio,
    source: video.source,
    parentVideoId: video.parent_video_id,
    createdAt: video.createdAt,
    url,
  };
}

function serializeTask(task) {
  return {
    _id: task._id,
    projectId: task.project_id,
    videoId: task.video_id,
    videoName: task.video_name,
    op: task.op,
    params: { start: task.params.start, end: task.params.end },
    state: task.state,
    outputVideoId: task.output_video_id,
    error: task.error_code ? { code: task.error_code, message: task.error_msg } : null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.started_at,
    finishedAt: task.finished_at,
  };
}

module.exports = {
  LIMITS,
  MESSAGES,
  MIME_TYPES,
  extOf,
  parseFps,
  validateProbe,
  validateCut,
  cutResultName,
  ffprobe,
  serializeVideo,
  serializeTask,
};
