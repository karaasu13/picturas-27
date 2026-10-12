"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Crosshair, Eye, LoaderCircle, Scissors } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  formatTimecode,
  parseTimecode,
  ProjectVideo,
  validateCutInterval,
  VIDEO_RULES,
} from "@/lib/videos";

type UserType = "anonymous" | "free" | "premium";

export function VideoCutPanel({
  video,
  userType,
  remainingOperations,
  submitting,
  onSubmit,
}: {
  video: ProjectVideo;
  userType: UserType;
  remainingOperations: number | null | undefined;
  submitting: boolean;
  onSubmit: (start: number, end: number) => void;
}) {
  const playerRef = useRef<HTMLVideoElement>(null);
  const previewRef = useRef<{ start: number; end: number; stopAt: number } | null>(null);

  const [startText, setStartText] = useState("");
  const [endText, setEndText] = useState("");
  const [touched, setTouched] = useState(false);

  // Novo vídeo selecionado: valores iniciais razoáveis
  useEffect(() => {
    const d = video.duration;
    setStartText(formatTimecode(Math.min(d * 0.25, d)));
    setEndText(formatTimecode(Math.min(d * 0.5, d)));
    setTouched(false);
    previewRef.current = null;
  }, [video._id, video.duration]);

  const start = parseTimecode(startText);
  const end = parseTimecode(endText);
  const intervalError = validateCutInterval(start, end, video.duration);

  // Regras do perfil (o backend volta a verificar tudo)
  const blocker = useMemo(() => {
    if (userType === "anonymous") {
      return "Os utilizadores anónimos não têm acesso às ferramentas de vídeo. Cria uma conta para continuar.";
    }
    if (userType === "free" && video.duration > VIDEO_RULES.freeMaxDuration) {
      return "O perfil Registado só permite editar vídeos até 10 minutos. Escolhe um vídeo mais curto ou faz upgrade para Premium.";
    }
    if (userType === "free" && remainingOperations === 0) {
      return "Atingiu o limite de 5 operações diárias do perfil gratuito. Efetue upgrade para Premium para continuar.";
    }
    return null;
  }, [userType, video.duration, remainingOperations]);

  function takeCurrentTime(set: (v: string) => void) {
    const t = playerRef.current?.currentTime;
    if (t !== undefined) {
      set(formatTimecode(t));
      setTouched(true);
    }
  }

  // Pré-visualização da junção: 2 s antes do início, salta o segmento e
  // mostra 2 s depois do fim
  function previewJoin() {
    const p = playerRef.current;
    if (!p || start === null || end === null || intervalError) return;
    previewRef.current = { start, end, stopAt: Math.min(end + 2, video.duration) };
    p.currentTime = Math.max(0, start - 2);
    p.play().catch(() => {});
  }

  function onTimeUpdate() {
    const p = playerRef.current;
    const pv = previewRef.current;
    if (!p || !pv) return;
    if (p.currentTime >= pv.start && p.currentTime < pv.end) {
      p.currentTime = pv.end;
    } else if (p.currentTime >= pv.stopAt) {
      p.pause();
      previewRef.current = null;
    }
  }

  const removed = start !== null && end !== null && end > start ? end - start : null;
  const showError = touched && intervalError;
  const canSubmit = !blocker && !intervalError && !submitting;

  return (
    <div className="flex flex-col gap-4">
      {video.url ? (
        <video
          ref={playerRef}
          key={video._id}
          src={video.url}
          controls
          preload="metadata"
          className="w-full max-h-[45vh] rounded-lg bg-black"
          onTimeUpdate={onTimeUpdate}
          onSeeking={() => {
            // o utilizador saltou para fora da zona da junção: parar a pré-visualização
            const p = playerRef.current;
            const pv = previewRef.current;
            if (p && pv && (p.currentTime < pv.start - 2.5 || p.currentTime > pv.stopAt + 0.1)) {
              previewRef.current = null;
            }
          }}
          onPause={() => (previewRef.current = null)}
        />
      ) : (
        <Alert>
          <AlertDescription>Não foi possível carregar a pré-visualização deste vídeo.</AlertDescription>
        </Alert>
      )}

      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (canSubmit && start !== null && end !== null) onSubmit(start, end);
        }}
      >
        <div>
          <h2 className="font-semibold flex items-center gap-2">
            <Scissors className="size-4" /> Eliminar segmento
          </h2>
          <p className="text-sm text-muted-foreground">
            O segmento entre o início e o fim é removido e as duas partes são juntas. O vídeo
            original não é alterado: o resultado aparece como um novo vídeo.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <TimeField
            id="cut-start"
            label="Início do segmento"
            value={startText}
            onChange={(v) => {
              setStartText(v);
              setTouched(true);
            }}
            onUseCurrent={() => takeCurrentTime(setStartText)}
            invalid={!!showError}
          />
          <TimeField
            id="cut-end"
            label="Fim do segmento"
            value={endText}
            onChange={(v) => {
              setEndText(v);
              setTouched(true);
            }}
            onUseCurrent={() => takeCurrentTime(setEndText)}
            invalid={!!showError}
          />
        </div>

        <div className="text-sm text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
          <span>
            Duração original: <strong className="text-foreground">{formatTimecode(video.duration)}</strong>
          </span>
          {removed !== null && !intervalError && (
            <>
              <span>
                Segmento eliminado: <strong className="text-foreground">{formatTimecode(removed)}</strong>
              </span>
              <span>
                Duração final:{" "}
                <strong className="text-foreground">{formatTimecode(video.duration - removed)}</strong>
              </span>
            </>
          )}
        </div>

        {showError && (
          <p className="text-sm text-destructive" role="alert">
            {intervalError}
          </p>
        )}

        {blocker && (
          <Alert variant="destructive">
            <AlertDescription>
              {blocker}{" "}
              {userType !== "anonymous" && (
                <Link href="/dashboard/account/upgrade" className="underline">
                  Ver Premium
                </Link>
              )}
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!canSubmit}>
            {submitting ? <LoaderCircle className="animate-spin" /> : <Scissors />}
            Eliminar segmento
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!!intervalError || !video.url}
            onClick={previewJoin}
          >
            <Eye /> Pré-visualizar junção
          </Button>
          {userType === "free" && typeof remainingOperations === "number" && (
            <span className="text-xs text-muted-foreground">
              Usa 1 das {remainingOperations} operações que te restam hoje (devolvida se falhar ou
              cancelares).
            </span>
          )}
        </div>
      </form>
    </div>
  );
}

function TimeField({
  id,
  label,
  value,
  onChange,
  onUseCurrent,
  invalid,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  onUseCurrent: () => void;
  invalid: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          value={value}
          inputMode="decimal"
          placeholder="hh:mm:ss.mmm"
          aria-invalid={invalid}
          className="font-mono"
          onChange={(e) => onChange(e.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="shrink-0"
          title="Usar a posição atual do vídeo"
          onClick={onUseCurrent}
        >
          <Crosshair />
        </Button>
      </div>
    </div>
  );
}
