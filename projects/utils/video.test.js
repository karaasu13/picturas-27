// Testes das regras puras de vídeo. Sem dependências: `npm test`.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { checkExportLimits, resultName, validateProbe, validateTimeline } = require("./video");

const videos = new Map([
  ["a", { _id: "a", name: "a.mp4", duration: 10, has_audio: true }],
  ["mute", { _id: "mute", name: "mute.mp4", duration: 6, has_audio: false }],
]);

const output = { formato: "mp4", qualidade: "media", largura: 1280, altura: 720, fit: "pad" };
const clip = (over = {}) => ({ link_id: "l1", video_id: "a", in: 0, out: 4, speed: 1, posicao: 0, ...over });
const timeline = (video = [clip()], audio = [clip()], out = output) => ({
  output: out,
  faixas: [
    { tipo: "video", clips: video },
    { tipo: "audio", clips: audio },
  ],
});

const message = (body) => {
  const r = validateTimeline(body, videos);
  assert.equal(r.ok, false);
  assert.equal(r.code, "invalid_timeline");
  return r.message;
};

test("accepts a valid timeline and computes the final duration", () => {
  const r = validateTimeline(
    timeline([clip(), clip({ link_id: "l2", in: 6, out: 10, speed: 2, posicao: 4 })], [clip()]),
    videos,
  );
  assert.equal(r.ok, true);
  assert.equal(r.duration, 6); // 4 s + (4 s a 2x)
  assert.deepEqual(r.timeline.output, output);
});

test("rejects invalid output enums", () => {
  assert.match(message(timeline(undefined, undefined, { ...output, formato: "mkv" })), /format/);
  assert.match(message(timeline(undefined, undefined, { ...output, qualidade: "ultra" })), /quality/);
  assert.match(message(timeline(undefined, undefined, { ...output, fit: "stretch" })), /fit/);
  assert.match(message({ faixas: [] }), /output/);
});

test("rejects odd or out-of-range output sizes", () => {
  for (const [largura, altura] of [[1281, 720], [1280, 0], [8, 8], [4098, 2160], [1280.5, 720]]) {
    assert.match(message(timeline(undefined, undefined, { ...output, largura, altura })), /even numbers/);
  }
  assert.equal(validateTimeline(timeline(undefined, undefined, { ...output, largura: 4096, altura: 16 }), videos).ok, true);
});

test("rejects clips of videos from another project", () => {
  assert.match(message(timeline([clip({ video_id: "other" })], [])), /no longer in this project/);
});

test("rejects in/out outside the source duration", () => {
  assert.match(message(timeline([clip({ in: -1 })], [])), /outside/);
  assert.match(message(timeline([clip({ in: 4, out: 4 })], [])), /outside/);
  assert.match(message(timeline([clip({ out: 10.5 })], [])), /outside/);
  assert.equal(validateTimeline(timeline([clip({ out: 10.0004 })], []), videos).ok, true); // tolerância de 1 ms
});

test("rejects speeds outside 0.25x-4x", () => {
  assert.match(message(timeline([clip({ speed: 0.2 })], [])), /speed/);
  assert.match(message(timeline([clip({ speed: 5 })], [])), /speed/);
  assert.match(message(timeline([clip({ speed: "fast" })], [])), /numbers/);
  assert.equal(validateTimeline(timeline([clip({ speed: 0.25 }), clip({ speed: 4, posicao: 16 })], []), videos).ok, true);
});

test("rejects audio clips from a video without audio", () => {
  assert.match(message(timeline([clip({ video_id: "mute" })], [clip({ video_id: "mute" })])), /has no audio/);
  assert.equal(validateTimeline(timeline([clip({ video_id: "mute" })], []), videos).ok, true);
});

test("rejects overlapping clips on the same track, in any order", () => {
  assert.match(message(timeline([clip({ link_id: "b", posicao: 3 }), clip()], [])), /overlap/);
  // 4 s a 0,5x ocupa 8 s
  assert.match(message(timeline([clip({ speed: 0.5 }), clip({ link_id: "b", posicao: 7 })], [])), /overlap/);
});

test("allows gaps and sorts clips by position", () => {
  const r = validateTimeline(timeline([clip({ link_id: "b", posicao: 9 }), clip({ posicao: 1 })], [clip({ posicao: 5 })]), videos);
  assert.equal(r.ok, true);
  assert.deepEqual(r.timeline.faixas[0].clips.map((c) => c.posicao), [1, 9]);
  assert.equal(r.duration, 13);
});

test("rounds times to the millisecond", () => {
  const r = validateTimeline(timeline([clip({ in: 0.12345, out: 3.99951, posicao: 0.0006 })], []), videos);
  assert.equal(r.ok, true);
  const c = r.timeline.faixas[0].clips[0];
  assert.deepEqual([c.in, c.out, c.posicao], [0.123, 4, 0.001]);
});

test("rejects malformed tracks and links", () => {
  assert.match(message({ output, faixas: [] }), /tracks/);
  assert.match(message({ output, faixas: [{ tipo: "subtitles", clips: [] }] }), /track/);
  assert.match(message(timeline([clip({ link_id: "" })], [])), /link/);
});

test("rejects more than one video or audio track", () => {
  const two = (tipo) => ({ output, faixas: [{ tipo, clips: [] }, { tipo, clips: [] }] });
  assert.match(message(two("video")), /only one video track and one audio track/);
  assert.match(message(two("audio")), /only one video track and one audio track/);
  assert.equal(validateTimeline({ output, faixas: [{ tipo: "video", clips: [] }] }, videos).ok, true);
});

// ------------------------------------------------------- limites da exportação

const limits = (over = {}) =>
  checkExportLimits({ duration: 60, output: { largura: 1920, altura: 1080 }, sourceCount: 1, userType: "free", ...over });
const size = (largura, altura) => ({ output: { largura, altura } });
const code = (r) => (r.ok ? "ok" : r.code);

test("export: anonymous users and empty timelines are refused", () => {
  assert.deepEqual([limits({ userType: "anonymous" }).status, code(limits({ userType: "anonymous" }))], [403, "anonymous"]);
  assert.equal(code(limits({ duration: 0 })), "empty_timeline");
});

test("export: the result must last at least 5 s (both plans)", () => {
  for (const userType of ["free", "premium"]) {
    assert.equal(code(limits({ userType, duration: 4.999 })), "result_too_short");
    assert.equal(code(limits({ userType, duration: 5 })), "ok");
  }
});

test("export: registered accounts up to 10 min of final duration, premium without limit", () => {
  assert.equal(code(limits({ duration: 600 })), "ok");
  assert.equal(code(limits({ duration: 600.001 })), "duration_limit");
  assert.equal(code(limits({ userType: "premium", duration: 4 * 3600 })), "ok");
});

test("export: registered accounts up to 1080p in any orientation, premium up to 4096", () => {
  assert.equal(code(limits(size(1920, 1080))), "ok");
  assert.equal(code(limits(size(1080, 1920))), "ok");
  assert.equal(code(limits(size(1920, 1088))), "resolution_limit");
  assert.equal(code(limits(size(2560, 1440))), "resolution_limit");
  assert.match(limits(size(2560, 1440)).message, /1080p/);
  assert.equal(code(limits({ userType: "premium", ...size(4096, 2160) })), "ok");
  assert.equal(code(limits({ userType: "premium", ...size(4096, 4096) })), "ok");
});

test("export: up to 5 source videos for registered accounts and 20 for premium", () => {
  assert.equal(code(limits({ sourceCount: 5 })), "ok");
  assert.equal(code(limits({ sourceCount: 6 })), "too_many_sources");
  assert.match(limits({ sourceCount: 6 }).message, /up to 5/);
  assert.equal(code(limits({ userType: "premium", sourceCount: 20 })), "ok");
  assert.equal(code(limits({ userType: "premium", sourceCount: 21 })), "too_many_sources");
  assert.match(limits({ userType: "premium", sourceCount: 21 }).message, /up to 20/);
});

// ------------------------------------------------------------ vídeos

test("uses the video track duration, not the container's", () => {
  const probe = (videoDuration) => ({
    format: { format_name: "avi", duration: "7.104000" },
    streams: [
      { codec_type: "video", codec_name: "h264", width: 640, height: 360, avg_frame_rate: "25/1", duration: videoDuration },
      { codec_type: "audio", codec_name: "mp3", duration: "7.104000" },
    ],
  });
  assert.equal(validateProbe(probe("7.000000"), "clip.avi").meta.duration, 7);
  // sem duração na faixa de vídeo: usa a do contentor
  assert.equal(validateProbe(probe(undefined), "clip.avi").meta.duration, 7.104);
});

test("export names never collide with existing videos", () => {
  assert.equal(resultName("a.mp4", ["a.mp4"], "mp4"), "a_edit.mp4");
  assert.equal(resultName("a.mp4", ["a.mp4", "a_edit.mp4"], "mp4"), "a_edit_2.mp4");
  assert.equal(resultName("a.mp4", ["a_edit.mp4", "a_edit_2.mp4"], "mp4"), "a_edit_3.mp4");
  assert.equal(resultName("a.mov", ["a_edit.mp4"], "avi"), "a_edit.avi");
});
