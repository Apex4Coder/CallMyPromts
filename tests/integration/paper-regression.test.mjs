import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { request as httpRequest } from "node:http";
import { tempRoot, cleanup, promptFile, startServer } from "../helpers/harness.mjs";
const withServer = async (fn) => {
  const root = tempRoot();
  promptFile(root + "/prompts", "code", "c-one", { title: "One", pin: 1 });
  promptFile(root + "/prompts", "code", "c-two", { title: "Two" });
  const up = await startServer(root);
  try {
    await fn(up);
  } finally {
    await up.close();
    cleanup(root);
  }
};
test("malformed URL returns 400 and the same server survives", () =>
  withServer(async (up) => {
    const response = await new Promise((resolve, reject) => {
      const s = net.connect(up.port, "127.0.0.1");
      let text = "";
      s.on("connect", () =>
        s.write(`GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${up.port}\r\nConnection: close\r\n\r\n`),
      );
      s.on("data", (b) => (text += b));
      s.on("end", () => resolve(text));
      s.on("error", reject);
    });
    assert.match(response, /HTTP\/1.1 400/);
    assert.equal((await up.call("/api/system")).status, 200);
  }));
test("bad clear body never removes a clip", () =>
  withServer(async (up) => {
    await up.call("/api/clips", { method: "POST", body: { text: "synthetic-regression" } });
    const before = (await up.call("/api/clips")).data;
    for (const body of ["{", "null", "[]", '{"keepPromoted":"false"}']) {
      const r = await fetch(up.url + "api/clips/clear", {
        method: "POST",
        headers: { "X-Deck-Token": up.token, "Content-Type": "application/json" },
        body,
      });
      assert.equal(r.status, 400);
    }
    assert.deepEqual((await up.call("/api/clips")).data, before);
  }));
test("foreign Host and Origin cannot receive token-bearing HTML", () =>
  withServer(async (up) => {
    for (const headers of [{ Host: "foreign.example" }, { Origin: "https://foreign.example" }]) {
      const r = await new Promise((resolve, reject) => {
        const q = httpRequest(up.url, { headers }, (res) => {
          let text = "";
          res.on("data", (b) => (text += b));
          res.on("end", () => resolve({ status: res.statusCode, text }));
        });
        q.on("error", reject);
        q.end();
      });
      assert.equal(r.status, 403);
      assert.equal(r.text.includes(up.token), false);
    }
  }));
test("pinned view uses CRM pin metadata, not frequency", () =>
  withServer(async (up) => {
    const all = await up.call("/api/prompts");
    const pins = await up.call("/api/prompts?pinned=1");
    assert.equal(all.data.items.length, 2);
    assert.equal(pins.data.items.length, 1);
    assert.equal(pins.data.items[0].id, "c-one");
  }));
test("native take requires ack; wrong/duplicate ack rejected", () =>
  withServer(async (up) => {
    const request = up.call("/api/paste", { method: "POST", body: { text: "test" } });
    let delivery;
    for (let n = 0; n < 30; n++) {
      delivery = (await up.call("/api/paste")).data;
      if (delivery.has) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(delivery.has, true);
    assert.equal(
      (await up.call("/api/paste/ack", { method: "POST", body: { id: "wrong", success: true } })).status,
      409,
    );
    assert.equal(
      (await up.call("/api/paste/ack", { method: "POST", body: { id: delivery.id, success: true } })).status,
      200,
    );
    assert.equal((await request).data.pasted, true);
    assert.equal(
      (await up.call("/api/paste/ack", { method: "POST", body: { id: delivery.id, success: true } })).status,
      409,
    );
  }));
test("Google setup missing is explicit and profile writes do not run", () =>
  withServer(async (up) => {
    const s = await up.call("/api/cloud");
    assert.equal(s.status, 200);
    assert.equal(s.data.provider, "Google Drive");
    assert.equal(s.data.connected, false);
    const r = await up.call("/api/cloud/login", { method: "POST" });
    assert.equal(r.status, 500);
    assert.match(r.data.message, /GOOGLE_CLIENT_NOT_CONFIGURED/);
  }));
