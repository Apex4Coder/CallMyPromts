// tests/unit/bridge-keys.test.mjs — разбор горячих клавиш.
//
// Требование: REQ-KEY-BIND (docs/SPEC.md §8). Сценарий: S-07.
//
// Формат — нотация AutoHotkey (^ Ctrl, ! Alt, + Shift, # Win). Она выбрана не из
// вкуса: мост это AHK-скрипт, и любой другой формат пришлось бы переводить в неё
// же, добавив ещё одно место для ошибки.
//
// Главное правило файла: отказ всегда назван словами. Клавиша, которая не
// работает, и никто не сказал почему, — худший из вариантов (S-07).

import test from 'node:test';
import assert from 'node:assert/strict';

import { MODS, SYSTEM_COMBOS, parseCombo, suggestFree } from '../../bridge/index.mjs';

// ── модификаторы ─────────────────────────────────────────────────────────────

test('четыре модификатора, названные по-человечески', () => {
  assert.deepEqual(MODS, { '^': 'Ctrl', '!': 'Alt', '+': 'Shift', '#': 'Win' });
});

test('разбирает одиночный модификатор', () => {
  const out = parseCombo('^r');

  assert.equal(out.ok, true);
  assert.deepEqual(out.mods, ['Ctrl']);
  assert.equal(out.key, 'r');
  assert.equal(out.human, 'Ctrl + R', 'человеку показывается словами, а не символами');
});

test('разбирает несколько модификаторов в любом порядке записи', () => {
  assert.deepEqual(parseCombo('^!r').mods, ['Ctrl', 'Alt']);
  assert.deepEqual(parseCombo('!^r').mods, ['Alt', 'Ctrl']);
  assert.deepEqual(parseCombo('^+#q').mods, ['Ctrl', 'Shift', 'Win']);
});

test('регистр клавиши не важен: Ctrl+R и Ctrl+r — одно и то же', () => {
  assert.equal(parseCombo('^R').key, 'r');
  assert.equal(parseCombo('^r').key, 'r');
});

// ── что принимается как клавиша ──────────────────────────────────────────────

test('буквы и цифры принимаются', () => {
  for (const key of ['a', 'z', '0', '9']) {
    assert.equal(parseCombo(`^!${key}`).ok, true, `${key}: должна приниматься`);
  }
});

test('функциональные клавиши принимаются целиком', () => {
  for (const key of ['f1', 'f9', 'f12']) {
    assert.equal(parseCombo(`^${key}`).ok, true, `${key}: должна приниматься`);
  }
});

test('F13 не принимается: такой клавиши нет на обычной клавиатуре', () => {
  const out = parseCombo('^f13');

  assert.equal(out.ok, false);
  assert.match(out.reason, /не поддерживается/);
});

test('именованные клавиши принимаются', () => {
  // Модификатор здесь !+ (Alt+Shift) намеренно: с Ctrl+Alt отклонился бы `del`
  // (Ctrl+Alt+Del), а с Ctrl+Shift — `esc` (Ctrl+Shift+Esc). Обе комбинации
  // перехватывает Windows, и это свойство комбинации, а не клавиши.
  for (const key of ['space', 'tab', 'enter', 'esc', 'del', 'ins', 'home', 'end', 'up', 'down', 'pgup', 'pgdn']) {
    assert.equal(parseCombo(`!+${key}`).ok, true, `${key}: должна приниматься`);
  }
});

test('одна и та же клавиша годна или нет в зависимости от модификаторов', () => {
  // Проверка порядка причин: клавиша `del` сама по себе допустима, но именно
  // Ctrl+Alt+Del перехватывается Windows — и сказать нужно именно это, а не
  // винить клавишу.
  assert.equal(parseCombo('!+del').ok, true, 'Alt+Shift+Del свободна');

  const taken = parseCombo('^!del');
  assert.equal(taken.ok, false);
  assert.match(taken.reason, /Windows/);
  assert.equal(/не поддерживается/.test(taken.reason), false, 'причина не должна винить клавишу');
});

test('Ctrl+Shift+Esc тоже занят системой: это диспетчер задач', () => {
  const out = parseCombo('^+esc');

  assert.equal(out.ok, false);
  assert.match(out.reason, /Windows/);
});

test('выдуманное имя клавиши отклоняется с указанием самой клавиши', () => {
  const out = parseCombo('^!нажми');

  assert.equal(out.ok, false);
  assert.match(out.reason, /«нажми»/, 'в причине видно, что именно не понято');
});

// ── обязательный модификатор ─────────────────────────────────────────────────

test('клавиша без модификатора отклоняется', () => {
  // Иначе буква «р» перестала бы печататься во всей системе.
  const out = parseCombo('r');

  assert.equal(out.ok, false);
  assert.match(out.reason, /минимум один модификатор/);
  assert.match(out.reason, /Ctrl/, 'перечислено, что именно годится');
});

test('одна функциональная клавиша без модификатора тоже отклоняется', () => {
  assert.equal(parseCombo('f5').ok, false);
});

test('повтор модификатора — ошибка, а не молчаливое схлопывание', () => {
  // «^^r» это опечатка. Принять её означало бы записать в настройки то, чего
  // человек не имел в виду.
  const out = parseCombo('^^r');

  assert.equal(out.ok, false);
  assert.match(out.reason, /Ctrl указан дважды/);
});

// ── системные комбинации ─────────────────────────────────────────────────────

test('комбинации, занятые Windows, перечислены явно', () => {
  // Список нужен, чтобы объяснить отказ до попытки регистрации: сама попытка
  // выглядела бы как необъяснимый отказ.
  for (const combo of ['#l', '#d', '#e', '#r', '!tab']) {
    assert.equal(SYSTEM_COMBOS.has(combo), true, `${combo}: должен быть в списке системных`);
  }
});

test('системная комбинация отклоняется с указанием Windows', () => {
  const out = parseCombo('#l');

  assert.equal(out.ok, false);
  assert.match(out.reason, /Windows/);
});

test('Win+L отклоняется в любом регистре записи', () => {
  assert.equal(parseCombo('#L').ok, false);
});

// ── пустое значение ──────────────────────────────────────────────────────────

test('пустая строка — это «не назначена», а не ошибка', () => {
  // Горячая клавиша необязательна. Ошибка на пустом значении заставляла бы
  // придумывать комбинацию там, где она не нужна.
  const out = parseCombo('');

  assert.equal(out.ok, true);
  assert.equal(out.empty, true);
  assert.equal(out.key, null);
  assert.equal(out.human, 'не назначена');
  assert.equal(out.reason, null);
});

test('пробелы и null тоже означают «не назначена»', () => {
  for (const v of ['   ', null, undefined]) {
    assert.equal(parseCombo(v).empty, true, `${JSON.stringify(v)}: должно быть «не назначена»`);
  }
});

test('только модификатор без клавиши отклоняется', () => {
  const out = parseCombo('^');

  assert.equal(out.ok, false);
  assert.equal(out.empty, undefined, 'это не «не назначена», а неполная комбинация');
});

// ── предложение свободных ────────────────────────────────────────────────────

test('предлагает свободные комбинации, а не назначает их', () => {
  const out = suggestFree([], 3);

  assert.equal(out.length, 3);
  for (const s of out) {
    assert.equal(parseCombo(s.combo).ok, true, `${s.combo}: предложенное обязано быть корректным`);
    assert.equal(s.human.includes('+'), true, 'подпись читается человеком');
  }
});

test('предложенное не пересекается с занятым и известным', () => {
  const taken = ['^!q', '^!w'];

  const out = suggestFree(taken, 5);

  for (const s of out) {
    assert.equal(taken.includes(s.combo), false, `${s.combo}: занято пользователем`);
    assert.equal(SYSTEM_COMBOS.has(s.combo), false, `${s.combo}: занято Windows`);
  }
});

test('предложение учитывает регистр занятых', () => {
  const out = suggestFree(['^!Q'], 5);

  assert.equal(out.some((s) => s.combo === '^!q'), false, 'сравнение без учёта регистра');
});

test('запрошенное количество соблюдается', () => {
  assert.equal(suggestFree([], 1).length, 1);
  assert.equal(suggestFree([], 7).length, 7);
});

test('предложения не повторяются', () => {
  const out = suggestFree([], 8);

  assert.equal(new Set(out.map((s) => s.combo)).size, out.length);
});
