// First-visible geometry is measured separately in tests/native/paper-appearance.ahk.
// These guards prevent regression to visible restore/resize and personal profile reuse.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readScript, ahkFn, orderIn } from '../helpers/ahk.mjs';
const source = readScript();

test('панель запускается скрыто в отдельном профиле приложения', () => {
  const entry = ahkFn(source, 'Open').text;
  assert.match(entry, /DetectHiddenWindows true/);
  assert.match(entry, /finally[\s\S]*DetectHiddenWindows hiddenBefore/);
  assert.match(entry, /OpenOwnedPanel\(hash/);
  const open = ahkFn(source, 'OpenOwnedPanel').text;
  assert.match(open, /Run command, , "Hide"/);
  assert.match(open, /CallMyPromts\.OwnerPort/);
  assert.match(open, /WinGetProcessPath/);
  const flags = ahkFn(source, 'PanelLaunchFlags').text;
  assert.match(flags, /ROOT "\\state\\edge-panels\\"/);
  assert.match(flags, /--user-data-dir=/);
  assert.match(flags, /--start-minimized/);
  assert.match(flags, /--window-position=/);
  assert.match(flags, /--window-size=/);
});

test('восстановление и перемещение завершаются до показа панели', () => {
  const reveal = ahkFn(source, 'RevealPanelAt').text;
  assert.equal(orderIn(reveal, 'WinSetTransparent 0', 'WinRestore target').ordered, true);
  assert.equal(orderIn(reveal, 'WinHide target', 'WinRestore target').ordered, true);
  assert.equal(orderIn(reveal, 'WinMove geometry.x', '"ShowWindow"').ordered, true);
  assert.equal(orderIn(reveal, '"ShowWindow"', 'WinSetTransparent "Off"').ordered, true);
  assert.match(reveal, /DwmSetWindowAttribute/);
  assert.match(reveal, /DwmFlush/);
  assert.doesNotMatch(reveal, /SystemParametersInfo/);
});

test('появление Paper меняет только прозрачность, не координаты окна', () => {
  const css = readFileSync(new URL('../../ui/styles/paper-panels.css', import.meta.url), 'utf8');
  const animation = css.match(/@keyframes paper-appear\s*\{[\s\S]*?\n\}/)?.[0];
  assert.ok(animation, 'анимация появления должна оставаться определена');
  assert.match(animation, /opacity/);
  assert.doesNotMatch(animation, /translate|transform|top:|left:/);
});
