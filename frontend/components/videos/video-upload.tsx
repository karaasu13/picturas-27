"use client";

import { useRef, useState } from "react";
import { useDropzone, FileRejection } from "react-dropzone";
import { LoaderCircle, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { useUploadVideo } from "@/lib/mutations/videos";
import { useGetVideos } from "@/lib/queries/videos";
import {
  formatBytes,
  ProjectVideo,
  VIDEO_RULES,
  videoErrorMessage,
} from "@/lib/videos";
import { cn } from "@/lib/utils";

export function VideoUpload({
  uid,
  pid,
  token,
  onUploaded,
}: {
  uid: string;
  pid: string;
  token: string;
  onUploaded?: (video: ProjectVideo) => void;
}) {
  const { toast } = useToast();
  const upload = useUploadVideo({ uid, pid, token });
  // Mesma query da página: vem da cache, não faz outro pedido
  const videos = useGetVideos(uid, pid, token);
  const [progress, setProgress] = useState(0);
  const [fileName, setFileName] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const busy = upload.isPending;

  function start(file: File) {
    // Avisar já, em vez de depois de enviar até 2 GB (o servidor volta a verificar)
    if (videos.data?.some((v) => v.name === file.name)) {
      toast({
        title: "The video couldn't be uploaded",
        description: "This project already has a video with that name. Rename the file and try again.",
        variant: "destructive",
      });
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setFileName(file.name);
    setProgress(0);

    upload.mutate(
      { file, onProgress: setProgress, signal: controller.signal },
      {
        onSuccess: (video) => {
          toast({ title: "Video uploaded", description: video.name });
          onUploaded?.(video);
        },
        onError: (error) => {
          if (controller.signal.aborted) return;
          toast({
            title: "The video couldn't be uploaded",
            description: videoErrorMessage(error, "The upload failed. Try again."),
            variant: "destructive",
          });
        },
        onSettled: () => {
          abortRef.current = null;
          setFileName(null);
        },
      },
    );
  }

  function onReject(rejections: FileRejection[]) {
    const tooBig = rejections.some((r) => r.errors.some((e) => e.code === "file-too-large"));
    toast({
      title: "File not accepted",
      description: tooBig
        ? "The video is larger than the 2 GB limit. Reduce the file size and try again."
        : "Only MP4, MOV or AVI videos (H.264 or H.265) are accepted.",
      variant: "destructive",
    });
  }

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: VIDEO_RULES.accept,
    maxSize: VIDEO_RULES.maxBytes,
    multiple: false,
    disabled: busy,
    onDropAccepted: (files) => files[0] && start(files[0]),
    onDropRejected: onReject,
  });

  if (busy) {
    return (
      <div className="rounded-xl border p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm">
          <LoaderCircle className="size-4 animate-spin shrink-0" />
          <span className="truncate flex-1">
            {progress < 1 ? "Uploading" : "Checking"} {fileName}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            title="Cancel upload"
            aria-label="Cancel upload"
            disabled={progress >= 1}
            onClick={() => abortRef.current?.abort()}
          >
            <X />
          </Button>
        </div>
        <Progress value={Math.round(progress * 100)} />
      </div>
    );
  }

  return (
    <div
      {...getRootProps()}
      className={cn(
        "flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed p-5 text-center cursor-pointer transition-colors",
        isDragActive
          ? "border-primary bg-primary/10 text-primary"
          : "border-muted-foreground/40 text-muted-foreground hover:bg-sidebar",
      )}
    >
      <input {...getInputProps()} />
      <Upload className="size-5" />
      <span className="text-sm font-medium text-foreground">Upload video</span>
      <span className="text-xs">
        MP4, MOV or AVI (H.264/H.265), up to {formatBytes(VIDEO_RULES.maxBytes)}
      </span>
    </div>
  );
}
