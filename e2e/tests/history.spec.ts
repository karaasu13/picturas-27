import { expect, test } from "@playwright/test";
import {
  Account,
  addToTimeline,
  audioClip,
  openEditor,
  splitAt,
  toasts,
  totalDuration,
  updateVideoInDb,
  videoClip,
} from "./helpers";

test("undo and redo, with the buttons and the keyboard", async ({ page, request }) => {
  const account = await Account.create(request);
  const pid = await account.createProject();
  await account.uploadAll(pid, "a.mp4");
  await openEditor(page, account, pid);

  const undo = page.getByRole("button", { name: "Undo (Ctrl+Z)" });
  const redo = page.getByRole("button", { name: "Redo (Ctrl+Shift+Z)" });
  await expect(undo).toBeDisabled();

  await addToTimeline(page, "a.mp4");
  await splitAt(page, "00:00:05.000");
  await videoClip(page, "a.mp4", "00:00:05.000", "00:00:08.000").click();
  await page.keyboard.press("Delete");
  await expect(totalDuration(page)).toHaveText("/ 00:00:05.000");

  await undo.click();
  await expect(totalDuration(page)).toHaveText("/ 00:00:08.000");
  await expect(redo).toBeEnabled();
  await redo.click();
  await expect(totalDuration(page)).toHaveText("/ 00:00:05.000");

  await page.locator("body").press("ControlOrMeta+z");
  await expect(totalDuration(page)).toHaveText("/ 00:00:08.000");
  await page.locator("body").press("ControlOrMeta+Shift+z");
  await expect(totalDuration(page)).toHaveText("/ 00:00:05.000");

  // O histórico fica no servidor: sobrevive a recarregar a página
  await page.reload();
  await expect(totalDuration(page)).toHaveText("/ 00:00:05.000");
  await undo.click();
  await expect(totalDuration(page)).toHaveText("/ 00:00:08.000");
});

test("unlink lets the audio be edited on its own, link joins it again", async ({ page, request }) => {
  const account = await Account.create(request);
  const pid = await account.createProject();
  await account.uploadAll(pid, "a.mp4");
  await openEditor(page, account, pid);
  await addToTimeline(page, "a.mp4");

  const audio = audioClip(page, "a.mp4", "00:00:00.000", "00:00:08.000");
  await audio.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unlink audio and video" }).click();
  await expect(audio.getByLabel("Unlinked")).toBeVisible();

  // Apagar só o áudio: o vídeo fica e não há ripple (buraco de silêncio)
  await audio.click();
  await page.keyboard.press("Delete");
  await expect(audioClip(page, "a.mp4")).toHaveCount(0);
  await expect(videoClip(page, "a.mp4", "00:00:00.000", "00:00:08.000")).toBeVisible();
  await expect(totalDuration(page)).toHaveText("/ 00:00:08.000");

  await page.getByRole("button", { name: "Undo (Ctrl+Z)" }).click();
  await expect(audio).toBeVisible();

  await audio.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Link audio and video" }).click();
  await expect(audio.getByLabel("Unlinked")).toHaveCount(0);

  // Ligados outra vez: apagar o áudio leva o vídeo também
  await audio.click();
  await page.keyboard.press("Delete");
  await expect(videoClip(page, "a.mp4")).toHaveCount(0);
  await expect(totalDuration(page)).toHaveText("/ 00:00:00.000");
});

test("deleting a video used in the timeline explains why it can't be deleted", async ({ page, request }) => {
  const account = await Account.create(request);
  const pid = await account.createProject();
  await account.uploadAll(pid, "a.mp4");
  await openEditor(page, account, pid);
  await addToTimeline(page, "a.mp4");
  await expect(videoClip(page, "a.mp4")).toBeVisible();

  await page.getByRole("button", { name: "Delete a.mp4" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(toasts(page).getByText("Video in use")).toBeVisible();
  await expect(toasts(page).getByText(/is being used in the timeline\. Remove its clips/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a.mp4 to the timeline" })).toBeVisible();
});

test("a failed preview can be prepared again with Retry", async ({ page, request, browserName }) => {
  test.skip(browserName !== "chromium", "precisa de acesso ao Docker; basta correr num browser");
  const account = await Account.create(request);
  const pid = await account.createProject();
  const [video] = await account.uploadAll(pid, "a.mp4");

  // Estado que a UI não cria sozinha: a pré-visualização falhou
  updateVideoInDb(video._id, { $set: { "preview.state": "failed" } });
  await openEditor(page, account, pid);
  await addToTimeline(page, "a.mp4");
  await expect(page.getByText("Preview unavailable for a.mp4.")).toBeVisible();

  await page.getByRole("button", { name: /Preview failed · Retry/ }).click();
  await expect(page.getByText("Preparing preview…").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Retry/ })).toHaveCount(0, { timeout: 120_000 });
  await expect(page.getByText("Preparing preview…")).toHaveCount(0, { timeout: 120_000 });
  await expect(page.getByTestId("preview-video")).not.toHaveClass(/invisible/);
});
