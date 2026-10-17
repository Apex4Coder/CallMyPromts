import { api, toast } from "./state.js";
import { mountBackup } from "./backup.js";
const $ = (id) => document.getElementById(id);
const bindAccount = (refresh) => {
  $("cloudClientSave").onclick = async () => {
    const out = await api("/api/cloud/client", {
      method: "PUT",
      body: { clientId: $("cloudClient").value.trim() },
    });
    if (!out.ok) return toast(out.error.message, "bad");
    await refresh();
  };
  $("cloudLogin").onclick = async () => {
    const popup = window.open("about:blank", "_blank");
    const out = await api("/api/cloud/login", { method: "POST" });
    if (!out.ok) {
      popup?.close();
      return toast(out.error.message, "bad", 7000);
    }
    const u = new URL(out.data.url);
    if (u.origin !== "https://accounts.google.com") {
      popup?.close();
      return toast("Неверный адрес входа", "bad");
    }
    if (popup) {
      popup.opener = null;
      popup.location.href = u.href;
    } else toast("Браузер заблокировал вкладку входа", "warn");
    await refresh();
  };
};
const bindProfiles = () => {
  const list = async () => {
    const out = await api("/api/cloud/profiles");
    if (!out.ok) return toast(out.error.message, "bad");
    $("cloudProfiles").replaceChildren();
    for (const p of out.data.profiles) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name + " · " + (p.modifiedTime || "");
      $("cloudProfiles").append(o);
    }
  };
  $("cloudList").onclick = list;
  $("cloudSave").onclick = async () => {
    const out = await api("/api/cloud/profiles", {
      method: "POST",
      body: { name: $("cloudName").value },
    });
    if (!out.ok)
      return toast(
        out.error.message +
          "; при неизвестном исходе сначала обнови список, не повторяй сохранение",
        "bad",
        8000,
      );
    toast("Профиль сохранён", "good");
    await list();
  };
  $("cloudRestore").onclick = async () => {
    const id = $("cloudProfiles").value;
    if (!id) return;
    const path = "/api/cloud/profile/" + encodeURIComponent(id);
    const preview = await api(path);
    if (!preview.ok) return toast(preview.error.message, "bad");
    if (
      !confirm(
        "Восстановить настройки «" +
          preview.data.name +
          "»? Текущие настройки интерфейса, порядка и хоткеев будут заменены.",
      )
    )
      return;
    const out = await api(path + "/restore", {
      method: "POST",
      body: { confirm: true, expectedLocal: preview.data.expectedLocal },
    });
    if (!out.ok) return toast(out.error.message, "bad");
    window.location.reload();
  };
};
export const mountCloud = async () => {
  mountBackup();
  const refresh = async () => {
    const out = await api("/api/cloud");
    $("cloudLogin").disabled =
      !out.ok || !out.data.configured || out.data.pending;
    $("cloudState").textContent = out.ok
      ? out.data.connected
        ? "Google подключён"
        : out.data.pending
          ? "Ожидание входа в браузере"
          : out.data.configured
            ? "Можно войти в Google"
            : "Google пока не настроен разработчиком. Резервная копия в файл работает без входа."
      : out.error.message;
  };
  bindAccount(refresh);
  bindProfiles();
  $("cloudDisconnect").onclick = async () => {
    if (!confirm("Отключить локальный аккаунт? Облачные профили не удаляются."))
      return;
    const out = await api("/api/cloud/disconnect", { method: "POST" });
    if (!out.ok) return toast(out.error.message, "bad");
    await refresh();
  };
  await refresh();
  const timer = setInterval(refresh, 5000);
  window.addEventListener("pagehide", () => clearInterval(timer), {
    once: true,
  });
};
