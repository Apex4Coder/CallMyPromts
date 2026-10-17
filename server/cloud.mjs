// Google Drive settings profiles: explicit owner actions, PKCE and appData scope only.
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { readFile, writeFile, rename } from "node:fs/promises";
import { tokenStore } from "./cloud-secrets.mjs";
import { listenLoopback } from "./loopback.mjs";
export const PROFILE_FORMAT = "callmypromts-settings-v1";
export const portableSettings = (settings) =>
  structuredClone({ ui: settings.ui, order: settings.order, hotkeys: settings.hotkeys });
export const settingsHash = (settings) =>
  createHash("sha256")
    .update(JSON.stringify(portableSettings(settings)))
    .digest("hex");
const nonce = () => randomBytes(32).toString("base64url");
const equal = (a, b) => {
  const x = Buffer.from(a || ""),
    y = Buffer.from(b || "");
  return x.length === y.length && timingSafeEqual(x, y);
};
const CLIENT = /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/;
const FILE_ID = /^[A-Za-z0-9_-]{1,200}$/;
export class DriveProfiles {
  constructor(deck, { request = fetch, store = tokenStore(join(deck.stateDir, "google.dpapi")) } = {}) {
    this.deck = deck;
    this.request = request;
    this.store = store;
    this.pending = null;
    this.busy = false;
    this.error = null;
  }
  async client() {
    try {
      return JSON.parse(await readFile(join(this.deck.stateDir, "google-client.json"), "utf8"));
    } catch {
      return { clientId: process.env.CALLMYPROMPTS_GOOGLE_CLIENT_ID || "" };
    }
  }
  async configure(clientId) {
    if (typeof clientId !== "string" || !CLIENT.test(clientId))
      throw new Error("Нужен Google Desktop OAuth client ID");
    if (this.pending) throw new Error("Сначала завершите текущий вход");
    const f = join(this.deck.stateDir, "google-client.json");
    await writeFile(f + ".tmp", JSON.stringify({ clientId }), { mode: 0o600 });
    await rename(f + ".tmp", f);
  }
  async status() {
    const c = await this.client();
    let saved = null;
    try {
      saved = await this.store.read();
    } catch {
      this.error = "Локальный credential недоступен";
    }
    return {
      provider: "Google Drive",
      configured: CLIENT.test(c.clientId || ""),
      connected: !!saved?.refresh_token,
      pending: !!this.pending,
      error: this.error,
      scope: "drive.appdata",
      sync: "manual-settings-profiles",
    };
  }
  async login() {
    if (this.pending) throw new Error("Вход уже ожидает подтверждения");
    const c = await this.client();
    if (!CLIENT.test(c.clientId || ""))
      throw new Error("GOOGLE_CLIENT_NOT_CONFIGURED: нужен Desktop OAuth client ID приложения");
    const state = nonce(),
      verifier = nonce();
    let listener, expiry;
    const pending = { state, verifier, clientId: c.clientId, at: Date.now() };
    this.pending = pending;
    this.error = null;
    listener = createServer((req, res) => this.callback(req, res, pending));
    try {
      await listenLoopback(listener);
    } catch (e) {
      this.pending = null;
      throw e;
    }
    pending.listener = listener;
    pending.redirect = `http://127.0.0.1:${listener.address().port}/oauth/google/callback`;
    expiry = setTimeout(() => {
      if (this.pending === pending) {
        this.pending = null;
        this.error = "Время входа истекло";
      }
      listener.close();
    }, 300000);
    expiry.unref?.();
    pending.expiry = expiry;
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.search = new URLSearchParams({
      client_id: c.clientId,
      redirect_uri: pending.redirect,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/drive.appdata",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    }).toString();
    return { url: u.href };
  }
  async callback(req, res, pending) {
    let u;
    try {
      u = new URL(req.url, "http://127.0.0.1");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const host = `127.0.0.1:${pending.listener.address()?.port}`;
    if (req.headers.host !== host || req.method !== "GET" || u.pathname !== "/oauth/google/callback") {
      res.writeHead(404).end();
      return;
    }
    if (
      this.pending !== pending ||
      Date.now() - pending.at > 300000 ||
      !equal(u.searchParams.get("state"), pending.state)
    ) {
      res.writeHead(400).end("Invalid or expired login state");
      return;
    }
    if (pending.used) {
      res.writeHead(409).end("Already processed");
      return;
    }
    pending.used = true;
    try {
      if (u.searchParams.get("error") || !u.searchParams.get("code")) throw new Error("Вход отменён");
      const token = await this.token({
        client_id: pending.clientId,
        grant_type: "authorization_code",
        code: u.searchParams.get("code"),
        code_verifier: pending.verifier,
        redirect_uri: pending.redirect,
      });
      if (!token.refresh_token)
        throw new Error("Google не вернул refresh credential; повторите явный вход с согласием");
      if (this.pending !== pending) throw new Error("Время входа истекло");
      await this.store.save(token);
      this.error = null;
      res
        .writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        })
        .end("CallMyPromts: вход выполнен. Можно закрыть вкладку.");
    } catch {
      this.error = "Вход Google не завершён или защищённое сохранение не удалось";
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end(this.error);
    } finally {
      clearTimeout(pending.expiry);
      this.pending = null;
      pending.listener.close();
    }
  }
  async token(body) {
    const r = await this.request("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error("Google OAuth отказал");
    return r.json();
  }
  async access() {
    const saved = await this.store.read();
    if (!saved?.refresh_token) throw new Error("Сначала войдите в Google");
    const c = await this.client();
    const fresh = await this.token({
      client_id: c.clientId,
      grant_type: "refresh_token",
      refresh_token: saved.refresh_token,
    });
    if (!fresh.access_token) throw new Error("Нет Google access credential");
    return fresh.access_token;
  }
  async drive(path, options = {}) {
    const access = await this.access();
    const r = await this.request("https://www.googleapis.com" + path, {
      ...options,
      headers: { ...options.headers, Authorization: "Bearer " + access },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`Google Drive: HTTP ${r.status}`);
    return r;
  }
  async list() {
    let files = [],
      page = "";
    do {
      const q = new URLSearchParams({
        spaces: "appDataFolder",
        q: "trashed = false and appProperties has { key='application' and value='CallMyPromts' }",
        fields: "nextPageToken,files(id,name,modifiedTime)",
        pageSize: "100",
        ...(page ? { pageToken: page } : {}),
      });
      const r = await this.drive("/drive/v3/files?" + q);
      const x = await r.json();
      files.push(...(x.files || []));
      page = x.nextPageToken || "";
      if (files.length > 10000) throw new Error("Слишком много профилей");
    } while (page);
    return files;
  }
  async save(name) {
    if (typeof name !== "string" || !name.trim() || name.length > 80 || /[\x00-\x1f]/.test(name))
      throw new Error("Имя профиля: 1–80 символов");
    const profile = {
      format: PROFILE_FORMAT,
      name: name.trim(),
      savedAt: new Date().toISOString(),
      settings: portableSettings(this.deck.settings),
    };
    const boundary = "callmypromts-" + nonce();
    const metadata = {
      name: profile.name + ".json",
      parents: ["appDataFolder"],
      appProperties: { application: "CallMyPromts" },
      mimeType: "application/json",
    };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(profile)}\r\n--${boundary}--`;
    // Immutable snapshot: never silently overwrite another machine's profile.
    const r = await this.drive("/upload/drive/v3/files?uploadType=multipart&fields=id,name", {
      method: "POST",
      headers: { "Content-Type": "multipart/related; boundary=" + boundary },
      body,
    });
    return r.json();
  }
  async read(id) {
    if (!FILE_ID.test(id || "")) throw new Error("Неверный ID профиля");
    const allowed = await this.list();
    if (!allowed.some((f) => f.id === id)) throw new Error("Профиль не принадлежит приложению");
    const r = await this.drive("/drive/v3/files/" + id + "?alt=media");
    const raw = await r.text();
    if (raw.length > 100000) throw new Error("Профиль слишком большой");
    const x = JSON.parse(raw);
    if (x.format !== PROFILE_FORMAT || !x.settings || typeof x.settings !== "object")
      throw new Error("Неверный формат профиля");
    return {
      name: x.name,
      settings: portableSettings(x.settings),
      expectedLocal: settingsHash(this.deck.settings),
    };
  }
  async restore(id, expectedLocal) {
    if (!equal(settingsHash(this.deck.settings), expectedLocal))
      throw new Error("Локальные настройки изменились; повторите просмотр");
    const profile = await this.read(id);
    if (!equal(settingsHash(this.deck.settings), expectedLocal))
      throw new Error("Локальные настройки изменились");
    const out = this.deck.saveSettings(profile.settings);
    if (!out.ok) throw new Error("Профиль не прошёл валидацию");
    return { restored: true };
  }
  async disconnect() {
    if (this.pending) {
      clearTimeout(this.pending.expiry);
      this.pending.listener.close();
      this.pending = null;
    }
    await this.store.clear();
    return { disconnected: true, remoteRevocation: false };
  }
  close() {
    if (this.pending) {
      clearTimeout(this.pending.expiry);
      this.pending.listener.close();
      this.pending = null;
    }
  }
}
