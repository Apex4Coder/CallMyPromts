// Paper mini-CRM. All library writes go through the existing authenticated API.
import { api, toast, setText, latest } from "./state.js";
import { icon } from "./icons.js";
const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
export class CRM {
  constructor() {
    this.items = [];
    this.groups = [];
    this.filter = "";
    this.pinned = false;
    this.selected = null;
    this.loads = latest();
    this.previews = latest();
  }
  mountIcons() {
    const rail = document.querySelectorAll(".crm-rail > a, .crm-rail > button");
    ["grid", "pin", "clock", "folder", "settings", "pulse", "help"].forEach((name, n) =>
      rail[n]?.replaceChildren(icon(name)),
    );
    $("crmAll").replaceChildren(icon("grid"), document.createTextNode("Все промпты"));
    $("crmPinned").replaceChildren(icon("pin"), document.createTextNode("Закреплённые"));
  }
  bindEditor() {
    $("crmEditor").addEventListener("submit", (e) => {
      e.preventDefault();
      this.save();
    });
    $("crmEditorClose").onclick = () => this.closeEditor();
    $("crmEditor").addEventListener("cancel", (e) => {
      e.preventDefault();
      this.closeEditor();
    });
  }
  async mount() {
    document.title = `CallMyPromts · CRM [${window.location.port}]`;
    this.mountIcons();
    $("crmSearch").addEventListener("input", () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.load(), 90);
    });
    $("crmDrawerToggle").onclick = () => {
      const open = $("crm").classList.toggle("drawer-open");
      $("crmDrawerToggle").setAttribute("aria-expanded", String(open));
    };
    $("crmAll").onclick = () => this.view("", false);
    $("crmPinned").onclick = () => this.view("", true);
    $("crmAdd").onclick = () => this.edit(null);
    $("crmEdit").onclick = () => this.edit(this.selected);
    $("crmPin").onclick = () => this.pin();
    $("crmGroupAdd").onclick = async () => {
      const name = prompt("Имя новой группы");
      if (!name) return;
      const out = await api("/api/group", { method: "POST", body: { name } });
      if (!out.ok) return toast(out.error.message, "bad");
      await this.load();
    };
    $("crmCopy").onclick = async () => {
      if (!this.full) return;
      try {
        await navigator.clipboard.writeText(this.full.body);
        toast("Скопировано", "good");
      } catch {
        toast("Нет доступа к буферу", "bad");
      }
    };
    this.bindEditor();
    $("crmList").addEventListener("keydown", (e) => {
      if (!["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) return;
      e.preventDefault();
      if (e.key === "Enter") return this.edit(this.selected);
      const at = this.items.findIndex((i) => i.id === this.selected?.id);
      this.select(
        this.items[Math.max(0, Math.min(this.items.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))],
      );
    });
    await this.load();
    const editId = window.location.hash.startsWith("#edit-")
      ? decodeURIComponent(window.location.hash.slice(6))
      : null;
    if (editId) {
      const item = this.items.find((i) => i.id === editId);
      if (item) await this.edit(item);
    }
    await this.status();
    this.statusTimer = setInterval(() => this.status(), 5000);
  }
  async view(group, pinned) {
    this.filter = group;
    this.pinned = pinned;
    await this.load();
  }
  async load() {
    const mine = this.loads.next();
    const out = await api(
      `/api/prompts?q=${encodeURIComponent($("crmSearch").value)}${this.filter ? "&group=" + encodeURIComponent(this.filter) : ""}${this.pinned ? "&pinned=1" : ""}`,
    );
    if (!this.loads.fresh(mine)) return;
    if (!out.ok) {
      toast(out.error.message, "bad");
      return;
    }
    this.items = out.data.items;
    this.groups = out.data.groups;
    $("crmHeading").textContent = this.pinned ? "Закреплённые" : this.filter || "Все промпты";
    $("crmCount").textContent = `${this.items.length} записей`;
    $("crmAll").setAttribute("aria-current", String(!this.filter && !this.pinned));
    $("crmPinned").setAttribute("aria-current", String(this.pinned));
    this.renderGroups();
    this.render();
  }
  renderGroups() {
    const box = $("crmGroups");
    box.replaceChildren();
    for (const g of this.groups) {
      const b = el("button", undefined, "crm-group");
      b.type = "button";
      b.append(el("span", "▱"), el("span", g.label || g.name || g.id), el("small", String(g.count ?? 0)));
      b.setAttribute("aria-current", String(this.filter === (g.id || g.name)));
      b.onclick = () => this.view(g.id || g.name, false);
      box.append(b);
    }
  }
  render() {
    const list = $("crmList");
    const old = this.selected?.id;
    list.replaceChildren();
    for (const item of this.items) {
      const b = el("button", undefined, "crm-row");
      b.type = "button";
      b.dataset.id = item.id;
      b.setAttribute("role", "option");
      b.append(
        this.pinGlyph(item),
        el("span", item.title, "crm-name"),
        el("span", item.group, "crm-row-group"),
      );
      b.onclick = () => this.select(item);
      b.ondblclick = () => this.edit(item);
      list.append(b);
    }
    $("crmEmpty").hidden = this.items.length > 0;
    this.select(this.items.find((i) => i.id === old) || this.items[0] || null);
  }
  pinGlyph(item) {
    const glyph = icon("pin");
    glyph.classList.add("crm-pin-glyph");
    if (item.pin === null) glyph.classList.add("not-pinned");
    return glyph;
  }
  async select(item) {
    const mine = this.previews.next();
    this.selected = item;
    this.full = null;
    for (const b of $("crmList").children) b.setAttribute("aria-selected", String(b.dataset.id === item?.id));
    for (const id of ["crmCopy", "crmEdit", "crmPin"]) $(id).disabled = !item;
    setText($("crmPreviewTitle"), item?.title || "Нет выбранного промпта");
    setText($("crmPreviewMeta"), item ? [item.group, ...(item.tags || [])].join(" · ") : "");
    setText($("crmPreviewBody"), item ? "Загрузка…" : "Выбери запись или измени фильтр.");
    $("crmPin").textContent = item?.pin !== null && item ? "Открепить" : "Закрепить";
    if (!item) return;
    const out = await api(`/api/prompt/${encodeURIComponent(item.id)}`);
    if (!this.previews.fresh(mine)) return;
    if (out.ok) this.full = out.data.item;
    setText($("crmPreviewBody"), out.ok ? this.full.body : out.error.message);
  }
  async pin() {
    const item = this.selected;
    if (!item) return;
    if (item.pin !== null) {
      const out = await api(`/api/prompt/${encodeURIComponent(item.id)}/pin`, {
        method: "POST",
        body: { group: item.group, unpin: true },
      });
      if (!out.ok) return toast(out.error.message, "bad");
      return this.load();
    }
    const raw = prompt("Позиция закрепления 1–9 (пусто — первая свободная)", "");
    if (raw === null) return;
    const pin = raw.trim() === "" ? null : Number(raw);
    if (pin !== null && (!Number.isInteger(pin) || pin < 1 || pin > 9))
      return toast("Нужна позиция 1–9", "warn");
    const path = `/api/prompt/${encodeURIComponent(item.id)}/pin`;
    const preview = await api(path, { method: "POST", body: { group: item.group, pin } });
    if (!preview.ok) return toast(preview.error.message, "bad");
    const plan = preview.data.plan;
    if (plan.occupied && !confirm("Позиция занята. Изменить закрепление?")) return;
    const out = await api(path, {
      method: "POST",
      body: { group: item.group, pin: plan.pin, confirm: true },
    });
    if (!out.ok) return toast(out.error.message, "bad");
    await this.load();
  }
  async edit(item) {
    let full = null;
    if (item) {
      const out = await api(`/api/prompt/${encodeURIComponent(item.id)}`);
      if (!out.ok) return toast(out.error.message, "bad");
      full = out.data.item;
    }
    this.editing = full;
    $("crmEditorHeading").textContent = full ? "Редактор промпта" : "Новый промпт";
    $("crmTitle").value = full?.title || "";
    $("crmBody").value = full?.body || "";
    const groups = $("crmGroup");
    groups.replaceChildren();
    for (const g of this.groups) {
      const o = el("option", g.label || g.id);
      o.value = g.id || g.name;
      groups.append(o);
    }
    if (!groups.options.length) {
      const o = el("option", "Входящие");
      o.value = "inbox";
      groups.append(o);
    }
    if (full) $("crmGroup").value = full.group;
    $("crmGroup").disabled = !!full;
    this.originalForm = this.formSnapshot();
    $("crmEditor").showModal();
    $("crmTitle").focus();
  }
  formSnapshot() {
    return JSON.stringify([$("crmTitle").value, $("crmGroup").value, $("crmBody").value]);
  }
  closeEditor() {
    if (this.formSnapshot() !== this.originalForm && !confirm("Закрыть без сохранения?")) return;
    $("crmEditor").close();
  }
  async save() {
    const full = this.editing;
    const body = { title: $("crmTitle").value, body: $("crmBody").value, group: $("crmGroup").value };
    if (full) body.expectedMtime = full.mtimeMs;
    $("crmSave").disabled = true;
    try {
      const out = await api(full ? `/api/prompt/${encodeURIComponent(full.id)}` : "/api/prompt", {
        method: full ? "PUT" : "POST",
        body,
      });
      if (!out.ok) return toast(out.error.message, "bad", 6000);
      $("crmEditor").close();
      await this.load();
      toast("Сохранено", "good");
    } finally {
      $("crmSave").disabled = false;
    }
  }
  async status() {
    const out = await api("/api/system");
    const status = $("crmStatus");
    const keys = out.ok ? Object.values(out.data.hotkeys || {}) : [];
    const state = !out.ok
      ? "bad"
      : keys.some((k) => k.state === "bad")
        ? "bad"
        : !keys.length || keys.some((k) => k.state === "warn")
          ? "warn"
          : "good";
    status.dataset.state = state;
    status.textContent = !out.ok
      ? "Нет связи"
      : state === "bad"
        ? "Ошибка горячих клавиш"
        : state === "warn"
          ? "Мост: требуется проверка"
          : "Сервис готов";
  }
}
