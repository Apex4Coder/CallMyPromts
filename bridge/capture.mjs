// bridge/capture.mjs — поиск AutoHotkey и запасной путь чтения буфера.
//
// Требование: REQ-KEY-CAPTURE (docs/SPEC.md §8). Сценарий S-03.
// Тест: tests/unit/bridge-capture.test.mjs.
//
// Разведка показала: на машине стоит AutoHotkey 2.0.26. Но приложение не имеет
// права падать, если его снесут: без AHK теряются только горячие клавиши и чтение
// выделения, а окно управления, журнал и библиотека продолжают работать
// (S-07, плохой путь 7). Поэтому здесь два пути и оба честно называются.

import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';

/** Где AHK v2 лежит на Windows. Порядок — от самого вероятного. */
const AHK_PATHS = [
  'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe',
  'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey32.exe',
  'C:\\Program Files\\AutoHotkey\\AutoHotkey.exe',
  'C:\\Program Files (x86)\\AutoHotkey\\v2\\AutoHotkey32.exe',
];

export const ahkFromEnv = () => process.env.DECK_AHK ?? null;

/**
 * Поиск исполняемого файла AHK.
 * @returns {{found: boolean, path: string|null, state: string, reason: string|null}}
 */
export const findAhk = ({ paths = AHK_PATHS, env = ahkFromEnv() } = {}) => {
  const wanted = env ? [env, ...paths] : paths;

  for (const p of wanted) {
    if (existsSync(p)) return { found: true, path: p, state: 'good', reason: null };
  }

  return {
    found: false,
    path: null,
    state: 'bad',
    reason: 'AutoHotkey v2 не найден — горячие клавиши и чтение выделения недоступны, окно управления работает',
  };
};

/** Команда запуска моста. Возвращается, а не выполняется: запуск — дело service. */
export const ahkCommand = (root, { ahk = null } = {}) => {
  const found = ahk ? { found: true, path: ahk } : findAhk();
  if (!found.found) return { ok: false, reason: found.reason };

  return {
    ok: true,
    file: found.path,
    args: ['/CP65001', join(root, 'bridge', 'deck.ahk')],
    script: join(root, 'bridge', 'deck.ahk'),
  };
};

const run = (file, args, { timeout = 4000 } = {}) => new Promise((done) => {
  execFile(file, args, { timeout, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
    done({ ok: !err, out: String(stdout ?? ''), err: err ? (err.message || String(stderr)) : null });
  });
});

/**
 * Запасное чтение буфера через PowerShell.
 * Медленнее AHK (запуск процесса ~200 мс) и не умеет читать выделение из чужого
 * окна — только то, что уже в буфере. Годится для слежки, не годится для S-03.
 */
export const readClipboard = async () => {
  const res = await run('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw',
  ]);
  if (!res.ok) return { ok: false, text: '', reason: `буфер не прочитан: ${res.err}` };
  return { ok: true, text: res.out.replace(/\r\n/g, '\n').replace(/\n$/, ''), reason: null };
};

/**
 * Имя процесса активного окна — источник записи для чёрного списка.
 * Без него защита от менеджеров паролей не работает, поэтому неудача возвращает
 * пустую строку, а не выдумывает имя.
 */
export const activeProcess = async () => {
  const res = await run('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -AssemblyName UIAutomationClient; '
    + '$h=[System.Windows.Automation.AutomationElement]::FocusedElement; '
    + 'if ($h) { (Get-Process -Id $h.Current.ProcessId).ProcessName } else { "" }',
  ]);
  return res.ok ? res.out.trim() : '';
};

/** Что именно доступно на этой машине — для раздела «Диагностика». */
export const capabilities = () => {
  const ahk = findAhk();
  return {
    hotkeys: ahk.found ? 'good' : 'bad',
    selectionCapture: ahk.found ? 'good' : 'bad',
    pasteIntoWindow: ahk.found ? 'good' : 'bad',
    clipboardRead: 'warn',
    reason: ahk.found ? null : ahk.reason,
    ahkPath: ahk.path,
    fallback: ahk.found ? null : 'PowerShell читает буфер, но не выделение и не вставляет',
  };
};
