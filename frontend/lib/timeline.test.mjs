// Testes das operações da timeline. Sem dependências (precisa de Node >= 22.6):
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import * as T from "./timeline.ts";

const output = { formato: "mp4", qualidade: "media", largura: 1280, altura: 720, fit: "pad" };
const clip = (link_id, video_id, from, to, posicao, speed = 1) => ({ link_id, video_id, in: from, out: to, speed, posicao });
const timeline = (video, audio) => ({
  output,
  faixas: [
    { tipo: "video", clips: video },
    { tipo: "audio", clips: audio },
  ],
});
const durationOf = (id) => ({ a: 10, b: 6, m: 8 })[id];
const round = (x) => Math.round(x * 1000) / 1000;
// [link_id, posição, in, out] de cada clip da faixa
const layout = (t, tipo) => T.track(t, tipo).clips.map((c) => [c.link_id, round(c.posicao), round(c.in), round(c.out)]);

// A (a: 0-4 s) seguido de B (b: 0-6 s), cada um com vídeo e áudio ligados
const base = () =>
  timeline([clip("A", "a", 0, 4, 0), clip("B", "b", 0, 6, 4)], [clip("A", "a", 0, 4, 0), clip("B", "b", 0, 6, 4)]);

const unlinkedA = () => {
  const t = T.unlink(base(), "A");
  return { t, v: T.track(t, "video").clips[0].link_id, a: T.track(t, "audio").clips[0].link_id };
};

test("split: halves keep the duration and the second halves share a new link", () => {
  const t = T.split(base(), 1.5);
  const video = T.track(t, "video").clips;
  const audio = T.track(t, "audio").clips;
  assert.deepEqual(layout(t, "video").map((c) => c.slice(1)), [[0, 0, 1.5], [1.5, 1.5, 4], [4, 0, 6]]);
  assert.equal(T.clipDuration(video[0]) + T.clipDuration(video[1]), 4);
  assert.equal(video[0].link_id, "A");
  assert.notEqual(video[1].link_id, "A");
  assert.equal(audio[1].link_id, video[1].link_id); // continua ligado ao áudio
  assert.equal(T.timelineDuration(t), 10);
});

test("split: respects speed, the selected group and boundaries", () => {
  const fast = timeline([clip("A", "a", 2, 10, 0, 2)], []);
  const [first, second] = T.track(T.split(fast, 1), "video").clips;
  assert.deepEqual([first.out, second.in, second.posicao], [4, 4, 1]); // 1 s a 2x = 2 s de origem
  assert.equal(T.split(base(), 2, "B"), null); // o instante não está no B
  assert.equal(T.split(base(), 4), null); // fronteira entre clips
});

test("remove of a linked group ripples both tracks", () => {
  const t = T.remove(base(), "A");
  assert.deepEqual(layout(t, "video"), [["B", 0, 0, 6]]);
  assert.deepEqual(layout(t, "audio"), [["B", 0, 0, 6]]);
});

test("cut = split + delete: removes the middle and joins the rest", () => {
  let t = T.split(T.split(base(), 1), 3);
  const middle = T.track(t, "video").clips[1].link_id;
  t = T.remove(t, middle);
  assert.deepEqual(layout(t, "video").map((c) => c.slice(1)), [[0, 0, 1], [1, 3, 4], [2, 0, 6]]);
  assert.equal(T.timelineDuration(t), 8);
});

test("remove of an unlinked clip leaves a gap and moves nothing", () => {
  const { t, a } = unlinkedA();
  const r = T.remove(t, a);
  assert.deepEqual(layout(r, "audio"), [["B", 4, 0, 6]]); // silêncio de 0 a 4 s
  assert.deepEqual(layout(r, "video").map((c) => c[1]), [0, 4]);
});

test("trim with ripple: out and in edges, limited by the source and the minimum length", () => {
  let r = T.trim(base(), "A", "out", -1, durationOf);
  assert.deepEqual(layout(r.timeline, "video"), [["A", 0, 0, 3], ["B", 3, 0, 6]]);
  assert.deepEqual(layout(r.timeline, "audio"), [["A", 0, 0, 3], ["B", 3, 0, 6]]);

  r = T.trim(base(), "A", "out", 20, durationOf); // a origem só tem 10 s
  assert.equal(r.delta, 6);
  assert.deepEqual(layout(r.timeline, "video")[1], ["B", 10, 0, 6]);

  r = T.trim(base(), "A", "in", 1, durationOf); // a ponta esquerda anda; o resto encosta
  assert.deepEqual(layout(r.timeline, "video"), [["A", 0, 1, 4], ["B", 3, 0, 6]]);

  r = T.trim(base(), "A", "in", -5, durationOf); // não há origem antes do 0
  assert.equal(r, null);

  r = T.trim(base(), "A", "in", 10, durationOf);
  assert.equal(round(T.clipDuration(T.track(r.timeline, "video").clips[0])), T.MIN_CLIP);
});

test("trim without ripple only grows into free space", () => {
  const { t, a } = unlinkedA();
  assert.equal(T.trim(t, a, "out", 1, durationOf), null); // o B está logo a seguir
  const r = T.trim(t, a, "in", 1, durationOf); // encolhe pela esquerda: fica um buraco
  assert.deepEqual(layout(r.timeline, "audio")[0].slice(1), [1, 1, 4]);
  assert.deepEqual(layout(r.timeline, "video")[1], ["B", 4, 0, 6]);
  const back = T.trim(r.timeline, a, "in", -3, durationOf); // volta a crescer até ao 0
  assert.equal(back.delta, -1);
});

test("setSpeed: duration changes and the rest ripples", () => {
  const t = T.setSpeed(base(), "A", 2);
  assert.equal(T.clipDuration(T.track(t, "video").clips[0]), 2);
  assert.deepEqual(layout(t, "video")[1], ["B", 2, 0, 6]);
  assert.deepEqual(layout(t, "audio")[1], ["B", 2, 0, 6]);
  assert.equal(T.timelineDuration(T.setSpeed(base(), "B", 0.5)), 16);
});

test("setSpeed on an unlinked clip: shrinking leaves a gap, growing needs room", () => {
  const { t, a } = unlinkedA();
  assert.equal(T.setSpeed(t, a, 0.5), null);
  const r = T.setSpeed(t, a, 2);
  assert.equal(T.clipEnd(T.track(r, "audio").clips[0]), 2);
  assert.deepEqual(layout(r, "audio")[1], ["B", 4, 0, 6]);
});

test("unlink/link: only aligned, unlinked clips can be linked again", () => {
  assert.equal(T.unlink(base(), "nope"), null);
  const { t, v, a } = unlinkedA();
  assert.notEqual(v, a);
  assert.equal(T.unlink(t, v), null); // já está sozinho

  const relinked = T.link(t, v);
  assert.equal(T.track(relinked, "audio").clips[0].link_id, v);

  const shorter = T.trim(t, a, "out", -1, durationOf).timeline; // deixa de estar alinhado
  assert.equal(T.linkCandidate(shorter, v), null);
  assert.equal(T.link(shorter, v), null);
});

test("gaps: insertion points never cut a clip, inserting ripples everything after", () => {
  // música desligada de 2 a 6 s por cima da junção A|B
  const t = timeline([clip("A", "a", 0, 4, 0), clip("B", "b", 0, 6, 4)], [clip("M", "m", 0, 4, 2)]);
  assert.deepEqual(T.insertionPoints(t), [0, 10]);
  assert.equal(T.nearestInsertionPoint(t, 8), 10);

  const src = { id: "b", duration: 6, hasAudio: false, format: "mp4", width: 640, height: 360 };
  const r = T.insertVideo(base(), src, 4);
  assert.deepEqual(layout(r, "video").map((c) => c[1]), [0, 4, 10]);
  assert.deepEqual(layout(r, "audio").map((c) => c[1]), [0, 10]); // sem áudio: buraco
  assert.equal(r.output.largura, 1280); // a saída só muda numa timeline vazia
});

test("first video in an empty timeline sets the output format and size", () => {
  const src = { id: "x", duration: 3, hasAudio: true, format: "mov", width: 1919, height: 1081 };
  const r = T.insertVideo(timeline([], []), src, 0);
  assert.deepEqual([r.output.formato, r.output.largura, r.output.altura], ["mov", 1920, 1082]);
  assert.equal(T.track(r, "audio").clips.length, 1);
});

test("move: linked groups reorder with ripple, unlinked clips need free space", () => {
  let t = T.move(base(), "B", 0);
  assert.deepEqual(layout(t, "video"), [["B", 0, 0, 6], ["A", 6, 0, 4]]);
  assert.deepEqual(layout(t, "audio"), [["B", 0, 0, 6], ["A", 6, 0, 4]]);

  t = T.moveStep(base(), "A", 1, 0.04);
  assert.deepEqual(layout(t, "video").map((c) => c[0]), ["B", "A"]);
  assert.equal(T.moveStep(base(), "A", -1, 0.04), null); // já é o primeiro

  const { t: u, a } = unlinkedA();
  assert.equal(T.move(u, a, 3), null); // ocuparia o B
  const gap = T.remove(T.remove(u, "B"), a); // só o vídeo do A, áudio vazio
  const withMusic = { ...gap, faixas: [gap.faixas[0], { tipo: "audio", clips: [clip("M", "m", 0, 2, 0)] }] };
  assert.deepEqual(layout(T.move(withMusic, "M", 1.5), "audio"), [["M", 1.5, 0, 2]]);
});
