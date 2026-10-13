import { ToolbarButton } from "./toolbar-button";
import { Gauge } from "lucide-react";
import { useEffect, useState } from "react";
import {
  useCurrentImage,
  useProjectInfo,
  useUnsavedChanges,
} from "@/providers/project-provider";
import { VideoSpeedToolParams } from "@/lib/tool-types";
import { isVideoFile } from "@/lib/utils";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Slider } from "../ui/slider";

// Limites do fator de velocidade (têm de coincidir com os da ferramenta Tools/video_speed)
const MIN_SPEED = 0.25;
const MAX_SPEED = 4;
const DEFAULT_SPEED = 1;

export default function VideoSpeedTool({ disabled }: { disabled: boolean }) {
  const project = useProjectInfo();
  const currentImage = useCurrentImage();
  const { setHasUnsavedChanges } = useUnsavedChanges();

  const [speed, setSpeed] = useState<number>(DEFAULT_SPEED);
  const [speedText, setSpeedText] = useState<string>(String(DEFAULT_SPEED));
  const [open, setOpen] = useState<boolean>(false);

  // A ferramenta só faz sentido para vídeos
  const isVideo = currentImage ? isVideoFile(currentImage.name) : true;

  const textValue = Number(speedText);
  const textIsValid =
    speedText.trim() !== "" &&
    Number.isFinite(textValue) &&
    textValue >= MIN_SPEED &&
    textValue <= MAX_SPEED;

  function handleSliderChange(value: number) {
    setSpeed(value);
    setSpeedText(String(value));
    setHasUnsavedChanges(true);
  }

  function handleTextChange(text: string) {
    setSpeedText(text);
    const value = Number(text);
    if (
      text.trim() !== "" &&
      Number.isFinite(value) &&
      value >= MIN_SPEED &&
      value <= MAX_SPEED
    ) {
      setSpeed(value);
      setHasUnsavedChanges(true);
    }
  }

  useEffect(() => {
    const speedTool = project.tools.find((t) => t.procedure === "video_speed");
    if (speedTool) {
      const params = speedTool.params as VideoSpeedToolParams;
      setSpeed(params.speed);
      setSpeedText(String(params.speed));
    }
  }, [project.tools, open]);

  return (
    <ToolbarButton
      open={open}
      setOpen={setOpen}
      tool={{
        procedure: "video_speed",
        params: { speed },
      }}
      onDefault={() => {
        setSpeed(DEFAULT_SPEED);
        setSpeedText(String(DEFAULT_SPEED));
        setHasUnsavedChanges(false);
      }}
      isDefault={speed === DEFAULT_SPEED && textIsValid}
      disabled={disabled || !isVideo}
      icon={Gauge}
      label="Change Video Speed"
    >
      <div className="flex flex-col justify-center items-center gap-4">
        <div className="flex w-full justify-between items-center text-sm text-gray-500">
          <Label htmlFor="video-speed">Speed</Label>
          <div className="flex items-center space-x-2 w-1/2">
            <Input
              id="video-speed"
              type="number"
              step={0.25}
              min={MIN_SPEED}
              max={MAX_SPEED}
              value={speedText}
              onChange={(e) => handleTextChange(e.target.value)}
            />
            <span>x</span>
          </div>
        </div>
        <Slider
          className="w-full"
          min={MIN_SPEED}
          max={MAX_SPEED}
          step={0.25}
          value={[speed]}
          onValueChange={(v) => handleSliderChange(v[0])}
        />
        <div className="flex w-full justify-between text-xs text-gray-400">
          <span>{MIN_SPEED}x</span>
          <span>{MAX_SPEED}x</span>
        </div>
        {!textIsValid && (
          <p className="text-xs text-red-500 text-center">
            Choose a value between {MIN_SPEED}x and {MAX_SPEED}x.
          </p>
        )}
      </div>
    </ToolbarButton>
  );
}
