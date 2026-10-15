import { expect, Page, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  Account,
  addToTimeline,
  audioClip,
  choose,
  FIXTURES,
  openEditor,
  splitAt,
  startExport,
  totalDuration,
  videoClip,
} from "../tests/helpers";

// Demonstração gravada do editor de vídeo; fica fora da suite (testDir é ./tests).
// Corre no host, com o Chrome do host, contra a stack local:
//   cd e2e && PATH=~/.local/opt/node-v22.23.3-linux-x64/bin:$PATH DISPLAY=:0 npx playwright test -c demo
// O vídeo fica em ~/picturas-demo/demo.webm.

const OUT_DIR = path.join(homedir(), "picturas-demo");
const CHROME = path.join(homedir(), ".local/opt/google-chrome-deb/opt/google/chrome/chrome");
const size = { width: 1920, height: 1080 };
const baseURL = process.env.BASE_URL ?? "https://localhost:8080";

test.use({ baseURL, ignoreHTTPSErrors: true, launchOptions: { executablePath: CHROME, headless: false, slowMo: 250 } });

/** Legenda por cima da página, a dizer o que está a acontecer, seguida de uma pausa. */
async function say(page: Page, text: string, pause = 1500) {
  await page.evaluate((t) => {
    let el = document.getElementById("demo-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "demo-caption";
      el.style.cssText =
        "position:fixed;left:50%;top:72px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;" +
        "max-width:80%;padding:14px 28px;border-radius:12px;background:rgba(0,0,0,.8);color:#fff;" +
        "font:600 28px/1.3 system-ui,sans-serif;text-align:center";
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
  await page.waitForTimeout(pause);
}

/** Envia um vídeo pela zona de upload e espera pela pré-visualização. */
async function upload(page: Page, file: string) {
  await page.locator("input[type=file]").setInputFiles(path.join(FIXTURES, file));
  await expect(page.getByRole("button", { name: `Add ${file} to the timeline` })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("Preparing preview…")).toHaveCount(0, { timeout: 180_000 });
}

test("video editor demo", async ({ browser, request }) => {
  test.setTimeout(15 * 60_000);
  mkdirSync(OUT_DIR, { recursive: true });

  const account = await Account.create(request);
  const pid = await account.createProject("Video editor demo");

  const context = await browser.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
    viewport: size,
    recordVideo: { dir: OUT_DIR, size },
  });
  const page = await context.newPage();

  await openEditor(page, account, pid);
  await say(page, "PictuRAS video editor: a new project, with no videos yet", 2500);

  // Upload
  await say(page, "1. Upload: a.mp4 (8 s, with sound)");
  await upload(page, "a.mp4");
  await say(page, "The upload is done and the preview proxy is ready");
  await addToTimeline(page, "a.mp4");
  await expect(totalDuration(page)).toHaveText("/ 00:00:08.000");
  // Zoom de 40 para 140 px/s, para os clips se verem bem no vídeo
  const zoom = page.locator('[aria-label="Timeline zoom"] [role=slider]');
  await zoom.focus();
  for (let i = 0; i < 10; i++) await zoom.press("PageUp");
  await say(page, "a.mp4 is on the timeline: 8 s of video and audio, linked", 2000);

  // Corte
  await say(page, "2. Cut: split at 2 s and at 4 s");
  await splitAt(page, "00:00:02.000");
  await page.waitForTimeout(800);
  await splitAt(page, "00:00:04.000");
  await say(page, "Three segments now. Select the middle one and press Delete");
  await videoClip(page, "a.mp4", "00:00:02.000", "00:00:04.000").click();
  await page.waitForTimeout(800);
  await page.keyboard.press("Delete");
  await expect(totalDuration(page)).toHaveText("/ 00:00:06.000");
  await say(page, "The middle 2 s are gone and the rest closes the gap: 6 s", 2000);

  // Velocidade
  await say(page, "3. Speed: the last segment at 2×");
  await videoClip(page, "a.mp4", "00:00:02.000", "00:00:06.000").click();
  await choose(page, "Speed", "2×");
  await expect(totalDuration(page)).toHaveText("/ 00:00:04.000");
  await say(page, "4 s at 2× last 2 s: the timeline is now 4 s long", 2000);
  await page.getByRole("button", { name: "Go to start" }).click();
  await say(page, "Preview from the start: the second part plays at double speed", 500);
  await page.getByRole("button", { name: "Play (Space)" }).click();
  await expect(page.getByRole("button", { name: "Pause (Space)" })).toBeVisible();
  // A reprodução para sozinha no fim da timeline
  await expect(page.getByRole("button", { name: "Play (Space)" })).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1000);

  // Concatenação
  await say(page, "4. Concatenation: upload mute.mp4, a 6 s video with no audio track");
  await upload(page, "mute.mp4");
  await addToTimeline(page, "mute.mp4");
  await expect(totalDuration(page)).toHaveText("/ 00:00:10.000");
  await expect(videoClip(page, "mute.mp4")).toBeVisible();
  await expect(audioClip(page, "mute.mp4")).toHaveCount(0);
  await say(page, "Appended after a.mp4: 10 s in total. It has no audio clip, so that part is silent", 2500);

  // Reenquadramento
  await say(page, "5. Reframe: output at 720p (16:9) from 4:3 sources");
  await page.getByRole("tab", { name: "Export" }).click();
  await choose(page, "Resolution", "720p · 1280×720");
  await choose(page, "Reframe", "Fill (crop)");
  await expect(page.getByTestId("preview-video")).toHaveClass(/object-cover/);
  await say(page, "Fill (crop): the image fills the 16:9 frame and the top and bottom are cut", 2500);
  await choose(page, "Reframe", "Fit (black bars)");
  await expect(page.getByTestId("preview-video")).toHaveClass(/object-contain/);
  await say(page, "Fit (pad): the whole image is kept, with black bars on the sides", 2500);

  // Undo/redo
  await say(page, "6. Undo and redo (Ctrl+Z / Ctrl+Shift+Z)");
  await page.getByRole("button", { name: "Undo (Ctrl+Z)" }).click();
  await expect(page.getByTestId("preview-video")).toHaveClass(/object-cover/);
  await say(page, "Undo: back to Fill (crop)", 2000);
  await page.getByRole("button", { name: "Redo (Ctrl+Shift+Z)" }).click();
  await expect(page.getByTestId("preview-video")).toHaveClass(/object-contain/);
  await say(page, "Redo: Fit (black bars) again", 2000);

  // Exportação
  await say(page, "7. Export: MP4, 1280×720, 10 s. This renders the original files on the server");
  const task = await startExport(page);
  await say(page, "The export is a task: queued, then processing. Progress arrives over WebSocket");
  await expect(task).toContainText("Done", { timeout: 240_000 });
  await expect(task).toContainText("a_edit.mp4");
  await say(page, "Done: a_edit.mp4 is ready and was added to the project's videos", 2500);

  // Reprodução do resultado
  const result = (await account.videos(pid)).find((v) => v.name === "a_edit.mp4")!;
  await say(page, "8. Playing the exported file");
  await page.goto(result.url!);
  await say(page, "a_edit.mp4: cut, sped up, joined with the silent video, and padded to 16:9", 11_000);

  await context.close();
  await page.video()!.saveAs(path.join(OUT_DIR, "demo.webm"));
  await page.video()!.delete();
});
