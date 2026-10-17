// Cloud sync never receives prompt bodies or clipboard history.
import { BACKUP_ROUTES, BACKUP_HANDLERS } from "./settings-backup.mjs";
import { DriveProfiles } from "./cloud.mjs";
import { readJsonBody, sendError, sendJson } from "./http.mjs";
const instances = new WeakMap();
export const cloudFor = (deck) => {
  if (!instances.has(deck)) {
    const cloud = new DriveProfiles(deck);
    instances.set(deck, cloud);
    deck.closeCloud = () => cloud.close();
  }
  return instances.get(deck);
};
export const CLOUD_ROUTES = [
  ...BACKUP_ROUTES,
  ["GET", "/api/cloud"],
  ["PUT", "/api/cloud/client"],
  ["POST", "/api/cloud/login"],
  ["POST", "/api/cloud/disconnect"],
  ["GET", "/api/cloud/profiles"],
  ["POST", "/api/cloud/profiles"],
  ["GET", "/api/cloud/profile/:id"],
  ["POST", "/api/cloud/profile/:id/restore"],
];
export const CLOUD_HANDLERS = {
  ...BACKUP_HANDLERS,
  "GET /api/cloud": async ({ res, deck }) =>
    sendJson(res, 200, await cloudFor(deck).status()),
  "PUT /api/cloud/client": async ({ req, res, deck }) => {
    const b = await readJsonBody(req);
    if (!b.ok) return sendError(res, 400, "bad_json", b.message);
    await cloudFor(deck).configure(b.data?.clientId);
    sendJson(res, 200, { configured: true });
  },
  "POST /api/cloud/login": async ({ res, deck }) =>
    sendJson(res, 200, await cloudFor(deck).login()),
  "POST /api/cloud/disconnect": async ({ res, deck }) =>
    sendJson(res, 200, await cloudFor(deck).disconnect()),
  "GET /api/cloud/profiles": async ({ res, deck }) =>
    sendJson(res, 200, { profiles: await cloudFor(deck).list() }),
  "POST /api/cloud/profiles": async ({ req, res, deck }) => {
    const b = await readJsonBody(req);
    if (!b.ok) return sendError(res, 400, "bad_json", b.message);
    sendJson(res, 201, await cloudFor(deck).save(b.data?.name));
  },
  "GET /api/cloud/profile/:id": async ({ res, deck, args }) =>
    sendJson(res, 200, await cloudFor(deck).read(args.id)),
  "POST /api/cloud/profile/:id/restore": async ({ req, res, deck, args }) => {
    const b = await readJsonBody(req);
    if (!b.ok || b.data?.confirm !== true)
      return sendError(
        res,
        400,
        "confirmation_required",
        "нужно подтверждение восстановления",
      );
    sendJson(
      res,
      200,
      await cloudFor(deck).restore(args.id, b.data.expectedLocal),
    );
  },
};
