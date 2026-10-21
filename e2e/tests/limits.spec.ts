import { expect, Page, test } from "@playwright/test";
import { Account, clip, exportTasks, openEditor, output, startExport, totalDuration, videoClip } from "./helpers";

// Limites da exportação por perfil: avisados no painel (Export desativado)
// e recusados pelo servidor (422) mesmo que o pedido chegue lá.

const exportButton = (page: Page) => page.getByRole("button", { name: "Export", exact: true });
// o Next.js tem também um role="alert" (anúncio de rotas): procurar só no painel
const blocker = (page: Page) => page.getByRole("tabpanel", { name: "Export" }).getByRole("alert");

async function openExportTab(page: Page) {
  await page.getByRole("tab", { name: "Export" }).click();
}

async function expectBlocked(page: Page, account: Account, pid: string, message: RegExp, code: string) {
  await openExportTab(page);
  await expect(blocker(page)).toContainText(message);
  await expect(exportButton(page)).toBeDisabled();
  const r = await account.exportTimeline(pid);
  expect(r.status()).toBe(422);
  expect((await r.json()).code).toBe(code);
}

test.describe("registered account", () => {
  test("final duration up to 10 minutes", async ({ page, request }) => {
    const account = await Account.create(request);
    const pid = await account.createProject();
    const [long] = await account.uploadAll(pid, "long.mp4");
    await account.putTimeline(pid, [{ tipo: "video", clips: [clip("l", long._id, 0, 660, 0)] }], output({ largura: 64, altura: 64 }));
    await openEditor(page, account, pid);
    await expect(totalDuration(page)).toHaveText("/ 00:11:00.000");
    await expectBlocked(page, account, pid, /up to 10 minutes long/, "duration_limit");
  });

  test("output up to 1080p", async ({ page, request }) => {
    const account = await Account.create(request);
    const pid = await account.createProject();
    await account.uploadAll(pid, "a.mp4");
    await openEditor(page, account, pid);
    await page.getByRole("button", { name: "Add a.mp4 to the timeline" }).click();
    await openExportTab(page);

    // Os presets acima de 1080p aparecem desativados
    await page.getByLabel("Resolution").click();
    await expect(page.getByRole("option", { name: "1440p · 2560×1440 · Premium" })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("option", { name: "2160p (4K) · 3840×2160 · Premium" })).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");

    // ...e um tamanho livre acima de 1080p também é recusado
    await page.getByLabel("Width").fill("2560");
    await page.getByLabel("Width").press("Enter");
    await page.getByLabel("Height").fill("1440");
    await page.getByLabel("Height").press("Enter");
    await expectBlocked(page, account, pid, /up to 1080p/, "resolution_limit");

    // 1080p na vertical está dentro do limite
    await page.getByLabel("Width").fill("1080");
    await page.getByLabel("Width").press("Enter");
    await page.getByLabel("Height").fill("1920");
    await page.getByLabel("Height").press("Enter");
    await expect(blocker(page)).toHaveCount(0);
    await expect(exportButton(page)).toBeEnabled();
  });

  test("up to 5 different source videos", async ({ page, request }) => {
    const account = await Account.create(request);
    const pid = await account.createProject();
    const files = ["a.mp4", "b.mp4", "mute.mp4", "hevc.mov", "clip.avi", "slow.mp4"];
    await account.uploadAll(pid, ...files);
    await openEditor(page, account, pid);
    for (const f of files) await page.getByRole("button", { name: `Add ${f} to the timeline` }).click();
    await expect(videoClip(page, "slow.mp4")).toBeVisible();
    await openExportTab(page);
    await expect(page.getByText("6 of 5")).toBeVisible();
    await expectBlocked(page, account, pid, /up to 5 different videos/, "too_many_sources");
  });

  test("the result must last at least 5 seconds", async ({ page, request }) => {
    const account = await Account.create(request);
    const pid = await account.createProject();
    await account.uploadAll(pid, "a.mp4");
    await openEditor(page, account, pid);
    await page.getByRole("button", { name: "Add a.mp4 to the timeline" }).click();

    // aparar no inspetor: Source out = 3 s
    await videoClip(page, "a.mp4").click();
    await page.getByLabel("Source out").fill("00:00:03.000");
    await page.getByLabel("Source out").press("Enter");
    await expect(totalDuration(page)).toHaveText("/ 00:00:03.000");
    await expectBlocked(page, account, pid, /at least 5 seconds/, "result_too_short");
  });
});

test("premium: no limit on duration, resolution or number of sources", async ({ page, request }) => {
  const account = await Account.create(request, "premium");
  const pid = await account.createProject();
  const files = ["long.mp4", "a.mp4", "b.mp4", "mute.mp4", "hevc.mov", "clip.avi"];
  await account.uploadAll(pid, ...files);
  await openEditor(page, account, pid);
  for (const f of files) await page.getByRole("button", { name: `Add ${f} to the timeline` }).click();
  await expect(videoClip(page, "clip.avi")).toBeVisible();

  await openExportTab(page);
  await page.getByLabel("Resolution").click();
  await page.getByRole("option", { name: "1440p · 2560×1440", exact: true }).click();
  await expect(page.getByText("6 of 20")).toBeVisible();
  await expect(blocker(page)).toHaveCount(0);
  await expect(page.getByText(/operations you have left/)).toHaveCount(0); // não gasta quota

  // 11 min, 1440p e 6 origens: o servidor aceita (cancela-se logo para não ocupar o worker)
  const task = await startExport(page);
  await expect(task).toContainText(/Queued|Processing/);
  await task.getByRole("button", { name: "Cancel" }).click();
  await expect(task).toContainText("Cancelled");
  await expect(exportTasks(page)).toHaveCount(1);
});
