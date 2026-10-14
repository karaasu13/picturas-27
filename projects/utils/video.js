// Regras e utilitários de vídeo (editor com timeline e REQ-VID-PLAT-001).
// As funções de validação são puras para poderem ser testadas sem Docker.

const { execFile } = require("child_process");
const path = require("path");

const LIMITS = {
  // REQ-VID-PLAT-001: até 2 GB
  maxUploadBytes: Number(process.env.VIDEO_MAX_UPLOAD_BYTES) || 2 * 1024 * 1024 * 1024,
  // Perfil Registado: exportações até 10 min (Premium sem limite)
  freeMaxDuration: Number(process.env.VIDEO_FREE_MAX_DURATION) || 10 * 60,
  // O vídeo exportado tem de ter pelo menos 5 s
  minResult: 5,
};

// Limites da exportação por perfil: resolução do output (lado maior x lado
// menor) e n.º de vídeos de origem diferentes
const EXPORT_LIMITS = {
  free: { maxDuration: LIMITS.freeMaxDuration, maxLong: 1920, maxShort: 1080, maxSources: 5 },
  premium: { maxDuration: Infinity, maxLong: 4096, maxShort: 4096, maxSources: 20 },
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
  unsupported_format: "Unsupported format. Only MP4, MOV or AVI videos encoded in H.264 or H.265 are accepted.",
  unreadable: "The video could not be read. Make sure the file isn't corrupted and try again.",
  too_large: "The video is larger than the 2 GB limit. Reduce the file size and try again.",
  empty_timeline: "Add at least one video clip to the timeline before exporting.",
  result_too_short: "The exported video is too short. The final result must be at least 5 seconds long.",
  duration_limit:
    "Registered accounts can export videos up to 10 minutes long. Shorten the timeline or upgrade to Premium.",
  resolution_limit:
    "Registered accounts can export up to 1080p (1920×1080). Choose a lower resolution or upgrade to Premium.",
  too_many_sources_free:
    "Registered accounts can use up to 5 different videos in one export. Remove clips from some videos or upgrade to Premium.",
  too_many_sources_premium:
    "An export can use up to 20 different videos. Remove clips from some videos and try again.",
  quota_exceeded:
    "You have reached the limit of 5 daily operations of the free plan. Upgrade to Premium to continue.",
  anonymous: "Anonymous users don't have access to the video tools. Create an account to continue.",
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

  if (!Array.isArray(body.faixas) || body.faixas.length === 0) return bad("Invalid timeline tracks.");
  // O render junta uma faixa de vídeo com uma de áudio (sem sobreposição de imagens nem mistura)
  for (const tipo of TIMELINE.trackTypes) {
    if (body.faixas.filter((f) => f?.tipo === tipo).length > 1) {
      return bad("The timeline can have only one video track and one audio track.");
    }
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

/**
 * Limites da exportação para o perfil (o anónimo não exporta). `duration` é
 * a duração final e `sourceCount` o n.º de vídeos de origem diferentes.
 * Devolve { ok: true } ou { ok: false, status, code, message }.
 */
function checkExportLimits({ duration, output, sourceCount, userType }) {
  const no = (status, code, message = MESSAGES[code]) => ({ ok: false, status, code, message });

  if (userType === "anonymous") return no(403, "anonymous");
  if (!(duration > 0)) return no(422, "empty_timeline");
  if (duration < LIMITS.minResult) return no(422, "result_too_short");

  const premium = userType === "premium";
  const limits = premium ? EXPORT_LIMITS.premium : EXPORT_LIMITS.free;
  if (duration > limits.maxDuration) return no(422, "duration_limit");

  const long = Math.max(output.largura, output.altura);
  const short = Math.min(output.largura, output.altura);
  if (long > limits.maxLong || short > limits.maxShort) return no(422, "resolution_limit");

  if (sourceCount > limits.maxSources) {
    return no(422, "too_many_sources", MESSAGES[premium ? "too_many_sources_premium" : "too_many_sources_free"]);
  }
  return { ok: true };
}

/** Nome do vídeo exportado ("<origem>_edit.<formato>") que não colide com os existentes. */
function resultName(sourceName, existingNames, format) {
  const base = path.basename(sourceName, path.extname(sourceName));
  const taken = new Set(existingNames);
  for (let i = 1; ; i++) {
    const name = `${base}_edit${i > 1 ? `_${i}` : ""}.${format}`;
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
    videoIds: task.video_ids,
    name: task.name,
    op: task.op,
    // a receita completa fica só no servidor; o cliente mostra o resumo
    params: { output: task.params?.output ?? null, duration: task.params?.duration ?? null },
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
  validateTimeline,
  timelineDuration,
  checkExportLimits,
  resultName,
  ffprobe,
  serializeVideo,
  serializeTask,
  serializeTimeline,
};
