import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  cancelVideoTask,
  deleteVideo,
  exportTimeline,
  regeneratePreview,
  uploadVideo,
  VideoTask,
} from "../videos";
import { timelineKey, videosKey, videoTasksKey } from "../queries/videos";

type Ctx = { uid: string; pid: string; token: string };

export const useUploadVideo = ({ uid, pid, token }: Ctx) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      file: File;
      onProgress?: (fraction: number) => void;
      signal?: AbortSignal;
    }) => uploadVideo({ uid, pid, token, ...args }),
    onSuccess: () => qc.invalidateQueries({ queryKey: videosKey(uid, pid) }),
  });
};

export const useDeleteVideo = ({ uid, pid, token }: Ctx) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (videoId: string) => deleteVideo({ uid, pid, token, videoId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: videosKey(uid, pid) });
      // o servidor pode ter limpo o histórico de desfazer que usava o vídeo
      qc.invalidateQueries({ queryKey: timelineKey(uid, pid) });
    },
  });
};

export const useRegeneratePreview = ({ uid, pid, token }: Ctx) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (videoId: string) => regeneratePreview({ uid, pid, token, videoId }),
    onSettled: () => qc.invalidateQueries({ queryKey: videosKey(uid, pid) }),
  });
};

const upsertTask = (old: VideoTask[] | undefined, task: VideoTask) => {
  if (!old) return [task];
  return old.some((t) => t._id === task._id)
    ? old.map((t) => (t._id === task._id ? task : t))
    : [task, ...old];
};

export const useExportTimeline = ({ uid, pid, token }: Ctx) => {
  const qc = useQueryClient();
  return useMutation({
    // a mesma fila das gravações da timeline: exporta depois de tudo gravado
    scope: { id: `timeline-${pid}` },
    mutationFn: (version: () => number) => exportTimeline({ uid, pid, token, version: version() }),
    onSuccess: (task) =>
      qc.setQueryData<VideoTask[]>(videoTasksKey(uid, pid), (old) => upsertTask(old, task)),
  });
};

export const useCancelVideoTask = ({ uid, pid, token }: Ctx) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => cancelVideoTask({ uid, pid, token, taskId }),
    onSuccess: (task) =>
      qc.setQueryData<VideoTask[]>(videoTasksKey(uid, pid), (old) => upsertTask(old, task)),
    // Pode já ter terminado entretanto: atualizar a lista
    onError: () => qc.invalidateQueries({ queryKey: videoTasksKey(uid, pid) }),
  });
};
