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

// ------------------------------------------------------------- timeline

const TIMELINE = {
  qualities: ["baixa", "media", "alta"],
  fits: ["pad", "crop"],
  trackTypes: ["video", "audio"],
  minSpeed: 0.25,
  maxSpeed: 4,
  minSide: 16,
  maxSide: 4096,
  // limita o tamanho do documento (o histórico guarda até 50 cópias)
  maxTracks: 8,
  maxClips: 500,
};

const ms = (x) => Math.round(x * 1000) / 1000;

function clipEnd(clip) {
  return clip.posicao + (clip.out - clip.in) / clip.speed;
}

/** Duração final: fim do último clip nas faixas de vídeo. */
function timelineDuration(faixas) {
  let end = 0;
  for (const f of faixas || []) {
    if (f.tipo !== "video") continue;
    for (const c of f.clips) end = Math.max(end, clipEnd(c));
  }
  return ms(end);
}

/**
 * Valida a timeline enviada pelo editor. `videosById` tem os vídeos do
 * projeto (Map id -> vídeo). Devolve { ok: true, timeline, duration } com os
 * tempos arredondados ao milissegundo e os clips ordenados, ou
 * { ok: false, code, message }.
 */
function validateTimeline(body, videosById) {
  const bad = (message) => ({ ok: false, code: "invalid_timeline", message });

  const o = body?.output;
  if (!o || typeof o !== "object") return bad("Missing output settings.");
  if (!FORMATS[o.formato]) return bad("Unsupported output format. Choose MP4, MOV or AVI.");
  if (!TIMELINE.qualities.includes(o.qualidade)) return bad("Invalid output quality.");
  if (!TIMELINE.fits.includes(o.fit)) return bad("Invalid output fit. Choose pad or crop.");
  for (const side of [o.largura, o.altura]) {
    if (!Number.isInteger(side) || side % 2 !== 0 || side < TIMELINE.minSide || side > TIMELINE.maxSide) {
      return bad(`The output width and height must be even numbers between ${TIMELINE.minSide} and ${TIMELINE.maxSide}.`);
    }
  }

  if (!Array.isArray(body.faixas) || body.faixas.length === 0 || body.faixas.length > TIMELINE.maxTracks) {
    return bad("Invalid timeline tracks.");
  }

  const faixas = [];
  let clipCount = 0;

  for (const f of body.faixas) {
    if (!TIMELINE.trackTypes.includes(f?.tipo) || !Array.isArray(f.clips)) return bad("Invalid timeline track.");

    clipCount += f.clips.length;
    if (clipCount > TIMELINE.maxClips) return bad(`A timeline can have at most ${TIMELINE.maxClips} clips.`);

    const clips = [];
    for (const c of f.clips) {
      const video = videosById.get(String(c?.video_id));
      if (!video) return bad("A clip uses a video that is no longer in this project.");

      if (typeof c.link_id !== "string" || !c.link_id || c.link_id.length > 64) {
        return bad("A clip has an invalid link.");
      }

      const clip = {
        link_id: c.link_id,
        video_id: String(video._id),
        in: ms(Number(c.in)),
        out: ms(Number(c.out)),
        speed: Number(c.speed ?? 1),
        posicao: ms(Number(c.posicao)),
      };

      if (![clip.in, clip.out, clip.speed, clip.posicao].every(Number.isFinite)) {
        return bad("Clip times must be numbers.");
      }
      if (clip.in < 0 || clip.out <= clip.in || clip.out > video.duration + 0.001) {
        return bad(`A clip of "${video.name}" is outside the video's duration.`);
      }
      if (clip.speed < TIMELINE.minSpeed || clip.speed > TIMELINE.maxSpeed) {
        return bad(`The clip speed must be between ${TIMELINE.minSpeed}x and ${TIMELINE.maxSpeed}x.`);
      }
      if (clip.posicao < 0) return bad("A clip cannot start before the beginning of the timeline.");
      if (f.tipo === "audio" && !video.has_audio) return bad(`"${video.name}" has no audio.`);

      clips.push(clip);
    }

    clips.sort((a, b) => a.posicao - b.posicao);
    for (let i = 1; i < clips.length; i++) {
      if (clips[i].posicao < clipEnd(clips[i - 1]) - 0.001) {
        return bad("Clips on the same track cannot overlap.");
      }
    }

    faixas.push({ tipo: f.tipo, clips });
  }

  const output = { formato: o.formato, qualidade: o.qualidade, largura: o.largura, altura: o.altura, fit: o.fit };
  return { ok: true, timeline: { output, faixas }, duration: timelineDuration(faixas) };
}

function serializeTimeline(t) {
  return {
    version: t.version,
    output: t.output,
    faixas: t.faixas,
    canUndo: t.undo.length > 0,
    canRedo: t.redo.length > 0,
    duration: timelineDuration(t.faixas),
  };
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

function serializeVideo(video, url = null, previewUrls = {}) {
  const p = video.preview || {};
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
    preview: {
      state: p.state || "missing",
      proxyUrl: previewUrls.proxyUrl ?? null,
      spriteUrl: previewUrls.spriteUrl ?? null,
      waveformUrl: previewUrls.waveformUrl ?? null,
      sprite: p.sprite?.cols
        ? { interval: p.sprite.interval, cols: p.sprite.cols, count: p.sprite.count, width: p.sprite.width, height: p.sprite.height }
        : null,
    },
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
  validateTimeline,
  timelineDuration,
  cutResultName,
  ffprobe,
  serializeVideo,
  serializeTask,
  serializeTimeline,
};
