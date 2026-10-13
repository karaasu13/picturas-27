// Vídeos do projeto e tarefas de corte (UC-VID-001).
import axios from "axios";
import { api } from "./axios";

export type VideoFormat = "mp4" | "mov" | "avi";

export interface ProjectVideo {
  _id: string;
  name: string;
  format: VideoFormat;
  size: number;
  duration: number; // segundos
  width: number;
  height: number;
  fps: number;
  codec: "h264" | "hevc";
  hasAudio: boolean;
  source: "upload" | "cut";
  parentVideoId: string | null;
  createdAt: string;
  url: string | null;
}

export type VideoTaskState =
  | "queued"
  | "processing"
  | "done"
  | "failed"
  | "cancelled";

export interface VideoTask {
  _id: string;
  projectId: string;
  videoId: string;
  videoName: string;
  op: "cut";
  params: { start: number; end: number };
  state: VideoTaskState;
  outputVideoId: string | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export const ACTIVE_TASK_STATES: VideoTaskState[] = ["queued", "processing"];

export const TASK_STATE_LABELS: Record<VideoTaskState, string> = {
  queued: "Em Fila",
  processing: "A processar",
  done: "Concluído",
  failed: "Falhou",
  cancelled: "Cancelado",
};

// Mesmas regras do backend (REQ-VID-PLAT-001 e UC-VID-001), para avisar
// logo no browser. O backend continua a ser quem decide.
export const VIDEO_RULES = {
  accept: {
    "video/mp4": [".mp4"],
    "video/quicktime": [".mov"],
    "video/x-msvideo": [".avi"],
    "video/avi": [".avi"],
  },
  maxBytes: 2 * 1024 * 1024 * 1024,
  freeMaxDuration: 10 * 60,
  minCut: 1,
  minResult: 5,
};

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const base = (uid: string, pid: string) => `/projects/${uid}/${pid}`;

/** Mensagem do backend ({ code, message }) ou uma genérica. */
export function videoErrorMessage(error: unknown, fallback: string) {
  if (axios.isAxiosError(error)) {
    if (!error.response) {
      return "Não foi possível comunicar com o servidor. Verifica a tua ligação e tenta novamente.";
    }
    const data = error.response.data;
    if (data && typeof data === "object" && typeof data.message === "string") {
      return data.message as string;
    }
    if (typeof data === "string" && data.length < 200) return data;
  }
  return fallback;
}

export const fetchVideos = async (uid: string, pid: string, token: string) => {
  const resp = await api.get<ProjectVideo[]>(`${base(uid, pid)}/videos`, {
    headers: auth(token),
  });
  return resp.data;
};

export const uploadVideo = async ({
  uid,
  pid,
  token,
  file,
  onProgress,
  signal,
}: {
  uid: string;
  pid: string;
  token: string;
  file: File;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}) => {
  const form = new FormData();
  form.append("video", file);

  const resp = await api.post<ProjectVideo>(`${base(uid, pid)}/videos`, form, {
    headers: { ...auth(token), "Content-Type": "multipart/form-data" },
    onUploadProgress: (e) => {
      if (onProgress && e.total) onProgress(e.loaded / e.total);
    },
    signal,
  });
  return resp.data;
};

export const deleteVideo = async ({
  uid,
  pid,
  token,
  videoId,
}: {
  uid: string;
  pid: string;
  token: string;
  videoId: string;
}) => {
  await api.delete(`${base(uid, pid)}/videos/${videoId}`, {
    headers: auth(token),
  });
};

export const requestVideoCut = async ({
  uid,
  pid,
  token,
  videoId,
  start,
  end,
}: {
  uid: string;
  pid: string;
  token: string;
  videoId: string;
  start: number;
  end: number;
}) => {
  const resp = await api.post<VideoTask>(
    `${base(uid, pid)}/videos/${videoId}/cut`,
    { start, end },
    { headers: auth(token) },
  );
  return resp.data;
};

export const fetchVideoTasks = async (
  uid: string,
  pid: string,
  token: string,
) => {
  const resp = await api.get<VideoTask[]>(`${base(uid, pid)}/video-tasks`, {
    headers: auth(token),
  });
  return resp.data;
};

export const cancelVideoTask = async ({
  uid,
  pid,
  token,
  taskId,
}: {
  uid: string;
  pid: string;
  token: string;
  taskId: string;
}) => {
  const resp = await api.delete<VideoTask>(
    `${base(uid, pid)}/video-tasks/${taskId}`,
    { headers: auth(token) },
  );
  return resp.data;
};

// ------------------------------------------------------------- tempos

/** 75.5 -> "00:01:15.500" (formato do campo do UC-VID-001) */
export function formatTimecode(seconds: number) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalS = Math.floor(totalMs / 1000);
  const s = totalS % 60;
  const m = Math.floor(totalS / 60) % 60;
  const h = Math.floor(totalS / 3600);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

/**
 * Aceita "hh:mm:ss.mmm", "mm:ss.mmm", "ss.mmm" ou "ss".
 * Devolve segundos, ou null se o texto não for um tempo válido.
 */
export function parseTimecode(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!/^(\d+:){0,2}\d+(\.\d{1,3})?$/.test(t)) return null;

  const parts = t.split(":").map(Number);
  const secs = parts[parts.length - 1];
  if (parts.length >= 2 && secs >= 60) return null; // "1:75" não é válido
  if (parts.length === 3 && parts[1] >= 60) return null;

  // [h, m, s] -> (h * 60 + m) * 60 + s
  return parts.reduce((total, p) => total * 60 + p, 0);
}

/** Duração legível: 754 -> "12:34" e 3725 -> "1:02:05" */
export function formatDuration(seconds: number) {
  const total = Math.round(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Validação do intervalo no browser (mesmas regras do backend).
 * Devolve null se estiver bem, ou a mensagem a mostrar.
 */
export function validateCutInterval(
  start: number | null,
  end: number | null,
  duration: number,
): string | null {
  if (start === null || end === null) {
    return "Indica o início e o fim no formato hh:mm:ss.mmm.";
  }
  if (start <= 0 || end >= duration || end - start <= VIDEO_RULES.minCut) {
    return "O intervalo a eliminar deve ser interior ao vídeo e ter uma duração superior a 1 segundo.";
  }
  if (duration - (end - start) < VIDEO_RULES.minResult) {
    return "O vídeo resultante é demasiado curto. O resultado final deve ter pelo menos 5 segundos.";
  }
  return null;
}
