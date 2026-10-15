"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioLines, Film, Unlink } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import * as T from "@/lib/timeline";
import { formatDuration, formatTimecode, ProjectVideo } from "@/lib/videos";
import { useWaveform } from "@/lib/queries/videos";
import { VIDEO_DRAG_TYPE } from "./video-library";
import { cn } from "@/lib/utils";

export interface ClipActions {
  split: (linkId: string) => void;
  remove: (linkId: string) => void;
  speed: (linkId: string, speed: number) => void;
  move: (linkId: string, dir: -1 | 1) => void;
  unlink: (linkId: string) => void;
  link: (linkId: string) => void;
}

type View = { left: number; width: number };
type DragMode = "move" | "in" | "out";
type Drag = { mode: DragMode; linkId: string; startX: number; start: number; dx: number; moved: boolean };

const VIDEO_LANE_H = 64; // px (h-16): altura das miniaturas
const RULER_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];

/**
 * Timeline com régua, faixa de vídeo (miniaturas) e de áudio (forma de onda)
 * e playhead. Arrastar um clip move-o; as pontas aparam; o botão direito abre
 * as ações do clip. Os vídeos da biblioteca podem ser largados aqui.
 */
export function Timeline({
  timeline,
  videos,
  time,
  zoom,
  selected,
  onSeek,
  onSelect,
  onEdit,
  onInsert,
  actions,
}: {
  timeline: T.TimelineData;
  videos: Map<string, ProjectVideo>;
  time: number;
  zoom: number; // px por segundo
  selected: string | null;
  onSeek: (t: number) => void;
  onSelect: (linkId: string | null) => void;
  onEdit: (next: T.TimelineData | null, refusal?: string) => void;
  onInsert: (videoId: string, at: number) => void;
  actions: ClipActions;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ left: 0, width: 800 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [seeking, setSeeking] = useState(false);

  // Os handlers dos clips são estáveis (o componente das faixas não volta a
  // desenhar a cada fotograma) e leem sempre os valores mais recentes
  const latest = useRef({ timeline, videos, zoom, actions, onEdit, onSelect });
  latest.current = { timeline, videos, zoom, actions, onEdit, onSelect };
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  const durationOf = useCallback((id: string) => latest.current.videos.get(id)?.duration ?? 0, []);

  // Parte visível (só se desenham as marcas e as miniaturas à vista)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setView({ left: el.scrollLeft, width: el.clientWidth });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, []);

  // Manter o playhead à vista (a tocar, ou depois de saltar para outro sítio)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || drag || seeking) return;
    const x = time * zoom;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 24) el.scrollLeft = Math.max(0, x - 48);
  }, [time, zoom, drag, seeking]);

  const timeAt = useCallback((clientX: number) => {
    const rect = contentRef.current?.getBoundingClientRect();
    return rect ? Math.max(0, (clientX - rect.left) / latest.current.zoom) : 0;
  }, []);

  // ---------------------------------------------------------- arrastar clips

  const startDrag = useCallback((e: React.PointerEvent, linkId: string, mode: DragMode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    latest.current.onSelect(linkId);
    const group = T.groupClips(latest.current.timeline, linkId);
    const start = Math.min(...group.map((c) => c.posicao));
    setDrag({ mode, linkId, startX: e.clientX, start, dx: 0, moved: false });
  }, []);

  const dragResult = useCallback(
    (d: Drag) => {
      const { timeline: t, zoom: z } = latest.current;
      const delta = d.dx / z;
      if (d.mode === "move") return T.move(t, d.linkId, d.start + delta);
      return T.trim(t, d.linkId, d.mode, delta, durationOf)?.timeline ?? null;
    },
    [durationOf],
  );

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) =>
      setDrag((d) => d && { ...d, dx: e.clientX - d.startX, moved: d.moved || Math.abs(e.clientX - d.startX) > 3 });
    const up = () => {
      const d = dragRef.current;
      if (d?.moved) {
        latest.current.onEdit(
          dragResult(d),
          d.mode === "move" ? "There is no free space there for this clip." : undefined,
        );
      }
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    // só (re)liga ao começar um arrasto
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.linkId, drag?.mode, drag?.startX, dragResult]);

  // Durante o arrasto mostra-se o resultado (com o ripple) em tempo real
  const shown = useMemo(
    () => (drag?.moved ? (dragResult(drag) ?? timeline) : timeline),
    [drag, timeline, dragResult],
  );

  // ---------------------------------------------------------------- seek

  useEffect(() => {
    if (!seeking) return;
    const move = (e: PointerEvent) => onSeek(timeAt(e.clientX));
    const up = () => setSeeking(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [seeking, onSeek, timeAt]);

  const startSeek = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    onSeek(timeAt(e.clientX));
    setSeeking(true);
  };

  // ------------------------------------------------------------------ desenho

  const stableActions = useMemo<ClipActions>(
    () => ({
      split: (id) => latest.current.actions.split(id),
      remove: (id) => latest.current.actions.remove(id),
      speed: (id, s) => latest.current.actions.speed(id, s),
      move: (id, dir) => latest.current.actions.move(id, dir),
      unlink: (id) => latest.current.actions.unlink(id),
      link: (id) => latest.current.actions.link(id),
    }),
    [],
  );
  const select = useCallback((id: string | null) => latest.current.onSelect(id), []);

  const end = Math.max(0, ...shown.faixas.flatMap((f) => f.clips.map(T.clipEnd)));
  const width = Math.max((end + 10) * zoom, view.width);
  const empty = shown.faixas.every((f) => f.clips.length === 0);

  return (
    <div className="flex select-none text-xs">
      <div className="w-10 shrink-0 border-r bg-sidebar text-muted-foreground">
        <div className="h-6 border-b" />
        <div className="flex h-16 items-center justify-center gap-0.5 border-b" title="Video track">
          <Film className="size-3.5" /> V1
        </div>
        <div className="flex h-12 items-center justify-center gap-0.5" title="Audio track">
          <AudioLines className="size-3.5" /> A1
        </div>
      </div>

      <div ref={scrollRef} className="relative flex-1 overflow-x-auto overflow-y-hidden">
        <div
          ref={contentRef}
          className="relative"
          style={{ width }}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(VIDEO_DRAG_TYPE)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDropAt(T.nearestInsertionPoint(timeline, timeAt(e.clientX)));
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null);
          }}
          onDrop={(e) => {
            const id = e.dataTransfer.getData(VIDEO_DRAG_TYPE);
            setDropAt(null);
            if (!id) return;
            e.preventDefault();
            onInsert(id, T.nearestInsertionPoint(timeline, timeAt(e.clientX)));
          }}
        >
          <Ruler zoom={zoom} view={view} onPointerDown={startSeek} />

          <Lanes
            timeline={shown}
            videos={videos}
            zoom={zoom}
            view={view}
            selected={selected}
            onClipPointerDown={startDrag}
            onSelect={select}
            actions={stableActions}
            onBackgroundPointerDown={(e) => {
              if (e.target !== e.currentTarget) return;
              select(null);
              startSeek(e);
            }}
          />

          {empty && (
            <p className="pointer-events-none absolute inset-x-0 top-6 flex h-28 items-center justify-center text-sm text-muted-foreground">
              Drag videos here, or use + in the library.
            </p>
          )}

          {dropAt !== null && (
            <div className="pointer-events-none absolute bottom-0 top-6 w-0.5 bg-primary" style={{ left: dropAt * zoom }} />
          )}

          <div className="pointer-events-none absolute bottom-0 top-0 w-px bg-destructive" style={{ left: time * zoom }}>
            <div className="absolute -left-1 top-0 h-2 w-2 rounded-sm bg-destructive" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- régua

function rulerLabel(t: number, step: number) {
  if (step >= 1) return formatDuration(t);
  return `${formatDuration(Math.floor(t))}.${Math.round((t % 1) * 10) % 10}`;
}

const Ruler = memo(function Ruler({
  zoom,
  view,
  onPointerDown,
}: {
  zoom: number;
  view: View;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  const step = RULER_STEPS.find((s) => s * zoom >= 80) ?? RULER_STEPS[RULER_STEPS.length - 1];
  const first = Math.floor(view.left / zoom / step);
  const last = Math.ceil((view.left + view.width) / zoom / step);
  const ticks = [];
  for (let k = Math.max(0, first); k <= last; k++) ticks.push(k * step);

  return (
    <div className="relative h-6 cursor-pointer border-b bg-sidebar" onPointerDown={onPointerDown} title="Click or drag to move the playhead">
      {ticks.map((t) => (
        <span
          key={k(t)}
          className="absolute top-0 h-full border-l border-border pl-1 font-mono text-[10px] leading-6 text-muted-foreground"
          style={{ left: t * zoom }}
        >
          {rulerLabel(t, step)}
        </span>
      ))}
    </div>
  );
});

const k = (t: number) => t.toFixed(3);

// ---------------------------------------------------------------- faixas

const Lanes = memo(function Lanes({
  timeline,
  videos,
  zoom,
  view,
  selected,
  onClipPointerDown,
  onSelect,
  onBackgroundPointerDown,
  actions,
}: {
  timeline: T.TimelineData;
  videos: Map<string, ProjectVideo>;
  zoom: number;
  view: View;
  selected: string | null;
  onClipPointerDown: (e: React.PointerEvent, linkId: string, mode: DragMode) => void;
  onSelect: (linkId: string | null) => void;
  onBackgroundPointerDown: (e: React.PointerEvent) => void;
  actions: ClipActions;
}) {
  return (
    <>
      {(["video", "audio"] as const).map((tipo) => (
        <div
          key={tipo}
          className={cn("relative", tipo === "video" ? "h-16 border-b" : "h-12")}
          onPointerDown={onBackgroundPointerDown}
        >
          {T.track(timeline, tipo)?.clips.map((clip) => {
            const video = videos.get(clip.video_id);
            const groupSize = T.groupClips(timeline, clip.link_id).length;
            return (
              <ClipBlock
                key={clip.link_id}
                clip={clip}
                tipo={tipo}
                video={video}
                zoom={zoom}
                view={view}
                selected={clip.link_id === selected}
                // um clip sozinho que podia ter par (áudio, ou vídeo com áudio) está desligado
                unlinked={groupSize === 1 && (tipo === "audio" || !!video?.hasAudio)}
                canLink={groupSize === 1 && !!T.linkCandidate(timeline, clip.link_id)}
                groupSize={groupSize}
                onPointerDown={onClipPointerDown}
                onSelect={onSelect}
                actions={actions}
              />
            );
          })}
        </div>
      ))}
    </>
  );
});

function ClipBlock({
  clip,
  tipo,
  video,
  zoom,
  view,
  selected,
  unlinked,
  canLink,
  groupSize,
  onPointerDown,
  onSelect,
  actions,
}: {
  clip: T.Clip;
  tipo: T.TrackType;
  video: ProjectVideo | undefined;
  zoom: number;
  view: View;
  selected: boolean;
  unlinked: boolean;
  canLink: boolean;
  groupSize: number;
  onPointerDown: (e: React.PointerEvent, linkId: string, mode: DragMode) => void;
  onSelect: (linkId: string | null) => void;
  actions: ClipActions;
}) {
  const left = clip.posicao * zoom;
  const width = Math.max(2, T.clipDuration(clip) * zoom);
  const id = clip.link_id;
  const name = video?.name ?? "Missing video";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          aria-pressed={selected}
          aria-label={`${tipo === "video" ? "Video" : "Audio"} clip ${name}, from ${formatTimecode(clip.posicao)} to ${formatTimecode(T.clipEnd(clip))}`}
          className={cn(
            "absolute bottom-0.5 top-0.5 cursor-grab overflow-hidden rounded-md border outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-ring",
            tipo === "video" ? "border-primary/40 bg-primary/15" : "border-border bg-secondary",
            selected && "ring-2 ring-primary",
          )}
          style={{ left, width }}
          onPointerDown={(e) => onPointerDown(e, id, "move")}
          onContextMenu={() => onSelect(id)}
          onFocus={() => onSelect(id)}
        >
          {tipo === "video" ? (
            <Thumbnails clip={clip} video={video} zoom={zoom} left={left} view={view} />
          ) : (
            <WaveformView clip={clip} video={video} />
          )}

          <span className="pointer-events-none absolute left-1.5 top-0.5 flex max-w-[calc(100%-0.75rem)] items-center gap-1 rounded bg-background/80 px-1 text-[10px] font-medium">
            {unlinked && <Unlink className="size-3 shrink-0" aria-label="Unlinked" />}
            <span className="truncate">{name}</span>
            {clip.speed !== 1 && <span className="shrink-0 text-muted-foreground">{clip.speed}×</span>}
          </span>

          {/* pontas para aparar */}
          <span
            className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize hover:bg-primary/50"
            onPointerDown={(e) => onPointerDown(e, id, "in")}
            aria-hidden
          />
          <span
            className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize hover:bg-primary/50"
            onPointerDown={(e) => onPointerDown(e, id, "out")}
            aria-hidden
          />
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent className="w-56">
        <ContextMenuItem onSelect={() => actions.split(id)}>
          Split at playhead <ContextMenuShortcut>S</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.remove(id)}>
          Delete <ContextMenuShortcut>Del</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>Speed</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuRadioGroup value={String(clip.speed)} onValueChange={(v) => actions.speed(id, Number(v))}>
              {T.SPEEDS.map((s) => (
                <ContextMenuRadioItem key={s} value={String(s)}>
                  {s}×
                </ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem onSelect={() => actions.move(id, -1)}>
          Move left <ContextMenuShortcut>Alt+←</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.move(id, 1)}>
          Move right <ContextMenuShortcut>Alt+→</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        {groupSize > 1 ? (
          <ContextMenuItem onSelect={() => actions.unlink(id)}>Unlink audio and video</ContextMenuItem>
        ) : (
          <ContextMenuItem disabled={!canLink} onSelect={() => actions.link(id)}>
            Link audio and video
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ------------------------------------------------- miniaturas e forma de onda

// Recorta as miniaturas do sprite; só desenha as que estão à vista
function Thumbnails({
  clip,
  video,
  zoom,
  left,
  view,
}: {
  clip: T.Clip;
  video: ProjectVideo | undefined;
  zoom: number;
  left: number;
  view: View;
}) {
  const sprite = video?.preview.sprite;
  const url = video?.preview.spriteUrl;
  if (!sprite || !url) return null;

  const tileW = sprite.width * (VIDEO_LANE_H / sprite.height);
  const width = T.clipDuration(clip) * zoom;
  const rows = Math.ceil(sprite.count / sprite.cols);
  const from = Math.max(0, Math.floor((view.left - left) / tileW) - 1);
  const to = Math.min(Math.ceil(width / tileW), Math.ceil((view.left + view.width - left) / tileW) + 1);

  const tiles = [];
  for (let i = from; i < to; i++) {
    const t = clip.in + ((i * tileW) / zoom) * clip.speed;
    const idx = Math.min(sprite.count - 1, Math.max(0, Math.floor(t / sprite.interval)));
    const sx = (idx % sprite.cols) * sprite.width;
    const sy = Math.floor(idx / sprite.cols) * sprite.height;
    tiles.push(
      <svg
        key={i}
        x={i * tileW}
        width={tileW}
        height={VIDEO_LANE_H}
        viewBox={`${sx} ${sy} ${sprite.width} ${sprite.height}`}
        preserveAspectRatio="none"
      >
        <image href={url} width={sprite.cols * sprite.width} height={rows * sprite.height} />
      </svg>,
    );
  }

  return (
    <svg className="pointer-events-none absolute left-0 top-0 opacity-90" width={width} height={VIDEO_LANE_H} aria-hidden>
      {tiles}
    </svg>
  );
}

function WaveformView({ clip, video }: { clip: T.Clip; video: ProjectVideo | undefined }) {
  const { data } = useWaveform(clip.video_id, video?.preview.waveformUrl ?? null);

  // Área preenchida (picos acima e abaixo do centro) do troço [in, out]
  const shape = useMemo(() => {
    if (!data) return null;
    const a = Math.floor(clip.in * data.rate);
    const b = Math.min(data.peaks.length, Math.ceil(clip.out * data.rate));
    if (b <= a) return null;
    const peaks = data.peaks.slice(a, b).map((p) => Math.max(2, p) / 2);
    const top = peaks.map((p, i) => `${i + 0.5},${50 - p}`);
    const bottom = peaks.map((p, i) => `${i + 0.5},${50 + p}`).reverse();
    return { n: peaks.length, d: `M0,50L${top.join("L")}L${peaks.length},50L${bottom.join("L")}Z` };
  }, [data, clip.in, clip.out]);

  if (!shape) return null;
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full text-primary/60"
      viewBox={`0 0 ${shape.n} 100`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <path d={shape.d} fill="currentColor" />
    </svg>
  );
}
