"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Film } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { SidebarTrigger } from "@/components/ui/sidebar";
import Loading from "@/components/loading";
import { VideoUpload } from "@/components/videos/video-upload";
import { VideoLibrary } from "@/components/videos/video-library";
import { VideoCutPanel } from "@/components/videos/video-cut-panel";
import { VideoTaskList } from "@/components/videos/video-task-list";
import { useSession } from "@/providers/session-provider";
import { useToast } from "@/hooks/use-toast";
import { useGetProject, useGetSocket } from "@/lib/queries/projects";
import { useGetVideos, useGetVideoTasks, useVideoTaskEvents } from "@/lib/queries/videos";
import {
  useCancelVideoTask,
  useDeleteVideo,
  useRequestVideoCut,
} from "@/lib/mutations/videos";
import { useUpdateSession } from "@/lib/mutations/session";
import { ACTIVE_TASK_STATES, VideoTask, videoErrorMessage } from "@/lib/videos";

// Vídeos do projeto e corte de segmento intermédio (UC-VID-001).
// Só o dono do projeto chega aqui (o botão não aparece em modo partilhado e o
// backend recusa pedidos de outros utilizadores).
export default function ProjectVideos({ params }: { params: Promise<{ pid: string }> }) {
  const { pid } = use(params);
  const session = useSession();
  const uid = session.user._id;
  const token = session.token;
  const userType = session.user.type;
  const { toast } = useToast();

  const project = useGetProject(uid, pid, token);
  const videos = useGetVideos(uid, pid, token);
  const tasks = useGetVideoTasks(uid, pid, token);
  const socket = useGetSocket(token);

  const ctx = { uid, pid, token };
  const requestCut = useRequestVideoCut(ctx);
  const cancelTask = useCancelVideoTask(ctx);
  const deleteVideo = useDeleteVideo(ctx);
  const { mutate: refreshSession } = useUpdateSession();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const videoList = useMemo(() => videos.data ?? [], [videos.data]);
  const taskList = useMemo(() => tasks.data ?? [], [tasks.data]);
  const selected = videoList.find((v) => v._id === selectedId) ?? null;

  // Seleciona o primeiro vídeo quando a lista chega (ou se o selecionado sair)
  useEffect(() => {
    if (videoList.length === 0) return;
    if (!selectedId || !videoList.some((v) => v._id === selectedId)) {
      setSelectedId(videoList[0]._id);
    }
  }, [videoList, selectedId]);

  // Um corte terminou (por exemplo, visto pela consulta periódica e não pelo
  // socket) e o novo vídeo ainda não está na biblioteca: atualizar
  const missingOutput = taskList.some(
    (t) => t.state === "done" && t.outputVideoId && !videoList.some((v) => v._id === t.outputVideoId),
  );
  useEffect(() => {
    if (missingOutput) videos.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingOutput]);

  async function openResult(task: VideoTask) {
    if (!task.outputVideoId) return;
    if (!videoList.some((v) => v._id === task.outputVideoId)) await videos.refetch();
    setSelectedId(task.outputVideoId);
  }

  const busyVideoIds = useMemo(
    () =>
      new Set(
        taskList.filter((t) => ACTIVE_TASK_STATES.includes(t.state)).map((t) => t.videoId),
      ),
    [taskList],
  );

  // Estados em tempo real: aviso quando um corte termina ou falha
  const onTaskUpdate = useCallback(
    (task: VideoTask, previous: VideoTask | undefined) => {
      if (previous?.state === task.state) return;

      if (task.state === "done") {
        toast({ title: "Corte concluído", description: `O novo vídeo já está no projeto (${task.videoName}).` });
      } else if (task.state === "failed") {
        toast({
          title: "O corte falhou",
          description: task.error?.message ?? "Ocorreu um erro ao processar o vídeo.",
          variant: "destructive",
        });
      }

      // falha/cancelamento devolvem a operação: atualizar o contador
      if (task.state === "failed" || task.state === "cancelled") {
        refreshSession({ userId: uid, token });
      }
    },
    [toast, refreshSession, uid, token],
  );

  useVideoTaskEvents(socket.data, uid, pid, onTaskUpdate);

  function submitCut(start: number, end: number) {
    if (!selected) return;
    requestCut.mutate(
      { videoId: selected._id, start, end },
      {
        onSuccess: () => {
          toast({ title: "Tarefa criada", description: "O corte ficou em fila. Podes acompanhar o estado abaixo." });
          refreshSession({ userId: uid, token });
        },
        onError: (error) =>
          toast({
            title: "Não foi possível pedir o corte",
            description: videoErrorMessage(error, "Tenta novamente."),
            variant: "destructive",
          }),
      },
    );
  }

  function cancel(task: VideoTask) {
    setCancellingId(task._id);
    cancelTask.mutate(task._id, {
      onSuccess: () => {
        toast({ title: "Tarefa cancelada", description: "A operação não foi contabilizada." });
        refreshSession({ userId: uid, token });
      },
      onError: (error) =>
        toast({
          title: "Não foi possível cancelar",
          description: videoErrorMessage(error, "Tenta novamente."),
          variant: "destructive",
        }),
      onSettled: () => setCancellingId(null),
    });
  }

  function remove(videoId: string) {
    deleteVideo.mutate(videoId, {
      onSuccess: () => toast({ title: "Vídeo removido" }),
      onError: (error) =>
        toast({
          title: "Não foi possível remover o vídeo",
          description: videoErrorMessage(error, "Tenta novamente."),
          variant: "destructive",
        }),
    });
  }

  if (videos.isLoading || tasks.isLoading) return <Loading />;

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-sidebar-border py-2 px-2 md:px-3 xl:px-4">
        <SidebarTrigger variant="outline" className="h-9 w-10 lg:hidden" />
        <Button asChild variant="ghost" size="icon" title="Voltar ao projeto">
          <Link href={`/dashboard/${pid}`}>
            <ArrowLeft />
          </Link>
        </Button>
        <Film className="size-4 text-muted-foreground" />
        <h1 className="text-lg font-semibold truncate">
          Vídeos{project.data?.name ? ` · ${project.data.name}` : ""}
        </h1>
      </div>

      <div className="flex-1 overflow-y-auto">
        {videos.isError ? (
          <div className="p-4">
            <Alert variant="destructive">
              <AlertTitle>Não foi possível carregar os vídeos</AlertTitle>
              <AlertDescription>
                {videoErrorMessage(videos.error, "Tenta recarregar a página.")}
              </AlertDescription>
            </Alert>
          </div>
        ) : (
          <div className="grid gap-6 p-3 md:p-4 lg:grid-cols-[minmax(260px,340px)_1fr]">
            {/* Biblioteca */}
            <section className="flex flex-col gap-3">
              {userType === "anonymous" ? (
                <Alert>
                  <AlertDescription>
                    Os utilizadores anónimos não têm acesso às ferramentas de vídeo.{" "}
                    <Link href="/register" className="underline">
                      Cria uma conta
                    </Link>{" "}
                    para continuar.
                  </AlertDescription>
                </Alert>
              ) : (
                <VideoUpload uid={uid} pid={pid} token={token} onUploaded={(v) => setSelectedId(v._id)} />
              )}
              <h2 className="text-sm font-semibold text-muted-foreground px-1">
                Biblioteca ({videoList.length})
              </h2>
              <VideoLibrary
                videos={videoList}
                selectedId={selectedId}
                busyIds={busyVideoIds}
                onSelect={(v) => setSelectedId(v._id)}
                onDelete={(v) => remove(v._id)}
              />
            </section>

            {/* Vídeo selecionado + corte + tarefas */}
            <section className="flex flex-col gap-6 min-w-0">
              {selected ? (
                <VideoCutPanel
                  video={selected}
                  userType={userType}
                  remainingOperations={session.user.remaining_operations}
                  submitting={requestCut.isPending}
                  onSubmit={submitCut}
                />
              ) : (
                <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                  Carrega um vídeo para começar.
                </div>
              )}

              <div className="flex flex-col gap-2">
                <h2 className="text-sm font-semibold text-muted-foreground px-1">Tarefas</h2>
                <VideoTaskList
                  tasks={taskList}
                  cancellingId={cancellingId}
                  onCancel={cancel}
                  onOpenResult={openResult}
                />
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
