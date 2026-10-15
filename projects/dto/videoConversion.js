const FORMATS = ["mp4", "mov", "avi"];
const QUALITIES = ["low", "medium", "high"];

// Resoluções suportadas pelo contrato da conversão. A dimensão original é
// sempre aceite quando pertence a uma destas proporções.
const RESOLUTIONS = [
  { width: 3840, height: 2160, label: "2160p" },
  { width: 2560, height: 1440, label: "1440p" },
  { width: 1920, height: 1080, label: "1080p" },
  { width: 1280, height: 720, label: "720p" },
  { width: 854, height: 480, label: "480p" },
];

const QUALITY_FACTORS = {
  low: 0.55,
  medium: 0.8,
  high: 1.15,
};

const FORMAT_FACTORS = {
  mp4: 1,
  mov: 1.08,
  avi: 1.2,
};

function invalid(code, message) {
  return { ok: false, code, status: 422, message };
}

function findResolution(width, height) {
  return RESOLUTIONS.find((resolution) => resolution.width === width && resolution.height === height);
}

function parseResolution(body) {
  if (typeof body?.resolution === "string") {
    const match = body.resolution.trim().match(/^(\d+)\s*[xX]\s*(\d+)$/);
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
  }

  return { width: Number(body?.width), height: Number(body?.height) };
}

function estimateSizeBytes(video, format, resolution, quality) {
  const originalPixels = video.width * video.height;
  const targetPixels = resolution.width * resolution.height;
  const estimate = video.size
    * (targetPixels / originalPixels)
    * QUALITY_FACTORS[quality]
    * FORMAT_FACTORS[format];

  return Math.max(1, Math.round(estimate));
}

/**
 * Valida e normaliza o pedido de conversão sem iniciar processamento.
 * A resolução só pode ser reduzida relativamente ao vídeo original.
 */
function validateVideoConversion(body, video) {
  const format = String(body?.format || "").toLowerCase();
  const qualityInput = String(body?.quality || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const quality = { baixa: "low", media: "medium", alta: "high" }[qualityInput] || qualityInput;
  const { width, height } = parseResolution(body);

  if (!FORMATS.includes(format)) {
    return invalid("invalid_format", "O formato deve ser MP4, MOV ou AVI.");
  }

  if (!QUALITIES.includes(quality)) {
    return invalid("invalid_quality", "A qualidade deve ser Baixa, Média ou Alta.");
  }

  const resolution = findResolution(width, height);
  if (!resolution) {
    return invalid("invalid_resolution", "A resolução indicada não é suportada.");
  }

  if (width > video.width || height > video.height) {
    return invalid("resolution_above_original", "A resolução de destino não pode ser superior à do vídeo original.");
  }

  if (format === video.format && width === video.width && height === video.height) {
    return invalid("no_changes", "O formato ou a resolução deve ser diferente do vídeo original.");
  }

  return {
    ok: true,
    value: {
      format,
      width,
      height,
      resolution: resolution.label,
      quality,
      estimatedSizeBytes: estimateSizeBytes(video, format, resolution, quality),
    },
  };
}

module.exports = {
  FORMATS,
  QUALITIES,
  RESOLUTIONS,
  estimateSizeBytes,
  validateVideoConversion,
};
