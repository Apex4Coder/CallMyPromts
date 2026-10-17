import { test, expect } from "@playwright/test";
import {
  tempRoot,
  cleanup,
  promptFile,
  startServer,
} from "../helpers/harness.mjs";
let root, up;
test.beforeAll(async () => {
  root = tempRoot();
  for (let n = 1; n <= 18; n++)
    promptFile(root + "/prompts", "code", "c-paper-" + n, {
      title: "Paper prompt " + n,
      pin: n <= 9 ? n : null,
      body: "Synthetic prompt body " + n,
    });
  up = await startServer(root);
});
test.afterAll(async () => {
  await up?.close();
  cleanup(root);
});
test("single click previews; double click opens real editor and saves", async ({
  page,
}) => {
  await page.goto(up.url + "#crm");
  await expect(page.locator(".crm-row")).toHaveCount(18);
  await page.locator(".crm-row").nth(1).click();
  await expect(page.locator("#crmEditor")).not.toBeVisible();
  await page.locator(".crm-row").nth(1).dblclick();
  await expect(page.locator("#crmEditor")).toBeVisible();
  await page.locator("#crmTitle").fill("Edited Paper prompt");
  await page.locator("#crmSave").click();
  await expect(page.locator("#crmEditor")).not.toBeVisible();
  await expect(
    page.locator(".crm-name").filter({ hasText: "Edited Paper prompt" }),
  ).toHaveCount(1);
});
test("empty search clears stale preview and disables actions", async ({
  page,
}) => {
  await page.goto(up.url + "#crm");
  await expect(page.locator(".crm-row")).toHaveCount(18);
  await page.locator("#crmSearch").fill("no-such-prompt");
  await expect(page.locator(".crm-row")).toHaveCount(0);
  await expect(page.locator("#crmPreviewTitle")).toHaveText(
    "Нет выбранного промпта",
  );
  await expect(page.locator("#crmCopy")).toBeDisabled();
});
test("fixed quick viewport scrolls CRM pinned prompts only", async ({
  page,
}) => {
  await page.setViewportSize({ width: 340, height: 370 });
  await page.goto(up.url + "#pins");
  await expect(page.locator("#pickerList .row")).toHaveCount(9);
  expect(
    await page
      .locator("#pickerList")
      .evaluate((e) => e.scrollHeight > e.clientHeight),
  ).toBe(true);
  expect(
    (await page.locator("#picker").boundingBox()).height,
  ).toBeLessThanOrEqual(370);
});
test("narrow rail drawer is accessible with no horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 750 });
  await page.goto(up.url + "#crm");
  await page.locator("#crmDrawerToggle").click();
  await expect(page.locator("#crmDrawerToggle")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("reduced motion disables CRM appearance animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(up.url + "#crm");
  expect(
    await page
      .locator("#crm")
      .evaluate((e) => getComputedStyle(e).animationName),
  ).toBe("none");
});
test("CRM fills its entire native viewport, not a card in empty canvas", async ({
  page,
}) => {
  for (const viewport of [
    { width: 764, height: 481 },
    { width: 1280, height: 900 },
    { width: 390, height: 700 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(up.url + "#crm");
    await expect(page.locator("html")).toHaveAttribute("data-screen", "crm");
    await expect(page.locator(".crm-row")).toHaveCount(18);
    await expect.poll(() => page.locator("#crm").evaluate(e => e.getAnimations().length)).toBe(0);
    const box = await page.locator("#crm").boundingBox();
    expect(box.x).toBe(0);
    expect(box.y).toBe(0);
    expect(Math.abs(box.width - viewport.width)).toBeLessThan(1);
    expect(Math.abs(box.height - viewport.height)).toBeLessThan(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight <= innerHeight,
      ),
    ).toBe(true);
  }
});
