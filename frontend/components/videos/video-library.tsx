"use client";

import { Film, Scissors, Trash2 } from "lucide-react";
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
import { cn } from "@/lib/utils";

export function VideoLibrary({
  videos,
  selectedId,
  busyIds,
  onSelect,
  onDelete,
}: {
  videos: ProjectVideo[];
  selectedId: string | null;
  busyIds: Set<string>;
  onSelect: (video: ProjectVideo) => void;
  onDelete: (video: ProjectVideo) => void;
}) {
  if (videos.length === 0) {
    return (
      <p className="text-sm text-muted-foreground px-1">
        Ainda não há vídeos neste projeto.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1">
      {videos.map((video) => {
        const selected = video._id === selectedId;
        const busy = busyIds.has(video._id);
        return (
          <li key={video._id}>
            <div
              className={cn(
                "group flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors",
                selected ? "border-primary bg-primary/5" : "hover:bg-sidebar",
              )}
            >
              <button
                type="button"
                className="flex flex-1 min-w-0 items-center gap-3 text-left"
                onClick={() => onSelect(video)}
              >
                {video.source === "cut" ? (
                  <Scissors className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <Film className="size-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{video.name}</span>
                    {video.source === "cut" && (
                      <Badge variant="secondary" className="shrink-0">
                        Corte
                      </Badge>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {formatDuration(video.duration)} · {video.width}×{video.height} ·{" "}
                    {formatBytes(video.size)}
                  </span>
                </div>
              </button>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0 text-muted-foreground"
                    title={busy ? "Tem uma tarefa em curso" : "Remover vídeo"}
                    disabled={busy}
                  >
                    <Trash2 />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Remover vídeo?</AlertDialogTitle>
                    <AlertDialogDescription>
                      O vídeo &quot;{video.name}&quot; é apagado do projeto. Esta ação não pode ser
                      desfeita.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancelar</AlertDialogCancel>
                    <AlertDialogAction onClick={() => onDelete(video)}>Remover</AlertDialogAction>
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
