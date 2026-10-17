import { api, toast } from "./state.js";
const $ = (id) => document.getElementById(id);
const save = async () => {
  const name = $("backupName").value.trim();
  if (!name || name.length > 80 || /[\x00-\x1f]/.test(name))
    return toast("Имя копии: 1–80 символов", "bad");
  const out = await api("/api/settings/backup");
  if (!out.ok) return toast(out.error.message, "bad");
  const profile = { ...out.data.profile, name };
  const blob = new Blob([JSON.stringify(profile, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download =
    name.replace(/[<>:"/\\|?*]/g, "_").replace(/[. ]+$/g, "") + ".json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast("Файл подготовлен для сохранения браузером", "good");
};
const restore = async (file) => {
  if (!file) return;
  if (file.size > 100000) return toast("Файл слишком большой", "bad");
  let profile;
  try {
    profile = JSON.parse(await file.text());
  } catch {
    return toast("Файл не является JSON настроек", "bad");
  }
  const preview = await api("/api/settings/backup/preview", {
    method: "POST",
    body: { profile },
  });
  if (!preview.ok) return toast(preview.error.message, "bad");
  if (
    !confirm(
      "Восстановить настройки «" +
        preview.data.name +
        "»? Интерфейс, порядок и хоткеи будут заменены. Промпты и журнал не меняются.",
    )
  )
    return;
  const out = await api("/api/settings/backup/restore", {
    method: "POST",
    body: { profile, confirm: true, expectedLocal: preview.data.expectedLocal },
  });
  if (!out.ok)
    return toast(
      out.error.message + "; не повторяй восстановление при неизвестном исходе",
      "bad",
      8000,
    );
  window.location.reload();
};
export const mountBackup = () => {
  $("backupSave").onclick = save;
  $("backupRestore").onclick = () => $("backupFile").click();
  $("backupFile").onchange = async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    $("backupRestore").disabled = true;
    try {
      await restore(file);
    } catch {
      toast(
        "Ошибка чтения файла или связи; проверь настройки перед повтором",
        "bad",
      );
    } finally {
      $("backupRestore").disabled = false;
    }
  };
  $("coffeeCopy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(
        $("coffeeAddress").textContent.trim(),
      );
      toast("Адрес скопирован · USDT только Tron (TRC20)", "good");
    } catch {
      toast("Не удалось скопировать; выдели адрес вручную", "bad");
    }
  };
};
