import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  cancelVideoTask,
  deleteVideo,
  requestVideoCut,
  uploadVideo,
  VideoTask,
} from "../videos";
import { videosKey, videoTasksKey } from "../queries/videos";

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
    onSuccess: () => qc.invalidateQueries({ queryKey: videosKey(uid, pid) }),
  });
};

const upsertTask = (old: VideoTask[] | undefined, task: VideoTask) => {
  if (!old) return [task];
  return old.some((t) => t._id === task._id)
    ? old.map((t) => (t._id === task._id ? task : t))
    : [task, ...old];
};

export const useRequestVideoCut = ({ uid, pid, token }: Ctx) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { videoId: string; start: number; end: number }) =>
      requestVideoCut({ uid, pid, token, ...args }),
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
