// tests/unit/server-paste.test.mjs — очередь заявок на вставку.
//
// Требование: REQ-API-PASTE (docs/SPEC.md §6). Сценарий S-01, шаг 3.
// Проверяемый файл: server/paste.mjs.
//
// Это единственный канал между страницей в браузере и мостом AutoHotkey, и он
// решает, будет ли вставка вообще. Прежняя версия его не имела: интерфейс посылал
// событие `deck:paste` в своё же окно, мост о нём не знал, и текст молча оставался
// в буфере. Отсюда набор проверок: заявка обязана быть одноразовой, недолгой и
// честной в ответе — «мост не забрал» должно доходить до интерфейса как есть.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PasteQueue, PASTE_WAIT_MS, PASTE_TTL_MS } from '../../server/index.mjs';

// ── обычный путь ─────────────────────────────────────────────────────────────

test('мост забрал текст — интерфейс узнал об этом', async () => {
  const q = new PasteQueue();
  const asked = q.request('Текст промпта');

  assert.equal(q.take(), 'Текст промпта');
  assert.equal(q.acknowledge(q.deliveryId, true), true);
  assert.equal(await asked, true);
});

test('текст доходит без изменений', async () => {
  // Кириллица, перевод строки и кавычки — обычное содержимое промпта.
  const q = new PasteQueue();
  const text = 'Ревью кода\n\n«Проверь: `a\\b` и "цитата"»\tтабуляция';
  const asked = q.request(text);

  assert.equal(q.take(), text);
  q.acknowledge(q.deliveryId, true);
  await asked;
});

test('заявка одноразовая: второй опрос ничего не даёт', async () => {
  // Иначе один выбор вставился бы столько раз, сколько мост успел спросить.
  const q = new PasteQueue();
  const asked = q.request('раз');

  assert.equal(q.take(), 'раз');
  assert.equal(q.take(), null);
  assert.equal(q.take(), null);
  q.acknowledge(q.deliveryId, true);
  await asked;
});

test('ожидание видно в состоянии', async () => {
  const q = new PasteQueue();
  assert.equal(q.waiting, false);

  const asked = q.request('текст');
  assert.equal(q.waiting, true);

  q.take();
  assert.equal(q.waiting, true, 'taken is not pasted');
  q.acknowledge(q.deliveryId, true);
  assert.equal(q.waiting, false);
  q.acknowledge(q.deliveryId, true);
  await asked;
});

// ── мост не ответил ──────────────────────────────────────────────────────────

test('без моста заявка отвечает «не вставлено», а не висит', async () => {
  // S-01, плохой путь 5. Висящее обещание оставило бы окно выбора открытым
  // навсегда, и человек не понял бы, что произошло.
  const q = new PasteQueue({ waitMs: 30 });

  assert.equal(await q.request('текст'), false);
});

test('ответ приходит по истечении ожидания, а не позже', async () => {
  const q = new PasteQueue({ waitMs: 40 });
  const started = Date.now();

  await q.request('текст');
  const spent = Date.now() - started;

  assert.equal(spent >= 30, true, `ответ через ${spent} мс — раньше срока`);
  assert.equal(spent < 400, true, `ответ через ${spent} мс — слишком долго`);
});

test('опоздавший мост получает null, а не старый текст', async () => {
  // Вставка через полминуты после выбора — это неожиданный ввод в окно, где
  // человек уже делает другое.
  const q = new PasteQueue({ waitMs: 20 });

  assert.equal(await q.request('текст'), false);
  assert.equal(q.take(), null, 'просроченная заявка не выдаётся');
});

test('заявка старше TTL не выдаётся даже при живом ожидании', async () => {
  // Ожидание могло быть длинным по настройке, но возраст заявки — отдельное
  // ограничение: она описывает окно, которое было активным давно.
  const q = new PasteQueue({ waitMs: 5000, ttlMs: 50 });
  const now = Date.now();
  const asked = q.request('старое', { now });

  assert.equal(q.take({ now: now + 51 }), null);
  assert.equal(await asked, false, 'ожидающий узнаёт, что вставки не будет');
});

test('заявка внутри TTL выдаётся', async () => {
  const q = new PasteQueue({ waitMs: 5000, ttlMs: 100 });
  const now = Date.now();
  const asked = q.request('свежее', { now });

  assert.equal(q.take({ now: now + 99 }), 'свежее');
  assert.equal(q.acknowledge(q.deliveryId, true), true);
  assert.equal(await asked, true);
});

// ── две заявки подряд ────────────────────────────────────────────────────────

test('новая заявка вытесняет прежнюю', async () => {
  // Человек выбрал другой промпт: вставлять надо последний выбор, а не оба.
  const q = new PasteQueue({ waitMs: 5000 });
  const first = q.request('первый');
  const second = q.request('второй');

  assert.equal(await first, false, 'прежняя заявка отменена');
  assert.equal(q.take(), 'второй');
  q.acknowledge(q.deliveryId, true);
  assert.equal(await second, true);
});

test('вытесненная заявка не оставляет висящего обещания', async () => {
  // Иначе процесс не завершился бы: незакрытое обещание держит event loop.
  const q = new PasteQueue({ waitMs: 5000 });
  const first = q.request('первый');
  q.request('второй');

  await assert.doesNotReject(() => first);
  q.close();
});

// ── закрытие ─────────────────────────────────────────────────────────────────

test('закрытие сервера отпускает ожидающих', async () => {
  const q = new PasteQueue({ waitMs: 5000 });
  const asked = q.request('текст');

  q.close();
  assert.equal(await asked, false);
  assert.equal(q.waiting, false);
});

test('закрытие без заявок не ломается', () => {
  const q = new PasteQueue();
  assert.doesNotThrow(() => q.close());
});

// ── счётчики ─────────────────────────────────────────────────────────────────

test('счётчики различают забранное и потерянное', async () => {
  // Нужно диагностике: «мост не отвечает» видно по missed, а не по догадкам.
  const q = new PasteQueue({ waitMs: 20 });

  const a = q.request('раз');
  q.take();
  q.acknowledge(q.deliveryId, true);
  await a;
  await q.request('два');

  assert.deepEqual(q.stats(), { served: 1, missed: 1, waiting: false });
});

// ── значения по умолчанию ────────────────────────────────────────────────────

test('ожидание короче секунды', () => {
  // Окно выбора не должно застывать: человек нажал цифру и ждёт результата.
  assert.equal(PASTE_WAIT_MS <= 1000, true, `${PASTE_WAIT_MS} мс — слишком долго для окна выбора`);
});

test('срок жизни заявки — секунды, не минуты', () => {
  assert.equal(PASTE_TTL_MS <= 30000, true);
  assert.equal(PASTE_TTL_MS > PASTE_WAIT_MS, true, 'заявка должна жить дольше одного ожидания');
});

 test('take alone never reports native success; wrong/late ack cannot replay', async () => {
 const q = new PasteQueue({waitMs:20}); const p=q.request('x');q.take();
 const id=q.deliveryId; assert.equal(q.acknowledge('wrong',true),false);
 assert.equal(await p,false);assert.equal(q.acknowledge(id,true),false);assert.equal(q.take(),null);
 });
 test('native failure is reported once',async()=>{const q=new PasteQueue();const p=q.request('x');q.take();const id=q.deliveryId;assert.equal(q.acknowledge(id,false),true);assert.equal(await p,false);assert.equal(q.acknowledge(id,true),false);});
