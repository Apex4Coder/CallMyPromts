// server/routes-ready.mjs — обработчики /livez, /readyz, /healthz.
//
// Требование: REQ-API-READY (docs/SPEC.md §6). Концепция: gld/gold.md §7.1.
// Тест: tests/integration/api-ready.test.mjs.
//
// Отдельно от server/ready.mjs: там состояние как данные, здесь — превращение
// состояния в HTTP-ответ. Разделение не косметическое: состояние готовности читают
// трей, drain и деплой, и у каждого свой способ доставки. Слепив их, пришлось бы
// тащить `res` в модуль, который про HTTP знать не должен.
//
// Эти маршруты обрабатываются ДО проверки токена (server/index.mjs) — они публичные.
// Обоснование в server/ready.mjs: их спрашивают супервизор и скрипт деплоя, которые
// токена не знают. В ответе нет ни промптов, ни записей журнала.

import { sendJson } from './http.mjs';
import { worstOf } from './ready.mjs';

/**
 * `/livez` — жив ли процесс.
 *
 * Всегда `200`, пока процесс отвечает. В том числе во время drain: процесс жив и
 * здоров, он просто не принимает нового. Ровно ради этого различия `/livez` и
 * `/readyz` — разные адреса, а не один с флагом.
 *
 * Тело минимальное: супервизор опрашивает его часто, и лишние поля тут — трафик без
 * пользы. Всё подробное — в `/readyz`.
 */
const livez = (res, ready) => sendJson(res, 200, {
  alive: true,
  code_version: ready.codeVersion,
  uptime_sec: ready.uptimeSec(),
});

/**
 * `/readyz` — можно ли давать работу.
 *
 * `200` когда можно, `503` когда нет. Тело одинаковое в обоих случаях: причина
 * отказа обязана быть видна, иначе `503` — это молчание с кодом.
 *
 * `code_version` и `release_id` в теле — единственный честный критерий успеха
 * деплоя. «Порт занят» им быть не может: порт способен держать старый процесс.
 */
const readyz = (res, ready) => sendJson(res, ready.ready ? 200 : 503, ready.body());

/**
 * `/healthz` — сводка для трея.
 *
 * Агрегат: состояние, перечень проверок, время работы. Каждая проверка несёт и
 * состояние, и слово (docs/RULES.md §4) — значок в трее красится по худшему из
 * списка, но человек видит, что именно не так, а не только цвет.
 */
const healthz = (res, ready) => {
  const checks = ready.checks();
  return sendJson(res, 200, {
    status: worstOf(checks),
    checks,
    code_version: ready.codeVersion,
    release_id: ready.releaseId,
    port: ready.port,
    in_flight: ready.inFlight.count,
    uptime_sec: ready.uptimeSec(),
    started_at: ready.startedAt,
  });
};

const HANDLERS = { '/livez': livez, '/readyz': readyz, '/healthz': healthz };

/**
 * Обработка запроса готовности.
 *
 * Только `GET` и `HEAD`. Прочие методы получают `405` с перечнем разрешённых, а не
 * `404`: путь существует, недопустим именно метод, и разница важна тому, кто
 * отлаживает супервизор.
 *
 * @returns {boolean} обработан ли путь; false → решает вызывающий
 */
export const handleReady = (req, res, { path, ready }) => {
  const fn = HANDLERS[path];
  if (!fn) return false;

  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    sendJson(res, 405, {
      error: 'bad_method',
      message: `${method} ${path} — только GET`,
      expected: 'GET',
    });
    return true;
  }

  fn(res, ready);
  return true;
};
