import { expect, test } from "@playwright/test";
import { Account, clip, openEditor, output, restartRabbitMQ, startExport } from "./helpers";

test("an export finishes after RabbitMQ restarts in the middle of it", async ({ page, request }) => {
  const account = await Account.create(request);
  const pid = await account.createProject();
  const [slow] = await account.uploadAll(pid, "slow.mp4");
  await account.putTimeline(
    pid,
    [
      { tipo: "video", clips: [clip("s", slow._id, 0, 120, 0)] },
      { tipo: "audio", clips: [clip("s", slow._id, 0, 120, 0)] },
    ],
    output({ qualidade: "alta", largura: 1920, altura: 1080 }),
  );
  await openEditor(page, account, pid);

  const task = await startExport(page);
  await expect(task).toContainText("Processing", { timeout: 120_000 });
  restartRabbitMQ();

  // O worker volta a ligar-se e repete o render; a UI recebe o fim (WS ou consulta)
  await expect(task).toContainText("Done", { timeout: 300_000 });
  await expect(page.getByRole("button", { name: "Add slow_edit.mp4 to the timeline" })).toBeVisible();
  const result = (await account.videos(pid)).find((v) => v.name === "slow_edit.mp4")!;
  expect([result.width, result.height]).toEqual([1920, 1080]);
  expect(result.duration).toBeCloseTo(120, 0);
});
