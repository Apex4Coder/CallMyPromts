import test from "node:test";
import assert from "node:assert/strict";
import { tempRoot, cleanup, startServer } from "../helpers/harness.mjs";
const fixture = async (fn) => {
  const root = tempRoot(),
    up = await startServer(root);
  try {
    await fn(up);
  } finally {
    await up.close();
    cleanup(root);
  }
};
test("settings backup requires token and exports three allowlisted groups only", () =>
  fixture(async (up) => {
    assert.equal(
      (await up.call("/api/settings/backup", { token: null })).status,
      401,
    );
    const out = await up.call("/api/settings/backup");
    assert.equal(out.status, 200);
    assert.deepEqual(Object.keys(out.data.profile.settings), [
      "ui",
      "order",
      "hotkeys",
    ]);
    assert.equal(JSON.stringify(out.data).includes("clipboard"), false);
  }));
test("backup preview is read-only; restore needs confirmation and preserves local paths", () =>
  fixture(async (up) => {
    const profile = (await up.call("/api/settings/backup")).data.profile;
    profile.name = "Мой рабочий Paper";
    profile.settings.ui.theme = "dark";
    const preview = await up.call("/api/settings/backup/preview", {
      method: "POST",
      body: { profile },
    });
    assert.equal(preview.status, 200);
    assert.equal(
      (await up.call("/api/settings")).data.settings.ui.theme,
      "light",
    );
    assert.equal(
      (
        await up.call("/api/settings/backup/restore", {
          method: "POST",
          body: { profile, expectedLocal: preview.data.expectedLocal },
        })
      ).status,
      400,
    );
    const before = (await up.call("/api/settings")).data.settings;
    assert.equal(
      (
        await up.call("/api/settings/backup/restore", {
          method: "POST",
          body: {
            profile,
            confirm: true,
            expectedLocal: preview.data.expectedLocal,
          },
        })
      ).status,
      200,
    );
    const after = (await up.call("/api/settings")).data.settings;
    assert.equal(after.ui.theme, "dark");
    assert.deepEqual(after.library, before.library);
    assert.deepEqual(after.clipboard, before.clipboard);
    assert.deepEqual(after.server, before.server);
  }));
test("backup rejects changed local revision instead of clobbering settings", () =>
  fixture(async (up) => {
    const profile = (await up.call("/api/settings/backup")).data.profile;
    const preview = (
      await up.call("/api/settings/backup/preview", {
        method: "POST",
        body: { profile },
      })
    ).data;
    await up.call("/api/settings", {
      method: "PUT",
      body: { ui: { theme: "dark" } },
    });
    assert.equal(
      (
        await up.call("/api/settings/backup/restore", {
          method: "POST",
          body: {
            profile,
            confirm: true,
            expectedLocal: preview.expectedLocal,
          },
        })
      ).status,
      409,
    );
    assert.equal(
      (await up.call("/api/settings")).data.settings.ui.theme,
      "dark",
    );
  }));
test("backup rejects malformed, incomplete and unsafe settings without writing", () =>
  fixture(async (up) => {
    const good = (await up.call("/api/settings/backup")).data.profile;
    const bad = [
      null,
      {},
      { ...good, format: "wrong" },
      { ...good, name: "" },
      { ...good, name: "x".repeat(100001) },
    ];
    const incomplete = structuredClone(good);
    delete incomplete.settings.hotkeys;
    bad.push(incomplete);
    const unsafe = structuredClone(good);
    unsafe.settings.library = { path: "outside" };
    bad.push(unsafe);
    const nested = structuredClone(good);
    nested.settings.ui.credentials = "secret";
    bad.push(nested);
    const invalid = structuredClone(good);
    invalid.settings.ui.theme = "wrong";
    bad.push(invalid);
    for (const profile of bad)
      assert.equal(
        (
          await up.call("/api/settings/backup/preview", {
            method: "POST",
            body: { profile },
          })
        ).status,
        400,
      );
    assert.equal(
      (await up.call("/api/settings")).data.settings.ui.theme,
      "light",
    );
  }));
