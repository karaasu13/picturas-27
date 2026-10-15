"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Clapperboard,
  Link2,
  Redo2,
  Scissors,
  Trash2,
  Undo2,
  Unlink,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import Loading from "@/components/loading";
import { VideoUpload } from "@/components/videos/video-upload";
import { VideoLibrary } from "@/components/videos/video-library";
import { ClipActions, Timeline } from "@/components/videos/timeline";
import { TimelinePreview } from "@/components/videos/timeline-preview";
import { ClipInspector } from "@/components/videos/clip-inspector";
import { ExportPanel } from "@/components/videos/export-panel";
import { useSession } from "@/providers/session-provider";
import { useToast } from "@/hooks/use-toast";
import { useStablePreviews, useTimeline } from "@/hooks/use-timeline";
import { useGetProject, useGetSocket } from "@/lib/queries/projects";
import { useGetVideos, useGetVideoTasks, useVideoTaskEvents } from "@/lib/queries/videos";
import {
  useCancelVideoTask,
  useDeleteVideo,
  useExportTimeline,
  useRegeneratePreview,
} from "@/lib/mutations/videos";
import { useUpdateSession } from "@/lib/mutations/session";
import * as T from "@/lib/timeline";
import {
  ACTIVE_TASK_STATES,
  ProjectVideo,
  VideoTask,
  videoErrorCode,
  videoErrorMessage,
} from "@/lib/videos";

// Editor de vídeo do projeto: biblioteca, pré-visualização, timeline e
// exportação. Editar não gera ficheiros nem gasta quota; só exportar.
// Só o dono do projeto chega aqui (o botão não aparece em modo partilhado e o
// backend recusa pedidos de outros utilizadores).
export default function VideoEditor({ params }: { params: Promise<{ pid: string }> }) {
  const { pid } = use(params);
  const session = useSession();
  const uid = session.user._id;
  const token = session.token;
  const userType = session.user.type;
  const { toast } = useToast();

  const project = useGetProject(uid, pid, token);
  const videosQuery = useGetVideos(uid, pid, token);
  const tasksQuery = useGetVideoTasks(uid, pid, token);
  const socket = useGetSocket(token);

  const ctx = { uid, pid, token };
  const exportTimeline = useExportTimeline(ctx);
  const cancelTask = useCancelVideoTask(ctx);
  const deleteVideo = useDeleteVideo(ctx);
  const regeneratePreview = useRegeneratePreview(ctx);
  const { mutate: refreshSession } = useUpdateSession();

  const tl = useTimeline(uid, pid, token);
  const { draft, edit, undo, redo } = tl;

  const videoList = useMemo(() => videosQuery.data ?? [], [videosQuery.data]);
  const videos = useStablePreviews(videoList);
  const taskList = useMemo(() => tasksQuery.data ?? [], [tasksQuery.data]);

  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(40);
  const [tab, setTab] = useState("clip");
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const duration = draft ? T.timelineDuration(draft) : 0;
  const firstClip = draft ? T.track(draft, "video")?.clips[0] : undefined;
  const frame = 1 / ((firstClip && videos.get(firstClip.video_id)?.fps) || 25);

  // A seleção pode deixar de existir (clip apagado, desfazer...)
  useEffect(() => {
    if (selected && draft && T.groupClips(draft, selected).length === 0) setSelected(null);
  }, [draft, selected]);

  // O playhead fica dentro da timeline
  useEffect(() => {
    if (time > duration) setTime(duration);
  }, [time, duration]);

  const seek = useCallback((t: number) => setTime(Math.min(Math.max(0, t), duration)), [duration]);

  const select = useCallback((id: string | null) => {
    setSelected(id);
    if (id) setTab("clip");
  }, []);

  // ------------------------------------------------------------- edições

  const apply = useCallback(
    (next: T.TimelineData | null, refusal?: string) => {
      if (next) edit(next);
      else if (refusal) toast({ title: "Can't do that", description: refusal });
    },
    [edit, toast],
  );

  const durationOf = (id: string) => videos.get(id)?.duration ?? 0;

  const actions: ClipActions = {
    split: (id) => apply(draft && T.split(draft, time, id), "Move the playhead over the clip to split it."),
    remove: (id) => apply(draft && T.remove(draft, id)),
    speed: (id, s) =>
      apply(draft && T.setSpeed(draft, id, s), "There isn't enough free space on the track for this speed."),
    move: (id, dir) =>
      apply(
        draft && T.moveStep(draft, id, dir, frame),
        dir < 0 ? "This clip can't move further left." : "This clip can't move further right.",
      ),
    unlink: (id) => apply(draft && T.unlink(draft, id)),
    link: (id) =>
      apply(draft && T.link(draft, id), "Only clips aligned with an unlinked clip on the other track can be linked."),
  };

  function splitAtPlayhead() {
    apply(
      draft && T.split(draft, time, selected),
      selected ? "Move the playhead over the selected clip to split it." : "Move the playhead over a clip to split it.",
    );
  }

  function insert(videoId: string, at?: number) {
    const v = videos.get(videoId);
    if (!v || !draft) return;
    const src = { id: v._id, duration: v.duration, hasAudio: v.hasAudio, format: v.format, width: v.width, height: v.height };
    apply(T.insertVideo(draft, src, at ?? Math.max(...T.insertionPoints(draft))));
  }

  // ------------------------------------------------------------- teclado

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable=true], [role=combobox], [role=menu], [role=dialog]")) return;

      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          if (tl.canRedo) redo();
        } else if (tl.canUndo) undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        if (tl.canRedo) redo();
        return;
      }
      if (mod) return;

      switch (e.key) {
        case " ":
          if (el.closest("button, a")) return; // Espaço num botão carrega no botão
          e.preventDefault();
          if (duration > 0) setPlaying((p) => !p);
          break;
        case "ArrowLeft":
        case "ArrowRight": {
          e.preventDefault();
          const dir = e.key === "ArrowLeft" ? -1 : 1;
          if (e.altKey) {
            if (selected) actions.move(selected, dir);
          } else {
            setPlaying(false);
            seek(time + dir * frame);
          }
          break;
        }
        case "s":
        case "S":
          if (!e.altKey) splitAtPlayhead();
          break;
        case "Delete":
        case "Backspace":
          if (selected) {
            e.preventDefault();
            actions.remove(selected);
          }
          break;
        case "Escape":
          setSelected(null);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ------------------------------------------------------- tarefas e vídeos

  const busyVideoIds = useMemo(
    () => new Set(taskList.filter((t) => ACTIVE_TASK_STATES.includes(t.state)).flatMap((t) => t.videoIds ?? [])),
    [taskList],
  );

  // Estados em tempo real: aviso quando uma exportação termina ou falha
  const onTaskUpdate = useCallback(
    (task: VideoTask, previous: VideoTask | undefined) => {
      if (previous?.state === task.state) return;

      if (task.state === "done") {
        toast({ title: "Export finished", description: "The new video is in your library." });
      } else if (task.state === "failed") {
        toast({
          title: "The export failed",
          description: task.error?.message ?? "An error occurred while processing the video.",
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

  function startExport() {
    exportTimeline.mutate(tl.version, {
      onSuccess: () => {
        toast({ title: "Export started", description: "You can follow it in the Exports list." });
        refreshSession({ userId: uid, token });
      },
      onError: (error) =>
        toast({
          title: "The export couldn't start",
          description: videoErrorMessage(error, "Try again."),
          variant: "destructive",
        }),
    });
  }

  function cancel(task: VideoTask) {
    setCancellingId(task._id);
    cancelTask.mutate(task._id, {
      onSuccess: () => {
        toast({ title: "Export cancelled", description: "The operation was not counted." });
        refreshSession({ userId: uid, token });
      },
      onError: (error) =>
        toast({
          title: "The export couldn't be cancelled",
          description: videoErrorMessage(error, "Try again."),
          variant: "destructive",
        }),
      onSettled: () => setCancellingId(null),
    });
  }

  function remove(video: ProjectVideo) {
    deleteVideo.mutate(video._id, {
      onSuccess: () => toast({ title: "Video deleted", description: video.name }),
      onError: (error) =>
        toast({
          title: videoErrorCode(error) === "video_in_timeline" ? "Video in use" : "The video couldn't be deleted",
          description: videoErrorMessage(error, "Try again."),
          variant: "destructive",
        }),
    });
  }

  function retryPreview(video: ProjectVideo) {
    regeneratePreview.mutate(video._id, {
      onError: (error) =>
        toast({
          title: "The preview couldn't be prepared",
          description: videoErrorMessage(error, "Try again."),
          variant: "destructive",
        }),
    });
  }

  if (videosQuery.isLoading || tasksQuery.isLoading || tl.isLoading) return <Loading />;

  const loadError = videosQuery.error ?? tl.error;
  const groupSize = selected && draft ? T.groupClips(draft, selected).length : 0;

  return (
    <div className="flex h-screen flex-col">
      {/* Cabeçalho */}
      <div className="flex items-center gap-2 border-b border-sidebar-border px-2 py-2 md:px-3 xl:px-4">
        <SidebarTrigger variant="outline" className="h-9 w-10 lg:hidden" />
        <Button asChild variant="ghost" size="icon" title="Back to the project">
          <Link href={`/dashboard/${pid}`} aria-label="Back to the project">
            <ArrowLeft />
          </Link>
        </Button>
        <Clapperboard className="size-4 text-muted-foreground" />
        <h1 className="truncate text-lg font-semibold">
          Video editor{project.data?.name ? ` · ${project.data.name}` : ""}
        </h1>
        <div className="ml-auto flex items-center gap-1">
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {tl.saving ? "Saving…" : "All changes saved"}
          </span>
          <IconButton label="Undo (Ctrl+Z)" onClick={undo} disabled={!tl.canUndo}>
            <Undo2 />
          </IconButton>
          <IconButton label="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!tl.canRedo}>
            <Redo2 />
          </IconButton>
        </div>
      </div>

      {loadError || !draft ? (
        <div className="p-4">
          <Alert variant="destructive">
            <AlertTitle>The editor couldn&apos;t be loaded</AlertTitle>
            <AlertDescription>{videoErrorMessage(loadError, "Try reloading the page.")}</AlertDescription>
          </Alert>
        </div>
      ) : (
        <>
          <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[17rem_minmax(0,1fr)_19rem] lg:overflow-hidden">
            {/* Biblioteca */}
            <aside className="flex flex-col gap-3 border-b p-3 lg:overflow-y-auto lg:border-b-0 lg:border-r">
              {userType === "anonymous" ? (
                <Alert>
                  <AlertDescription>
                    Anonymous users don&apos;t have access to the video tools.{" "}
                    <Link href="/register" className="underline">
                      Create an account
                    </Link>{" "}
                    to continue.
                  </AlertDescription>
                </Alert>
              ) : (
                <VideoUpload uid={uid} pid={pid} token={token} />
              )}
              <h2 className="px-1 text-sm font-semibold text-muted-foreground">Library ({videoList.length})</h2>
              <VideoLibrary
                videos={videoList}
                busyIds={busyVideoIds}
                onAdd={(v) => insert(v._id)}
                onDelete={remove}
                onRetryPreview={retryPreview}
              />
            </aside>

            {/* Pré-visualização */}
            <section className="flex min-h-72 flex-col p-3">
              <TimelinePreview
                timeline={draft}
                videos={videos}
                time={time}
                duration={duration}
                frame={frame}
                playing={playing}
                onTime={setTime}
                onPlayingChange={setPlaying}
                onRetryPreview={retryPreview}
              />
            </section>

            {/* Clip selecionado e exportação */}
            <aside className="border-t p-3 lg:overflow-y-auto lg:border-l lg:border-t-0">
              <Tabs value={tab} onValueChange={setTab}>
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="clip">Clip</TabsTrigger>
                  <TabsTrigger value="export">Export</TabsTrigger>
                </TabsList>
                <TabsContent value="clip" className="pt-2">
                  <ClipInspector
                    timeline={draft}
                    videos={videos}
                    linkId={selected}
                    actions={actions}
                    onTrim={(id, edge, delta) =>
                      apply(T.trim(draft, id, edge, delta, durationOf)?.timeline ?? null)
                    }
                  />
                </TabsContent>
                <TabsContent value="export" className="pt-2">
                  <ExportPanel
                    timeline={draft}
                    videos={videos}
                    userType={userType}
                    remainingOperations={session.user.remaining_operations}
                    exporting={exportTimeline.isPending}
                    onOutputChange={(output) => apply({ ...draft, output })}
                    onExport={startExport}
                    tasks={taskList}
                    cancellingId={cancellingId}
                    onCancelTask={cancel}
                  />
                </TabsContent>
              </Tabs>
            </aside>
          </div>

          {/* Timeline */}
          <div className="border-t">
            <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1">
              <IconButton label="Split at playhead (S)" onClick={splitAtPlayhead} disabled={duration === 0}>
                <Scissors />
              </IconButton>
              <IconButton
                label="Delete clip (Del)"
                onClick={() => selected && actions.remove(selected)}
                disabled={!selected}
              >
                <Trash2 />
              </IconButton>
              {groupSize > 1 ? (
                <IconButton label="Unlink audio and video" onClick={() => selected && actions.unlink(selected)}>
                  <Unlink />
                </IconButton>
              ) : (
                <IconButton
                  label="Link audio and video"
                  onClick={() => selected && actions.link(selected)}
                  disabled={!selected || !T.linkCandidate(draft, selected)}
                >
                  <Link2 />
                </IconButton>
              )}

              <div className="ml-auto flex items-center gap-2">
                <ZoomOut className="size-4 text-muted-foreground" aria-hidden />
                <Slider
                  aria-label="Timeline zoom"
                  className="w-32"
                  min={5}
                  max={200}
                  step={1}
                  value={[zoom]}
                  onValueChange={([z]) => setZoom(z)}
                />
                <ZoomIn className="size-4 text-muted-foreground" aria-hidden />
              </div>
            </div>
            <Timeline
              timeline={draft}
              videos={videos}
              time={time}
              zoom={zoom}
              selected={selected}
              onSeek={seek}
              onSelect={select}
              onEdit={apply}
              onInsert={insert}
              actions={actions}
            />
          </div>
        </>
      )}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* o span mantém a dica visível com o botão desativado */}
        <span tabIndex={disabled ? 0 : -1}>
          <Button variant="ghost" size="icon" className="size-8" aria-label={label} onClick={onClick} disabled={disabled}>
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
