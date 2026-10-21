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

/**
 * Biblioteca com upload: um botão "Upload" no cabeçalho e a área inteira
 * aceita largar ficheiros. Sem upload (anónimos) fica só o cabeçalho.
 */
export function VideoUpload({
  uid,
  pid,
  token,
  title,
  disabled = false,
  onUploaded,
  children,
}: {
  uid: string;
  pid: string;
  token: string;
  title: string;
  disabled?: boolean;
  onUploaded?: (video: ProjectVideo) => void;
  children: React.ReactNode;
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

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    accept: VIDEO_RULES.accept,
    maxSize: VIDEO_RULES.maxBytes,
    multiple: false,
    disabled: busy || disabled,
    // Só o botão abre o seletor: clicar nos itens da biblioteca não
    noClick: true,
    noKeyboard: true,
    onDropAccepted: (files) => files[0] && start(files[0]),
    onDropRejected: onReject,
  });

  return (
    <div {...getRootProps()} className="relative flex size-full min-h-0 flex-col gap-2 p-2">
      <input {...getInputProps()} />
      <div className="flex items-center gap-2 px-1">
        <h2 className="flex-1 truncate text-sm font-semibold text-muted-foreground">{title}</h2>
        {!disabled && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0"
            title={`MP4, MOV or AVI (H.264/H.265), up to ${formatBytes(VIDEO_RULES.maxBytes)}. You can also drop files on the library.`}
            disabled={busy}
            onClick={() => open()}
          >
            <Upload /> Upload
          </Button>
        )}
      </div>

      {busy && (
        <div className="flex flex-col gap-1.5 rounded-md border px-2 py-1.5">
          <div className="flex items-center gap-2 text-xs">
            <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
            <span className="flex-1 truncate">
              {progress < 1 ? "Uploading" : "Checking"} {fileName}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              title="Cancel upload"
              aria-label="Cancel upload"
              disabled={progress >= 1}
              onClick={() => abortRef.current?.abort()}
            >
              <X />
            </Button>
          </div>
          <Progress value={Math.round(progress * 100)} className="h-1.5" />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

      {isDragActive && (
        <div
          className={cn(
            "pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-lg border-2 border-dashed",
            "border-primary bg-primary/10 text-sm font-medium text-primary",
          )}
        >
          Drop to upload
        </div>
      )}
    </div>
  );
}
