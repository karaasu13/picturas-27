"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LoaderCircle, Upload } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { VideoTaskList } from "./video-task-list";
import * as T from "@/lib/timeline";
import { EXPORT_LIMITS, formatTimecode, ProjectVideo, VIDEO_RULES, VideoTask } from "@/lib/videos";

type UserType = "anonymous" | "free" | "premium";

const PRESETS = [
  { w: 3840, h: 2160, label: "2160p (4K) · 3840×2160" },
  { w: 2560, h: 1440, label: "1440p · 2560×1440" },
  { w: 1920, h: 1080, label: "1080p · 1920×1080" },
  { w: 1280, h: 720, label: "720p · 1280×720" },
  { w: 854, h: 480, label: "480p · 854×480" },
  { w: 1080, h: 1920, label: "Vertical · 1080×1920" },
  { w: 1080, h: 1080, label: "Square · 1080×1080" },
];

const limitsFor = (userType: UserType) => (userType === "premium" ? EXPORT_LIMITS.premium : EXPORT_LIMITS.free);

const fits = (w: number, h: number, userType: UserType) => {
  const l = limitsFor(userType);
  return Math.max(w, h) <= l.maxLong && Math.min(w, h) <= l.maxShort;
};

/** Mesmas regras da exportação no backend, para avisar antes de exportar. */
function exportBlocker(
  userType: UserType,
  duration: number,
  output: T.Output,
  sourceCount: number,
  remainingOperations: number | null | undefined,
) {
  if (userType === "anonymous") {
    return "Anonymous users don't have access to the video tools. Create an account to continue.";
  }
  if (duration === 0) return "Add at least one video clip to the timeline before exporting.";
  if (duration < VIDEO_RULES.minResult) {
    return "The exported video is too short. The final result must be at least 5 seconds long.";
  }
  const limits = limitsFor(userType);
  if (duration > limits.maxDuration) {
    return "Registered accounts can export videos up to 10 minutes long. Shorten the timeline or upgrade to Premium.";
  }
  if (!fits(output.largura, output.altura, userType)) {
    return "Registered accounts can export up to 1080p (1920×1080). Choose a lower resolution or upgrade to Premium.";
  }
  if (sourceCount > limits.maxSources) {
    return userType === "premium"
      ? "An export can use up to 20 different videos. Remove clips from some videos and try again."
      : "Registered accounts can use up to 5 different videos in one export. Remove clips from some videos or upgrade to Premium.";
  }
  if (userType === "free" && remainingOperations === 0) {
    return "You have reached the limit of 5 daily operations of the free plan. Upgrade to Premium to continue.";
  }
  return null;
}

export function ExportPanel({
  timeline,
  videos,
  userType,
  remainingOperations,
  exporting,
  onOutputChange,
  onExport,
  tasks,
  cancellingId,
  onCancelTask,
}: {
  timeline: T.TimelineData;
  videos: Map<string, ProjectVideo>;
  userType: UserType;
  remainingOperations: number | null | undefined;
  exporting: boolean;
  onOutputChange: (output: T.Output) => void;
  onExport: () => void;
  tasks: VideoTask[];
  cancellingId: string | null;
  onCancelTask: (task: VideoTask) => void;
}) {
  const { output } = timeline;
  const set = (patch: Partial<T.Output>) => onOutputChange({ ...output, ...patch });

  const duration = T.timelineDuration(timeline);
  const sourceCount = new Set(timeline.faixas.flatMap((f) => f.clips.map((c) => c.video_id))).size;
  const blocker = exportBlocker(userType, duration, output, sourceCount, remainingOperations);

  const preset = PRESETS.find((p) => p.w === output.largura && p.h === output.altura);
  const first = T.track(timeline, "video")?.clips[0];
  const sourceFormat = first ? videos.get(first.video_id)?.format : undefined;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="export-format">Format</Label>
        <Select value={output.formato} onValueChange={(v) => set({ formato: v as T.Formato })}>
          <SelectTrigger id="export-format" className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="mp4">MP4</SelectItem>
            <SelectItem value="mov">MOV</SelectItem>
            <SelectItem value="avi">AVI</SelectItem>
          </SelectContent>
        </Select>
        {sourceFormat && (
          <p className="text-xs text-muted-foreground">
            {sourceFormat === output.formato
              ? "Keeps the video codec of the source."
              : `Converted to H.264 + ${output.formato === "avi" ? "MP3" : "AAC"}.`}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="export-size">Resolution</Label>
        <Select
          value={preset ? `${preset.w}x${preset.h}` : "custom"}
          onValueChange={(v) => {
            const p = PRESETS.find((x) => `${x.w}x${x.h}` === v);
            if (p) set({ largura: p.w, altura: p.h });
          }}
        >
          <SelectTrigger id="export-size" className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRESETS.map((p) => {
              const allowed = fits(p.w, p.h, userType);
              return (
                <SelectItem key={p.label} value={`${p.w}x${p.h}`} disabled={!allowed}>
                  {p.label}
                  {!allowed && " · Premium"}
                </SelectItem>
              );
            })}
            {!preset && <SelectItem value="custom">Custom · {output.largura}×{output.altura}</SelectItem>}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <SizeInput label="Width" value={output.largura} onCommit={(largura) => set({ largura })} />
          <span className="text-muted-foreground">×</span>
          <SizeInput label="Height" value={output.altura} onCommit={(altura) => set({ altura })} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="export-quality">Quality</Label>
          <Select value={output.qualidade} onValueChange={(v) => set({ qualidade: v as T.Qualidade })}>
            <SelectTrigger id="export-quality" className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="alta">High</SelectItem>
              <SelectItem value="media">Medium</SelectItem>
              <SelectItem value="baixa">Low</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="export-fit">Reframe</Label>
          <Select value={output.fit} onValueChange={(v) => set({ fit: v as T.Fit })}>
            <SelectTrigger id="export-fit" className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pad">Fit (black bars)</SelectItem>
              <SelectItem value="crop">Fill (crop)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Final duration</dt>
        <dd className="font-mono">{formatTimecode(duration)}</dd>
        <dt className="text-muted-foreground">Videos used</dt>
        <dd>
          {sourceCount} of {limitsFor(userType).maxSources}
        </dd>
      </dl>

      {blocker && (
        <Alert variant="destructive">
          <AlertDescription>
            {blocker}{" "}
            {userType === "free" && (
              <Link href="/dashboard/account/upgrade" className="underline">
                See Premium
              </Link>
            )}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-1">
        <Button onClick={onExport} disabled={!!blocker || exporting}>
          {exporting ? <LoaderCircle className="animate-spin" /> : <Upload />}
          Export
        </Button>
        {userType === "free" && typeof remainingOperations === "number" && (
          <p className="text-xs text-muted-foreground">
            Uses 1 of the {remainingOperations} operations you have left today (refunded if it fails or you cancel).
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="px-1 text-sm font-semibold text-muted-foreground">Exports</h3>
        <VideoTaskList tasks={tasks} videos={videos} cancellingId={cancellingId} onCancel={onCancelTask} />
      </div>
    </div>
  );
}

// Largura/altura livre: par, entre 16 e 4096 (aplicada com Enter ou ao sair)
function SizeInput({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);

  function commit() {
    const n = Math.min(4096, Math.max(16, Math.round(Number(text) / 2) * 2));
    if (!Number.isFinite(n)) return setText(String(value));
    setText(String(n));
    if (n !== value) onCommit(n);
  }

  return (
    <Input
      aria-label={label}
      inputMode="numeric"
      className="h-8 font-mono"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}
