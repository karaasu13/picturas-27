"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Pause, Play, RotateCw, SkipBack, SkipForward, StepBack, StepForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TimeField } from "./time-field";
import * as T from "@/lib/timeline";
import { formatTimecode, ProjectVideo } from "@/lib/videos";
import { cn } from "@/lib/utils";

/**
 * Pré-visualização da timeline sem render: um <video> (sem som) segue a
 * faixa de vídeo e um <audio> segue a faixa de áudio, ambos sobre os proxies
 * e guiados por um relógio próprio. A velocidade de cada clip usa
 * playbackRate com preservesPitch (como o atempo do render).
 */
export function TimelinePreview({
  timeline,
  videos,
  time,
  duration,
  frame,
  playing,
  onTime,
  onPlayingChange,
  onRetryPreview,
}: {
  timeline: T.TimelineData;
  videos: Map<string, ProjectVideo>;
  time: number;
  duration: number;
  frame: number; // 1/fps
  playing: boolean;
  onTime: (t: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onRetryPreview: (video: ProjectVideo) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const clock = useRef({ wall: 0, t: 0 });
  const lastTick = useRef(0);

  // A moldura tem a proporção da saída e o maior tamanho que cabe na área
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Relógio da reprodução
  useEffect(() => {
    if (!playing) return;
    const from = time >= duration - 0.01 ? 0 : time; // no fim, recomeça do início
    clock.current = { wall: performance.now(), t: from };
    lastTick.current = from;
    let raf = 0;
    const tick = () => {
      const t = clock.current.t + (performance.now() - clock.current.wall) / 1000;
      if (t >= duration) {
        onTime(duration);
        onPlayingChange(false);
        return;
      }
      lastTick.current = t;
      onTime(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // só arranca/para com o play; os saltos tratam-se abaixo
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // Saltar para outro instante a meio da reprodução: o relógio segue o salto
  useEffect(() => {
    if (playing && Math.abs(time - lastTick.current) > 0.05) {
      clock.current = { wall: performance.now(), t: time };
      lastTick.current = time;
    }
  }, [time, playing]);

  // Cada elemento mostra o clip da sua faixa no instante atual
  useEffect(() => {
    sync(videoRef.current, T.track(timeline, "video"), time, playing, videos);
    sync(audioRef.current, T.track(timeline, "audio"), time, playing, videos);
  }, [time, playing, timeline, videos]);

  const clip = T.clipAt(T.track(timeline, "video"), time);
  const source = clip ? videos.get(clip.video_id) : undefined;
  const ready = !!source?.preview.proxyUrl;
  const { largura, altura, fit } = timeline.output;
  const scale = Math.min(box.w / largura, box.h / altura) || 0;

  const seek = (t: number) => onTime(Math.min(Math.max(0, t), duration));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div ref={boxRef} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <div
          className="relative overflow-hidden rounded-md bg-black"
          style={{ width: largura * scale, height: altura * scale }}
        >
          <video
            ref={videoRef}
            muted
            playsInline
            preload="auto"
            className={cn(
              "absolute inset-0 h-full w-full",
              fit === "crop" ? "object-cover" : "object-contain",
              (!clip || !ready) && "invisible",
            )}
          />
          <audio ref={audioRef} preload="auto" />

          {clip && !ready && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-sm text-white/80">
              {source?.preview.state === "pending" ? (
                <>
                  <LoaderCircle className="size-5 animate-spin" /> Preparing preview…
                </>
              ) : (
                <>
                  <span>Preview unavailable for {source?.name ?? "this video"}.</span>
                  {source && (
                    <Button size="sm" variant="secondary" onClick={() => onRetryPreview(source)}>
                      <RotateCw /> Retry
                    </Button>
                  )}
                </>
              )}
            </div>
          )}
          {duration === 0 && (
            <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-white/70">
              Add a video to the timeline to preview it here.
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-1">
        <TransportButton label="Go to start" onClick={() => seek(0)}>
          <SkipBack />
        </TransportButton>
        <TransportButton label="Previous frame (←)" onClick={() => seek(time - frame)}>
          <StepBack />
        </TransportButton>
        <TransportButton
          label={playing ? "Pause (Space)" : "Play (Space)"}
          onClick={() => onPlayingChange(!playing)}
          disabled={duration === 0}
        >
          {playing ? <Pause /> : <Play />}
        </TransportButton>
        <TransportButton label="Next frame (→)" onClick={() => seek(time + frame)}>
          <StepForward />
        </TransportButton>
        <TransportButton label="Go to end" onClick={() => seek(duration)}>
          <SkipForward />
        </TransportButton>

        <TimeField id="playhead" seconds={time} max={duration} onCommit={seek} className="ml-2 w-32" />
        <span className="font-mono text-xs text-muted-foreground">/ {formatTimecode(duration)}</span>
      </div>
    </div>
  );
}

function TransportButton({
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
        <Button variant="ghost" size="icon" className="size-8" aria-label={label} onClick={onClick} disabled={disabled}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function sync(
  el: HTMLMediaElement | null,
  f: T.Track | undefined,
  t: number,
  playing: boolean,
  videos: Map<string, ProjectVideo>,
) {
  if (!el) return;
  const clip = T.clipAt(f, t);
  const url = clip ? videos.get(clip.video_id)?.preview.proxyUrl : null;
  if (!clip || !url) {
    if (!el.paused) el.pause();
    return;
  }

  if (el.getAttribute("src") !== url) el.src = url;
  const target = T.sourceTime(clip, t);
  el.playbackRate = clip.speed;
  el.preservesPitch = true;

  if (playing) {
    if (el.paused) {
      el.currentTime = target;
      el.play().catch(() => {});
    } else if (Math.abs(el.currentTime - target) > 0.15) {
      // desfasado do relógio (mudou de clip ou atrasou-se): acertar
      el.currentTime = target;
    }
  } else {
    if (!el.paused) el.pause();
    if (Math.abs(el.currentTime - target) > 0.01) el.currentTime = target;
  }
}
