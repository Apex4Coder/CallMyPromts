// Explicit settings-only file export/import. No cloud, credentials or prompt data.
import { DEFAULTS, validateSettings } from "../contracts/index.mjs";
import { PROFILE_FORMAT, settingsHash } from "./cloud.mjs";
import { readJsonBody, sendError, sendJson } from "./http.mjs";
const groups = ["ui", "order", "hotkeys"];
const select = (settings) =>
  Object.fromEntries(
    groups.map((group) => [
      group,
      Object.fromEntries(
        Object.keys(DEFAULTS[group]).map((key) => [key, settings[group][key]]),
      ),
    ]),
  );
const object = (x) => x && typeof x === "object" && !Array.isArray(x);
const valid = (p) => {
  if (
    !object(p) ||
    p.format !== PROFILE_FORMAT ||
    typeof p.name !== "string" ||
    !p.name.trim() ||
    p.name.length > 80 ||
    /[\x00-\x1f]/.test(p.name) ||
    !object(p.settings) ||
    JSON.stringify(p).length > 100000
  )
    return false;
  if (Object.keys(p.settings).length !== groups.length) return false;
  for (const group of groups) {
    const values = p.settings[group];
    if (
      !object(values) ||
      Object.keys(values).length !== Object.keys(DEFAULTS[group]).length
    )
      return false;
    if (Object.keys(values).some((key) => !Object.hasOwn(DEFAULTS[group], key)))
      return false;
  }
  return validateSettings(p.settings).length === 0;
};
export const BACKUP_ROUTES = [
  ["GET", "/api/settings/backup"],
  ["POST", "/api/settings/backup/preview"],
  ["POST", "/api/settings/backup/restore"],
];
const preview = async ({ req, res, deck }, restore) => {
  const body = await readJsonBody(req),
    x = body.data;
  if (!body.ok || !valid(x?.profile))
    return sendError(
      res,
      400,
      "bad_profile",
      "Неверный файл настроек; настройки не изменены",
    );
  if (!restore)
    return sendJson(res, 200, {
      name: x.profile.name,
      expectedLocal: settingsHash(deck.settings),
    });
  if (x.confirm !== true)
    return sendError(
      res,
      400,
      "confirmation_required",
      "Нужно подтверждение восстановления",
    );
  if (
    typeof x.expectedLocal !== "string" ||
    x.expectedLocal !== settingsHash(deck.settings)
  )
    return sendError(
      res,
      409,
      "settings_changed",
      "Настройки изменились; повтори просмотр файла",
    );
  const result = deck.saveSettings(select(x.profile.settings));
  if (!result.ok)
    return sendError(res, 400, "bad_profile", "Профиль не прошёл валидацию");
  sendJson(res, 200, { restored: true, restartHotkeysRequired: true });
};
export const BACKUP_HANDLERS = {
  "GET /api/settings/backup": ({ res, deck }) =>
    sendJson(res, 200, {
      profile: {
        format: PROFILE_FORMAT,
        name: "Мой Paper",
        savedAt: new Date().toISOString(),
        settings: select(deck.settings),
      },
    }),
  "POST /api/settings/backup/preview": (context) => preview(context, false),
  "POST /api/settings/backup/restore": (context) => preview(context, true),
};
