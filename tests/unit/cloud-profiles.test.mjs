import test from "node:test";
import assert from "node:assert/strict";
import { portableSettings, settingsHash, DriveProfiles } from "../../server/index.mjs";
import { DEFAULTS } from "../../contracts/index.mjs";
import { tempRoot, cleanup } from "../helpers/harness.mjs";
import { mkdirSync } from "node:fs";
test("cloud allowlist excludes paths, tokens and clipboard history", () => {
  const settings = {
    ...structuredClone(DEFAULTS),
    token: "secret",
    credentials: { refresh_token: "secret" },
    clips: ["private"],
  };
  const out = portableSettings(settings);
  assert.deepEqual(Object.keys(out), ["ui", "order", "hotkeys"]);
  assert.equal(JSON.stringify(out).includes("secret"), false);
  assert.equal(JSON.stringify(out).includes("prompts"), false);
  assert.equal(settingsHash(settings), settingsHash({ ...settings, token: "changed" }));
});
test("PKCE login uses random state, appdata and loopback; bad state cannot consume login", async () => {
  const root = tempRoot();
  mkdirSync(root + "/state", { recursive: true });
  const store = {
    read: async () => null,
    save: async () => {
      throw Error("must not store");
    },
  };
  const d = new DriveProfiles(
    { stateDir: root + "/state", settings: DEFAULTS },
    {
      store,
      request: async () => {
        throw Error("no network expected");
      },
    },
  );
  try {
    await d.configure("fixture.apps.googleusercontent.com");
    const { url } = await d.login();
    const u = new URL(url);
    assert.equal(u.origin, "https://accounts.google.com");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.equal(u.searchParams.get("scope"), "https://www.googleapis.com/auth/drive.appdata");
    const redirect = new URL(u.searchParams.get("redirect_uri"));
    assert.equal(redirect.hostname, "127.0.0.1");
    assert.ok(Number(redirect.port) >= 49152 && Number(redirect.port) <= 65535);
    const r = await fetch(redirect + "?state=wrong&code=fixture");
    assert.equal(r.status, 400);
    assert.equal((await d.status()).pending, true);
  } finally {
    d.close();
    cleanup(root);
  }
});
test("bad profile name is rejected before any network access", async () => {
  const d = new DriveProfiles(
    { stateDir: ".", settings: DEFAULTS },
    {
      store: { read: async () => null },
      request: async () => {
        throw Error("must not call");
      },
    },
  );
  for (const n of ["", null, "x".repeat(81), "bad\nname"])
    await assert.rejects(() => d.save(n), /Имя профиля/);
});
