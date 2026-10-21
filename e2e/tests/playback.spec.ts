import { expect, Page, test } from "@playwright/test";
import { Account, addToTimeline, openEditor, setPlayhead, splitAt, totalDuration, videoClip } from "./helpers";

// Pré-visualização sem render: o <video> e o <audio> (sobre os proxies H.264)
// têm de seguir o relógio da timeline, e tem de haver imagem.

type Sample = {
  playhead: number;
  video: { t: number; paused: boolean; ready: number; width: number };
  audio: { t: number; paused: boolean };
  luma: number;
};

async function sample(page: Page): Promise<Sample> {
  return page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>("[data-testid=preview-video]")!;
    const a = document.querySelector<HTMLAudioElement>("[data-testid=preview-audio]")!;
    const field = document.getElementById("playhead") as HTMLInputElement;
    const [h, m, s] = field.value.split(":").map(Number);
    // Imagem: luminância média do fotograma atual (preto = não descodificou)
    const c = document.createElement("canvas");
    c.width = 32;
    c.height = 18;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let luma = 0;
    for (let i = 0; i < d.length; i += 4) luma += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return {
      playhead: (h * 60 + m) * 60 + s,
      video: { t: v.currentTime, paused: v.paused, ready: v.readyState, width: v.videoWidth },
      audio: { t: a.currentTime, paused: a.paused },
      luma: luma / (d.length / 4),
    };
  });
}

const playhead = (page: Page) =>
  page.getByLabel("Time (hh:mm:ss.mmm)").evaluate((el: HTMLInputElement) => {
    const [h, m, s] = el.value.split(":").map(Number);
    return (h * 60 + m) * 60 + s;
  });

function expectInSync(s: Sample, sourceOffset = 0) {
  expect(s.video.paused, "video playing").toBe(false);
  expect(s.audio.paused, "audio playing").toBe(false);
  expect(s.video.ready).toBeGreaterThanOrEqual(2);
  expect(s.video.width).toBeGreaterThan(0);
  expect(s.luma, "the frame is not black").toBeGreaterThan(20);
  // a imagem e o som seguem o relógio (tolerância de ~ 1 fotograma de ecrã + o atraso do rAF)
  expect(Math.abs(s.video.t - (s.playhead + sourceOffset))).toBeLessThan(0.25);
  expect(Math.abs(s.audio.t - s.video.t)).toBeLessThan(0.15);
}

for (const file of ["a.mp4", "hevc.mov", "clip.avi"]) {
  test(`plays the ${file} proxy with picture and sound following the clock`, async ({ page, request }) => {
    const account = await Account.create(request);
    const pid = await account.createProject();
    await account.uploadAll(pid, file);
    await openEditor(page, account, pid);
    await addToTimeline(page, file);
    await expect(videoClip(page, file)).toBeVisible();

    await page.getByRole("button", { name: "Play (Space)" }).click();
    await expect.poll(() => playhead(page)).toBeGreaterThan(1);
    const first = await sample(page);
    expectInSync(first);

    await expect.poll(() => playhead(page)).toBeGreaterThan(first.playhead + 1.5);
    const second = await sample(page);
    expectInSync(second);
    // passou o mesmo tempo no relógio, na imagem e no som
    expect(second.video.t - first.video.t).toBeCloseTo(second.playhead - first.playhead, 0);

    await page.getByRole("button", { name: "Pause (Space)" }).click();
    await expect(page.getByTestId("preview-video")).toHaveJSProperty("paused", true);
  });
}

test("playback jumps over a deleted segment and keeps picture and sound together", async ({ page, request }) => {
  const account = await Account.create(request);
  const pid = await account.createProject();
  await account.uploadAll(pid, "a.mp4");
  await openEditor(page, account, pid);
  await addToTimeline(page, "a.mp4");

  // corte de 1 s a 3 s: a partir de 1 s na timeline vem o segundo 3 do original
  await splitAt(page, "00:00:01.000");
  await splitAt(page, "00:00:03.000");
  await videoClip(page, "a.mp4", "00:00:01.000", "00:00:03.000").click();
  await page.keyboard.press("Delete");
  await expect(totalDuration(page)).toHaveText("/ 00:00:06.000");

  await setPlayhead(page, "00:00:00.500");
  await page.getByRole("button", { name: "Play (Space)" }).click();
  await expect.poll(() => playhead(page)).toBeGreaterThan(1.8);
  expectInSync(await sample(page), 2); // origem = timeline + 2 s
  await page.getByRole("button", { name: "Pause (Space)" }).click();
});
