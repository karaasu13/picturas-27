import { cn, isVideoFile } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Download, FileVideo, Trash } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import Image from "next/image";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useDeleteProjectImages,
  useDownloadProjectImage,
} from "@/lib/mutations/projects";
import { useProjectInfo } from "@/providers/project-provider";
import { useSession } from "@/providers/session-provider";
import { useToast } from "@/hooks/use-toast";
import type { ProjectImage } from "@/lib/projects";
import { useSearchParams } from "next/navigation";
import { getErrorMessage } from "@/lib/error-messages";

interface ImageItemProps {
  image: ProjectImage;
  animation?: boolean;
}

export function ProjectImage({ image, animation = true }: ImageItemProps) {
  const searchParams = useSearchParams();
  const mode = searchParams.get("mode") ?? "edit";

  const [loaded, setLoaded] = useState<boolean>(false);
  const [open, setOpen] = useState<boolean>(false);
  const [videoFailed, setVideoFailed] = useState<boolean>(false);

  const { _id: pid, version } = useProjectInfo();
  const session = useSession();
  const ownerId = searchParams.get("owner") ?? session.user._id;
  const shareId = searchParams.get("share") ?? undefined;

  const projectInfo = useProjectInfo(); // para ter version também
  const deleteImage = useDeleteProjectImages(
    session.user._id,
    pid as string,
    session.token,
    ownerId,
    shareId,
  );
  const downloadImage = useDownloadProjectImage(mode === "results");
  const { toast } = useToast();
  const isVideo = isVideoFile(image.name);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <ContextMenu>
        <ContextMenuTrigger>
          <Card className="group relative overflow-hidden size-full">
            {/* Image */}
            <div className="size-full relative grid z-0 grid-cols-1 grid-rows-1">
              {isVideo && videoFailed ? (
                // O browser não reproduz este formato (ex.: AVI original); o processamento continua a funcionar
                <div className="row-start-1 col-start-1 z-30 flex size-full flex-col items-center justify-center gap-2 bg-muted p-2 text-center text-xs text-muted-foreground">
                  <FileVideo className="size-8" />
                  <span className="max-w-full truncate">{image.name}</span>
                  <span>Preview not available in this browser</span>
                </div>
              ) : isVideo ? (
                // Vídeo: só mostra os controlos no carrossel (na grelha o cartão é clicável)
                <video
                  src={`${image.url}#t=0.1`}
                  muted
                  loop
                  playsInline
                  preload="metadata"
                  controls={!animation}
                  aria-label={image.name}
                  className={cn(
                    "size-full object-contain row-start-1 col-start-1 z-30 bg-black",
                    animation && "transition-all group-hover:scale-105",
                  )}
                  onLoadedData={() => setLoaded(true)}
                  onError={() => {
                    setVideoFailed(true);
                    setLoaded(true);
                  }}
                />
              ) : (
                <>
                  <Image
                    src={image.url}
                    unoptimized
                    height={500}
                    width={500}
                    alt={image.name}
                    className={cn(
                      "size-full object-contain row-start-1 col-start-1 z-30",
                      animation && "transition-all group-hover:scale-105",
                    )}
                    priority
                    onLoad={() => setLoaded(true)}
                  />
                  <Image
                    src={image.url}
                    unoptimized
                    width={500}
                    height={500}
                    className="object-cover row-start-1 col-start-1 size-full z-10"
                    alt={image.name + " blurred"}
                  />
                  <div className="row-start-1 col-start-1 backdrop-blur-sm size-full bg-black/30 z-20" />
                </>
              )}
              {!loaded && (
                <>
                  <div className="row-start-1 col-start-1 z-40 bg-background size-full" />
                  <Skeleton className="size-full row-start-1 col-start-1 z-50" />
                </>
              )}
            </div>
          </Card>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <DialogTrigger asChild onClick={(e) => e.stopPropagation()}>
            {mode !== "results" && (
              <ContextMenuItem
                className="flex justify-between"
                onClick={(e) => e.stopPropagation()}
              >
                <span>Delete</span>
                <Trash className="size-4" />
              </ContextMenuItem>
            )}
          </DialogTrigger>
          <ContextMenuItem
            className="flex justify-between"
            onClick={(e) => {
              e.stopPropagation();
              downloadImage.mutate(
                {
                  imageUrl: image.url,
                  imageName: image.name,
                },
                {
                  onSuccess: () => {
                    toast({
                      title: `Image ${image.name} downloaded.`,
                    });
                  },
                  onError: (error) => {
                    const { title, description } = getErrorMessage("project-download", error);
                    toast({
                      title,
                      description,
                      variant: "destructive",
                    });
                  },
                },
              );
            }}
          >
            <span>Download</span>
            <Download className="size-4" />
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Are you sure?</DialogTitle>
          <DialogDescription>This action cannot be undone.</DialogDescription>
        </DialogHeader>
        <div className="flex justify-end">
          <Button
            variant="destructive"
            onClick={(e) => {
              deleteImage.mutate(
                {
                  imageIds: [image._id],
                  projectVersion: projectInfo.version,
                },
                {
                  onSuccess: () => {
                    toast({
                      title: `Image ${image.name} deleted successfully.`,
                    });
                  },
                  onError: (error) => {
                    const { title, description } = getErrorMessage("project-delete", error);
                    toast({
                      title,
                      description,
                      variant: "destructive",
                    });
                  },
                },
              );
              setOpen(false);
              e.stopPropagation();
            }}
          >
            Permanently Delete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
