// server/routes-clips.mjs — маршруты журнала буфера обмена.
//
// Требование: REQ-API-CLIPS (docs/SPEC.md §6). Сценарии S-04, S-05.
// Тесты: tests/integration/api.test.mjs, tests/integration/promote.test.mjs.
//
// Здесь единственное разрешённое место встречи `clipboard` и `library`:
// `planPromotion` готовит решение, `createPrompt` его исполняет. Прямая запись
// из clipboard в prompts/ запрещена картой границ (docs/ENTITY-MAP.md §6).

import { createPrompt, cleanBody, titleFromText, slugify } from '../library/index.mjs';
import {
  planPromotion, applyPromotion, groupChoices, matchesFilter, countByFilter,
} from '../clipboard/index.mjs';

import { sendJson, sendError, readJsonBody } from './http.mjs';
import { clipForList, clipForOne, firstBad } from './present.mjs';

/** Инструменты library, которые clipboard не имеет права импортировать сам. */
const TOOLS = { cleanBody, titleFromText, slugify };

export const CLIP_ROUTES = [
  ['GET', '/api/clips'],
  ['POST', '/api/clips'],
  ['POST', '/api/clips/clear'],
  ['POST', '/api/watch'],
  ['GET', '/api/clip/:id'],
  ['DELETE', '/api/clip/:id'],
  ['POST', '/api/clips/:id/promote'],
];

export const CLIP_HANDLERS = {
  'GET /api/clips': ({ res, deck, params }) => {
    const asked = Number(params.get('limit') ?? deck.settings.clipboard.limit);
    const limit = Math.min(Number.isFinite(asked) ? asked : 100, deck.settings.clipboard.limit);
    const filter = params.get('filter') ?? 'all';
    const query = params.get('q') ?? '';

    const rows = deck.clips
      .list({ limit, query: query || null })
      .filter((c) => matchesFilter(c.kind, filter));

    const stats = deck.clips.stats(deck.settings.clipboard.limit);

    let empty = null;
    if (rows.length === 0) {
      empty = query
        ? { reason: 'no_match', message: `В журнале нет записей с «${query}»` }
        : { reason: 'no_clips', message: 'Журнал пуст — скопируйте что-нибудь, запись появится здесь' };
    }

    sendJson(res, 200, {
      items: rows.map(clipForList),
      stats,
      counts: countByFilter(stats.byKind),
      paused: deck.clips.paused,
      enabled: deck.settings.clipboard.enabled,
      empty,
    });
  },

  'GET /api/clip/:id': ({ res, deck, args }) => {
    const clip = deck.clips.get(args.id);
    if (!clip) return sendError(res, 404, 'not_found', `записи ${args.id} нет в журнале`);
    return sendJson(res, 200, { item: clipForOne(clip) });
  },

  /**
   * Приём записи от слежки. Ответ всегда 200/201 с полем `skipped`:
   * пропуск по чёрному списку или дедупликации — это нормальная работа,
   * а не ошибка, и мост не должен считать её сбоем.
   */
  'POST /api/clips': async ({ req, res, deck }) => {
    const body = await readJsonBody(req);
    if (!body.ok) return sendError(res, 400, 'bad_json', body.message);

    if (!deck.settings.clipboard.enabled) {
      return sendJson(res, 200, {
        ok: false,
        skipped: 'disabled',
        why: 'слежка за буфером отключена в настройках',
      });
    }
    if (body.data.isImage === true && !deck.settings.clipboard.save_images) {
      return sendJson(res, 200, { ok: false, skipped: 'images_off', why: 'сохранение картинок отключено' });
    }

    const out = deck.clips.add(body.data.text, {
      sourceApp: body.data.sourceApp ?? null,
      isImage: body.data.isImage === true,
      blacklist: deck.settings.clipboard.blacklist,
      limit: deck.settings.clipboard.limit,
    });
    return sendJson(res, out.ok ? 201 : 200, out);
  },

  'DELETE /api/clip/:id': ({ res, deck, args }) => {
    const gone = deck.clips.remove(args.id);
    if (!gone) return sendError(res, 404, 'not_found', `записи ${args.id} нет в журнале`);
    return sendJson(res, 200, { removed: Number(args.id) });
  },

  /**
   * Сохранение записи как промпта в два шага.
   * Без `confirm` возвращается план: имя файла, группа, что будет очищено,
   * предупреждения (повтор, секрет). С `confirm: true` создаётся файл.
   */
  'POST /api/clips/:id/promote': async ({ req, res, deck, args }) => {
    const body = await readJsonBody(req);
    if (!body.ok) return sendError(res, 400, 'bad_json', body.message);

    const clip = deck.clips.get(args.id);
    if (!clip) return sendError(res, 404, 'not_found', `записи ${args.id} нет в журнале`);

    const lib = await deck.library();
    const prepared = planPromotion(clip, {
      group: body.data.group,
      title: body.data.title ?? null,
      existing: lib.items,
      tools: TOOLS,
    });

    if (!prepared.ok) {
      const bad = firstBad(prepared.issues);
      return sendError(res, 400, bad.code, bad.message, { field: bad.field ?? null });
    }
    if (body.data.confirm !== true) {
      return sendJson(res, 200, {
        plan: prepared.plan,
        issues: prepared.issues,
        groups: groupChoices(lib.groups),
      });
    }

    const out = await applyPromotion(prepared.plan, {
      create: (data) => createPrompt(deck.libraryRoot, data),
      store: deck.clips,
    });
    if (!out.ok) {
      const bad = firstBad(out.issues);
      return sendError(res, 400, bad?.code ?? 'promote_failed', bad?.message ?? 'не удалось сохранить');
    }

    deck.invalidate();
    return sendJson(res, 201, {
      created: out.created,
      marked: out.marked,
      issues: [...prepared.issues, ...out.issues],
    });
  },

  'POST /api/clips/clear': async ({ req, res, deck }) => {
    const body = await readJsonBody(req);
    if (!body.ok) return sendError(res, 400, 'bad_json', body.message);
    if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
      return sendError(res, 400, 'bad_body', 'ожидался объект');
    }
    if (body.data.keepPromoted !== undefined && typeof body.data.keepPromoted !== 'boolean') {
      return sendError(res, 400, 'bad_body', 'keepPromoted должен быть boolean');
    }
    const keep = body.data.keepPromoted !== false;
    const removed = deck.clips.clear({ keepPromoted: keep });
    return sendJson(res, 200, { removed, keptPromoted: keep });
  },

  'POST /api/watch': async ({ req, res, deck }) => {
    const body = await readJsonBody(req);
    if (!body.ok || typeof body.data?.enabled !== 'boolean') {
      return sendError(res, 400, 'bad_body', 'enabled должен быть boolean');
    }
    const on = body.data.enabled;
    if (on) deck.clips.resume();
    else deck.clips.pause();
    return sendJson(res, 200, { paused: deck.clips.paused });
  },
};
