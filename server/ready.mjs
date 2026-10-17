// server/ready.mjs — три эндпоинта готовности: /livez, /readyz, /healthz.
//
// Требование: REQ-API-READY (docs/SPEC.md §6). Концепция: gld/gold.md §7.1.
// Тест: tests/integration/api-ready.test.mjs.
//
// Зачем три, а не один. Это три РАЗНЫХ вопроса, и слитый ответ на них — источник
// ложно-зелёного вердикта:
//
//   /livez   — процесс жив?            200 всегда, пока жив. Даже во время drain.
//   /readyz  — можно давать работу?    200 или 503. В теле — чем именно занят.
//   /healthz — сводка для трея         агрегат с перечнем проверок.
//
// Главная причина существования этого файла — критерий успеха деплоя. «Порт занят»
// им быть не может: порт способен держать СТАРЫЙ процесс, который не умер, и тогда
// деплой отрапортует успех, а работает прежний код. Это тот же класс дефекта, что
// «правило V-P-10 недостижимо» — проверка, которая физически не может покраснеть.
//
// Поэтому `/readyz` отдаёт `code_version` и `release_id`, а деплой обязан сверить
// оба. Совпало — значит запущен именно тот код, который ставили.
//
// Эндпоинты публичные, без токена, и это осознанно: их спрашивают супервизор и
// скрипт деплоя, которые токена не знают и знать не должны. Секретов в ответе нет —
// версия кода и номер релиза не тайна, а тело `/readyz` не содержит ни промптов,
// ни записей журнала буфера.

import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Пути готовности. Публичные: их спрашивают супервизор и деплой. */
export const READY_PATHS = new Set(['/livez', '/readyz', '/healthz']);

/**
 * Корень КОДА — каталог релиза, а не каталог данных.
 *
 * Различение найдено провалившимся тестом, и оно принципиальное. В целевой
 * раскладке (gld/gold.md §3.1) это два разных места:
 *
 *   releases/<id>/   код: package.json, .release-id, server/, ui/
 *   shared/          состояние: state/, prompts/
 *
 * `code_version` и `release_id` описывают КОД, поэтому читаются отсюда — от места,
 * откуда реально загружен этот модуль. Первая версия читала их от корня данных, и
 * тест немедленно получил `"unknown"` вместо версии: во временной папке теста
 * package.json нет и быть не должно.
 *
 * Ошибка была бы тихой и дорогой: деплой сверяет `code_version`, и постоянное
 * `"unknown" === "unknown"` дало бы ложное совпадение на любом релизе — тот самый
 * гейт, который не может покраснеть.
 */
export const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Значение незнания. Строка, а не `null` и не пустота.
 *
 * Причина ровно та, из-за которой в прежней системе появлялся «NaN»: отсутствие
 * данных выглядело как данные. `release_id: ""` читается как «релиз без имени»,
 * `release_id: null` — как «поля нет», а `"unknown"` говорит правду: файл не найден,
 * значение не выяснено (gld/gold.md §2, «никаких молчаливых дефолтов»).
 */
export const UNKNOWN = 'unknown';

/**
 * Версия кода из package.json релиза.
 *
 * Берётся один раз при старте. Читать при каждом запросе нельзя: файл лежит внутри
 * релиза, а релиз объявлен неизменяемым — повторное чтение дало бы то же значение
 * ценой обращения к диску на каждый запрос от супервизора (раз в 5 секунд).
 *
 * @param {string} root корень КОДА; по умолчанию каталог этого релиза
 */
export const readCodeVersion = (root = CODE_ROOT) => {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const version = String(pkg.version ?? '').trim();
    return version === '' ? UNKNOWN : version;
  } catch {
    return UNKNOWN;
  }
};

/**
 * Номер релиза из `.release-id`.
 *
 * Файл кладёт деплой в каталог релиза, поэтому корень тот же, что у версии кода.
 * Его отсутствие — нормальный случай при запуске из рабочей копии, а не ошибка,
 * поэтому ответ `"unknown"`, а не исключение.
 *
 * @param {string} root корень КОДА; по умолчанию каталог этого релиза
 */
export const readReleaseId = (root = CODE_ROOT) => {
  try {
    const got = readFileSync(join(root, '.release-id'), 'utf8').trim();
    return got === '' ? UNKNOWN : got;
  } catch {
    return UNKNOWN;
  }
};

/**
 * Счётчик активных запросов.
 *
 * Нужен drain: «слить работу» означает дождаться `in_flight === 0`. Считается на
 * входе в обработчик и уменьшается по событию `finish` ответа, а не в конце
 * функции: ответ может уйти позже возврата из обработчика, и счётчик обнулился бы
 * раньше времени.
 *
 * Запросы к самим эндпоинтам готовности НЕ считаются. Иначе опрос супервизора
 * каждые 5 секунд держал бы `in_flight > 0` вечно, и drain никогда бы не завершился.
 */
export class InFlight {
  #count = 0;

  #peak = 0;

  get count() {
    return this.#count;
  }

  get peak() {
    return this.#peak;
  }

  /** @returns {() => void} функция, которую надо вызвать по завершении */
  enter() {
    this.#count += 1;
    if (this.#count > this.#peak) this.#peak = this.#count;

    let done = false;
    return () => {
      // Защита от двойного вызова: `finish` и `close` могут прийти оба, и без
      // этого счётчик уехал бы в минус, а drain завершился бы раньше срока.
      if (done) return;
      done = true;
      this.#count -= 1;
    };
  }
}

/**
 * Состояние готовности как данные.
 *
 * Отдельный объект, а не поля сервера: его читают три эндпоинта, drain и будущая
 * шина команд. Логика «готов или нет» живёт в одном месте, иначе `/readyz` и трей
 * однажды ответят по-разному.
 */
export class Readiness {
  /**
   * @param {string} opts.root корень ДАННЫХ (state/, prompts/)
   * @param {string} opts.codeRoot корень КОДА; по умолчанию каталог этого релиза
   */
  constructor({
    root, codeRoot = CODE_ROOT, codeVersion = null, releaseId = null, appRoot = null,
  }) {
    this.root = root;
    this.codeRoot = codeRoot;
    // Версия и релиз — от корня КОДА. Путать их с корнем данных нельзя: см.
    // комментарий к CODE_ROOT, эту ошибку уже поймал тест.
    this.codeVersion = codeVersion ?? readCodeVersion(codeRoot);
    this.releaseId = releaseId ?? readReleaseId(codeRoot);
    this.appRoot = appRoot ?? root;
    this.inFlight = new InFlight();
    this.startedAt = new Date().toISOString();

    /**
     * Состояние drain. `active: false` — не «нет данных», а «слива не было»:
     * это известный факт, поэтому поля срока равны `null` осознанно.
     */
    this.drain = { active: false, startedAt: null, deadlineAt: null, reason: null };

    /** Порт заполняется после listen: до него он неизвестен. */
    this.port = null;
  }

  /** Готов ли принимать работу. Единственное место, где это решается. */
  get ready() {
    return !this.drain.active;
  }

  uptimeSec() {
    return Math.floor((Date.now() - Date.parse(this.startedAt)) / 1000);
  }

  /** Тело `/readyz`. Отдаётся и при 200, и при 503 — причина видна в обоих случаях. */
  body() {
    return {
      ready: this.ready,
      code_version: this.codeVersion,
      release_id: this.releaseId,
      app_root: this.appRoot,
      code_root: this.codeRoot,
      port: this.port,
      in_flight: this.inFlight.count,
      drain: {
        active: this.drain.active,
        started_at: this.drain.startedAt,
        deadline_at: this.drain.deadlineAt,
        reason: this.drain.reason,
      },
      started_at: this.startedAt,
      uptime_sec: this.uptimeSec(),
    };
  }

  /**
   * Сводка для трея: перечень проверок, каждая с состоянием и словом.
   *
   * Четыре состояния те же, что во всём приложении (docs/RULES.md §4): значок и
   * слово, никогда только цвет. Трей берёт худшее из списка.
   */
  checks() {
    const out = [
      { name: 'процесс', state: 'good', word: 'жив' },
      this.ready
        ? { name: 'готовность', state: 'good', word: 'принимает работу' }
        : { name: 'готовность', state: 'warn', word: this.drain.reason ?? 'слив работы' },
    ];

    out.push(this.releaseId === UNKNOWN
      ? { name: 'релиз', state: 'none', word: 'запуск из рабочей копии' }
      : { name: 'релиз', state: 'good', word: this.releaseId });

    out.push(this.inFlight.count === 0
      ? { name: 'в работе', state: 'good', word: 'ничего не выполняется' }
      : { name: 'в работе', state: 'good', word: `запросов: ${this.inFlight.count}` });

    return out;
  }
}

const WORST = { bad: 3, warn: 2, none: 1, good: 0 };

/** Худшее состояние списка проверок: трей красит значок по нему. */
export const worstOf = (checks) => checks
  .reduce((acc, c) => (WORST[c.state] > WORST[acc] ? c.state : acc), 'good');
