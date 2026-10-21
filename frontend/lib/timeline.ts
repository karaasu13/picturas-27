// Timeline do editor de vídeo: tipos e operações puras sobre { output, faixas }.
//
// Clips de faixas diferentes com o mesmo link_id formam um grupo (vídeo +
// áudio ligados) e são editados juntos. Quando nenhum outro clip ocupa o
// intervalo do grupo, as edições fazem ripple: o que vem depois encosta, em
// todas as faixas. Um clip desligado edita-se só na sua faixa e deixa
// buracos (preto ou silêncio no render).
//
// Sem imports e só com TypeScript "apagável", para os testes correrem
// diretamente no Node (lib/timeline.test.mjs).

export type Formato = "mp4" | "mov" | "avi";
export type Qualidade = "baixa" | "media" | "alta";
export type Fit = "pad" | "crop";
export type TrackType = "video" | "audio";

export interface Clip {
  link_id: string;
  video_id: string;
  in: number; // segundos no vídeo de origem
  out: number;
  speed: number;
  posicao: number; // início na timeline (s)
}

export interface Track {
  tipo: TrackType;
  clips: Clip[];
}

export interface Output {
  formato: Formato;
  qualidade: Qualidade;
  largura: number;
  altura: number;
  fit: Fit;
}

export interface TimelineData {
  output: Output;
  faixas: Track[];
}

/** O que as operações precisam de saber de um vídeo de origem. */
export interface Source {
  id: string;
  duration: number;
  hasAudio: boolean;
  format: Formato;
  width: number;
  height: number;
}

export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
export const MIN_CLIP = 0.05; // duração mínima de um clip na timeline (s)
const EPS = 0.0005;

export const newLinkId = () => crypto.randomUUID();

export const clipDuration = (c: Clip) => (c.out - c.in) / c.speed;
export const clipEnd = (c: Clip) => c.posicao + clipDuration(c);
/** Instante do vídeo de origem que corresponde ao instante t da timeline. */
export const sourceTime = (c: Clip, t: number) => c.in + (t - c.posicao) * c.speed;

export function track(t: TimelineData, tipo: TrackType) {
  return t.faixas.find((f) => f.tipo === tipo);
}

/** Duração final: fim do último clip de vídeo. */
export function timelineDuration(t: TimelineData) {
  let end = 0;
  for (const c of track(t, "video")?.clips ?? []) end = Math.max(end, clipEnd(c));
  return end;
}

/** Clip da faixa no instante t, ou null num buraco. */
export function clipAt(f: Track | undefined, t: number) {
  return f?.clips.find((c) => c.posicao <= t + EPS && t < clipEnd(c) - EPS) ?? null;
}

export function groupClips(t: TimelineData, linkId: string) {
  return t.faixas.flatMap((f) => f.clips.filter((c) => c.link_id === linkId));
}

function span(clips: Clip[]): [number, number] {
  return [Math.min(...clips.map((c) => c.posicao)), Math.max(...clips.map(clipEnd))];
}

/** Nenhum clip de fora do grupo ocupa o intervalo do grupo: edita-se com ripple. */
export function isExclusive(t: TimelineData, linkId: string) {
  const [s, e] = span(groupClips(t, linkId));
  return t.faixas.every((f) =>
    f.clips.every((c) => c.link_id === linkId || clipEnd(c) <= s + EPS || c.posicao >= e - EPS),
  );
}

function clone(t: TimelineData): TimelineData {
  return {
    output: { ...t.output },
    faixas: t.faixas.map((f) => ({ tipo: f.tipo, clips: f.clips.map((c) => ({ ...c })) })),
  };
}

function sortClips(t: TimelineData) {
  for (const f of t.faixas) f.clips.sort((a, b) => a.posicao - b.posicao);
  return t;
}

function overlaps(t: TimelineData) {
  return t.faixas.some((f) => {
    const clips = [...f.clips].sort((a, b) => a.posicao - b.posicao);
    return clips.some((c, i) => i > 0 && c.posicao < clipEnd(clips[i - 1]) - EPS);
  });
}

// Ripple: desloca todos os clips (de todas as faixas) que começam em `from` ou depois
function shift(t: TimelineData, from: number, delta: number, except?: string) {
  for (const f of t.faixas) {
    for (const c of f.clips) if (c.link_id !== except && c.posicao >= from - EPS) c.posicao += delta;
  }
}

function trackOf(t: TimelineData, tipo: TrackType) {
  let f = track(t, tipo);
  if (!f) {
    f = { tipo, clips: [] };
    t.faixas.push(f);
  }
  return f;
}

/** Instantes onde se pode inserir sem cortar nenhum clip a meio. */
export function insertionPoints(t: TimelineData) {
  const points = new Set<number>([0]);
  for (const f of t.faixas) {
    for (const c of f.clips) {
      points.add(c.posicao);
      points.add(clipEnd(c));
    }
  }
  const straddled = (x: number) =>
    t.faixas.some((f) => f.clips.some((c) => c.posicao < x - EPS && clipEnd(c) > x + EPS));
  return [...points].filter((x) => !straddled(x)).sort((a, b) => a - b);
}

export function nearestInsertionPoint(t: TimelineData, x: number) {
  return insertionPoints(t).reduce((best, p) => (Math.abs(p - x) < Math.abs(best - x) ? p : best));
}

const even = (x: number) => Math.min(4096, Math.max(16, Math.round(x / 2) * 2));

/**
 * Insere um vídeo inteiro em `at` (um ponto de inserção): clip de vídeo e,
 * se tiver áudio, o clip de áudio ligado. O que vem depois encosta.
 * Numa timeline vazia, a saída fica com o formato e a resolução do vídeo.
 */
export function insertVideo(t: TimelineData, src: Source, at: number) {
  const next = clone(t);
  if (!next.faixas.some((f) => f.clips.length > 0)) {
    next.output = { ...next.output, formato: src.format, largura: even(src.width), altura: even(src.height) };
  }
  shift(next, at, src.duration);
  const clip: Clip = { link_id: newLinkId(), video_id: src.id, in: 0, out: src.duration, speed: 1, posicao: at };
  trackOf(next, "video").clips.push({ ...clip });
  if (src.hasAudio) trackOf(next, "audio").clips.push({ ...clip });
  return sortClips(next);
}

/**
 * Divide no instante t os clips do grupo (ou, sem grupo, todos os clips
 * nesse instante). As segundas metades de um grupo ficam com um link_id
 * novo, partilhado entre elas. Null se não houver nada para dividir.
 */
export function split(t: TimelineData, time: number, linkId?: string | null) {
  const next = clone(t);
  const ids = new Map<string, string>();
  for (const f of next.faixas) {
    f.clips = f.clips.flatMap((c) => {
      if ((linkId && c.link_id !== linkId) || time <= c.posicao + EPS || time >= clipEnd(c) - EPS) return [c];
      if (!ids.has(c.link_id)) ids.set(c.link_id, newLinkId());
      const cut = sourceTime(c, time);
      return [
        { ...c, out: cut },
        { ...c, in: cut, posicao: time, link_id: ids.get(c.link_id)! },
      ];
    });
  }
  return ids.size > 0 ? next : null;
}

/** Apaga o grupo. Com ripple o que vem depois encosta; sem ripple fica um buraco. */
export function remove(t: TimelineData, linkId: string) {
  const group = groupClips(t, linkId);
  if (group.length === 0) return null;
  const ripple = isExclusive(t, linkId);
  const [s, e] = span(group);
  const next = clone(t);
  for (const f of next.faixas) f.clips = f.clips.filter((c) => c.link_id !== linkId);
  if (ripple) shift(next, e, -(e - s));
  return next;
}

/**
 * Apara uma ponta do grupo. `delta` é quanto essa ponta anda na timeline
 * (s, positivo para a direita); fica limitado pela origem, pela duração
 * mínima e, sem ripple, pelo espaço livre na faixa. Devolve a timeline e o
 * delta aplicado, ou null se não mudar nada.
 */
export function trim(
  t: TimelineData,
  linkId: string,
  edge: "in" | "out",
  delta: number,
  durationOf: (videoId: string) => number,
) {
  const group = groupClips(t, linkId);
  if (group.length === 0) return null;
  const ripple = isExclusive(t, linkId);
  const [, e] = span(group);

  let d = delta;
  for (const c of group) {
    const len = clipDuration(c);
    if (edge === "out") {
      d = Math.min(d, (durationOf(c.video_id) - c.out) / c.speed);
      d = Math.max(d, MIN_CLIP - len);
    } else {
      d = Math.max(d, -c.in / c.speed);
      d = Math.min(d, len - MIN_CLIP);
      if (!ripple) d = Math.max(d, -c.posicao);
    }
  }

  // Sem ripple, só cresce para o espaço livre da própria faixa
  if (!ripple) {
    for (const f of t.faixas) {
      for (const c of f.clips.filter((x) => x.link_id === linkId)) {
        const others = f.clips.filter((x) => x.link_id !== linkId);
        if (edge === "out") {
          const room = Math.min(Infinity, ...others.filter((x) => x.posicao >= clipEnd(c) - EPS).map((x) => x.posicao));
          d = Math.min(d, room - clipEnd(c));
        } else {
          const room = Math.max(0, ...others.filter((x) => clipEnd(x) <= c.posicao + EPS).map(clipEnd));
          d = Math.max(d, room - c.posicao);
        }
      }
    }
  }

  if (Math.abs(d) < EPS) return null;

  const next = clone(t);
  for (const c of groupClips(next, linkId)) {
    if (edge === "out") {
      c.out += d * c.speed;
    } else {
      c.in += d * c.speed;
      if (!ripple) c.posicao += d;
    }
  }
  if (ripple) shift(next, e, edge === "out" ? d : -d, linkId);
  return { timeline: next, delta: d };
}

/** Muda a velocidade do grupo. Sem ripple e sem espaço para crescer: null. */
export function setSpeed(t: TimelineData, linkId: string, speed: number) {
  const group = groupClips(t, linkId);
  if (group.length === 0) return null;
  const ripple = isExclusive(t, linkId);
  const [, e] = span(group);

  const next = clone(t);
  const members = groupClips(next, linkId);
  for (const c of members) c.speed = speed;
  if (ripple) {
    shift(next, e, span(members)[1] - e, linkId);
    return next;
  }
  return overlaps(next) ? null : next;
}

/**
 * Move o grupo para começar em `to`. Com ripple sai do sítio (o resto encosta)
 * e entra no ponto de inserção mais próximo; desligado, vai para `to` se
 * houver espaço (senão null).
 */
export function move(t: TimelineData, linkId: string, to: number) {
  const group = groupClips(t, linkId);
  if (group.length === 0) return null;
  const [s, e] = span(group);

  if (isExclusive(t, linkId)) {
    const next = remove(t, linkId)!;
    const at = nearestInsertionPoint(next, to);
    shift(next, at, e - s);
    for (const f of t.faixas) {
      for (const c of f.clips) {
        if (c.link_id === linkId) trackOf(next, f.tipo).clips.push({ ...c, posicao: at + (c.posicao - s) });
      }
    }
    return sortClips(next);
  }

  const next = clone(t);
  const at = Math.max(0, to);
  for (const c of groupClips(next, linkId)) c.posicao = at + (c.posicao - s);
  return overlaps(next) ? null : sortClips(next);
}

/**
 * Mover para a esquerda/direita pelo teclado: um grupo com ripple troca de
 * lugar com o vizinho; um clip desligado anda um fotograma (`step` s).
 */
export function moveStep(t: TimelineData, linkId: string, dir: -1 | 1, step: number) {
  const group = groupClips(t, linkId);
  if (group.length === 0) return null;
  const [s] = span(group);
  if (!isExclusive(t, linkId)) return move(t, linkId, s + dir * step);

  const points = insertionPoints(remove(t, linkId)!);
  const target = dir < 0 ? [...points].reverse().find((p) => p < s - EPS) : points.find((p) => p > s + EPS);
  return target === undefined ? null : move(t, linkId, target);
}

/** Desliga o grupo: cada clip passa a editar-se sozinho. */
export function unlink(t: TimelineData, linkId: string) {
  if (groupClips(t, linkId).length < 2) return null;
  const next = clone(t);
  for (const c of groupClips(next, linkId)) c.link_id = newLinkId();
  return next;
}

/** Clip desligado, alinhado com este (mesmo início e fim), noutra faixa. */
export function linkCandidate(t: TimelineData, linkId: string) {
  const group = groupClips(t, linkId);
  if (group.length !== 1) return null;
  const [c] = group;
  for (const f of t.faixas) {
    if (f.clips.includes(c)) continue;
    const other = f.clips.find(
      (x) =>
        Math.abs(x.posicao - c.posicao) < EPS &&
        Math.abs(clipEnd(x) - clipEnd(c)) < EPS &&
        groupClips(t, x.link_id).length === 1,
    );
    if (other) return other;
  }
  return null;
}

/** Volta a ligar o clip ao clip alinhado da outra faixa. */
export function link(t: TimelineData, linkId: string) {
  const other = linkCandidate(t, linkId);
  if (!other) return null;
  const next = clone(t);
  for (const c of groupClips(next, other.link_id)) c.link_id = linkId;
  return next;
}
