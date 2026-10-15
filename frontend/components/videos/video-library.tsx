"use client";

import { AlertTriangle, Clapperboard, Film, LoaderCircle, Plus, RotateCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { formatBytes, formatDuration, ProjectVideo } from "@/lib/videos";

// Tipo usado no drag & drop da biblioteca para a timeline
export const VIDEO_DRAG_TYPE = "application/x-picturas-video";

export function VideoLibrary({
  videos,
  busyIds,
  onAdd,
  onDelete,
  onRetryPreview,
}: {
  videos: ProjectVideo[];
  busyIds: Set<string>;
  onAdd: (video: ProjectVideo) => void;
  onDelete: (video: ProjectVideo) => void;
  onRetryPreview: (video: ProjectVideo) => void;
}) {
  if (videos.length === 0) {
    return <p className="text-sm text-muted-foreground px-1">No videos yet. Drop files here or use Upload.</p>;
  }

  return (
    <ul className="flex flex-col gap-1">
      {videos.map((video) => {
        const busy = busyIds.has(video._id);
        const state = video.preview.state;
        return (
          <li key={video._id}>
            <div
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(VIDEO_DRAG_TYPE, video._id);
                e.dataTransfer.effectAllowed = "copy";
              }}
              className="group flex items-center gap-2 rounded-md border px-2 py-1.5 cursor-grab active:cursor-grabbing hover:bg-sidebar"
              title="Drag to the timeline"
            >
              {video.source === "render" ? (
                <Clapperboard className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <Film className="size-4 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{video.name}</span>
                  {video.source === "render" && (
                    <Badge variant="secondary" className="shrink-0">
                      Export
                    </Badge>
                  )}
                </div>
                <span className="block truncate text-xs text-muted-foreground">
                  {formatDuration(video.duration)} · {video.width}×{video.height} · {formatBytes(video.size)}
                </span>
                {state === "pending" && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <LoaderCircle className="size-3 animate-spin" /> Preparing preview…
                  </span>
                )}
                {(state === "failed" || state === "missing") && (
                  <button
                    type="button"
                    className="flex items-center gap-1 text-xs text-destructive hover:underline"
                    onClick={() => onRetryPreview(video)}
                  >
                    <AlertTriangle className="size-3" />
                    {state === "failed" ? "Preview failed" : "No preview"} · Retry
                    <RotateCw className="size-3" />
                  </button>
                )}
              </div>

              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                title="Add to timeline"
                aria-label={`Add ${video.name} to the timeline`}
                onClick={() => onAdd(video)}
              >
                <Plus />
              </Button>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0 text-muted-foreground"
                    title={busy ? "Used by an export in progress" : "Delete video"}
                    aria-label={`Delete ${video.name}`}
                    disabled={busy}
                  >
                    <Trash2 />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete video?</AlertDialogTitle>
                    <AlertDialogDescription>
                      &quot;{video.name}&quot; will be removed from the project. This can&apos;t be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => onDelete(video)}>Delete</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
