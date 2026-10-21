import { expect, test } from "@playwright/test";
import {
  Account,
  addToTimeline,
  audioClip,
  choose,
  exportAndWait,
  frameStats,
  openEditor,
  splitAt,
  totalDuration,
  videoClip,
} from "./helpers";

// Os 5 casos de uso de vídeo, feitos no editor e exportados.

test("cut: split at the playhead and delete the middle segment", async ({ page, request }) => {
  const account = await Account.create(request);
  const pid = await account.createProject();
  await account.uploadAll(pid, "a.mp4");
  await openEditor(page, account, pid);

  await addToTimeline(page, "a.mp4");
  await expect(totalDuration(page)).toHaveText("/ 00:00:08.000");

  await splitAt(page, "00:00:02.000");
  await splitAt(page, "00:00:04.000");
  await videoClip(page, "a.mp4", "00:00:02.000", "00:00:04.000").click();
  await page.keyboard.press("Delete");

  // O que vinha depois encostou, no vídeo e no áudio
  await expect(totalDuration(page)).toHaveText("/ 00:00:06.000");
  await expect(videoClip(page, "a.mp4", "00:00:02.000", "00:00:06.000")).toBeVisible();
  await expect(audioClip(page, "a.mp4", "00:00:02.000", "00:00:06.000")).toBeVisible();

  const task = await exportAndWait(page);
  await expect(task).toContainText("a_edit.mp4");
  await expect(task).toContainText("MP4 · 320×240 · 00:00:06.000");

  const result = (await account.videos(pid)).find((v) => v.name === "a_edit.mp4")!;
  expect(result.duration).toBeCloseTo(6, 1);
  expect(result.hasAudio).toBe(true);
});

test("speed: a clip at 2x lasts half and plays at 2x in the preview", async ({ page, request }) => {
  const account = await Account.create(request);
  const pid = await account.createProject();
  await account.uploadAll(pid, "a.mp4", "b.mp4");
  await openEditor(page, account, pid);

  // 8 s a 2x = 4 s (sozinho ficava abaixo do mínimo de 5 s); o b.mp4 encosta
  await addToTimeline(page, "a.mp4");
  await addToTimeline(page, "b.mp4");
  await videoClip(page, "a.mp4").click();
  await choose(page, "Speed", "2×");
  await expect(totalDuration(page)).toHaveText("/ 00:00:10.000");
  await expect(videoClip(page, "a.mp4")).toContainText("2×");
  await expect(videoClip(page, "b.mp4", "00:00:04.000", "00:00:10.000")).toBeVisible();

  await page.getByRole("button", { name: "Play (Space)" }).click();
  await expect
    .poll(() => page.getByTestId("preview-video").evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(1);
  const rates = await page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>("[data-testid=preview-video]")!;
    const a = document.querySelector<HTMLAudioElement>("[data-testid=preview-audio]")!;
    return { video: v.playbackRate, audio: a.playbackRate, pitch: a.preservesPitch };
  });
  expect(rates).toEqual({ video: 2, audio: 2, pitch: true });
  await page.getByRole("button", { name: "Pause (Space)" }).click();

  await exportAndWait(page);
  const result = (await account.videos(pid)).find((v) => v.name === "a_edit.mp4")!;
  expect(result.duration).toBeCloseTo(10, 1);
});

test("conversion: MOV/H.265 to AVI with low quality becomes H.264", async ({ page, request }) => {
  const account = await Account.create(request);
  const pid = await account.createProject();
  await account.uploadAll(pid, "hevc.mov");
  await openEditor(page, account, pid);

  await addToTimeline(page, "hevc.mov");
  await page.getByRole("tab", { name: "Export" }).click();
  await choose(page, "Format", "AVI");
  await choose(page, "Quality", "Low");
  await expect(page.getByText("Converted to H.264 + MP3.")).toBeVisible();

  const task = await exportAndWait(page);
  await expect(task).toContainText("hevc_edit.avi");
  await expect(task).toContainText("AVI · 640×360");

  const result = (await account.videos(pid)).find((v) => v.name === "hevc_edit.avi")!;
  expect([result.format, result.codec, result.width, result.height]).toEqual(["avi", "h264", 640, 360]);
});

test("concatenation: three sources, one of them without audio", async ({ page, request }) => {
  const account = await Account.create(request);
  const pid = await account.createProject();
  await account.uploadAll(pid, "a.mp4", "mute.mp4", "hevc.mov");
  await openEditor(page, account, pid);

  await addToTimeline(page, "a.mp4");
  await addToTimeline(page, "mute.mp4");
  await addToTimeline(page, "hevc.mov");
  await expect(totalDuration(page)).toHaveText("/ 00:00:20.000");
  await expect(videoClip(page, "mute.mp4", "00:00:08.000", "00:00:14.000")).toBeVisible();
  await expect(audioClip(page, "mute.mp4")).toHaveCount(0); // buraco: silêncio no render
  await expect(audioClip(page, "hevc.mov", "00:00:14.000", "00:00:20.000")).toBeVisible();

  const task = await exportAndWait(page);
  await expect(task).toContainText("MP4 · 320×240 · 00:00:20.000"); // saída herdada do primeiro vídeo

  const result = (await account.videos(pid)).find((v) => v.name === "a_edit.mp4")!;
  expect(result.duration).toBeCloseTo(20, 1);
  expect(result.hasAudio).toBe(true);
});

test("resize and reframe: 4:3 to 16:9 with black bars (pad) and filled (crop)", async ({ page, request }) => {
  const account = await Account.create(request);
  const pid = await account.createProject();
  await account.uploadAll(pid, "a.mp4");
  await openEditor(page, account, pid);

  await addToTimeline(page, "a.mp4");
  await page.getByRole("tab", { name: "Export" }).click();
  await choose(page, "Resolution", "720p · 1280×720");
  await choose(page, "Reframe", "Fit (black bars)");
  await expect(page.getByTestId("preview-video")).toHaveClass(/object-contain/);
  await exportAndWait(page);

  await choose(page, "Reframe", "Fill (crop)");
  await expect(page.getByTestId("preview-video")).toHaveClass(/object-cover/);
  await exportAndWait(page);

  const videos = await account.videos(pid);
  const pad = videos.find((v) => v.name === "a_edit.mp4")!;
  const crop = videos.find((v) => v.name === "a_edit_2.mp4")!;
  for (const v of [pad, crop]) expect([v.width, v.height]).toEqual([1280, 720]);

  // Pad: barras pretas dos lados; crop: imagem até à borda
  const padFrame = await frameStats(page, pad.url!);
  expect(padFrame.left).toBeLessThan(20);
  expect(padFrame.center).toBeGreaterThan(40);
  const cropFrame = await frameStats(page, crop.url!);
  expect(cropFrame.left).toBeGreaterThan(40);
});
