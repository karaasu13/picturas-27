import { useState, useEffect } from "react";
import Loading from "./loading";
import Image from "next/image";
import { isVideoFile } from "@/lib/utils";

const ImagePreview = ({
  file,
}: {
  file: { stream: () => ReadableStream; type?: string; name: string };
}) => {
  const [blobUrl, setBlobUrl] = useState<string | null>(null); // Explicitly define type
  const [videoFailed, setVideoFailed] = useState<boolean>(false);

  useEffect(() => {
    const createBlobUrlFromStream = async () => {
      if (file.stream) {
        const stream = file.stream();
        // Cria o blob diretamente do stream
        const blob = await new Response(stream).blob();
        const url = URL.createObjectURL(blob);
        setBlobUrl(url);

        return () => URL.revokeObjectURL(url);
      }
    };

    createBlobUrlFromStream();
  }, [file]);

  if (!blobUrl) return <Loading />;

  if (file.type?.startsWith("video/") || isVideoFile(file.name)) {
    return (
      <div className="relative grid rounded-lg overflow-hidden shadow-md border size-full max-h-full bg-black">
        {videoFailed ? (
          <div className="flex size-full items-center justify-center bg-muted p-2 text-center text-xs text-muted-foreground">
            Preview not available in this browser
          </div>
        ) : (
          <video
            src={blobUrl}
            muted
            controls
            playsInline
            className="object-contain size-full"
            onError={() => setVideoFailed(true)}
          />
        )}
        <p
          className="absolute top-0 left-0 z-30 h-4 max-w-full w-fit bg-background rounded-br-md text-xs truncate line-clamp-1 px-1 flex items-center"
          title={file.name}
        >
          {file.name}
        </p>
      </div>
    );
  }

  return (
    <div className="grid rounded-lg overflow-hidden shadow-md border size-full max-h-full bg-background">
      <Image
        src={blobUrl}
        width={500}
        height={500}
        className="object-contain row-start-1 col-start-1 z-20 size-full"
        alt={file.name}
      />
      <Image
        src={blobUrl}
        width={500}
        height={500}
        className="object-cover row-start-1 col-start-1 size-full"
        alt={file.name}
      />
      <div className="row-start-1 col-start-1 backdrop-blur-sm z-10 size-full" />
      <p
        className="row-start-1 col-start-1 z-30 h-4 max-w-full w-fit bg-background rounded-br-md text-xs truncate line-clamp-1 px-1 flex items-center"
        title={file.name}
      >
        {file.name}
      </p>
    </div>
  );
};

export default ImagePreview;
