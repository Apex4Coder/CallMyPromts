import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { tempRoot, cleanup, startServer } from "../helpers/harness.mjs";
let root, up;
test.beforeAll(async () => {
  root = tempRoot();
  up = await startServer(root);
});
test.afterAll(async () => {
  await up?.close();
  cleanup(root);
});
test("named file backup works without Google and contains settings only", async ({
  page,
}) => {
  await page.goto(up.url + "#view-cloud");
  await expect(page.locator("#cloudLogin")).toBeDisabled();
  await page.locator("#backupName").fill("Мой Paper тест");
  const downloaded = page.waitForEvent("download");
  await page.locator("#backupSave").click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("Мой Paper тест.json");
  const profile = JSON.parse(await readFile(await download.path(), "utf8"));
  expect(profile.name).toBe("Мой Paper тест");
  expect(Object.keys(profile.settings)).toEqual(["ui", "order", "hotkeys"]);
  expect(profile.settings.library).toBeUndefined();
  expect(profile.settings.clipboard).toBeUndefined();
});
test("file restore cancels safely then restores only on explicit approval", async ({
  page,
}) => {
  const profile = (await up.call("/api/settings/backup")).data.profile;
  profile.settings.ui.theme = "dark";
  await page.goto(up.url + "#view-cloud");
  page.once("dialog", (d) => d.dismiss());
  await page
    .locator("#backupFile")
    .setInputFiles({
      name: "test.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(profile)),
    });
  await expect(page.locator("#backupRestore")).toBeEnabled();
  expect((await up.call("/api/settings")).data.settings.ui.theme).toBe("light");
  page.once("dialog", (d) => d.accept());
  await page
    .locator("#backupFile")
    .setInputFiles({
      name: "test.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(profile)),
    });
  await expect
    .poll(async () => (await up.call("/api/settings")).data.settings.ui.theme)
    .toBe("dark");
});
test("coffee address is exact and network is explicit; no automatic transfer", async ({
  page,
}) => {
  await page.goto(up.url + "#view-about");
  await expect(page.locator("#coffeeAddress")).toHaveText(
    "TLbByAXvtNNxWTTCrRrRU7yQjib8p5k1RH",
  );
  await expect(page.locator("#view-about")).toContainText(
    "только сеть Tron (TRC20)",
  );
  await expect(page.locator("#coffeeCopy")).toBeEnabled();
  expect(await page.locator("#view-about a[href]").count()).toBe(0);
});
