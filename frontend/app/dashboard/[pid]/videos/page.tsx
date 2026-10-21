"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { ImperativePanelHandle } from "react-resizable-panels";
import {
  ArrowLeft,
  Clapperboard,
  Library,
  Link2,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Redo2,
  Scissors,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  StepBack,
  StepForward,
  Trash2,
  Undo2,
  Unlink,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import Loading from "@/components/loading";
import { VideoUpload } from "@/components/videos/video-upload";
import { VideoLibrary } from "@/components/videos/video-library";
import { ClipActions, Timeline, TIMELINE_MAX_H, TIMELINE_MIN_H } from "@/components/videos/timeline";
import { TimelinePreview } from "@/components/videos/timeline-preview";
import { TimeField } from "@/components/videos/time-field";
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
  formatTimecode,
  ProjectVideo,
  VideoTask,
  videoErrorCode,
  videoErrorMessage,
} from "@/lib/videos";

// Os tamanhos dos painéis ficam no localStorage; sem ele (modo privado, dados
// bloqueados) ficam só em memória
const panelStorage = {
  getItem: (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // sem localStorage
    }
  },
};

// Os painéis medem-se em % do editor; os mínimos em px (o que o conteúdo
// precisa) passam a % do espaço que há, sem descer abaixo de um mínimo em %
const minPct = (px: number, total: number, floor: number) =>
  total > 0 ? Math.max(floor, Math.ceil((px / total) * 100)) : floor;

const TIMELINE_BAR_H = 41; // barra de ferramentas e transporte, com a borda

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

  // ----------------------------------------------------------- layout

  // No editor a barra lateral começa recolhida (Ctrl+B ou o botão abrem-na);
  // ao sair volta ao estado que tinha
  const sidebar = useSidebar();
  const sidebarWasOpen = useRef(sidebar.open);
  useEffect(() => {
    const was = sidebarWasOpen.current;
    sidebar.setOpen(false);
    return () => sidebar.setOpen(was);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const libraryRef = useRef<ImperativePanelHandle>(null);
  const inspectorRef = useRef<ImperativePanelHandle>(null);
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);

  const togglePanel = (panel: ImperativePanelHandle | null) => {
    if (panel?.isCollapsed()) panel.expand();
    else panel?.collapse();
  };

  // Modo Focus: só a pré-visualização e a timeline; ao sair repõe o que estava
  const focus = !sidebar.open && !libraryOpen && !inspectorOpen;
  const beforeFocus = useRef({ sidebar: false, library: true, inspector: true });
  function toggleFocus() {
    if (!focus) {
      beforeFocus.current = { sidebar: sidebar.open, library: libraryOpen, inspector: inspectorOpen };
      sidebar.setOpen(false);
      libraryRef.current?.collapse();
      inspectorRef.current?.collapse();
      return;
    }
    const b = beforeFocus.current;
    // já estava tudo recolhido antes: sair do Focus mostra a biblioteca e o inspector
    const restore = b.sidebar || b.library || b.inspector ? b : { sidebar: false, library: true, inspector: true };
    if (restore.sidebar) sidebar.setOpen(true);
    if (restore.library) libraryRef.current?.expand();
    if (restore.inspector) inspectorRef.current?.expand();
  }

  // Espaço do editor, para converter os mínimos em px dos painéis em %
  const [area, setArea] = useState({ w: 0, h: 0 });
  const areaRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setArea({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const libraryMin = minPct(200, area.w, 12);
  const inspectorMin = minPct(290, area.w, 14); // Source in/out lado a lado sem cortes
  const timelineMin = Math.min(75, minPct(TIMELINE_BAR_H + TIMELINE_MIN_H + 2, area.h, 20));
  // Por omissão ~40 %, mas não mais do que as faixas no máximo precisam: em
  // ecrãs altos o resto fica para a pré-visualização
  const timelineDefault = Math.max(timelineMin, Math.min(40, minPct(TIMELINE_BAR_H + TIMELINE_MAX_H + 2, area.h, 0)));

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
        case "f":
        case "F":
          if (!e.altKey) toggleFocus();
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
      <div className="flex items-center gap-1 border-b border-sidebar-border px-2 py-1.5 md:px-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <SidebarTrigger className="size-8" aria-label="Toggle sidebar (Ctrl+B)" />
          </TooltipTrigger>
          <TooltipContent>Toggle sidebar (Ctrl+B)</TooltipContent>
        </Tooltip>
        <Button asChild variant="ghost" size="icon" className="size-8" title="Back to the project">
          <Link href={`/dashboard/${pid}`} aria-label="Back to the project">
            <ArrowLeft />
          </Link>
        </Button>
        <Clapperboard className="ml-1 size-4 shrink-0 text-muted-foreground" />
        <h1 className="truncate text-base font-semibold">
          Video editor{project.data?.name ? ` · ${project.data.name}` : ""}
        </h1>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <span className="mr-1 hidden text-xs text-muted-foreground md:inline">
            {tl.saving ? "Saving…" : "All changes saved"}
          </span>
          <IconButton label="Undo (Ctrl+Z)" onClick={undo} disabled={!tl.canUndo}>
            <Undo2 />
          </IconButton>
          <IconButton label="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!tl.canRedo}>
            <Redo2 />
          </IconButton>
          <div className="mx-1 h-5 w-px bg-border" />
          <IconButton
            label={libraryOpen ? "Hide library" : "Show library"}
            onClick={() => togglePanel(libraryRef.current)}
          >
            <Library />
          </IconButton>
          <IconButton
            label={inspectorOpen ? "Hide clip and export panel" : "Show clip and export panel"}
            onClick={() => togglePanel(inspectorRef.current)}
          >
            <SlidersHorizontal />
          </IconButton>
          <IconButton label={focus ? "Exit focus mode (F)" : "Focus mode (F)"} onClick={toggleFocus}>
            {focus ? <Minimize2 /> : <Maximize2 />}
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
        <div ref={areaRef} className="min-h-0 flex-1">
          {/* os tamanhos iniciais dependem do espaço: os painéis montam depois de o medir */}
          {area.h > 0 && (
            <ResizablePanelGroup direction="vertical" autoSaveId="video-editor-rows" storage={panelStorage}>
              <ResizablePanel id="editor-top" order={1} defaultSize={100 - timelineDefault} minSize={25}>
                <ResizablePanelGroup direction="horizontal" autoSaveId="video-editor-columns" storage={panelStorage}>
                  {/* Biblioteca */}
                  <ResizablePanel
                    id="library"
                    order={1}
                    ref={libraryRef}
                    collapsible
                    collapsedSize={0}
                    defaultSize={Math.max(18, libraryMin)}
                    minSize={libraryMin}
                    maxSize={35}
                    onCollapse={() => setLibraryOpen(false)}
                    onExpand={() => setLibraryOpen(true)}
                  >
                    <VideoUpload
                      uid={uid}
                      pid={pid}
                      token={token}
                      title={`Library (${videoList.length})`}
                      disabled={userType === "anonymous"}
                    >
                      {userType === "anonymous" && (
                        <Alert className="mb-2">
                          <AlertDescription>
                            Anonymous users don&apos;t have access to the video tools.{" "}
                            <Link href="/register" className="underline">
                              Create an account
                            </Link>{" "}
                            to continue.
                          </AlertDescription>
                        </Alert>
                      )}
                      <VideoLibrary
                        videos={videoList}
                        busyIds={busyVideoIds}
                        onAdd={(v) => insert(v._id)}
                        onDelete={remove}
                        onRetryPreview={retryPreview}
                      />
                    </VideoUpload>
                  </ResizablePanel>
                  <ResizableHandle withHandle />

                  {/* Pré-visualização: todo o espaço livre, com a proporção da saída */}
                  <ResizablePanel id="preview" order={2} minSize={30}>
                    <div className="size-full p-2">
                      <TimelinePreview
                        timeline={draft}
                        videos={videos}
                        time={time}
                        duration={duration}
                        playing={playing}
                        onTime={setTime}
                        onPlayingChange={setPlaying}
                        onRetryPreview={retryPreview}
                      />
                    </div>
                  </ResizablePanel>
                  <ResizableHandle withHandle />

                  {/* Clip selecionado e exportação */}
                  <ResizablePanel
                    id="inspector"
                    order={3}
                    ref={inspectorRef}
                    collapsible
                    collapsedSize={0}
                    defaultSize={Math.max(22, inspectorMin)}
                    minSize={inspectorMin}
                    maxSize={40}
                    onCollapse={() => setInspectorOpen(false)}
                    onExpand={() => setInspectorOpen(true)}
                  >
                    <div className="size-full overflow-y-auto p-3">
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
                    </div>
                  </ResizablePanel>
                </ResizablePanelGroup>
              </ResizablePanel>
              <ResizableHandle withHandle />

              {/* Timeline: ferramentas e transporte numa só linha */}
              <ResizablePanel
                id="timeline"
                order={2}
                defaultSize={timelineDefault}
                minSize={timelineMin}
                maxSize={75}
              >
                <div className="flex size-full flex-col">
                  <div className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-b px-2 py-1">
                    <div className="flex items-center gap-1">
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
                    </div>

                    <div className="flex items-center gap-1">
                      <IconButton label="Go to start" onClick={() => seek(0)}>
                        <SkipBack />
                      </IconButton>
                      <IconButton label="Previous frame (←)" onClick={() => seek(time - frame)}>
                        <StepBack />
                      </IconButton>
                      <IconButton
                        label={playing ? "Pause (Space)" : "Play (Space)"}
                        onClick={() => setPlaying(!playing)}
                        disabled={duration === 0}
                      >
                        {playing ? <Pause /> : <Play />}
                      </IconButton>
                      <IconButton label="Next frame (→)" onClick={() => seek(time + frame)}>
                        <StepForward />
                      </IconButton>
                      <IconButton label="Go to end" onClick={() => seek(duration)}>
                        <SkipForward />
                      </IconButton>
                      <TimeField id="playhead" seconds={time} max={duration} onCommit={seek} className="ml-2 w-32" />
                      <span className="whitespace-nowrap font-mono text-xs text-muted-foreground" data-testid="timeline-duration">
                        / {formatTimecode(duration)}
                      </span>
                    </div>

                    <div className="flex items-center justify-end gap-2">
                      <ZoomOut className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <Slider
                        aria-label="Timeline zoom"
                        className="w-24 xl:w-32"
                        min={5}
                        max={200}
                        step={1}
                        value={[zoom]}
                        onValueChange={([z]) => setZoom(z)}
                      />
                      <ZoomIn className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    </div>
                  </div>
                  <div className="min-h-0 flex-1">
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
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          )}
        </div>
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
