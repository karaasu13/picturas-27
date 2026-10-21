import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "../ui/label";
import { Input } from "../ui/input";
import { useEffect, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useAddProject } from "@/lib/mutations/projects";
import ImageSubmissionArea from "../image-submission-area";
import { useSession } from "@/providers/session-provider";
import { LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { getErrorMessage } from "@/lib/error-messages";
import { isVideoFile, uploadVideo, videoErrorMessage } from "@/lib/videos";

export default function NewProjectDialog({
  files = [],
  setFiles,
  children,
}: {
  files?: File[];
  setFiles?: (files: File[]) => void;
  children: React.ReactNode;
}) {
  const { toast } = useToast();
  const router = useRouter();

  const [open, setOpen] = useState<boolean>(false);
  const [name, setName] = useState<string>("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadingVideos, setUploadingVideos] = useState<boolean>(false);

  const session = useSession();
  const addProject = useAddProject(session.user._id, session.token);
  const busy = addProject.isPending || uploadingVideos;

  function handleCreate() {
    const videos = selectedFiles.filter(isVideoFile);
    addProject.mutate(
      {
        uid: session.user._id,
        token: session.token,
        name: name,
        images: selectedFiles.filter((file) => !isVideoFile(file)),
      },
      {
        onSuccess: async (project) => {
          // Os vídeos vão depois de o projeto existir; um que falhe avisa e não impede os outros
          let failed = false;
          setUploadingVideos(true);
          for (const file of videos) {
            try {
              await uploadVideo({ uid: session.user._id, pid: project._id, token: session.token, file });
            } catch (error) {
              failed = true;
              toast({
                title: "The video couldn't be uploaded",
                description: `${file.name}: ${videoErrorMessage(error, "The upload failed. Try again.")}`,
                variant: "destructive",
              });
            }
          }
          setUploadingVideos(false);
          setOpen(false);
          // Só se vê um toast de cada vez: não tapar o aviso de um vídeo que falhou
          if (!failed)
            toast({
              title: "Project created successfully.",
              description: videos.length > 0
                ? "The videos were added to the video editor."
                : "The images were added to the new project.",
            });
          router.push(videos.length > 0 ? `/dashboard/${project._id}/videos` : `/dashboard/${project._id}`);
        },
        onError: (error) => {
          const { title, description } = getErrorMessage("project-create", error);
          toast({
            title,
            description,
            variant: "destructive",
          });
        },
      },
    );
  }

  useEffect(() => {
    if (files.length > 0) {
      setOpen(true);
    }
  }, [files]);

  useEffect(() => {
    setName("");
    setSelectedFiles([]);
    if (setFiles && open === false) setFiles([]);
  }, [open, setFiles]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create New Project</DialogTitle>
        </DialogHeader>
        <Label htmlFor="project-name">Project Name</Label>
        <Input
          id="project-name"
          placeholder="Enter project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <ImageSubmissionArea
          onDrop={(files) => setSelectedFiles(files)}
          receivedFiles={files}
          videos
        />
        <DialogFooter>
          <Button
            onClick={() => handleCreate()}
            disabled={busy || selectedFiles.length <= 0 || name === ""}
            className="inline-flex items-center gap-1"
          >
            <span>Create</span>
            {busy && (
              <LoaderCircle className="size-[1em] animate-spin" />
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
