'use strict';

// DESIGN-012. Окно «Что нового» из «О программе». Только рисует: какие пункты и на каком
// языке, решил src/whats-new.js, тексты и действия приходят параметрами. Вид — тот же
// lib-modal, что у «Подробнее» и переноса папки, чтобы окна приложения не расходились.
// Открывается только по кнопке: само после обновления не появляется (решение владельца).

(function expose(root) {
  const ID = 'whatsNewBackdrop';
  let keyHandler = null;

  function close() {
    const backdrop = document.getElementById(ID);
    if (!backdrop) return;
    if (keyHandler) {
      document.removeEventListener('keydown', keyHandler, true);
      keyHandler = null;
    }
    const restore = backdrop.__restoreFocus;
    backdrop.remove();
    if (restore && restore.isConnected) restore.focus({ preventScroll: true });
  }

  // { title, items:[{title,text}], lang, closeLabel, allReleasesLabel, onAllReleases }
  function open(opts) {
    close();
    const backdrop = document.createElement('div');
    backdrop.className = 'lib-modal-backdrop';
    backdrop.id = ID;
    backdrop.__restoreFocus = document.activeElement;

    const modal = document.createElement('div');
    modal.className = 'lib-modal whats-new-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'whatsNewTitle');
    modal.tabIndex = -1;

    const head = document.createElement('div');
    head.className = 'lib-modal-head';
    const title = document.createElement('strong');
    title.id = 'whatsNewTitle';
    title.textContent = opts.title;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'lib-modal-close';
    closeBtn.setAttribute('aria-label', opts.closeLabel);
    closeBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
    closeBtn.addEventListener('click', close);
    head.append(title, closeBtn);

    // Пункты на запасном английском помечены своим языком, чтобы экранный диктор
    // и проверка орфографии не читали их как текст интерфейса.
    const body = document.createElement('div');
    body.className = 'lib-modal-body';
    const list = document.createElement('ul');
    list.className = 'whats-new-list';
    if (opts.lang) list.lang = opts.lang;
    for (const item of opts.items) {
      const li = document.createElement('li');
      const strong = document.createElement('strong');
      strong.textContent = item.title;
      const text = document.createElement('p');
      text.textContent = item.text;
      li.append(strong, text);
      list.appendChild(li);
    }
    body.appendChild(list);

    const foot = document.createElement('div');
    foot.className = 'lib-modal-foot';
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'pill ghost';
    all.textContent = opts.allReleasesLabel;
    all.addEventListener('click', () => opts.onAllReleases());
    foot.appendChild(all);

    modal.append(head, body, foot);
    backdrop.appendChild(modal);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
    document.body.appendChild(backdrop);

    keyHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      // Фокус не уходит под затемнение: в окне всего две кнопки, ходим по кругу.
      const focusable = [closeBtn, all];
      const at = focusable.indexOf(document.activeElement);
      e.preventDefault();
      const next = e.shiftKey ? (at <= 0 ? focusable.length - 1 : at - 1) : (at + 1) % focusable.length;
      focusable[next].focus();
    };
    document.addEventListener('keydown', keyHandler, true);
    modal.focus({ preventScroll: true });
  }

  root.WhatsNewDialog = { open, close };
})(window);
