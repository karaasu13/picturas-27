"use client";

import { Ban, CircleCheck, CircleX, Clock, LoaderCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ACTIVE_TASK_STATES,
  formatTimecode,
  TASK_STATE_LABELS,
  VideoTask,
  VideoTaskState,
} from "@/lib/videos";
import { cn } from "@/lib/utils";

const STATE_STYLE: Record<VideoTaskState, { icon: React.ReactNode; className: string }> = {
  queued: { icon: <Clock className="size-3.5" />, className: "text-muted-foreground" },
  processing: {
    icon: <LoaderCircle className="size-3.5 animate-spin" />,
    className: "text-primary",
  },
  done: {
    icon: <CircleCheck className="size-3.5" />,
    className: "text-green-600 dark:text-green-500",
  },
  failed: { icon: <CircleX className="size-3.5" />, className: "text-destructive" },
  cancelled: { icon: <Ban className="size-3.5" />, className: "text-muted-foreground" },
};

export function VideoTaskList({
  tasks,
  cancellingId,
  onCancel,
  onOpenResult,
}: {
  tasks: VideoTask[];
  cancellingId: string | null;
  onCancel: (task: VideoTask) => void;
  onOpenResult: (task: VideoTask) => void;
}) {
  if (tasks.length === 0) {
    return <p className="text-sm text-muted-foreground px-1">Ainda não há tarefas.</p>;
  }

  return (
    <ul className="flex flex-col gap-1">
      {tasks.map((task) => {
        const style = STATE_STYLE[task.state];
        const active = ACTIVE_TASK_STATES.includes(task.state);
        return (
          <li key={task._id} className="rounded-lg border px-3 py-2 flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span
                className={cn("inline-flex items-center gap-1 text-xs font-medium shrink-0", style.className)}
              >
                {style.icon}
                {TASK_STATE_LABELS[task.state]}
              </span>
              <span className="truncate text-sm flex-1" title={task.videoName}>
                {task.videoName}
              </span>
              {active && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  disabled={cancellingId === task._id}
                  onClick={() => onCancel(task)}
                >
                  {cancellingId === task._id ? <LoaderCircle className="animate-spin" /> : <X />}
                  Cancelar
                </Button>
              )}
              {task.state === "done" && task.outputVideoId && (
                <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => onOpenResult(task)}>
                  Ver resultado
                </Button>
              )}
            </div>
            <span className="text-xs text-muted-foreground font-mono">
              Eliminar {formatTimecode(task.params.start)} → {formatTimecode(task.params.end)}
            </span>
            {task.state === "failed" && task.error && (
              <p className="text-xs text-destructive">{task.error.message}</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
