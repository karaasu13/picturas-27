import { expect, Page, test } from "@playwright/test";
import { Account, clip, openEditor, output, serviceLogs, startExport, toasts } from "./helpers";

// Quota diária do perfil Registado: a exportação reserva 1 operação, que é
// devolvida se for cancelada (pelo utilizador ou ao apagar o projeto).

// Exportação que demora o suficiente para se apanhar "Processing": 2 min em 1080p
async function slowTimeline(account: Account, pid: string) {
  const [slow] = await account.uploadAll(pid, "slow.mp4");
  await account.putTimeline(
    pid,
    [
      { tipo: "video", clips: [clip("s", slow._id, 0, 120, 0)] },
      { tipo: "audio", clips: [clip("s", slow._id, 0, 120, 0)] },
    ],
    output({ qualidade: "alta", largura: 1920, altura: 1080 }),
  );
}

// Menu do projeto na barra lateral: Delete -> Permanently Delete
async function deleteFromSidebar(page: Page, name: string) {
  await page.getByRole("button", { name: `More actions for ${name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Permanently Delete" }).click();
}

const quotaHint = (page: Page, n: number) => page.getByText(`Uses 1 of the ${n} operations you have left today`);

test("an export reserves one operation and cancelling gives it back", async ({ page, request }) => {
  const account = await Account.create(request);
  const pid = await account.createProject();
  await slowTimeline(account, pid);
  await openEditor(page, account, pid);
  await page.getByRole("tab", { name: "Export" }).click();
  await expect(quotaHint(page, 5)).toBeVisible();

  const task = await startExport(page);
  await expect(toasts(page).getByText("Export started")).toBeVisible();
  await expect(quotaHint(page, 4)).toBeVisible();
  expect(await account.remainingOperations()).toBe(4);

  await expect(task).toContainText("Processing", { timeout: 120_000 });
  await task.getByRole("button", { name: "Cancel" }).click();
  await expect(toasts(page).getByText("Export cancelled")).toBeVisible();
  await expect(task).toContainText("Cancelled");
  await expect(quotaHint(page, 5)).toBeVisible();
  expect(await account.remainingOperations()).toBe(5);
});

test("deleting the project during an export cancels it and refunds the operation", async ({ page, request }) => {
  const account = await Account.create(request);
  const name = `delete-me-${Date.now()}`;
  const pid = await account.createProject(name);
  await slowTimeline(account, pid);
  await openEditor(page, account, pid);

  const task = await startExport(page);
  await expect(task).toContainText("Processing", { timeout: 120_000 });
  expect(await account.remainingOperations()).toBe(4);
  const [{ _id: taskId }] = await (await account.tasks(pid)).json();

  await deleteFromSidebar(page, name);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(toasts(page).getByText("Project deleted successfully.")).toBeVisible();

  await expect.poll(() => account.remainingOperations()).toBe(5);
  expect((await account.tasks(pid)).status()).toBe(404);
  // o worker parou o ffmpeg (ficheiro de cancelamento)
  await expect.poll(() => serviceLogs("video_render_tool", "5m"), { timeout: 30_000 }).toMatch(
    new RegExp(`"event": "cancelled", "taskId": "${taskId}"`),
  );
});

test("deleting the project from the sidebar while in the video editor", async ({ page, request }) => {
  const account = await Account.create(request);
  const name = `delete-from-editor-${Date.now()}`;
  const pid = await account.createProject(name);
  await openEditor(page, account, pid);

  await deleteFromSidebar(page, name);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(toasts(page).getByText("Project deleted successfully.")).toBeVisible();
  expect((await account.tasks(pid)).status()).toBe(404);
});
