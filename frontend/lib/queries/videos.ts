import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Socket } from "socket.io-client";
import {
  ACTIVE_TASK_STATES,
  fetchTimeline,
  fetchVideos,
  fetchVideoTasks,
  fetchWaveform,
  ProjectVideo,
  VideoTask,
} from "../videos";

export const videosKey = (uid: string, pid: string) => ["videos", uid, pid];
export const videoTasksKey = (uid: string, pid: string) => ["videoTasks", uid, pid];
export const timelineKey = (uid: string, pid: string) => ["timeline", uid, pid];

export const useGetVideos = (uid: string, pid: string, token: string) => {
  return useQuery({
    queryKey: videosKey(uid, pid),
    queryFn: () => fetchVideos(uid, pid, token),
    enabled: !!uid && !!pid && !!token,
    // As URLs do storage expiram: renovar de vez em quando
    staleTime: 5 * 60 * 1000,
    // Enquanto o worker prepara pré-visualizações, perguntar de vez em quando
    refetchInterval: (query) => {
      const videos = query.state.data as ProjectVideo[] | undefined;
      return videos?.some((v) => v.preview.state === "pending") ? 3000 : false;
    },
  });
};

// O editor guarda as alterações localmente e só lê a timeline do servidor
// ao abrir e depois de um erro (o rascunho local é a fonte de verdade).
export const useGetTimeline = (uid: string, pid: string, token: string) => {
  return useQuery({
    queryKey: timelineKey(uid, pid),
    queryFn: () => fetchTimeline(uid, pid, token),
    enabled: !!uid && !!pid && !!token,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
};

// Os picos não mudam: a chave é o vídeo, não a URL (que expira)
export const useWaveform = (videoId: string, url: string | null) => {
  return useQuery({
    queryKey: ["waveform", videoId],
    queryFn: () => fetchWaveform(url!),
    enabled: !!url,
    staleTime: Infinity,
  });
};

export const useGetVideoTasks = (uid: string, pid: string, token: string) => {
  return useQuery({
    queryKey: videoTasksKey(uid, pid),
    queryFn: () => fetchVideoTasks(uid, pid, token),
    enabled: !!uid && !!pid && !!token,
    // Os estados chegam pelo socket; enquanto houver tarefas ativas também
    // perguntamos de vez em quando, caso a ligação em tempo real falhe.
    refetchInterval: (query) => {
      const tasks = query.state.data as VideoTask[] | undefined;
      return tasks?.some((t) => ACTIVE_TASK_STATES.includes(t.state)) ? 5000 : false;
    },
  });
};

/**
 * Ouve os eventos "video-task" do ws_gateway e atualiza a lista de tarefas.
 * Quando uma exportação termina, a lista de vídeos também é atualizada (o
 * novo vídeo aparece na biblioteca). `onUpdate` permite mostrar um aviso.
 */
export const useVideoTaskEvents = (
  socket: Socket | undefined,
  uid: string,
  pid: string,
  onUpdate?: (task: VideoTask, previous: VideoTask | undefined) => void,
) => {
  const qc = useQueryClient();

  useEffect(() => {
    if (!socket) return;

    const handler = (task: VideoTask) => {
      if (task.projectId !== pid) return;

      const key = videoTasksKey(uid, pid);
      const previous = qc.getQueryData<VideoTask[]>(key)?.find((t) => t._id === task._id);

      qc.setQueryData<VideoTask[]>(key, (old) => {
        if (!old) return [task];
        const exists = old.some((t) => t._id === task._id);
        return exists ? old.map((t) => (t._id === task._id ? task : t)) : [task, ...old];
      });

      if (task.state === "done") {
        qc.invalidateQueries({ queryKey: videosKey(uid, pid) });
      }

      onUpdate?.(task, previous);
    };

    socket.on("video-task", handler);
    return () => {
      socket.off("video-task", handler);
    };
  }, [socket, uid, pid, qc, onUpdate]);
};
