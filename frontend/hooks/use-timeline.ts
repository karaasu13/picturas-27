// Estado do editor de vídeo: o rascunho local da timeline é a fonte de
// verdade e cada edição é gravada no servidor (PUT com a versão). As
// gravações correm em fila (scope), cada uma com a versão devolvida pela
// anterior. Num conflito ou erro, recarrega o que está no servidor.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useGetTimeline } from "@/lib/queries/videos";
import {
  ProjectVideo,
  saveTimeline,
  timelineHistoryStep,
  TimelineResponse,
  videoErrorMessage,
} from "@/lib/videos";
import type { TimelineData } from "@/lib/timeline";

export function useTimeline(uid: string, pid: string, token: string) {
  const { toast } = useToast();
  const query = useGetTimeline(uid, pid, token);

  const [draft, setDraft] = useState<TimelineData | null>(null);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const version = useRef(0);
  // As gravações pedidas antes de um erro já não fazem sentido: são descartadas
  const generation = useRef(0);

  const load = useCallback((t: TimelineResponse) => {
    version.current = t.version;
    setHistory({ canUndo: t.canUndo, canRedo: t.canRedo });
  }, []);

  const reset = useCallback(
    (t: TimelineResponse) => {
      load(t);
      setDraft({ output: t.output, faixas: t.faixas });
    },
    [load],
  );

  useEffect(() => {
    if (query.data) reset(query.data);
  }, [query.data, reset]);

  const { refetch } = query;
  const onError = useCallback(
    (error: unknown) => {
      generation.current++;
      toast({
        title: "The timeline couldn't be saved",
        description: videoErrorMessage(error, "Your last change was undone. Try again."),
        variant: "destructive",
      });
      // os dados podem vir iguais (mesma referência): repor à mão
      refetch().then((r) => r.data && reset(r.data));
    },
    [toast, refetch, reset],
  );

  const scope = { id: `timeline-${pid}` };

  const save = useMutation({
    scope,
    mutationFn: async ({ timeline, gen }: { timeline: TimelineData; gen: number }) =>
      gen === generation.current
        ? saveTimeline({ uid, pid, token, version: version.current, timeline })
        : null,
    onSuccess: (t) => t && load(t),
    onError,
  });

  const step = useMutation({
    scope,
    mutationFn: (s: "undo" | "redo") => timelineHistoryStep({ uid, pid, token, version: version.current, step: s }),
    onSuccess: reset,
    onError,
  });

  const { mutate: saveMutate } = save;
  const edit = useCallback(
    (next: TimelineData | null) => {
      if (!next) return false;
      setDraft(next);
      saveMutate({ timeline: next, gen: generation.current });
      return true;
    },
    [saveMutate],
  );

  return {
    draft,
    edit,
    undo: () => step.mutate("undo"),
    redo: () => step.mutate("redo"),
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    saving: save.isPending || step.isPending,
    // a versão atual, lida no momento do pedido (para exportar o que está gravado)
    version: () => version.current,
    isLoading: query.isLoading,
    error: query.error,
  };
}

const URL_TTL_MS = 30 * 60 * 1000; // as URLs assinadas valem 1 h

/**
 * Vídeos por id, com as URLs da pré-visualização estáveis. A lista de vídeos
 * traz URLs assinadas novas a cada pedido; trocar o src do <video> ou do
 * sprite fazia-os recarregar. Mantém as de cada vídeo durante 30 min.
 */
export function useStablePreviews(videos: ProjectVideo[]) {
  const cache = useRef(new Map<string, { at: number; preview: ProjectVideo["preview"] }>());
  return useMemo(() => {
    const now = Date.now();
    const byId = new Map<string, ProjectVideo>();
    for (const v of videos) {
      const hit = cache.current.get(v._id);
      const keep = hit && hit.preview.state === "ready" && v.preview.state === "ready" && now - hit.at < URL_TTL_MS;
      if (!keep) cache.current.set(v._id, { at: now, preview: v.preview });
      byId.set(v._id, { ...v, preview: cache.current.get(v._id)!.preview });
    }
    return byId;
  }, [videos]);
}
