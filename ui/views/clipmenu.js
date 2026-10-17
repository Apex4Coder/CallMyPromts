// ui/views/clipmenu.js — контекстное меню журнала: три пункта, не больше.
//
// Требование: REQ-UI-CLIPS (docs/SPEC.md §7). Сценарий S-05. DOM-id: UI-SPEC §3.2.
// Тест: tests/e2e/clips.spec.mjs (утверждения U-11, U-12).
//
// Владелец сформулировал границу прямо: «правой клавишей мыши сохранить,
// копировать, а больше тут копировать и сохранить ничего не надо». Поэтому пунктов
// ровно три, и добавление четвёртого — изменение контракта, а не улучшение.
//
// Сохранение идёт в два шага: сначала сервер возвращает план (имя файла, что будет
// очищено, предупреждения о повторе и секретах), потом человек подтверждает.
// Молчаливое создание файла с придуманным именем — это изменение, которого не просили.

import { api, toast } from './state.js';

const $ = (id) => document.getElementById(id);

export class ClipMenu {
  constructor({ onCopy, onChanged, current } = {}) {
    this.onCopy = onCopy;
    this.onChanged = onChanged;
    this.current = current;
    this.clip = null;
  }

  mount() {
    this.el = {
      menu: $('clipMenu'),
      copy: $('clipCopyBtn'),
      promote: $('clipPromoteBtn'),
      groups: $('clipGroupList'),
      del: $('clipDeleteBtn'),
    };

    this.el.copy.addEventListener('click', () => this.copy());
    this.el.promote.addEventListener('click', () => this.toggleGroups());
    this.el.del.addEventListener('click', () => this.remove());

    document.addEventListener('click', (e) => {
      if (!this.el.menu.hidden && !this.el.menu.contains(e.target)) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.el.menu.hidden) this.close();
    });
  }

  open(event, clip) {
    event.preventDefault();
    this.clip = clip ?? this.current?.() ?? null;
    if (!this.clip) return;

    const m = this.el.menu;
    m.hidden = false;
    this.el.groups.hidden = true;
    this.el.promote.setAttribute('aria-expanded', 'false');

    // Меню не должно уезжать за край окна: измеряем после показа.
    const w = m.offsetWidth || 220;
    const h = m.offsetHeight || 120;
    m.style.left = `${Math.max(4, Math.min(event.clientX, window.innerWidth - w - 8))}px`;
    m.style.top = `${Math.max(4, Math.min(event.clientY, window.innerHeight - h - 8))}px`;

    this.el.copy.focus();
  }

  close() {
    this.el.menu.hidden = true;
    this.el.groups.hidden = true;
    this.el.promote.setAttribute('aria-expanded', 'false');
    this.clip = null;
  }

  async copy() {
    const clip = this.clip;
    this.close();
    if (!clip) return;

    const out = await api(`/api/clip/${clip.id}`);
    if (!out.ok) {
      toast(out.error.message, 'bad');
      return;
    }

    const ok = await this.onCopy?.(out.data.item.text);
    if (ok === false) return;

    document.getElementById(`clip-${clip.id}`)?.classList.add('is-flash');
    toast('Скопировано', 'good', 1400);
  }

  /** Выпадающий список групп — прямая просьба владельца при сохранении. */
  async toggleGroups() {
    const open = this.el.promote.getAttribute('aria-expanded') === 'true';
    if (open) {
      this.el.groups.hidden = true;
      this.el.promote.setAttribute('aria-expanded', 'false');
      return;
    }
    if (!this.clip) return;

    const got = await api('/api/prompts');
    const groups = got.ok ? got.data.groups : [];

    const box = this.el.groups;
    box.textContent = '';

    for (const g of groups) {
      box.append(this.groupButton(g.id, `${g.label ?? g.id} (${g.count ?? 0})`));
    }
    box.append(this.groupButton('__new__', '+ Новая группа'));

    box.hidden = false;
    this.el.promote.setAttribute('aria-expanded', 'true');
  }

  groupButton(id, label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.dataset.group = id;
    b.textContent = label;
    b.addEventListener('click', () => this.promote(id));
    return b;
  }

  async promote(groupId) {
    const clip = this.clip;
    if (!clip) return;

    let group = groupId;
    if (groupId === '__new__') {
      const name = window.prompt('Имя новой группы');
      if (!name) return;

      const made = await api('/api/group', { method: 'POST', body: { name } });
      if (!made.ok) {
        toast(made.error.message, 'bad');
        return;
      }
      group = made.data.name;
      // Приведение имени к допустимому виду показывается: «Мои Промпты!» → «moi-prompty».
      if (made.data.renamed) toast(`Группа создана как «${group}»`, 'warn', 4000);
    }

    const plan = await api(`/api/clips/${clip.id}/promote`, { method: 'POST', body: { group } });
    if (!plan.ok) {
      toast(plan.error.message, 'bad');
      return;
    }

    const warn = plan.data.issues?.find((i) => i.level === 'warn');
    const ask = warn
      ? `${warn.message}\n\nНазвание промпта:`
      : 'Название промпта:';

    const title = window.prompt(ask, plan.data.plan.title);
    if (title === null) return;

    const made = await api(`/api/clips/${clip.id}/promote`, {
      method: 'POST',
      body: { group, title, confirm: true },
    });

    this.close();

    if (!made.ok) {
      toast(made.error.message, 'bad');
      return;
    }

    const left = made.data.issues?.find((i) => i.level === 'warn');
    toast(left
      ? `Сохранён «${made.data.created.id}», но: ${left.message}`
      : `Сохранён как «${made.data.created.id}» в «${made.data.created.group}»`,
    left ? 'warn' : 'good', left ? 5000 : 2600);

    await this.onChanged?.();
  }

  async remove() {
    const clip = this.clip;
    this.close();
    if (!clip) return;

    const out = await api(`/api/clip/${clip.id}`, { method: 'DELETE' });
    if (!out.ok) {
      toast(out.error.message, 'bad');
      return;
    }

    toast('Удалено', 'good', 1400);
    await this.onChanged?.();
  }
}
