"use client";

import { ArrowLeft, ArrowRight, Link2, Scissors, Trash2, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TimeField } from "./time-field";
import type { ClipActions } from "./timeline";
import * as T from "@/lib/timeline";
import { formatTimecode, ProjectVideo } from "@/lib/videos";

/** Detalhes e ações do clip (grupo) selecionado. */
export function ClipInspector({
  timeline,
  videos,
  linkId,
  actions,
  onTrim,
}: {
  timeline: T.TimelineData;
  videos: Map<string, ProjectVideo>;
  linkId: string | null;
  actions: ClipActions;
  onTrim: (linkId: string, edge: "in" | "out", delta: number) => void;
}) {
  const group = linkId ? T.groupClips(timeline, linkId) : [];
  if (!linkId || group.length === 0) {
    return (
      <p className="px-1 text-sm text-muted-foreground">
        Select a clip on the timeline to edit it. Right-click a clip for more actions.
      </p>
    );
  }

  const clip = group[0];
  const video = videos.get(clip.video_id);
  const tracks = new Set(timeline.faixas.filter((f) => f.clips.some((c) => c.link_id === linkId)).map((f) => f.tipo));
  const kind = tracks.size > 1 ? "Video + audio (linked)" : tracks.has("video") ? "Video only" : "Audio only";
  const canLink = group.length === 1 && !!T.linkCandidate(timeline, linkId);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="truncate font-semibold" title={video?.name}>
          {video?.name ?? "Missing video"}
        </h3>
        <p className="text-xs text-muted-foreground">{kind}</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <TimeField
          id="clip-in"
          label="Source in"
          seconds={clip.in}
          max={clip.out - T.MIN_CLIP * clip.speed}
          onCommit={(v) => onTrim(linkId, "in", (v - clip.in) / clip.speed)}
        />
        <TimeField
          id="clip-out"
          label="Source out"
          seconds={clip.out}
          min={clip.in + T.MIN_CLIP * clip.speed}
          max={video?.duration}
          onCommit={(v) => onTrim(linkId, "out", (v - clip.out) / clip.speed)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="clip-speed">Speed</Label>
        <Select value={String(clip.speed)} onValueChange={(v) => actions.speed(linkId, Number(v))}>
          <SelectTrigger id="clip-speed" className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {T.SPEEDS.map((s) => (
              <SelectItem key={s} value={String(s)}>
                {s}×{s === 1 ? " (normal)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Starts at</dt>
        <dd className="font-mono">{formatTimecode(clip.posicao)}</dd>
        <dt className="text-muted-foreground">Length on timeline</dt>
        <dd className="font-mono">{formatTimecode(T.clipDuration(clip))}</dd>
      </dl>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" size="sm" onClick={() => actions.split(linkId)}>
          <Scissors /> Split
        </Button>
        <Button variant="outline" size="sm" onClick={() => actions.remove(linkId)}>
          <Trash2 /> Delete
        </Button>
        <Button variant="outline" size="sm" onClick={() => actions.move(linkId, -1)}>
          <ArrowLeft /> Move left
        </Button>
        <Button variant="outline" size="sm" onClick={() => actions.move(linkId, 1)}>
          <ArrowRight /> Move right
        </Button>
        {group.length > 1 ? (
          <Button variant="outline" size="sm" className="col-span-2" onClick={() => actions.unlink(linkId)}>
            <Unlink /> Unlink audio and video
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="col-span-2"
            disabled={!canLink}
            title={canLink ? undefined : "Only clips aligned with an unlinked clip on the other track can be linked"}
            onClick={() => actions.link(linkId)}
          >
            <Link2 /> Link audio and video
          </Button>
        )}
      </div>
    </div>
  );
}
